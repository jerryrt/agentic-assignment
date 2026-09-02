import { describe, expect, it } from 'vitest';

import { RuleResultSchema, moneyFromNumericString, type Money } from '@lj/domain';

import {
  CREDIT_RELEASE_MINIMUM_AMOUNT,
  PENDING_CREDIT_RELEASE_STATES,
  availableCredit,
  creditReleaseRules,
  creditReleaseSubmittable,
  evaluateCreditRelease,
  pendingCredit,
  type CreditReleaseContext,
} from '../src/index.ts';

const money = moneyFromNumericString;

const base: CreditReleaseContext = {
  requestedAmount: money('40000.00'),
  loan: { status: 'active', approvedLimit: money('500000.00') },
  outstanding: money('300000.00'),
  otherReleases: [],
};

function resultsById(context: CreditReleaseContext) {
  const results = evaluateCreditRelease(context);
  for (const result of results) {
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  }
  return new Map(results.map((result) => [result.id, result]));
}

describe('the derived balance', () => {
  it('sums only the releases that are actually in flight', () => {
    const context: CreditReleaseContext = {
      ...base,
      otherReleases: [
        { id: 'r1', state: 'submitted', amount: money('10000.00') },
        { id: 'r2', state: 'under_review', amount: money('5000.00') },
        { id: 'r3', state: 'approved', amount: money('2500.00') },
        { id: 'r4', state: 'declined', amount: money('90000.00') },
        { id: 'r5', state: 'cancelled', amount: money('90000.00') },
        { id: 'r6', state: 'funded', amount: money('90000.00') },
        { id: 'r7', state: 'draft', amount: money('90000.00') },
      ],
    };
    expect(pendingCredit(context)).toBe(money('17500.00'));
  });

  it('names the states that count as pending', () => {
    expect([...PENDING_CREDIT_RELEASE_STATES]).toEqual(['submitted', 'under_review', 'approved']);
  });

  // A funded release is already in the ledger, so counting it as pending as
  // well would hold the same money back twice.
  it('is the limit less what is drawn and less what is already requested', () => {
    expect(availableCredit(base)).toBe(money('200000.00'));
    expect(
      availableCredit({
        ...base,
        otherReleases: [{ id: 'r1', state: 'submitted', amount: money('50000.00') }],
      }),
    ).toBe(money('150000.00'));
  });

  it('does not go below zero when a loan is over its limit', () => {
    expect(availableCredit({ ...base, outstanding: money('600000.00') })).toBe(0 as Money);
  });
});

describe('the rule set that guards draft -> submitted', () => {
  it('is the four checks plan 06 names, in order', () => {
    expect(creditReleaseRules.map((rule) => rule.id)).toEqual([
      'release_minimum_amount',
      'release_within_available',
      'loan_is_active',
      'no_other_pending_release',
    ]);
  });
});

describe('the minimum request', () => {
  it('is one thousand dollars, stated once', () => {
    expect(CREDIT_RELEASE_MINIMUM_AMOUNT).toBe(money('1000.00'));
  });

  it('accepts a request exactly at the minimum', () => {
    const context: CreditReleaseContext = { ...base, requestedAmount: money('1000.00') };
    expect(resultsById(context).get('release_minimum_amount')?.status).toBe('pass');
  });

  it('refuses one cent under it, and says by how much', () => {
    const context: CreditReleaseContext = { ...base, requestedAmount: money('999.99') };
    const result = resultsById(context).get('release_minimum_amount');
    expect(result?.status).toBe('fail');
    expect(result?.explain).toBe(
      'Needs $1,000.00 or more -- you are at $999.99. Increase by $0.01.',
    );
  });
});

describe('the available credit cap', () => {
  // The guard and the figure the borrower is shown are the same quantity. If
  // they differed, a borrower could submit a request the screen called fine.
  it('accepts a request for exactly what is available', () => {
    const context: CreditReleaseContext = { ...base, requestedAmount: availableCredit(base) };
    expect(resultsById(context).get('release_within_available')?.status).toBe('pass');
  });

  it('refuses one cent more, quoting the same figure the borrower is shown', () => {
    const context: CreditReleaseContext = { ...base, requestedAmount: money('200000.01') };
    const result = resultsById(context).get('release_within_available');
    expect(result?.status).toBe('fail');
    expect(result?.explain).toBe(
      'Must be $200,000.00 or less -- you are at $200,000.01. Reduce by $0.01.',
    );
  });

  it('accounts for another request already with the lender', () => {
    const context: CreditReleaseContext = {
      ...base,
      requestedAmount: money('200000.00'),
      otherReleases: [{ id: 'r1', state: 'submitted', amount: money('50000.00') }],
    };
    expect(resultsById(context).get('release_within_available')?.status).toBe('fail');
  });
});

describe('the loan itself', () => {
  it('passes on an active loan', () => {
    expect(resultsById(base).get('loan_is_active')?.status).toBe('pass');
  });

  it.each(['closed', 'delinquent'] as const)('refuses on a %s loan', (status) => {
    const context: CreditReleaseContext = { ...base, loan: { ...base.loan, status } };
    const result = resultsById(context).get('loan_is_active');
    expect(result?.status).toBe('fail');
    expect(result?.explain).toBe('This loan is not active -- no further credit can be released.');
  });
});

describe('one request at a time', () => {
  it('passes when nothing else is in flight', () => {
    expect(resultsById(base).get('no_other_pending_release')?.status).toBe('pass');
  });

  it('refuses a second request while the first is still with the lender', () => {
    const context: CreditReleaseContext = {
      ...base,
      otherReleases: [{ id: 'r1', state: 'under_review', amount: money('1000.00') }],
    };
    const result = resultsById(context).get('no_other_pending_release');
    expect(result?.status).toBe('fail');
    expect(result?.explain).toBe(
      'You already have a request with your lender -- one at a time.',
    );
  });

  it('ignores a request that has already been decided', () => {
    const context: CreditReleaseContext = {
      ...base,
      otherReleases: [{ id: 'r1', state: 'declined', amount: money('1000.00') }],
    };
    expect(resultsById(context).get('no_other_pending_release')?.status).toBe('pass');
  });
});

describe('a request nobody has typed an amount into yet', () => {
  it('is unknown on the amount rules and decided on the rest', () => {
    const context: CreditReleaseContext = { ...base, requestedAmount: null };
    const results = resultsById(context);
    expect(results.get('release_minimum_amount')?.status).toBe('unknown');
    expect(results.get('release_minimum_amount')?.missing).toEqual(['amount']);
    expect(results.get('release_within_available')?.status).toBe('unknown');
    expect(results.get('loan_is_active')?.status).toBe('pass');
  });
});

describe('creditReleaseSubmittable', () => {
  it('allows a well-formed request on an active loan', () => {
    expect(creditReleaseSubmittable(base).ok).toBe(true);
  });

  it('refuses and reports every blocker at once, not just the first', () => {
    const decision = creditReleaseSubmittable({
      ...base,
      requestedAmount: money('999.00'),
      loan: { ...base.loan, status: 'closed' },
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.blockers.map((result) => result.id)).toEqual([
      'release_minimum_amount',
      'loan_is_active',
    ]);
  });

  it('refuses while the amount is still unknown', () => {
    expect(creditReleaseSubmittable({ ...base, requestedAmount: null }).ok).toBe(false);
  });
});
