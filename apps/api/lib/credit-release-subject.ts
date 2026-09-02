/**
 * The `credit_release` subject: loading it, deciding who may act on it,
 * building the context its one guard takes, and advancing it.
 *
 * The third machine with a table, and the one that settles what the first two
 * had in common. The answer is still less than a registry would assume: three
 * subjects loaded from three tables, validated by three schemas, advanced by
 * three helpers, with three different things to prepare. What IS shared is
 * shared as a function and imported rather than restated -- who the audience is
 * (`applicationReadableBy`), how an event is narrowed (`narrowEvent`), how the
 * two structural refusals are answered (`structuralRefusal` in the route), and
 * how the audit entry is written. Everything else differs, and three
 * straight-line adjudicators read better than one generic one with a switch
 * inside every step (CLAUDE.md section 9).
 *
 * A RELEASE'S AUDIENCE IS ITS LOAN'S, WHICH IS ITS APPLICATION'S. That is the
 * shape `credit_release_read_visible_loan` has in 0007_servicing.sql: it reads
 * `loan` under the caller's policies, which reads `application` under them.
 * Three tables, one definition of who may read a loan file, and it lives in
 * 0002_rls.sql. The service role bypasses all of it, so this file has to make
 * the same decision, and it makes it the same way -- resolve the loan, resolve
 * its application, then ask `applicationReadableBy`. A predicate written out
 * again over `loan.borrower_id` and `loan.org_id` would be the second answer
 * the first time either changed, and those two columns are denormalised
 * precisely so that application code can read them without a join -- they are
 * not a security surface, and no policy reads them.
 *
 * THE GUARD'S CAP AND THE BORROWER'S FIGURE ARE THE SAME QUANTITY. plan/06
 * turns on it: the borrower's available credit is net of pending requests
 * exactly because the guard compares against that quantity, and if the two
 * differed a borrower could submit a request the screen had just told them was
 * fine. So the context is built from `loan_balance_v` -- the same view the
 * screen reads -- and the arithmetic over it is `availableCredit` in
 * packages/rules, which the browser calls too. Nothing here recomputes a
 * balance.
 */

import {
  getCreditRelease,
  getLoan,
  getLoanBalance,
  listCreditReleases,
  updateCreditRelease,
  type DatabaseClient,
} from '@lj/db';
import {
  CreditReleaseSchema,
  LoanBalanceSchema,
  LoanSchema,
  type CreditReleaseState,
  type LoanStatus,
  type Money,
} from '@lj/domain';
import {
  evaluateCreditRelease,
  type CreditReleaseContext,
  type CreditReleaseSummary,
} from '@lj/rules';
import {
  CREDIT_RELEASE_EVENTS,
  creditReleaseMachine,
  type CreditReleaseEvent,
  type CreditReleaseGuardContext,
} from '@lj/workflow';

import type { SubjectSnapshot } from './http.ts';
import { narrowEvent } from './machines.ts';

export interface CreditReleaseSubject {
  readonly id: string;
  readonly loanId: string;
  readonly amount: Money;
  readonly purpose: string;
  readonly state: CreditReleaseState;
  readonly revision: number;
  readonly requestedBy: string;
}

export interface LoanSubject {
  readonly id: string;
  readonly applicationId: string;
  readonly borrowerId: string;
  readonly orgId: string;
  readonly status: LoanStatus;
}

/**
 * The release, read with the service role and then validated.
 *
 * Parsed with the schema from packages/domain even though the row came from our
 * own database, for the reason `loadApplication` gives: the generated types are
 * a claim about the schema rather than a check of it, `state` is `text` because
 * legality lives in `workflow_transition`, and a state no machine declares must
 * not reach the engine as a string that happens to typecheck. The parse is also
 * what turns `amount` from the exact decimal @lj/db selected into `Money`.
 */
export async function loadCreditRelease(
  client: DatabaseClient,
  releaseId: string,
): Promise<CreditReleaseSubject | null> {
  const row = await getCreditRelease(client, releaseId);
  if (row === null) {
    return null;
  }
  const parsed = CreditReleaseSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      'credit release ' + releaseId + ' does not match the schema that describes it',
    );
  }
  return {
    id: parsed.data.id,
    loanId: parsed.data.loan_id,
    amount: parsed.data.amount,
    purpose: parsed.data.purpose,
    state: parsed.data.state,
    revision: parsed.data.revision,
    requestedBy: parsed.data.requested_by,
  };
}

/** The facility a release draws against. Its audience decides the release's. */
export async function loadLoan(
  client: DatabaseClient,
  loanId: string,
): Promise<LoanSubject | null> {
  const row = await getLoan(client, loanId);
  if (row === null) {
    return null;
  }
  const parsed = LoanSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error('loan ' + loanId + ' does not match the schema that describes it');
  }
  return {
    id: parsed.data.id,
    applicationId: parsed.data.application_id,
    borrowerId: parsed.data.borrower_id,
    orgId: parsed.data.org_id,
    status: parsed.data.status,
  };
}

/** The machine's events, narrowed from the string the request carried. */
export function asCreditReleaseEvent(event: string): CreditReleaseEvent | null {
  return narrowEvent(CREDIT_RELEASE_EVENTS, event);
}

/**
 * Whether this transition needs the rule sets evaluated at all.
 *
 * Read off the machine definition, which is the one statement of what each
 * transition needs, exactly as `applicationTransitionNeedsEvaluation` is -- a
 * guard is the only thing that reads the context, and a declared effect is the
 * only other thing that reads the evaluation beside it.
 *
 * It matters more here than it did there. Every other transition on this
 * machine is a decision in itself: `begin_review`, `approve`, `decline` and
 * `cancel` read no criteria, and a balance that cannot be read must not stand
 * between a borrower and abandoning a request they have already made. A
 * borrower's way out must not depend on rules with nothing to say about it
 * (issue #26).
 *
 * Getting this wrong in the direction of `false` is safe: the caller then
 * passes the unevaluated context, whose empty rule set `requireRules` reads as
 * "the caller did not evaluate this" and refuses. A mistake here can only
 * refuse a transition, never open one.
 */
export function creditReleaseTransitionNeedsEvaluation(
  from: CreditReleaseState,
  event: CreditReleaseEvent,
): boolean {
  return creditReleaseMachine.transitions.some(
    (transition) =>
      transition.event === event &&
      transition.from.includes(from) &&
      (transition.guard !== null || transition.effects.length > 0),
  );
}

/**
 * What a transition that needs no evaluation is adjudicated against.
 *
 * Empty rather than absent, for the reason `UNEVALUATED_APPLICATION_CONTEXT` is:
 * `apply` takes a context whether or not the transition has a guard, and an
 * empty rule set fails closed if one is ever reached with this in hand.
 */
export const UNEVALUATED_CREDIT_RELEASE_CONTEXT: CreditReleaseGuardContext = {
  availableCredit: [],
};

export interface CreditReleaseEvaluation {
  readonly context: CreditReleaseGuardContext;
  /** The context the rules read, carried so a runner never rebuilds it. */
  readonly criteria: CreditReleaseContext;
}

export type CreditReleaseEvaluationResult =
  | { readonly ok: true; readonly evaluation: CreditReleaseEvaluation }
  | { readonly ok: false; readonly reason: string };

/**
 * The evaluated rule set the `submit` guard reads.
 *
 * Two reads, and neither of them recomputes anything. `loan_balance_v` supplies
 * the limit and the outstanding figure -- the same row, from the same view,
 * that the borrower's screen shows -- and the releases supply what else is in
 * flight. `availableCredit` in packages/rules then does the arithmetic, and it
 * is the one implementation both the guard and the screen call.
 *
 * The subject itself is excluded from `otherReleases`, which is what makes the
 * two figures identical rather than merely close: the view's `pending` sums
 * every release of the loan in a pending state, and a `draft` is not one of
 * them, so for the transition this guard exists for -- `draft -> submitted` --
 * the sum over the others is the same sum. Excluding the subject is also what
 * stops a request being netted against itself.
 *
 * EVERY FAILURE HERE REFUSES. A balance that will not read is not "no
 * restriction": reading a missing figure as zero, or dropping a release whose
 * row does not parse, would make more credit appear available than there is,
 * which is failing open on a lending limit. Refusing costs the borrower a
 * transition; the alternative costs somebody money.
 */
export async function evaluateCreditReleaseSubject(
  client: DatabaseClient,
  loan: LoanSubject,
  release: CreditReleaseSubject,
): Promise<CreditReleaseEvaluationResult> {
  const [balanceRow, releaseRows] = await Promise.all([
    getLoanBalance(client, loan.id),
    listCreditReleases(client, loan.id),
  ]);

  if (balanceRow === null) {
    return { ok: false, reason: 'this loan has no balance row, so its credit could not be read' };
  }
  const balance = LoanBalanceSchema.safeParse(balanceRow);
  if (!balance.success) {
    return {
      ok: false,
      reason: "this loan's balance does not match the schema that describes it",
    };
  }

  const otherReleases: CreditReleaseSummary[] = [];
  for (const row of releaseRows) {
    if (row.id === release.id) {
      continue;
    }
    const parsed = CreditReleaseSchema.safeParse(row);
    if (!parsed.success) {
      // Dropped would be worse than refused: a pending release that is not
      // counted is credit the borrower gets to spend twice.
      return {
        ok: false,
        reason: 'another request on this loan could not be read, so the balance is not decidable',
      };
    }
    otherReleases.push({
      id: parsed.data.id,
      state: parsed.data.state,
      amount: parsed.data.amount,
    });
  }

  const criteria: CreditReleaseContext = {
    requestedAmount: release.amount,
    loan: { status: loan.status, approvedLimit: balance.data.approved_limit },
    outstanding: balance.data.outstanding,
    otherReleases,
  };

  return {
    ok: true,
    evaluation: {
      context: { availableCredit: evaluateCreditRelease(criteria) },
      criteria,
    },
  };
}

/**
 * Which events record who decided.
 *
 * `credit_release.decided_by` has no client grant of any kind -- a borrower and
 * a lender are the same database role, so a grant wide enough for one is wide
 * enough for the other -- which makes this handler the column's only possible
 * author. There is no path that could fill it in afterwards.
 *
 * Naming the two events here is a policy statement in the delivery layer, and
 * it is the least bad of the places available. The machine's vocabulary has no
 * way to say "this transition records a decider": that would be an `EffectSpec`
 * kind, and those live in packages/workflow/src/types.ts, which this issue does
 * not own. Stated as one named predicate rather than an `if` inside the
 * adjudicator so there is exactly one place to move it to when the vocabulary
 * grows one.
 *
 * `disburse` is deliberately not here. It carries out a decision that has
 * already been made, and stamping it would overwrite the lender who approved
 * the request with the one who released the money.
 */
const DECISION_EVENTS: readonly CreditReleaseEvent[] = ['approve', 'decline'];

export function creditReleaseEventRecordsDecider(event: CreditReleaseEvent): boolean {
  return DECISION_EVENTS.includes(event);
}

export interface CreditReleaseAdvanceRequest {
  readonly releaseId: string;
  readonly expectedRevision: number;
  readonly to: CreditReleaseState;
  /**
   * The lender who decided, on the two events that are a decision. Absent
   * means "leave it alone": a disbursement must not overwrite the approver.
   */
  readonly decidedBy?: string;
  /**
   * The reason a decline is refused for, written in the SAME statement that
   * moves the state.
   *
   * That is not a convenience. No client holds an UPDATE privilege on the
   * column (0007_servicing.sql argues why: a grant wide enough for a lender to
   * autosave one is wide enough for a borrower to forge one onto their own
   * draft), so a decline that landed without its reason could never acquire
   * one, and a decline with no explanation is the one thing plan/06 says a
   * decline is for.
   */
  readonly declineReason?: string;
}

/**
 * The state change, guarded by the revision the caller believes it holds.
 *
 * Null means nothing matched: the revision moved under the caller. Two lender
 * tabs approving one release therefore serialise rather than race, exactly as
 * two lenders on one application do -- the same optimistic concurrency, on a
 * third table. `credit_release_assert_legal_transition` re-checks the state
 * pair underneath, which is reachability and not authority; authority is this
 * code's job, because every write here arrives as the service role.
 */
export async function advanceCreditRelease(
  client: DatabaseClient,
  request: CreditReleaseAdvanceRequest,
): Promise<SubjectSnapshot | null> {
  const patch: Record<string, unknown> = { state: request.to };
  if (request.decidedBy !== undefined) {
    patch['decided_by'] = request.decidedBy;
  }
  if (request.declineReason !== undefined) {
    patch['decline_reason'] = request.declineReason;
  }

  const ack = await updateCreditRelease(client, {
    releaseId: request.releaseId,
    expectedRevision: request.expectedRevision,
    patch,
  });
  return ack === null ? null : { state: ack.state, revision: ack.revision };
}
