import { Injectable, InjectionToken, computed, inject, signal, type Signal } from '@angular/core';
import {
  ApplicationBorrowerViewSchema,
  ApplicationLenderViewSchema,
  DocumentSlotSchema,
  DocumentUploadSchema,
  EMPTY_APPLICATION_DATA,
  parseApplicationData,
  type DocumentSlot,
  type RuleResult,
} from '@lj/domain';
import {
  getApplicationForAudience,
  listDocumentSlots,
  listDocumentUploadsForApplication,
} from '@lj/db';
import {
  documentPackProgress,
  documentSlotRuleId,
  evaluateCompleteness,
  evaluateConsistency,
  type DocumentPackProgress,
  type DocumentSlotView,
} from '@lj/rules';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { AggregateStore, type WriteOutcome } from '../../core/store/aggregate-store.ts';
import { TransitionService, type TransitionAck } from '../../core/workflow/transition.service.ts';
import { DOCUMENT_INTAKE, fileRefusal } from './intake.ts';
import {
  applicationFactsOf,
  applySlotAck,
  nextActionFor,
  slotViewsOf,
  type DocumentPackValue,
  type SlotAction,
} from './pack.ts';

/**
 * One application's document pack: what was asked for, what arrived, and
 * where that leaves the borrower.
 *
 * Provided at the route rather than at the root (plan/07), so it dies when the
 * visitor leaves this application and nothing of one pack bleeds into the
 * next. Both screens -- the borrower's checklist and the lender's review --
 * inject the same class, because they are two audiences reading one aggregate
 * and a second store would be a second answer to "is this pack complete".
 *
 * **It decides nothing.** Every signal below `value` is a `computed()` over
 * rules in @lj/rules: `evaluateCompleteness` says what is complete,
 * `documentPackProgress` says how far along the pack is, and
 * `evaluateConsistency` says which figures disagree. This class assembles
 * their context and renders their answers. A threshold, a count of slots or a
 * definition of "accepted" appearing here would be a second copy of a policy
 * (CLAUDE.md sections 8 and 9).
 *
 * WHY `revisionOf` IS LEFT AT NULL. A pack has no single revision; it has one
 * per slot, because `document_slot` is the machine's subject and
 * POST /api/transition matches on that. The base class's monotonicity rule is
 * therefore applied per slot, in `applySlotAck` (./pack.ts), which is also
 * where it can be tested.
 */

/** What a store that cannot reach the database reports. */
export const NO_DATABASE: string =
  'This deployment cannot reach the database, so the document pack cannot be opened.';

export const UNKNOWN_SLOT: string = 'That document is not part of this application.';

/**
 * A correction needs something to correct. Reached when a slot has no upload
 * yet, which is a screen offering a panel it should not have -- so it says what
 * is missing rather than failing at the API with a foreign key.
 */
export const NOTHING_TO_CORRECT: string =
  'There is nothing to correct on that document yet -- upload it first.';

/**
 * Today, as an ISO calendar date, injected.
 *
 * `isExpired` compares calendar dates as strings and @lj/rules takes the clock
 * in its context for exactly this reason: a rule that called `Date.now()`
 * could not be tested and could not be replayed against the date a decision
 * was actually made. The date is taken in UTC, which is the same convention
 * `valid_until` is stored under.
 */
export const DOCUMENT_TODAY = new InjectionToken<() => string>('lj.document-today', {
  providedIn: 'root',
  factory: () => (): string => new Date().toISOString().slice(0, 10),
});

/** One line of the checklist: the slot, the verdict, and the control beside it. */
export interface DocumentSlotRow {
  readonly slot: DocumentSlot;
  readonly view: DocumentSlotView;
  /** From `evaluateCompleteness`. Never composed here. */
  readonly result: RuleResult;
  readonly action: SlotAction;
}

@Injectable()
export class DocumentPackStore extends AggregateStore<DocumentPackValue> {
  private readonly client = inject(DATABASE_CLIENT);
  private readonly auth = inject(SupabaseAuthService);
  private readonly transitions = inject(TransitionService);
  private readonly intake = inject(DOCUMENT_INTAKE);
  private readonly today = inject(DOCUMENT_TODAY);

  private readonly currentId = signal<string | null>(null);
  private readonly refused = signal<string | null>(null);

  readonly applicationId: Signal<string | null> = this.currentId.asReadonly();

  /**
   * Why the browser would not send a file, or null.
   *
   * Kept apart from `failure()` on purpose: that surface is for a request that
   * was made and did not work, and this is for one that was never made. The
   * two read differently to the person in front of them.
   */
  readonly refusal: Signal<string | null> = this.refused.asReadonly();

  readonly slotViews: Signal<readonly DocumentSlotView[]> = computed(() => {
    const held = this.value();
    return held === null ? [] : slotViewsOf(held);
  });

  /** The checklist's verdicts, from @lj/rules. */
  readonly completeness: Signal<readonly RuleResult[]> = computed(() =>
    evaluateCompleteness({ today: this.today(), slots: this.slotViews() }),
  );

  /**
   * The bar.
   *
   * plan/04's first honesty rule: it counts accepted-and-valid, never
   * uploaded, so a document that uploads and then fails never moved it. That
   * is guaranteed by taking the figure from `documentPackProgress` over the
   * SAME results the rows render, rather than by counting slots here -- the
   * bar and the list cannot disagree, because they are one computation.
   */
  readonly progress: Signal<DocumentPackProgress> = computed(() =>
    documentPackProgress(this.completeness()),
  );

  /**
   * The cross-checks. Each result carries both figures and the tolerance in
   * its `inputs` and its delta, and `<lj-rule-list>` already renders those, so
   * there is no second renderer and no second statement of a tolerance.
   */
  readonly crossChecks: Signal<readonly RuleResult[]> = computed(() => {
    const held = this.value();
    if (held === null) {
      return [];
    }
    return evaluateConsistency({
      slots: this.slotViews(),
      application: applicationFactsOf(held.data),
    });
  });

  /**
   * The checklist, row by row.
   *
   * The verdict is looked up by the rule id @lj/rules publishes for a slot
   * code, rather than by position: the two lists are built from the same
   * array today, and a positional join is the kind of coupling that breaks
   * silently the day one of them is filtered.
   */
  readonly rows: Signal<readonly DocumentSlotRow[]> = computed(() => {
    const held = this.value();
    if (held === null) {
      return [];
    }
    const results = new Map(this.completeness().map((result) => [result.id, result]));
    const views = this.slotViews();
    const today = this.today();

    const rows: DocumentSlotRow[] = [];
    held.slots.forEach((slot, index) => {
      const view = views[index];
      const result = results.get(documentSlotRuleId(slot.code));
      if (view === undefined || result === undefined) {
        return;
      }
      rows.push({ slot, view, result, action: nextActionFor(view, today) });
    });
    return rows;
  });

  /** True once every required slot is accepted, valid and readable. */
  readonly isComplete: Signal<boolean> = computed(() => {
    const { accepted, total } = this.progress();
    return total > 0 && accepted === total;
  });

  /**
   * Read a pack. Safe to call again with the same id -- both screens do -- and
   * it re-reads rather than short-circuiting, because a lender arriving after
   * a borrower uploaded needs what is there now.
   */
  async open(applicationId: string): Promise<void> {
    this.currentId.set(applicationId);
    this.refused.set(null);
    await this.refresh();
  }

  /** The lender accepts one document. Lender-only on the machine; the server re-checks. */
  accept(slotId: string): Promise<WriteOutcome<TransitionAck>> {
    return this.fireSlot(slotId, 'accept');
  }

  /** The lender refuses one document. The borrower's row then asks for a replacement. */
  reject(slotId: string): Promise<WriteOutcome<TransitionAck>> {
    return this.fireSlot(slotId, 'reject');
  }

  /**
   * Send a file for one slot.
   *
   * The browser's checks happen first and never reach the seam, so a file that
   * cannot be accepted costs nothing to discover. Everything after that is the
   * API's, including the storage path -- see ./intake.ts.
   */
  async upload(slotId: string, file: File): Promise<void> {
    this.refused.set(null);
    const held = this.value();
    const slot = held?.slots.find((candidate) => candidate.id === slotId);
    if (held === null || held === undefined || slot === undefined) {
      this.refused.set(UNKNOWN_SLOT);
      return;
    }

    const refusal = fileRefusal(file);
    if (refusal !== null) {
      this.refused.set(refusal);
      return;
    }

    const outcome = await this.write(() =>
      this.intake.upload({
        applicationId: held.applicationId,
        slotId: slot.id,
        slotCode: slot.code,
        file,
      }),
    );
    if (outcome.ok) {
      // The server extracted, moved the slot and wrote the row. Ask it what it
      // holds rather than predicting any of that here.
      await this.refresh();
    }
  }

  /**
   * Type a value in that the extractor could not read.
   *
   * plan/04: extraction proposes, a human confirms, and confidence drops out
   * of the completeness rule once a field is human-verified. That only holds
   * if the correction is RECORDED -- so it goes through the seam and the pack
   * is re-read, rather than being patched locally into a `source: 'human'`
   * the server has never heard of.
   */
  async correct(slotId: string, field: string, value: string): Promise<void> {
    this.refused.set(null);
    const held = this.value();
    const slot = held?.slots.find((candidate) => candidate.id === slotId);
    if (held === null || held === undefined || slot === undefined) {
      this.refused.set(UNKNOWN_SLOT);
      return;
    }

    // The newest upload on this slot, which is the one the panel was showing.
    // The API refuses a correction against any other, because appending to the
    // head of an append-only list is only safe if the head is the one that was
    // read -- somebody replacing the document while this panel was open is
    // precisely the case that catches.
    const latest = held.uploads.find((upload) => upload.slot_id === slot.id);
    if (latest === undefined) {
      this.refused.set(NOTHING_TO_CORRECT);
      return;
    }

    const outcome = await this.write(() =>
      this.intake.correct({
        applicationId: held.applicationId,
        slotId: slot.id,
        uploadId: latest.id,
        field,
        value,
      }),
    );
    if (outcome.ok) {
      await this.refresh();
    }
  }

  protected async load(): Promise<DocumentPackValue> {
    const client = this.client;
    const applicationId = this.currentId();
    if (client === null) {
      throw new Error(NO_DATABASE);
    }
    if (applicationId === null) {
      throw new Error('No application has been opened.');
    }

    // The projection follows the reader's audience: a lender reading the
    // borrower's view is filtered out by row-level security and would see an
    // application that does not exist.
    const audience = this.auth.audience();
    const [row, slotRows, uploadRows] = await Promise.all([
      getApplicationForAudience(client, audience, applicationId),
      listDocumentSlots(client, applicationId),
      listDocumentUploadsForApplication(client, applicationId),
    ]);
    if (row === null) {
      throw new Error('That application does not exist, or is not yours to read.');
    }

    // Parsed even though it came from our own database: a view reports no
    // not-null constraint, so every generated column type is nullable, and a
    // `state` the machine does not know must not reach the rules as a string
    // that happens to typecheck.
    const application =
      audience === 'lender'
        ? ApplicationLenderViewSchema.parse(row)
        : ApplicationBorrowerViewSchema.parse(row);
    const data = parseApplicationData(application.data);

    return {
      applicationId: application.id,
      applicationState: application.state,
      applicationRevision: application.revision,
      // A payload that does not parse leaves the cross-checks with nothing to
      // compare against, which they report as "waiting on" rather than as
      // agreement. Refusing to open the pack over it would be worse: the
      // checklist itself does not depend on the form at all.
      data: data.ok ? data.data : EMPTY_APPLICATION_DATA,
      slots: slotRows.map((slot) => DocumentSlotSchema.parse(slot)),
      uploads: uploadRows.map((upload) => DocumentUploadSchema.parse(upload)),
    };
  }

  /**
   * Fire one slot transition, through the one place transitions are fired.
   *
   * `expectedRevision` is the revision of the slot AS READ, which is what
   * makes two lenders accepting one document serialise rather than race: the
   * second one gets a 409 and `AggregateStore.write()` refetches.
   */
  private async fireSlot(
    slotId: string,
    event: 'accept' | 'reject',
  ): Promise<WriteOutcome<TransitionAck>> {
    this.refused.set(null);
    const held = this.value();
    const slot = held?.slots.find((candidate) => candidate.id === slotId);
    if (held === null || held === undefined || slot === undefined) {
      return { ok: false, failure: { message: UNKNOWN_SLOT, code: null }, conflicted: false };
    }

    const outcome = await this.write(() =>
      this.transitions.fire({
        machine: 'document_slot',
        subjectId: slot.id,
        event,
        expectedRevision: slot.revision,
      }),
    );
    if (!outcome.ok) {
      return outcome;
    }

    // Re-read the held value: a conflict inside `write` would have refetched
    // it, and patching the copy taken before the call would undo that.
    const current = this.value();
    if (current !== null) {
      this.adopt(
        applySlotAck(current, {
          subjectId: outcome.result.subjectId,
          to: outcome.result.to,
          revision: outcome.result.revision,
        }),
      );
    }
    return outcome;
  }
}
