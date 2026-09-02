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
  CreditReleaseLenderViewSchema,
  CreditReleaseNoteSchema,
  LoanBalanceSchema,
  LoanSchema,
  WorkflowEventSchema,
  type CreditReleaseLenderView,
  type Loan,
  type LoanBalance,
  type WorkflowEvent,
} from '@lj/domain';
import {
  getCreditReleaseForLender,
  getCreditReleaseNote,
  getLoan,
  getLoanBalance,
  listWorkflowEvents,
  upsertCreditReleaseNote,
} from '@lj/db';
import type { CreditReleaseEvent } from '@lj/workflow';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { RealtimeChannelFactory } from '../../core/realtime/channel-factory.ts';
import { AggregateStore, type WriteOutcome } from '../../core/store/aggregate-store.ts';
import {
  TransitionService,
  type TransitionAck,
  type TransitionRequest,
} from '../../core/workflow/transition.service.ts';
import { lenderFigures, type LenderFigures } from '../servicing/balance.ts';
import {
  clearDecisionSnapshot,
  readDecisionSnapshot,
  reconcileDecision,
  writeDecisionSnapshot,
} from './decision-draft.ts';
import { decisionActions, decisionIsReady, type DecisionAction } from './decision.ts';

/**
 * One credit request, with everything a lender needs to decide it: the file,
 * the exposure behind it, the audit trail, and the two boxes they type into.
 *
 * ## The two boxes are not the same kind of field
 *
 * `internal_note` is LENDER-ONLY and client-writable, so it is autosaved
 * straight to `credit_release_note` -- safe precisely because a borrower holds
 * no policy on that table at all (issue #50). `decline_reason` is
 * lender-authored and BORROWER-READABLE, and no client may write it: a borrower
 * and a lender are the same database role, so a grant wide enough for a lender
 * to autosave it is wide enough for a borrower to forge one onto their own
 * draft. It travels with the `decline` transition instead, written by the
 * service role in the same statement that moves the state.
 *
 * Both are kept in the browser as they are typed (./decision-draft.ts), which
 * is plan/06's third refresh case: "lenders lose work too".
 *
 * ## The decline reason is checked, not assumed, after the decision
 *
 * The reason is sent with the transition request. Whether the endpoint carries
 * it is not this store's to know, so it does not assume: after a decline it
 * re-reads the row and clears the browser copy ONLY IF `decline_reason` came
 * back set. If it did not, the copy is kept and `declineReasonPending` says so,
 * because a lender's explanation silently dropped between the box and the
 * borrower is the worst available outcome -- the borrower reads "Declined" with
 * nothing to act on, and nobody is told.
 *
 * ## It decides nothing
 *
 * Which buttons exist is `decisionActions`, read off the machine with `can`
 * (./decision.ts). This store fires them through the one place transitions are
 * fired, with the revision it read -- which is what makes two lender tabs
 * serialise rather than double-approve.
 */

/** How long the lender has to stop typing before the note is written. */
export const NOTE_DELAY_MS = 800;

/** Where the seatbelt is kept. A token, so a test can supply its own. */
export const DECISION_STORAGE = new InjectionToken<Storage | null>('lj.decision-storage', {
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
  'This deployment cannot reach the database, so this request cannot be opened.';

export const NO_SUCH_RELEASE: string =
  'That request does not exist, or is not yours to read.';

export const REASON_REQUIRED: string =
  'A decline needs a reason the borrower can act on.';

export interface ReviewValue {
  readonly release: CreditReleaseLenderView;
  /** Null when nobody has left one, which is the ordinary case. */
  readonly internalNote: string | null;
  /** Null when the loan row did not arrive; the decision does not depend on it. */
  readonly loan: Loan | null;
  readonly balance: LoanBalance | null;
  readonly events: readonly WorkflowEvent[];
}

/**
 * The decline reason, carried with the transition that writes it.
 *
 * `TransitionRequest` in `core/` does not name this field -- that file belongs
 * to web-core (#19) and this feature may not edit it -- so the field is declared
 * here, on a type that IS one. Nothing is asserted away: a wider object is a
 * legal argument, the endpoint parses its body field by field and ignores what
 * it does not know, and the check above means a reason that fails to land is
 * reported rather than lost.
 */
interface DeclineRequest extends TransitionRequest {
  readonly declineReason: string;
}

@Injectable()
export class ReviewStore extends AggregateStore<ReviewValue> {
  private readonly client = inject(DATABASE_CLIENT);
  private readonly auth = inject(SupabaseAuthService);
  private readonly transitions = inject(TransitionService);
  private readonly realtime = inject(RealtimeChannelFactory);
  private readonly storage = inject(DECISION_STORAGE);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);

  /** The two boxes. Both hold strings; neither is a payload of its own. */
  readonly form = new FormGroup({
    internalNote: new FormControl('', { nonNullable: true }),
    declineReason: new FormControl('', { nonNullable: true }),
  });

  private readonly currentId = signal<string | null>(null);
  private readonly rawValue = signal(this.form.getRawValue());
  private readonly recoveredAt = signal<string | null>(null);
  private readonly reasonUnsent = signal(false);

  private loadingForm = false;
  private watching: string | null = null;

  readonly releaseId: Signal<string | null> = this.currentId.asReadonly();

  /** Non-null when the browser was holding typing the server had not seen. */
  readonly recovered: Signal<string | null> = this.recoveredAt.asReadonly();

  /**
   * True when a decline was recorded and the borrower's reason did not land
   * with it. The typed reason is still in the browser; nothing has been lost,
   * and the screen says so rather than pretending the borrower can see it.
   */
  readonly declineReasonPending: Signal<boolean> = this.reasonUnsent.asReadonly();

  readonly release: Signal<CreditReleaseLenderView | null> = computed(
    () => this.value()?.release ?? null,
  );

  readonly events: Signal<readonly WorkflowEvent[]> = computed(() => this.value()?.events ?? []);

  /** The application behind the loan, so the screen can link to its documents. */
  readonly applicationId: Signal<string | null> = computed(
    () => this.value()?.loan?.application_id ?? null,
  );

  /** The lender's reading of the balance: exposure, with pending kept apart. */
  readonly figures: Signal<LenderFigures | null> = computed(() => {
    const balance = this.value()?.balance ?? null;
    return balance === null ? null : lenderFigures(balance);
  });

  /** Which moves are open, read off the machine rather than listed. */
  readonly actions: Signal<readonly DecisionAction[]> = computed(() => {
    const held = this.release();
    const role = this.auth.role();
    return held === null || role === null ? [] : decisionActions(held.state, role);
  });

  readonly declineReason: Signal<string> = computed(() => this.rawValue().declineReason);

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
    });

    this.form.valueChanges
      .pipe(debounceTime(NOTE_DELAY_MS), takeUntilDestroyed())
      .subscribe(() => {
        void this.saveNote();
      });

    const flush = (): void => {
      if (this.document.visibilityState === 'hidden') {
        this.writeSeatbelt();
        void this.saveNote();
      }
    };
    this.document.addEventListener('visibilitychange', flush);
    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('visibilitychange', flush);
    });
  }

  /** Open a request. Safe to call again with the same id. */
  async open(releaseId: string): Promise<void> {
    this.currentId.set(releaseId);
    this.reasonUnsent.set(false);
    this.watch(releaseId);
    await this.refresh();
  }

  /**
   * Write the lender's private note.
   *
   * Only the note: the decline reason has no client-writable home, and sending
   * it here would be sending it to the wrong table as well as to the wrong
   * audience.
   */
  async saveNote(): Promise<void> {
    const client = this.client;
    const releaseId = this.currentId();
    const lenderId = this.auth.identity()?.userId ?? null;
    if (client === null || releaseId === null || lenderId === null || !this.form.dirty) {
      return;
    }

    const sent = this.rawValue();
    const outcome = await this.write(() =>
      upsertCreditReleaseNote(client, {
        release_id: releaseId,
        internal_note: sent.internalNote,
        recorded_by: lenderId,
      }),
    );
    if (!outcome.ok) {
      return;
    }
    const held = this.value();
    if (held !== null) {
      this.adopt({ ...held, internalNote: sent.internalNote });
    }
  }

  /**
   * Take a decision.
   *
   * The revision sent is the one this store read, so a second tab holding an
   * older one is refused rather than applied on top -- `AggregateStore.write()`
   * refetches on the 409 rather than reporting it beside a stale screen.
   */
  async decide(action: DecisionAction): Promise<WriteOutcome<TransitionAck>> {
    const held = this.release();
    if (held === null) {
      return {
        ok: false,
        failure: { message: NO_SUCH_RELEASE, code: null },
        conflicted: false,
      };
    }
    const reason = this.rawValue().declineReason.trim();
    if (!decisionIsReady(action, reason)) {
      return {
        ok: false,
        failure: { message: REASON_REQUIRED, code: null },
        conflicted: false,
      };
    }

    // The note is flushed first, so the trail records what the lender was
    // thinking BEFORE the decision rather than after it.
    await this.saveNote();
    const current = this.release() ?? held;

    const outcome = await this.write(() =>
      this.transitions.fire(this.requestFor(action.event, current.revision, current.id, reason)),
    );
    if (!outcome.ok) {
      return outcome;
    }

    await this.refresh();
    if (action.event === 'decline') {
      this.settleDeclineReason();
    }
    return outcome;
  }

  protected override revisionOf(value: ReviewValue): number {
    return value.release.revision;
  }

  override async refresh(): Promise<void> {
    await super.refresh();
    const held = this.value();
    if (held !== null && this.form.pristine) {
      this.loadFormFrom(held);
    }
  }

  protected async load(): Promise<ReviewValue> {
    const client = this.client;
    const releaseId = this.currentId();
    if (client === null) {
      throw new Error(NO_DATABASE);
    }
    if (releaseId === null) {
      throw new Error('No request has been opened.');
    }

    const [releaseRow, noteRow, events] = await Promise.all([
      getCreditReleaseForLender(client, releaseId),
      getCreditReleaseNote(client, releaseId),
      listWorkflowEvents(client, 'credit_release', releaseId),
    ]);
    if (releaseRow === null) {
      throw new Error(NO_SUCH_RELEASE);
    }
    // Parsed even though it came from our own database: a view reports no
    // not-null constraint, so a state no machine knows must not reach `can()`
    // as a string that happens to typecheck.
    const release = CreditReleaseLenderViewSchema.parse(releaseRow);

    const [loanRow, balanceRow] = await Promise.all([
      getLoan(client, release.loan_id),
      getLoanBalance(client, release.loan_id),
    ]);

    return {
      release,
      internalNote:
        noteRow === null ? null : CreditReleaseNoteSchema.parse(noteRow).internal_note,
      // The loan and its balance are context, not the subject. A decision on a
      // request must still be possible if one of them cannot be read; the
      // screen shows fewer figures rather than refusing to open.
      loan: loanRow === null ? null : LoanSchema.parse(loanRow),
      balance: balanceRow === null ? null : LoanBalanceSchema.parse(balanceRow),
      events: events.map((event) => WorkflowEventSchema.parse(event)),
    };
  }

  /**
   * The request body for one decision.
   *
   * A decline carries the reason; nothing else does, because nothing else has
   * one to carry. See DeclineRequest above for why the field is declared in
   * this feature rather than in `core/`.
   */
  private requestFor(
    event: CreditReleaseEvent,
    expectedRevision: number,
    subjectId: string,
    reason: string,
  ): TransitionRequest {
    const request: TransitionRequest = {
      machine: 'credit_release',
      subjectId,
      event,
      expectedRevision,
    };
    if (event !== 'decline') {
      return request;
    }
    const withReason: DeclineRequest = { ...request, declineReason: reason };
    return withReason;
  }

  /**
   * After a decline: did the borrower's reason actually land?
   *
   * Checked rather than assumed, and the browser copy is kept when it did not.
   * A reason dropped between the box and the borrower leaves them reading
   * "Declined" with nothing to act on and nobody told.
   */
  private settleDeclineReason(): void {
    const stored = this.release()?.decline_reason ?? null;
    if (stored !== null && stored.trim() !== '') {
      this.clearSeatbelt();
      this.reasonUnsent.set(false);
      return;
    }
    this.reasonUnsent.set(this.rawValue().declineReason.trim() !== '');
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

  private loadFormFrom(held: ReviewValue): void {
    const snapshot = readDecisionSnapshot(this.storage, held.release.id);
    const reconciled = reconcileDecision(snapshot, { internalNote: held.internalNote ?? '' });

    this.loadingForm = true;
    try {
      this.form.setValue({
        internalNote: reconciled.internalNote,
        declineReason: reconciled.declineReason,
      });
    } finally {
      this.loadingForm = false;
    }

    if (reconciled.recovered) {
      // Dirty on purpose: the note half has edits the server never received, so
      // the next autosave must send them.
      this.form.markAsDirty();
      this.recoveredAt.set(snapshot?.savedAt ?? null);
      return;
    }
    this.form.markAsPristine();
    this.recoveredAt.set(null);
  }

  private writeSeatbelt(): void {
    const releaseId = this.currentId();
    if (releaseId === null) {
      return;
    }
    const sent = this.rawValue();
    writeDecisionSnapshot(this.storage, {
      releaseId,
      internalNote: sent.internalNote,
      declineReason: sent.declineReason,
      savedAt: new Date().toISOString(),
    });
  }

  private clearSeatbelt(): void {
    const releaseId = this.currentId();
    if (releaseId !== null) {
      clearDecisionSnapshot(this.storage, releaseId);
    }
    this.recoveredAt.set(null);
  }
}
