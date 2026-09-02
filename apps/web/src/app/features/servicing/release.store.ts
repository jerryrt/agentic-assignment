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
import { FormControl, FormGroup } from '@angular/forms';
import { debounceTime } from 'rxjs';
import {
  CreditReleaseBorrowerViewSchema,
  WorkflowEventSchema,
  moneyToNumericString,
  type CreditRelease,
  type Money,
  type RuleResult,
  type WorkflowEvent,
} from '@lj/domain';
import {
  deleteCreditReleaseDraft,
  getCreditReleaseForBorrower,
  insertCreditRelease,
  listWorkflowEvents,
  updateCreditRelease,
} from '@lj/db';
import { evaluateCreditRelease } from '@lj/rules';
import { can, creditReleaseMachine, type GuardResult } from '@lj/workflow';

import { isApiFailure } from '../../core/api/api-client.ts';
import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { RealtimeChannelFactory } from '../../core/realtime/channel-factory.ts';
import { AggregateStore, type WriteOutcome } from '../../core/store/aggregate-store.ts';
import { TransitionService, type TransitionAck } from '../../core/workflow/transition.service.ts';
import { creditReleaseContextFor } from './balance.ts';
import {
  amountToMoney,
  clearComposeSnapshot,
  readComposeSnapshot,
  reconcileCompose,
  storableCompose,
  writeComposeSnapshot,
} from './compose-draft.ts';
import { LoanStore } from './loan.store.ts';

/**
 * One credit release: composing it, watching it, and moving it.
 *
 * Provided at `/loans/:id/release/:rid`, under the route that provides
 * `LoanStore`, so the balance this screen checks a request against is the same
 * instance the loan screen showed. Two stores reading the same figures would be
 * two answers to "what is available", which is the failure Option 3 exists to
 * avoid.
 *
 * ## Surviving a refresh mid-compose
 *
 * The row is created as soon as what has been typed CAN BE STORED, and from
 * that moment the URL names it and a reload re-reads it -- there is nothing
 * client-side left to lose. Before that moment the browser's own copy carries
 * it (./compose-draft.ts).
 *
 * "As soon as it can be stored" rather than "on the first keystroke", and the
 * schema is the reason: `credit_release.amount` carries `check (amount > 0)`
 * and `purpose` is `not null` and refused empty by `CreditReleaseSchema`. There
 * is no storable row to create from one character, and inventing an amount to
 * satisfy the check would be fabricating the borrower's request -- which is a
 * worse thing to have in a lending record than a URL that changes a keystroke
 * later. The refresh guarantee is unaffected: whatever has been typed is in the
 * seatbelt from the first keystroke, keyed to the loan until the row exists.
 *
 * ## The order of the two writes
 *
 * The seatbelt is written synchronously on every change; the server save is
 * debounced. That is deliberate -- the seatbelt is the copy that survives the
 * tab being killed between two keystrokes, and a debounced seatbelt would have
 * exactly the gap it exists to close.
 *
 * ## It decides nothing
 *
 * `rules` is @lj/rules' evaluation over a context this store assembles, and
 * `submitGuard` is @lj/workflow's `can` over those results -- the same machine
 * the server runs. Both are predictions that grey out a button; the decision is
 * `POST /api/transition`, and when the two disagree the server is right. What
 * it refused with is kept separately in `serverRefusal`, because
 * `AggregateStore` flattens a failure to a message and those blockers are worth
 * putting on the screen.
 */

/** How long the borrower has to stop typing before the payload is written. */
export const COMPOSE_DELAY_MS = 800;

/**
 * Where the seatbelt is kept, as a token so a test can supply its own and so a
 * browser that refuses storage does not take the screen down. Reading
 * `localStorage` throws outright in some privacy configurations, which is a
 * different failure from it being absent.
 */
export const RELEASE_STORAGE = new InjectionToken<Storage | null>('lj.release-storage', {
  providedIn: 'root',
  factory: () => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  },
});

export const NO_DATABASE: string =
  'This deployment cannot reach the database, so a request cannot be opened.';

export const NO_SUCH_RELEASE: string =
  'That request does not exist, or is not yours to read.';

export interface ReleaseFileValue {
  /** Null while a request is being composed and has no row yet. */
  readonly release: CreditRelease | null;
  /** The audit trail, oldest first, as `@lj/db` orders it. */
  readonly events: readonly WorkflowEvent[];
}

interface ComposeValue {
  readonly amount: string;
  readonly purpose: string;
}

@Injectable()
export class ReleaseStore extends AggregateStore<ReleaseFileValue> {
  private readonly client = inject(DATABASE_CLIENT);
  private readonly auth = inject(SupabaseAuthService);
  private readonly transitions = inject(TransitionService);
  private readonly realtime = inject(RealtimeChannelFactory);
  private readonly storage = inject(RELEASE_STORAGE);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly loans = inject(LoanStore);

  /** The working copy. Both controls hold strings; see ./compose-draft.ts. */
  readonly form = new FormGroup({
    amount: new FormControl('', { nonNullable: true }),
    purpose: new FormControl('', { nonNullable: true }),
  });

  private readonly currentLoanId = signal<string | null>(null);
  private readonly currentReleaseId = signal<string | null>(null);
  private readonly rawValue = signal<ComposeValue>(this.form.getRawValue());
  private readonly recoveredCopy = signal<{ amountText: string; savedAt: string } | null>(null);
  private readonly refusal = signal<readonly RuleResult[]>([]);

  /** True while a payload is being put into the form. See the apply feature's
   *  store for the failure this prevents: a load emits value changes, and a
   *  seatbelt written from one records a half-loaded form as unsaved work. */
  private loadingForm = false;
  private creating: Promise<void> | null = null;
  private watching: string | null = null;

  readonly loanId: Signal<string | null> = this.currentLoanId.asReadonly();
  readonly releaseId: Signal<string | null> = this.currentReleaseId.asReadonly();

  /** Non-null when the browser held edits the server never received. */
  readonly recovered = this.recoveredCopy.asReadonly();

  /** What the SERVER refused with, which is not always what the client predicted. */
  readonly serverRefusal: Signal<readonly RuleResult[]> = this.refusal.asReadonly();

  readonly release: Signal<CreditRelease | null> = computed(
    () => this.value()?.release ?? null,
  );

  readonly events: Signal<readonly WorkflowEvent[]> = computed(() => this.value()?.events ?? []);

  /** What is in the amount box, as an amount, or null while it is unreadable. */
  readonly requestedAmount: Signal<Money | null> = computed(() =>
    amountToMoney(this.rawValue().amount),
  );

  /** True once the request has left the borrower's hands. */
  readonly isDraft: Signal<boolean> = computed(() => {
    const held = this.release();
    return held === null || held.state === 'draft';
  });

  /**
   * Where the request stands against the rules -- the same evaluation the
   * server's guard reads, over the balance the loan screen displayed.
   */
  readonly rules: Signal<readonly RuleResult[]> = computed(() => {
    const facts = this.loans.facts();
    if (facts === null) {
      return [];
    }
    return evaluateCreditRelease(
      creditReleaseContextFor(facts, {
        requestedAmount: this.requestedAmount(),
        excludeReleaseId: this.currentReleaseId(),
      }),
    );
  });

  /**
   * The client's PREDICTION of the submit guard, from the machine definition
   * the server also runs. It greys out a button; it does not decide.
   */
  readonly submitGuard: Signal<GuardResult> = computed(() => {
    const held = this.release();
    const role = this.auth.role();
    if (held === null || role === null) {
      return { ok: false, reason: 'the request has not been created yet', blockers: [] };
    }
    return can(creditReleaseMachine, held.state, 'submit', role, {
      availableCredit: this.rules(),
    });
  });

  readonly canSubmit: Signal<boolean> = computed(() => this.submitGuard().ok);

  constructor() {
    super();

    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.rawValue.set(this.form.getRawValue());
      if (this.loadingForm) {
        return;
      }
      // Synchronous, and before the debounce: this is the copy that survives
      // the tab being killed between two keystrokes.
      this.writeSeatbelt();
      void this.ensureDraft();
    });

    this.form.valueChanges
      .pipe(debounceTime(COMPOSE_DELAY_MS), takeUntilDestroyed())
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

  /** Start a request that has no row yet. */
  async compose(loanId: string): Promise<void> {
    this.currentLoanId.set(loanId);
    this.currentReleaseId.set(null);
    this.refusal.set([]);
    await this.refresh();
    this.recoverUnsent(loanId);
  }

  /** Open a request that exists. Safe to call again with the same id. */
  async open(loanId: string, releaseId: string): Promise<void> {
    this.currentLoanId.set(loanId);
    this.currentReleaseId.set(releaseId);
    this.refusal.set([]);
    this.watch(releaseId);
    await this.refresh();
  }

  /**
   * Save the payload, if there is anything to save.
   *
   * THE PRISTINE GATE. Without it, opening a draft fires a value change from
   * the load itself and writes the form back over the row before the borrower
   * has typed a character. A pristine form holds nothing the server does not
   * already have, by definition.
   */
  async save(): Promise<void> {
    const client = this.client;
    const releaseId = this.currentReleaseId();
    const held = this.value()?.release ?? null;
    if (client === null || releaseId === null || held === null) {
      return;
    }
    if (!this.form.dirty || held.state !== 'draft') {
      return;
    }
    const sent = this.rawValue();
    const storable = storableCompose(sent.amount, sent.purpose);
    if (storable === null) {
      // Nothing writable in the box yet. The seatbelt is holding it, and a
      // patch that failed the check constraint would surface as an error the
      // borrower cannot act on mid-sentence.
      return;
    }

    const outcome = await this.write(() =>
      updateCreditRelease(client, {
        releaseId,
        expectedRevision: held.revision,
        patch: {
          amount: moneyToNumericString(storable.amount),
          purpose: storable.purpose,
        },
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
      release: {
        ...held,
        revision: outcome.result.revision,
        amount: storable.amount,
        purpose: storable.purpose,
      },
      events: this.events(),
    });
    // The server now holds it, so the seatbelt has nothing to protect.
    this.clearSeatbelt();
  }

  /**
   * Submit, through the one place a transition is fired.
   *
   * The pending payload is flushed first, so the server adjudicates what is on
   * the screen rather than what was there 800ms ago, and the revision is read
   * again afterwards because the flush moved it.
   */
  async submit(): Promise<WriteOutcome<TransitionAck>> {
    await this.save();
    const held = this.value()?.release ?? null;
    if (held === null) {
      return {
        ok: false,
        failure: { message: NO_SUCH_RELEASE, code: null },
        conflicted: false,
      };
    }

    this.refusal.set([]);
    const outcome = await this.write(async () => {
      try {
        return await this.transitions.fire({
          machine: 'credit_release',
          subjectId: held.id,
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
      // The request now holds credit, so the borrower's available figure has
      // moved. Ask the loan for it rather than adjusting a copy here.
      await this.loans.refresh();
    }
    return outcome;
  }

  /** Withdraw a request that is still with the lender. */
  async cancel(): Promise<WriteOutcome<TransitionAck>> {
    const held = this.value()?.release ?? null;
    if (held === null) {
      return {
        ok: false,
        failure: { message: NO_SUCH_RELEASE, code: null },
        conflicted: false,
      };
    }
    const outcome = await this.write(() =>
      this.transitions.fire({
        machine: 'credit_release',
        subjectId: held.id,
        event: 'cancel',
        expectedRevision: held.revision,
      }),
    );
    if (outcome.ok) {
      await this.refresh();
      await this.loans.refresh();
    }
    return outcome;
  }

  /**
   * Abandon a draft.
   *
   * A draft is deleted rather than cancelled, which is why the machine has no
   * transition out of `draft` other than `submit`: a record nobody but its
   * author ever saw is noise in a timeline.
   */
  async discard(): Promise<boolean> {
    const client = this.client;
    const releaseId = this.currentReleaseId();
    if (client === null || releaseId === null) {
      return false;
    }
    const outcome = await this.write(() => deleteCreditReleaseDraft(client, releaseId));
    if (!outcome.ok || !outcome.result) {
      return false;
    }
    this.clearSeatbelt();
    this.currentReleaseId.set(null);
    await this.loans.refresh();
    return true;
  }

  /** Discard a recovered copy and go back to what the server holds. */
  discardRecovered(): void {
    const held = this.value()?.release ?? null;
    this.recoveredCopy.set(null);
    this.clearSeatbelt();
    if (held !== null) {
      this.loadFormFrom(held);
    }
  }

  protected override revisionOf(value: ReleaseFileValue): number | null {
    return value.release?.revision ?? null;
  }

  /**
   * Re-read, and put the server's copy in the form only if the borrower is not
   * mid-sentence.
   *
   * A dirty form keeps what it has: a refetch happens on every conflict and
   * after every submit, and reloading under someone who is typing would delete
   * the words they are in the middle of. The seatbelt is what protects them.
   */
  override async refresh(): Promise<void> {
    await super.refresh();
    const held = this.value()?.release ?? null;
    if (held !== null && this.form.pristine) {
      this.loadFormFrom(held);
    }
  }

  protected async load(): Promise<ReleaseFileValue> {
    const releaseId = this.currentReleaseId();
    if (releaseId === null) {
      // Composing: there is nothing to read yet, and reporting that as an error
      // would put a failure on a screen that is working exactly as intended.
      return { release: null, events: [] };
    }
    const client = this.client;
    if (client === null) {
      throw new Error(NO_DATABASE);
    }

    const [row, events] = await Promise.all([
      getCreditReleaseForBorrower(client, releaseId),
      listWorkflowEvents(client, 'credit_release', releaseId),
    ]);
    if (row === null) {
      throw new Error(NO_SUCH_RELEASE);
    }
    // Parsed even though it came from our own database: a view reports no
    // not-null constraint, so every generated column type is nullable, and a
    // state no machine knows must not reach `can()` as a string that happens to
    // typecheck.
    return {
      release: CreditReleaseBorrowerViewSchema.parse(row),
      events: events.map((event) => WorkflowEventSchema.parse(event)),
    };
  }

  /**
   * Create the row, once, as soon as the typing can be stored.
   *
   * The in-flight promise is kept rather than a boolean: two keystrokes a
   * millisecond apart would otherwise both find "not creating" true and insert
   * two drafts, and the second is a request the borrower never made.
   */
  private async ensureDraft(): Promise<void> {
    const client = this.client;
    const loanId = this.currentLoanId();
    const borrowerId = this.auth.identity()?.userId ?? null;
    if (client === null || loanId === null || borrowerId === null) {
      return;
    }
    if (this.currentReleaseId() !== null || this.creating !== null) {
      return;
    }
    const sent = this.rawValue();
    const storable = storableCompose(sent.amount, sent.purpose);
    if (storable === null) {
      return;
    }

    this.creating = this.createDraft(client, loanId, borrowerId, storable);
    try {
      await this.creating;
    } finally {
      this.creating = null;
    }
  }

  private async createDraft(
    client: NonNullable<typeof this.client>,
    loanId: string,
    borrowerId: string,
    storable: { readonly amount: Money; readonly purpose: string },
  ): Promise<void> {
    const outcome = await this.write(() =>
      insertCreditRelease(client, {
        loan_id: loanId,
        // Text, not a float. PostgREST accepts the exact decimal and Postgres
        // parses it unrounded; the generated Insert type asking for a number is
        // the thing that is wrong (packages/db/src/queries/credit-releases.ts).
        amount: moneyToNumericString(storable.amount),
        purpose: storable.purpose,
        requested_by: borrowerId,
      }),
    );
    if (!outcome.ok || outcome.result === null) {
      return;
    }

    const releaseId = outcome.result.id;
    // The unsent copy belongs to the row now. Moved rather than left behind, so
    // that a later compose on this loan does not open with someone else's
    // sentence in the box.
    clearComposeSnapshot(this.storage, loanId, null);
    this.currentReleaseId.set(releaseId);
    this.writeSeatbelt();
    this.watch(releaseId);
    await this.refresh();
  }

  private watch(releaseId: string): void {
    if (this.watching === releaseId) {
      return;
    }
    this.watching = releaseId;
    // The DestroyRef is passed explicitly: this is called from a method, so
    // there is no injection context to resolve one from.
    this.realtime.watch(
      { table: 'credit_release', filter: 'id=eq.' + releaseId },
      () => this.refresh(),
      this.destroyRef,
    );
  }

  private recoverUnsent(loanId: string): void {
    const snapshot = readComposeSnapshot(this.storage, loanId, null);
    if (snapshot === null) {
      return;
    }
    this.loadingForm = true;
    try {
      this.form.setValue({ amount: snapshot.amountText, purpose: snapshot.purpose });
    } finally {
      this.loadingForm = false;
    }
    // Dirty on purpose: the server has never seen these edits, so the next
    // save must send them.
    this.form.markAsDirty();
    this.recoveredCopy.set({ amountText: snapshot.amountText, savedAt: snapshot.savedAt });
  }

  private loadFormFrom(release: CreditRelease): void {
    const loanId = this.currentLoanId();
    const server = {
      revision: release.revision,
      amountText: moneyToNumericString(release.amount),
      purpose: release.purpose,
    };
    const snapshot =
      loanId === null ? null : readComposeSnapshot(this.storage, loanId, release.id);
    const reconciled = reconcileCompose(snapshot, server);

    this.loadingForm = true;
    try {
      const shown =
        reconciled.source === 'local'
          ? { amount: reconciled.snapshot.amountText, purpose: reconciled.snapshot.purpose }
          : { amount: server.amountText, purpose: server.purpose };
      this.form.setValue(shown);
    } finally {
      this.loadingForm = false;
    }

    if (reconciled.source === 'local') {
      this.form.markAsDirty();
      this.recoveredCopy.set({
        amountText: reconciled.snapshot.amountText,
        savedAt: reconciled.snapshot.savedAt,
      });
      return;
    }
    this.form.markAsPristine();
    this.recoveredCopy.set(null);
  }

  /**
   * Mark the form clean, but only if it still holds what was sent.
   *
   * Anything typed during the round trip produced a new raw value, and calling
   * it saved would leave those keystrokes on the floor. Reference equality is
   * enough -- the raw value is replaced wholesale on every change.
   */
  private settle(sent: ComposeValue): void {
    if (this.rawValue() === sent) {
      this.form.markAsPristine();
    }
  }

  private writeSeatbelt(): void {
    const loanId = this.currentLoanId();
    if (loanId === null) {
      return;
    }
    const sent = this.rawValue();
    writeComposeSnapshot(this.storage, {
      loanId,
      releaseId: this.currentReleaseId(),
      revision: this.value()?.release?.revision ?? 0,
      amountText: sent.amount,
      purpose: sent.purpose,
      savedAt: new Date().toISOString(),
    });
  }

  private clearSeatbelt(): void {
    const loanId = this.currentLoanId();
    if (loanId === null) {
      return;
    }
    clearComposeSnapshot(this.storage, loanId, this.currentReleaseId());
    clearComposeSnapshot(this.storage, loanId, null);
    this.recoveredCopy.set(null);
  }
}
