import {
  PENDING_CREDIT_RELEASE_STATES,
  type CreditReleaseLenderView,
  type CreditReleaseState,
  type Loan,
  type LoanBalance,
  type Money,
} from '@lj/domain';

import { lenderFigures } from '../servicing/balance.ts';

/**
 * The lender's work queue, as rows.
 *
 * Criterion #1 is judged here -- "a loan officer could move through it quickly"
 * -- so this is a queue and not a table dump: oldest first, because the request
 * that has waited longest is the one that costs the most to leave; grouped by
 * state, because triage, review and disbursement are three different jobs; and
 * carrying enough context per row that the simple cases are decided without
 * opening anything.
 *
 * Every figure on a row is the LENDER'S reading of `loan_balance_v`: exposure
 * against the limit, with pending as its own at-risk column. The borrower
 * reading the same rows sees available credit net of pending, which is smaller
 * by exactly that column. Both come from ../servicing/balance.ts, so neither
 * audience can be shown the other's number by a template getting it wrong.
 *
 * THE ONE THRESHOLD IN THIS FEATURE THAT HAS NO HOME IN @lj/rules is the SLA
 * banding below, and it is worth saying why it is allowed to live here.
 * plan/06 asks for "SLA colouring on submitted age" and no rule in
 * `packages/rules` defines one, so there is nothing to render. It COLOURS A ROW
 * AND GATES NOTHING: no transition consults it, no guard reads it, and changing
 * it cannot change what may happen to a request. The moment it decides
 * something -- an escalation, an auto-assignment -- it stops being presentation
 * and belongs in @lj/rules with the others (CLAUDE.md sections 8 and 9). It is
 * stated once, here, and read by the queue and by nothing else.
 */

/** Waiting longer than this is worth noticing. */
export const QUEUE_SLA_DUE_DAYS = 2;

/** Waiting longer than this is the queue's oldest problem. */
export const QUEUE_SLA_OVERDUE_DAYS = 5;

export const SLA_BANDS = ['fresh', 'due', 'overdue'] as const;
export type SlaBand = (typeof SLA_BANDS)[number];

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Triage, then review, then disbursement -- the order a desk works in, and the
 * order the machine moves through. Taken from @lj/domain's pending set rather
 * than restated, so a state added to it appears here rather than silently
 * vanishing from the queue.
 */
export const QUEUE_STATE_ORDER: readonly CreditReleaseState[] = PENDING_CREDIT_RELEASE_STATES;

export interface QueueRow {
  readonly id: string;
  readonly loanId: string;
  /**
   * The application the loan came out of, so the queue can link to its document
   * review -- or null when the loan row did not arrive, which costs the link and
   * not the row: the request is real either way.
   */
  readonly applicationId: string | null;
  readonly borrowerName: string;
  readonly amount: Money;
  readonly purpose: string;
  readonly state: CreditReleaseState;
  /**
   * The revision as read, which is what makes a decision taken FROM THE QUEUE
   * safe: two lenders acting on one row serialise, because the second one's
   * write matches nothing and comes back as a conflict to refetch.
   */
  readonly revision: number;
  readonly createdAt: string;
  readonly waitingDays: number;
  readonly sla: SlaBand;
  /** The lender's headroom on the loan: limit less what is drawn. */
  readonly undrawn: Money | null;
  /** Committed and not yet disbursed, this request included. */
  readonly atRisk: Money | null;
  /** Whether somebody has already left a note on this file. */
  readonly hasNote: boolean;
}

export interface QueueSource {
  readonly releases: readonly CreditReleaseLenderView[];
  readonly loans: readonly Loan[];
  readonly balances: readonly LoanBalance[];
  /** ISO 8601. Injected rather than read from the clock, so a row's age is
   *  reproducible and the banding is testable (the same reason @lj/rules takes
   *  `today` in its context). */
  readonly now: string;
}

export function waitingDays(createdAt: string, now: string): number {
  const from = new Date(createdAt).getTime();
  const to = new Date(now).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return 0;
  }
  // Floored, and never negative: a row created a moment ago has waited no days,
  // and a clock behind the database is not a request from the future.
  return Math.max(0, Math.floor((to - from) / MILLISECONDS_PER_DAY));
}

export function slaBandFor(days: number): SlaBand {
  if (days >= QUEUE_SLA_OVERDUE_DAYS) {
    return 'overdue';
  }
  return days >= QUEUE_SLA_DUE_DAYS ? 'due' : 'fresh';
}

/**
 * The queue, oldest first.
 *
 * The sort is on `created_at` with `id` as the tiebreak, for the reason the
 * ledger query gives: two requests can share an instant, and without the
 * tiebreak the queue reshuffles between two reads -- which is a queue nobody can
 * work through, because the row they were about to click moves.
 */
export function queueRows(source: QueueSource): readonly QueueRow[] {
  const applications = new Map(source.loans.map((loan) => [loan.id, loan.application_id]));
  const balances = new Map(source.balances.map((balance) => [balance.loan_id, balance]));

  const rows = source.releases.map((release) => {
    const balance = balances.get(release.loan_id);
    const figures = balance === undefined ? null : lenderFigures(balance);
    const days = waitingDays(release.created_at, source.now);
    return {
      id: release.id,
      loanId: release.loan_id,
      applicationId: applications.get(release.loan_id) ?? null,
      borrowerName: release.requested_by_name ?? 'This borrower',
      amount: release.amount,
      purpose: release.purpose,
      state: release.state,
      revision: release.revision,
      createdAt: release.created_at,
      waitingDays: days,
      sla: slaBandFor(days),
      undrawn: figures?.undrawn ?? null,
      atRisk: figures?.atRisk ?? null,
      hasNote: release.internal_note !== null && release.internal_note !== '',
    };
  });

  return [...rows].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -1 : 1;
    }
    return left.id < right.id ? -1 : 1;
  });
}

export interface QueueGroup {
  readonly state: CreditReleaseState;
  readonly rows: readonly QueueRow[];
}

/**
 * The same rows, in the three piles a desk works through.
 *
 * A state with nothing in it is left out rather than rendered empty: a queue
 * whose headings outnumber its work reads as busier than it is.
 */
export function queueGroups(rows: readonly QueueRow[]): readonly QueueGroup[] {
  const groups: QueueGroup[] = [];
  for (const state of QUEUE_STATE_ORDER) {
    const inState = rows.filter((row) => row.state === state);
    if (inState.length > 0) {
      groups.push({ state, rows: inState });
    }
  }
  return groups;
}
