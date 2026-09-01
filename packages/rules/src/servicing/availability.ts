import {
  type CreditReleaseState,
  type Money,
  type RuleResult,
  ZERO_MONEY,
  moneyFromMinorUnits,
  subtractMoney,
  sumMoney,
} from '@lj/domain';

import { numericAtLeast, numericAtMost } from '../engine/numeric.js';
import { predicate } from '../engine/predicate.js';
import { known, readNumber } from '../engine/reading.js';
import { type Rule, type RuleDecision, decide, evaluate } from '../engine/rule.js';

/**
 * Credit availability: the guard on `credit_release: draft -> submitted`
 * (plan 06).
 *
 * The balance is derived here, never stored, for the same reason the SQL view
 * derives it: a stored balance is a cache with no invalidation strategy, and
 * every reconciliation bug in lending starts there.
 *
 * The important coherence is that the cap this guard applies and the "available
 * credit" the borrower is shown are the same function of the same figures. If
 * they differed, a borrower could submit a request the screen had just told
 * them was fine. That is the whole answer to "two truths without two bugs".
 */

/** Mirrors the `loan.status` column of plan 06. */
export type CreditLoanStatus = 'active' | 'closed' | 'delinquent';

/**
 * A request in one of these states has not been decided, so the money behind it
 * is spoken for. A funded release is already in the ledger, so counting it here
 * as well would hold the same money back twice.
 */
export const PENDING_CREDIT_RELEASE_STATES = [
  'submitted',
  'under_review',
  'approved',
] as const satisfies readonly CreditReleaseState[];

export interface CreditReleaseSummary {
  readonly id: string;
  readonly state: CreditReleaseState;
  readonly amount: Money;
}

export interface CreditReleaseContext {
  readonly requestedAmount: Money | null;
  readonly loan: {
    readonly status: CreditLoanStatus;
    readonly approvedLimit: Money;
  };
  /** Net of the ledger: draws positive, repayments negative. */
  readonly outstanding: Money;
  /** Every other release on this loan, whatever its state. */
  readonly otherReleases: readonly CreditReleaseSummary[];
}

/** One thousand dollars, stated once. */
export const CREDIT_RELEASE_MINIMUM_AMOUNT: Money = moneyFromMinorUnits(100_000);

function isPending(release: CreditReleaseSummary): boolean {
  return (PENDING_CREDIT_RELEASE_STATES as readonly CreditReleaseState[]).includes(release.state);
}

export function pendingReleases(
  context: CreditReleaseContext,
): readonly CreditReleaseSummary[] {
  return context.otherReleases.filter(isPending);
}

export function pendingCredit(context: CreditReleaseContext): Money {
  return sumMoney(pendingReleases(context).map((release) => release.amount));
}

/**
 * Limit less what is drawn less what is already requested.
 *
 * Floored at zero: a loan that is over its limit has no credit available, and
 * showing a negative figure as "available" invites a reading nobody intends.
 */
export function availableCredit(context: CreditReleaseContext): Money {
  const afterDraws = subtractMoney(context.loan.approvedLimit, context.outstanding);
  const remaining = subtractMoney(afterDraws, pendingCredit(context));
  return remaining < 0 ? ZERO_MONEY : remaining;
}

const readAmount = (context: CreditReleaseContext) =>
  readNumber(context.requestedAmount, 'amount', 'the amount you want to draw');

export const creditReleaseRules: readonly Rule<CreditReleaseContext>[] = [
  numericAtLeast<CreditReleaseContext>({
    id: 'release_minimum_amount',
    label: 'Minimum request',
    figure: 'money',
    minimum: CREDIT_RELEASE_MINIMUM_AMOUNT,
    read: readAmount,
  }),
  numericAtMost<CreditReleaseContext>({
    id: 'release_within_available',
    label: 'Within your available credit',
    figure: 'money',
    // The cap moves with the ledger, so it is read from the context rather than
    // stated as a constant -- and it is read through availableCredit, the same
    // function the borrower's screen calls.
    maximum: (context) => known(availableCredit(context)),
    read: readAmount,
  }),
  predicate<CreditReleaseContext>({
    id: 'loan_is_active',
    label: 'The loan is open',
    read: (context) => known(context.loan.status === 'active', { status: context.loan.status }),
    whenTrue: 'Your loan is active.',
    whenFalse: 'This loan is not active -- no further credit can be released.',
  }),
  predicate<CreditReleaseContext>({
    id: 'no_other_pending_release',
    label: 'One request at a time',
    read: (context) => {
      const pending = pendingReleases(context);
      return known(pending.length === 0, { pending: pending.length });
    },
    whenTrue: 'No other request is with your lender.',
    // A real policy choice, not a technical limit: two requests in flight
    // against one limit is how a loan gets over-drawn between decisions.
    whenFalse: 'You already have a request with your lender -- one at a time.',
  }),
];

export function evaluateCreditRelease(context: CreditReleaseContext): RuleResult[] {
  return evaluate(context, creditReleaseRules);
}

export function creditReleaseSubmittable(context: CreditReleaseContext): RuleDecision {
  return decide(evaluateCreditRelease(context));
}
