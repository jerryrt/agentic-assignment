import {
  ZERO_MONEY,
  lenderUndrawnLimit,
  type CreditRelease,
  type LoanBalance,
  type LoanStatus,
  type Money,
} from '@lj/domain';
import { availableCredit, type CreditReleaseContext } from '@lj/rules';

/**
 * Two roles, two truths, one row -- and the one place either of them is
 * computed.
 *
 * `plan/06-option3-servicing.md` makes the point literal: the borrower's
 * available credit is NET OF PENDING requests, because they must not spend the
 * same credit twice, while the lender reads exposure against the limit with
 * pending as a separate at-risk column. Both readings are legitimate, both come
 * out of `loan_balance_v`, and they differ by exactly `pending` -- which the
 * seed makes visible on purpose (outstanding 128,442.47, pending 30,000.00,
 * available 91,557.53, undrawn 121,557.53).
 *
 * THE REASON THIS IS A MODULE AND NOT TWO TEMPLATE EXPRESSIONS. The borrower's
 * figure is the quantity `credit_release: draft -> submitted` is guarded on, so
 * it must be the SAME computation the guard runs, not a second one that agrees
 * today. `borrowerFigures` therefore returns `availableCredit` from @lj/rules --
 * the function `amountWithinAvailable` reads -- rather than reaching for
 * `balance.available`. If the two ever diverged, a borrower could submit a
 * request the screen had just called affordable, and that is the bug Option 3
 * exists to avoid. The spec beside this file asserts the agreement in the
 * strongest available form: a request for exactly the displayed figure passes
 * the rule, and one cent more fails it.
 *
 * Nothing here decides anything. Every threshold, the pending state set and the
 * flooring at zero live in @lj/rules and @lj/domain; this file assembles their
 * inputs from rows the store has already read and parsed, and names the two
 * readings so a template cannot show one audience the other's number.
 */

/** One loan as both screens read it: its status, its balance row, its requests. */
export interface LoanFacts {
  readonly status: LoanStatus;
  /** `loan_balance_v`, parsed. The limit and the ledger sum both come from here. */
  readonly balance: LoanBalance;
  /** Every release on the loan, whatever its state. */
  readonly releases: readonly CreditRelease[];
}

export interface CreditReleaseContextOptions {
  /** What the borrower has typed, or null before they have typed anything. */
  readonly requestedAmount: Money | null;
  /**
   * The release being composed, which must not be counted against its own cap.
   *
   * A draft holds no credit back -- nobody has been asked about it -- so it is
   * excluded from the pending sum whether or not this is passed. Passing it is
   * what keeps that true if a release ever reaches this screen in a pending
   * state, and it is what stops a borrower watching their own typing reduce the
   * amount they are allowed to type.
   */
  readonly excludeReleaseId?: string | null;
}

/**
 * The context @lj/rules evaluates, built from what the store read.
 *
 * `approvedLimit` and `outstanding` come from `loan_balance_v` rather than from
 * the loan row and a re-summed ledger: the view is the one derivation of the
 * balance (plan/06), and summing the ledger again in the browser would be a
 * second one that drifts the moment an entry kind is added.
 */
export function creditReleaseContextFor(
  facts: LoanFacts,
  options: CreditReleaseContextOptions,
): CreditReleaseContext {
  const excluded = options.excludeReleaseId ?? null;
  return {
    requestedAmount: options.requestedAmount,
    loan: { status: facts.status, approvedLimit: facts.balance.approved_limit },
    outstanding: facts.balance.outstanding,
    otherReleases: facts.releases
      .filter((release) => release.id !== excluded)
      .map((release) => ({ id: release.id, state: release.state, amount: release.amount })),
  };
}

/** What the borrower is shown. Every figure is a column of `loan_balance_v`... */
export interface BorrowerFigures {
  readonly limit: Money;
  readonly outstanding: Money;
  readonly pending: Money;
  /** ...except this one, which is the guard's cap. See the header. */
  readonly available: Money;
}

export interface LenderFigures {
  readonly limit: Money;
  readonly outstanding: Money;
  /** Committed and not yet disbursed: the lender's separate at-risk column. */
  readonly atRisk: Money;
  /** `approved_limit - outstanding`. Exposure headroom, ignoring requests. */
  readonly undrawn: Money;
}

export function borrowerFigures(facts: LoanFacts, excludeReleaseId?: string | null): BorrowerFigures {
  const context = creditReleaseContextFor(facts, {
    requestedAmount: null,
    excludeReleaseId: excludeReleaseId ?? null,
  });
  return {
    limit: facts.balance.approved_limit,
    outstanding: facts.balance.outstanding,
    pending: facts.balance.pending,
    available: availableCredit(context),
  };
}

/**
 * Takes the balance row alone, not the whole file: the lender's reading needs
 * no release list, because pending is a column of the view rather than
 * something recomputed. That is what lets the queue read a hundred loans'
 * figures from one round trip.
 */
export function lenderFigures(balance: LoanBalance): LenderFigures {
  return {
    limit: balance.approved_limit,
    outstanding: balance.outstanding,
    atRisk: balance.pending,
    undrawn: lenderUndrawnLimit(balance),
  };
}

/**
 * The borrower's figure where there is no release list to hand -- the loans
 * list, which reads every balance in one round trip rather than one file per
 * card.
 *
 * `loan_balance_v.available` and `availableCredit` are the same quantity by
 * construction: the view sums the same three pending states @lj/domain names,
 * and the spec beside this file asserts the two agree on the seeded row. What
 * is restated here is only the floor, because the view reports a negative
 * available on an over-drawn loan and the rules do not -- and a card that said
 * "-$10,000.00 available" would be read by somebody as an amount they can ask
 * for.
 */
export function availableFromBalance(balance: LoanBalance): Money {
  return balance.available < 0 ? ZERO_MONEY : balance.available;
}
