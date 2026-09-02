import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime } from 'rxjs';

import {
  ApplicationBorrowerViewSchema,
  applicationStepIndex,
  deriveApplicationFigures,
  isApplicationStep,
  moneyFromNumericString,
  parseApplicationData,
  unmetRequirements,
  type ApplicationBorrowerView,
  type ApplicationData,
  type ApplicationFigures,
  type ApplicationRequirement,
  type ApplicationStep,
  type Money,
  type RuleResult,
} from '@lj/domain';
import { getBorrowerApplication, listActiveLoanProducts, saveApplicationDraft } from '@lj/db';
import type { LoanProduct } from '@lj/db';
import {
  atLeastOneEligibleProduct,
  eligibilityContextFromApplication,
  evaluateApplicationCompleteness,
  evaluateEligibility,
  parseEligibilityCriteria,
  type EligibilityProduct,
  type ProductEligibility,
} from '@lj/rules';
import { applicationMachine, can, type GuardResult } from '@lj/workflow';

import { isApiFailure } from '../../core/api/api-client.ts';
import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { AggregateStore, type WriteOutcome } from '../../core/store/aggregate-store.ts';
import { TransitionService, type TransitionAck } from '../../core/workflow/transition.service.ts';
import {
  clearDraftSnapshot,
  readDraftSnapshot,
  reconcileDraft,
  writeDraftSnapshot,
  type DraftSnapshot,
} from './draft.ts';
import {
  applicationDataFromForm,
  buildApplicationForm,
  loadApplicationForm,
  type ApplicationForm,
  type RawApplicationValue,
} from './form.ts';

/**
 * One application: the server's copy, the form over it, and everything derived
 * from the two.
 *
 * Provided at the `/apply/:id` route rather than at the root (plan/07), so it
 * dies when the applicant leaves and no stale payload bleeds into the next
 * file. Steps are views over slices of it; a step never holds state of its
 * own, which is what stops "does step two know about step three's data" from
 * ever being a question.
 *
 * Everything below `data` is `computed()`. Eligibility, the derived figures,
 * completeness and whether submit is legal are all functions of the form value
 * and the products, so none of them is stored -- a value that can be derived is
 * one that cannot go stale (plan/07, tier 3).
 *
 * `effect()` is not used at all. The two pieces of I/O -- autosave and the
 * seatbelt -- are driven by `form.valueChanges` through rxjs, because the thing
 * they need is DEBOUNCE and rxjs already has it. An effect would re-run on
 * every signal it read and would need its own timer, which is the same
 * mechanism with the scheduling written out by hand.
 *
 * THE ORDER OF THE TWO WRITES MATTERS. The seatbelt is written synchronously
 * on every change; the server save is debounced. That is deliberate: the
 * seatbelt is the copy that survives the tab being killed between keystrokes,
 * and a debounced seatbelt would have exactly the gap it exists to close.
 */

export const AUTOSAVE_DELAY_MS = 800;

/**
 * Where the seatbelt is kept, as a token so a test can supply its own and so
 * a browser that refuses storage does not take the feature down.
 *
 * The access is guarded: reading `localStorage` throws outright in some
 * privacy configurations, which is a different failure from it being absent
 * and would otherwise happen during construction.
 */
export const DRAFT_STORAGE = new InjectionToken<Storage | null>('lj.draft-storage', {
  providedIn: 'root',
  factory: () => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  },
});

/**
 * `numeric` as PostgREST renders it, without a float multiplication.
 *
 * The same conversion apps/api makes, for the same reason: money.ts warns that
 * `Math.trunc(value * 100)` loses a cent on the values nobody checks. Rendering
 * the value back to its shortest round-tripping decimal recovers the digits
 * exactly for everything `numeric(14,2)` can hold, and @lj/domain's exact
 * parser does the rest. `String` rather than a cast because the generated types
 * say `number` while money.ts says PostgREST emits a string; this is correct
 * either way, which is the point.
 *
 * DUPLICATED, knowingly, with `eligibilityProducts` in
 * apps/api/lib/application-subject.ts. It cannot be shared today: @lj/db sits
 * below @lj/rules so neither can own a conversion between their types, and the
 * only layer above both is the delivery layer, which is two applications. The
 * fix is a structural overload in @lj/rules that takes a product row without
 * importing @lj/db -- recorded on the issue rather than done here, because
 * packages/rules is not this scope's to edit and apps/api is in flight.
 */
function moneyFromPostgrestNumeric(value: number | string): Money | null {
  try {
    return moneyFromNumericString(String(value));
  } catch {
    return null;
  }
}

/**
 * A product whose criteria do not parse is DROPPED, not skipped into the
 * "matches" column. `parseEligibilityCriteria` fails closed by design, and
 * dropping the product can only ever make the applicant less eligible, never
 * more.
 */
function eligibilityProducts(rows: readonly LoanProduct[]): EligibilityProduct[] {
  const products: EligibilityProduct[] = [];
  for (const row of rows) {
    const criteria = parseEligibilityCriteria(row.criteria);
    if (!criteria.ok) {
      continue;
    }
    products.push({
      id: row.id,
      name: row.name,
      minAmount: row.min_amount === null ? null : moneyFromPostgrestNumeric(row.min_amount),
      maxAmount: row.max_amount === null ? null : moneyFromPostgrestNumeric(row.max_amount),
      criteria: criteria.criteria,
    });
  }
  return products;
}

/** What a store that has not been opened, or cannot reach the database, reports. */
export const NO_DATABASE: string =
  'This deployment cannot reach the database, so an application cannot be opened.';

@Injectable()
export class ApplicationStore extends AggregateStore<ApplicationBorrowerView> {
  private readonly client = inject(DATABASE_CLIENT);
  private readonly auth = inject(SupabaseAuthService);
  private readonly transitions = inject(TransitionService);
  private readonly storage = inject(DRAFT_STORAGE);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);

  /** The working copy. Steps bind to slices of it; nothing else owns form state. */
  readonly form: ApplicationForm = buildApplicationForm();

  private readonly currentId = signal<string | null>(null);
  private readonly rawValue = signal<RawApplicationValue>(this.form.getRawValue());
  private readonly currentProducts = signal<readonly EligibilityProduct[]>([]);
  private readonly recovered = signal<DraftSnapshot | null>(null);
  private readonly refusal = signal<readonly RuleResult[]>([]);

  /**
   * True while a payload is being put into the form.
   *
   * Loading emits value changes -- that is how the derived signals learn about
   * it -- and the seatbelt writer must not act on them. The form is still
   * carrying the previous load's dirty flag at that moment, so a seatbelt
   * written here would record a half-loaded form as unsaved work and offer it
   * back on the next visit.
   */
  private loadingForm = false;

  readonly applicationId: Signal<string | null> = this.currentId.asReadonly();

  /** Non-null when the seatbelt held edits the server never received. */
  readonly recoveredDraft: Signal<DraftSnapshot | null> = this.recovered.asReadonly();

  readonly products: Signal<readonly EligibilityProduct[]> = this.currentProducts.asReadonly();

  /**
   * What the SERVER said when it refused, which is not always what the client
   * predicted.
   *
   * The prediction below greys out a button; this is the decision. They should
   * agree -- same machine, same rules, same payload -- and when they do not,
   * the server is right and these are the results worth putting on the screen.
   * `AggregateStore` flattens a failure to a message and a code, so the
   * blockers are caught here before that happens.
   */
  readonly serverRefusal: Signal<readonly RuleResult[]> = this.refusal.asReadonly();

  /** The payload as it stands in the form, which is what every rule reads. */
  readonly data: Signal<ApplicationData> = computed(() =>
    applicationDataFromForm(this.rawValue()),
  );

  readonly figures: Signal<ApplicationFigures> = computed(() =>
    deriveApplicationFigures(this.data()),
  );

  readonly eligibility: Signal<readonly ProductEligibility[]> = computed(() =>
    evaluateEligibility(this.currentProducts(), eligibilityContextFromApplication(this.data())),
  );

  /** The one row that answers "may this be submitted at all". */
  readonly eligibilityMatch: Signal<RuleResult> = computed(() =>
    atLeastOneEligibleProduct(this.eligibility()),
  );

  readonly completeness: Signal<readonly RuleResult[]> = computed(() =>
    evaluateApplicationCompleteness(this.data()),
  );

  /** The furthest step reached. A deep link past it is redirected; see ./step.guard.ts. */
  readonly furthestStep: Signal<ApplicationStep> = computed(() => {
    const held = this.value();
    const stored = held?.furthest_step ?? null;
    return stored !== null && isApplicationStep(stored) ? stored : 'borrower';
  });

  readonly isDraft: Signal<boolean> = computed(() => this.value()?.state === 'draft');

  /**
   * The client's PREDICTION of the submit guard, from the same machine
   * definition the server runs. It greys out a button before a round trip; it
   * does not decide. If the two disagree the server is right, because it holds
   * the state (core/workflow/transition.service.ts).
   *
   * `documentPack` is empty and that is correct here: `can` runs only the
   * guard of the transition being asked about, and submit's guard reads
   * completeness and eligibility alone.
   */
  readonly submitGuard: Signal<GuardResult> = computed(() => {
    const held = this.value();
    const role = this.auth.role();
    if (held === null || role === null) {
      return { ok: false, reason: 'the application has not been read yet', blockers: [] };
    }
    return can(applicationMachine, held.state, 'submit', role, {
      completeness: this.completeness(),
      eligibility: [this.eligibilityMatch()],
      documentPack: [],
    });
  });

  readonly canSubmit: Signal<boolean> = computed(() => this.submitGuard().ok);

  constructor() {
    super();

    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.rawValue.set(this.form.getRawValue());
      if (!this.loadingForm) {
        // Synchronous, and before the debounce: this is the copy that survives
        // the tab being killed between two keystrokes.
        this.writeSeatbelt();
      }
    });

    this.form.valueChanges
      .pipe(debounceTime(AUTOSAVE_DELAY_MS), takeUntilDestroyed())
      .subscribe(() => {
        void this.save();
      });

    const flush = (): void => {
      if (this.document.visibilityState === 'hidden') {
        this.writeSeatbelt();
        void this.save();
      }
    };
    this.document.addEventListener('visibilitychange', flush);
    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('visibilitychange', flush);
    });
  }

  /** The requirements this applicant still has to answer on a step. */
  outstanding(step: ApplicationStep): readonly ApplicationRequirement[] {
    return unmetRequirements(step, this.data());
  }

  stepIsAnswered(step: ApplicationStep): boolean {
    return this.outstanding(step).length === 0;
  }

  /**
   * Read an application and put it in the form.
   *
   * Safe to call again with the same id -- the step guard and the shell both
   * do -- because a second read would drop the applicant's unsaved typing on
   * the floor.
   */
  async open(applicationId: string): Promise<void> {
    if (this.currentId() === applicationId && this.value() !== null) {
      return;
    }
    this.currentId.set(applicationId);
    await this.refresh();

    const held = this.value();
    if (held === null) {
      return;
    }
    this.currentProducts.set(await this.readProducts(held.org_id));
  }

  /**
   * Save the payload, if there is anything to save.
   *
   * THE PRISTINE GATE IS THE POINT. Without it, opening an application fires a
   * value change from the load itself and writes an empty form over good server
   * data -- the bug plan/05 singles out as the one that silently eats an
   * applicant's work. A pristine form has nothing the server does not already
   * have, by definition, so there is never a reason to write one.
   */
  async save(): Promise<void> {
    const client = this.client;
    const held = this.value();
    const applicationId = this.currentId();
    if (client === null || held === null || applicationId === null) {
      return;
    }
    if (!this.form.dirty || held.state !== 'draft') {
      return;
    }

    const sent = this.rawValue();
    const data = this.data();
    const outcome = await this.write(() =>
      saveApplicationDraft(client, {
        applicationId,
        expectedRevision: held.revision,
        data,
        furthestStep: held.furthest_step,
      }),
    );
    if (!outcome.ok || outcome.result === null) {
      // A null acknowledgement is a revision that moved under the write. The
      // base class refetches on a thrown conflict; this spelling of it -- zero
      // rows matched -- is not thrown, so ask explicitly.
      if (outcome.ok) {
        await this.refresh();
      }
      return;
    }

    this.settle(sent);
    this.adopt({
      ...held,
      revision: outcome.result.revision,
      updated_at: outcome.result.updated_at,
      data,
    });
    // The server now holds it, so the seatbelt has nothing to protect.
    this.clearSeatbelt();
  }

  /**
   * Record that the applicant has reached a step, so a reload lands there.
   *
   * Written straight through rather than left to the debounce: it is the
   * resume hint, and a resume hint that is 800ms behind the URL is a resume
   * hint that is wrong exactly when the page goes away.
   */
  async noteStepReached(step: ApplicationStep): Promise<void> {
    const client = this.client;
    const held = this.value();
    const applicationId = this.currentId();
    if (client === null || held === null || applicationId === null || held.state !== 'draft') {
      return;
    }
    const current = this.furthestStep();
    if (applicationStepIndex(step) <= applicationStepIndex(current)) {
      return;
    }

    const sent = this.rawValue();
    const data = this.data();
    const outcome = await this.write(() =>
      saveApplicationDraft(client, {
        applicationId,
        expectedRevision: held.revision,
        data,
        furthestStep: step,
      }),
    );
    if (!outcome.ok || outcome.result === null) {
      return;
    }
    this.settle(sent);
    this.adopt({
      ...held,
      revision: outcome.result.revision,
      updated_at: outcome.result.updated_at,
      data,
      furthest_step: step,
    });
    this.clearSeatbelt();
  }

  /**
   * Submit, through the one place a transition is fired.
   *
   * The pending payload is flushed first, so the server adjudicates what is on
   * the screen rather than what was there 800ms ago -- and the revision is
   * re-read afterwards, because the flush moved it.
   */
  async submit(): Promise<WriteOutcome<TransitionAck>> {
    await this.save();
    const held = this.value();
    const applicationId = this.currentId();
    if (held === null || applicationId === null) {
      return {
        ok: false,
        failure: { message: NO_DATABASE, code: null },
        conflicted: false,
      };
    }

    this.refusal.set([]);
    const outcome = await this.write(async () => {
      try {
        return await this.transitions.fire({
          machine: 'application',
          subjectId: applicationId,
          event: 'submit',
          expectedRevision: held.revision,
        });
      } catch (reason) {
        if (isApiFailure(reason)) {
          this.refusal.set(reason.blockers);
        }
        throw reason;
      }
    });
    if (outcome.ok) {
      this.clearSeatbelt();
      await this.refresh();
    }
    return outcome;
  }

  /** Discard a recovered copy and go back to what the server holds. */
  discardRecoveredDraft(): void {
    const held = this.value();
    this.recovered.set(null);
    this.clearSeatbelt();
    if (held !== null) {
      this.loadFormFrom(held);
    }
  }

  protected override revisionOf(value: ApplicationBorrowerView): number {
    return value.revision;
  }

  /**
   * Re-read, and put the server's copy in the form only if the applicant is
   * not mid-sentence.
   *
   * The hook is here rather than on `adopt` because the base class's
   * `refresh()` sets its value signal directly: `adopt` is the path a
   * CONFIRMED WRITE takes, and reloading the form from a payload this store
   * has just sent would throw away anything typed during the round trip.
   *
   * A dirty form keeps what it has. A refetch happens on every conflict and
   * after every submit, and reloading under someone who is typing would delete
   * the words they are in the middle of; the seatbelt is what protects them.
   */
  override async refresh(): Promise<void> {
    await super.refresh();
    const held = this.value();
    if (held !== null && this.form.pristine) {
      this.loadFormFrom(held);
    }
  }

  protected async load(): Promise<ApplicationBorrowerView> {
    const client = this.client;
    const applicationId = this.currentId();
    if (client === null) {
      throw new Error(NO_DATABASE);
    }
    if (applicationId === null) {
      throw new Error('No application has been opened.');
    }
    const row = await getBorrowerApplication(client, applicationId);
    if (row === null) {
      throw new Error('That application does not exist, or is not yours to read.');
    }
    // Parsed even though it came from our own database: the generated view
    // types make every column nullable, because Postgres reports no not-null
    // constraint through a view, and a `state` the machine does not know must
    // not reach `can()` as a string that happens to typecheck.
    return ApplicationBorrowerViewSchema.parse(row);
  }

  private loadFormFrom(row: ApplicationBorrowerView): void {
    this.loadingForm = true;
    try {
      this.putInForm(row);
    } finally {
      this.loadingForm = false;
    }
  }

  private putInForm(row: ApplicationBorrowerView): void {
    const server = parseApplicationData(row.data);
    if (!server.ok) {
      // A payload that does not parse is a corrupt row, not an unfinished
      // form. Leaving the form empty would tell the applicant they had
      // answered nothing, which is a lie about their own data.
      this.form.reset();
      this.form.markAsPristine();
      return;
    }

    const snapshot = readDraftSnapshot(this.storage, row.id);
    const reconciled = reconcileDraft(snapshot, { revision: row.revision, data: server.data });

    if (reconciled.source === 'local') {
      loadApplicationForm(this.form, reconciled.snapshot.data);
      // Dirty on purpose: these are edits the server has never seen, so the
      // next autosave must send them.
      this.form.markAsDirty();
      this.recovered.set(reconciled.snapshot);
      return;
    }

    loadApplicationForm(this.form, server.data);
    this.recovered.set(null);
  }

  private async readProducts(orgId: string): Promise<readonly EligibilityProduct[]> {
    const client = this.client;
    if (client === null) {
      return [];
    }
    try {
      return eligibilityProducts(await listActiveLoanProducts(client, orgId));
    } catch {
      // An eligibility panel with no products says "nothing to check yet",
      // which is honest, and it must not stop the form being filled in.
      return [];
    }
  }

  /**
   * Mark the form clean, but only if it still holds what was sent.
   *
   * Anything typed during the round trip produced a new raw value, and calling
   * it saved would leave those keystrokes on the floor: the next autosave
   * would see a pristine form and skip. Reference equality is enough -- the
   * raw value is replaced wholesale on every change, never mutated.
   */
  private settle(sent: RawApplicationValue): void {
    if (this.rawValue() === sent) {
      this.form.markAsPristine();
    }
  }

  private writeSeatbelt(): void {
    const applicationId = this.currentId();
    const held = this.value();
    if (applicationId === null || held === null || !this.form.dirty) {
      return;
    }
    writeDraftSnapshot(this.storage, {
      applicationId,
      revision: held.revision,
      data: this.data(),
      furthestStep: this.furthestStep(),
      savedAt: new Date().toISOString(),
    });
  }

  private clearSeatbelt(): void {
    const applicationId = this.currentId();
    if (applicationId !== null) {
      clearDraftSnapshot(this.storage, applicationId);
    }
  }
}
