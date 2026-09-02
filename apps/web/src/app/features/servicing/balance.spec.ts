import {
  CreditReleaseSchema,
  LoanBalanceSchema,
  moneyFromNumericString,
  type CreditRelease,
  type LoanBalance,
} from '@lj/domain';
import { evaluateCreditRelease } from '@lj/rules';

import {
  borrowerFigures,
  creditReleaseContextFor,
  lenderFigures,
  type LoanFacts,
} from './balance.ts';

/**
 * The figures 0007_servicing.sql seeds, as the handoff on issue #50 states
 * them. They are used here rather than invented ones because the whole point of
 * the seed is that the borrower's number and the lender's number differ
 * visibly: a screen that confused them is caught by looking.
 */
const LOAN = '00000000-0000-4000-8000-0000000000e1';
const BORROWER = '00000000-0000-4000-8000-0000000000c2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const DRAFT = '00000000-0000-4000-8000-0000000000f4';
const NOW = '2026-09-01T12:00:00.000+00:00';

function balance(patch: Record<string, unknown> = {}): LoanBalance {
  return LoanBalanceSchema.parse({
    loan_id: LOAN,
    borrower_id: BORROWER,
    org_id: ORG,
    approved_limit: '250000.00',
    outstanding: '128442.47',
    pending: '30000.00',
    available: '91557.53',
    ...patch,
  });
}

function release(patch: Record<string, unknown> = {}): CreditRelease {
  return CreditReleaseSchema.parse({
    id: '00000000-0000-4000-8000-0000000000f3',
    loan_id: LOAN,
    amount: '30000.00',
    purpose: 'Spring inputs',
    state: 'under_review',
    revision: 1,
    requested_by: BORROWER,
    decided_by: null,
    decline_reason: null,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  });
}

function facts(patch: Partial<LoanFacts> = {}): LoanFacts {
  return {
    status: 'active',
    balance: balance(),
    releases: [release()],
    ...patch,
  };
}

describe('the borrower figure and the guard', () => {
  it('shows exactly what loan_balance_v derived', () => {
    expect(borrowerFigures(facts()).available).toBe(moneyFromNumericString('91557.53'));
  });

  it('shows the lender undrawn limit, which is larger by exactly the pending column', () => {
    const lender = lenderFigures(facts());
    const borrower = borrowerFigures(facts());

    expect(lender.undrawn).toBe(moneyFromNumericString('121557.53'));
    expect(lender.atRisk).toBe(moneyFromNumericString('30000.00'));
    expect(lender.undrawn - borrower.available).toBe(lender.atRisk);
  });

  /**
   * THE INVARIANT THIS FEATURE EXISTS FOR. The number the borrower is shown is
   * the number the submit guard compares against, so a request for exactly that
   * amount is allowed and one cent more is refused. If these two ever came from
   * different computations, a borrower could submit a request the screen had
   * just told them was affordable.
   */
  it('admits a request for the whole of the figure on screen', () => {
    const shown = borrowerFigures(facts()).available;
    const results = evaluateCreditRelease(
      creditReleaseContextFor(facts(), { requestedAmount: shown }),
    );

    expect(results.find((result) => result.id === 'release_within_available')?.status).toBe('pass');
  });

  it('refuses one cent more than the figure on screen', () => {
    const shown = borrowerFigures(facts()).available;
    const results = evaluateCreditRelease(
      creditReleaseContextFor(facts(), { requestedAmount: (shown + 1) as typeof shown }),
    );

    expect(results.find((result) => result.id === 'release_within_available')?.status).toBe('fail');
  });

  /**
   * The draft being composed is not one of the requests holding credit back --
   * nobody has been asked about it yet -- so it must not count against its own
   * cap. Without the exclusion a borrower typing 1,000 would watch their own
   * typing reduce what they are allowed to type.
   */
  it('does not hold a draft back against itself', () => {
    const draft = release({ id: DRAFT, amount: '5000.00', state: 'draft' });
    const withDraft = facts({ releases: [release(), draft] });

    const context = creditReleaseContextFor(withDraft, {
      requestedAmount: moneyFromNumericString('5000.00'),
      excludeReleaseId: DRAFT,
    });

    expect(context.otherReleases).toHaveLength(1);
    expect(borrowerFigures(withDraft).available).toBe(moneyFromNumericString('91557.53'));
  });

  /**
   * `loan_balance_v` reports a negative `available` on an over-drawn loan and
   * @lj/rules floors the cap at zero. The screen follows the rules, because the
   * figure is the guard's: showing -4,000 as "available" invites a reading
   * nobody intends, and showing it while the guard says zero is the divergence
   * this file exists to prevent.
   */
  it('floors an over-drawn loan at zero, as the guard does', () => {
    const overdrawn = facts({
      balance: balance({ outstanding: '260000.00', pending: '0.00', available: '-10000.00' }),
      releases: [],
    });

    expect(borrowerFigures(overdrawn).available).toBe(0);
    expect(lenderFigures(overdrawn).undrawn).toBe(moneyFromNumericString('-10000.00'));
  });

  it('carries the loan status into the context the guard reads', () => {
    const closed = creditReleaseContextFor(facts({ status: 'closed' }), {
      requestedAmount: moneyFromNumericString('1000.00'),
    });
    const results = evaluateCreditRelease(closed);

    expect(results.find((result) => result.id === 'loan_is_active')?.status).toBe('fail');
  });

  it('reports no requested amount as unknown rather than as a refusal', () => {
    const results = evaluateCreditRelease(
      creditReleaseContextFor(facts(), { requestedAmount: null }),
    );

    expect(results.find((result) => result.id === 'release_minimum_amount')?.status).toBe(
      'unknown',
    );
  });
});
