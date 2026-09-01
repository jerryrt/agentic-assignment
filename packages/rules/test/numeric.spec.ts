import { describe, expect, it } from 'vitest';

import { RuleResultSchema, type RuleStatus } from '@lj/domain';

import {
  awaiting,
  known,
  missingInput,
  numericAtLeast,
  numericAtMost,
  numericWithinBand,
  readNumber,
  type Reading,
} from '../src/index.js';

/** The context these comparators read is just the reading under test. */
type Ctx = Reading<number>;

const identity = (context: Ctx): Reading<number> => context;

const dscrFloor = numericAtLeast<Ctx>({
  id: 'dscr_floor',
  label: 'Debt service coverage',
  figure: 'ratio',
  minimum: 12_500,
  read: identity,
});

const maxLtv = numericAtMost<Ctx>({
  id: 'max_ltv',
  label: 'Loan to value',
  figure: 'percentage',
  maximum: 8_000,
  read: identity,
});

const amountBand = numericWithinBand<Ctx>({
  id: 'amount_band',
  label: 'Loan amount',
  figure: 'money',
  minimum: 2_500_000,
  maximum: 50_000_000,
  read: identity,
});

const waitingForDscr = awaiting([
  missingInput('net_operating_income', 'net operating income'),
  missingInput('annual_debt_service', 'annual debt service'),
]);

describe('numericAtLeast', () => {
  const cases: readonly (readonly [string, Reading<number>, RuleStatus, string])[] = [
    // The boundary sits exactly on the threshold: a coverage ratio of exactly
    // 1.25 meets a 1.25 floor, and that is decidable only because both sides
    // are integers.
    ['exactly at the floor', known(12_500), 'pass', 'Needs 1.25 or more -- you are at 1.25.'],
    ['one basis point under', known(12_499), 'fail', 'Needs 1.25 or more -- you are at 1.24.'],
    ['comfortably over', known(14_200), 'pass', 'Needs 1.25 or more -- you are at 1.42.'],
    [
      'well under',
      known(10_800),
      'fail',
      'Needs 1.25 or more -- you are at 1.08. Increase by 0.17.',
    ],
    [
      'nothing entered yet',
      waitingForDscr,
      'unknown',
      'Needs 1.25 or more -- enter net operating income and annual debt service.',
    ],
  ];

  it.each(cases)('%s', (_name, reading, status, explain) => {
    const result = dscrFloor.evaluate(reading);
    expect(result.status).toBe(status);
    expect(result.explain).toBe(explain);
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('carries the gap to passing on a failure', () => {
    expect(dscrFloor.evaluate(known(10_800)).delta).toEqual({
      unit: 'basis_points',
      actual: 10_800,
      required: 12_500,
      shortfall: 1_700,
      direction: 'increase',
    });
  });

  it('names the inputs it is waiting for, machine-readably', () => {
    const result = dscrFloor.evaluate(waitingForDscr);
    expect(result.missing).toEqual(['net_operating_income', 'annual_debt_service']);
  });

  it('records what it read for the explanation drawer', () => {
    expect(dscrFloor.evaluate(known(14_200)).inputs).toEqual({
      actual: 14_200,
      minimum: 12_500,
      figure: 'ratio',
    });
  });

  // "Increase by 0.00" is worse than saying nothing: the shortfall is real but
  // it rounds away at the precision a coverage ratio is quoted to.
  it('omits the advice when the gap rounds away at the figure precision', () => {
    expect(dscrFloor.evaluate(known(12_499)).explain).not.toContain('Increase by');
  });

  it('defaults to blocking severity and honours an advisory one', () => {
    expect(dscrFloor.evaluate(known(12_500)).severity).toBe('error');
    const advisory = numericAtLeast<Ctx>({
      id: 'soft_floor',
      label: 'Soft floor',
      figure: 'ratio',
      minimum: 12_500,
      severity: 'warning',
      read: identity,
    });
    expect(advisory.evaluate(known(10_000)).severity).toBe('warning');
  });
});

describe('numericAtMost', () => {
  const cases: readonly (readonly [string, Reading<number>, RuleStatus, string])[] = [
    ['exactly at the cap', known(8_000), 'pass', 'Must be 80% or less -- you are at 80%.'],
    [
      'one basis point over',
      known(8_001),
      'fail',
      'Must be 80% or less -- you are at 80.01%. Reduce by 0.01%.',
    ],
    ['under the cap', known(6_200), 'pass', 'Must be 80% or less -- you are at 62%.'],
    [
      'over the cap',
      known(8_800),
      'fail',
      'Must be 80% or less -- you are at 88%. Reduce by 8%.',
    ],
    [
      'no collateral entered',
      awaiting([missingInput('collateral_value', 'the value of the security')]),
      'unknown',
      'Must be 80% or less -- enter the value of the security.',
    ],
  ];

  it.each(cases)('%s', (_name, reading, status, explain) => {
    const result = maxLtv.evaluate(reading);
    expect(result.status).toBe(status);
    expect(result.explain).toBe(explain);
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('points the delta downward', () => {
    expect(maxLtv.evaluate(known(8_800)).delta).toEqual({
      unit: 'basis_points',
      actual: 8_800,
      required: 8_000,
      shortfall: 800,
      direction: 'decrease',
    });
  });
});

describe('numericWithinBand', () => {
  const cases: readonly (readonly [string, Reading<number>, RuleStatus, string])[] = [
    [
      'exactly at the floor of the band',
      known(2_500_000),
      'pass',
      'Between $25,000.00 and $500,000.00 -- you asked for $25,000.00.',
    ],
    [
      'exactly at the ceiling of the band',
      known(50_000_000),
      'pass',
      'Between $25,000.00 and $500,000.00 -- you asked for $500,000.00.',
    ],
    [
      'one cent below the band',
      known(2_499_999),
      'fail',
      'Between $25,000.00 and $500,000.00 -- you asked for $24,999.99. Increase by $0.01.',
    ],
    [
      'above the band',
      known(60_000_000),
      'fail',
      'Between $25,000.00 and $500,000.00 -- you asked for $600,000.00. Reduce by $100,000.00.',
    ],
    [
      'no amount entered',
      awaiting([missingInput('requested_amount', 'the amount you want to borrow')]),
      'unknown',
      'Between $25,000.00 and $500,000.00 -- enter the amount you want to borrow.',
    ],
  ];

  it.each(cases)('%s', (_name, reading, status, explain) => {
    const result = amountBand.evaluate(reading);
    expect(result.status).toBe(status);
    expect(result.explain).toBe(explain);
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('measures the gap to the nearer bound', () => {
    expect(amountBand.evaluate(known(1_000_000)).delta).toEqual({
      unit: 'money_minor_units',
      actual: 1_000_000,
      required: 2_500_000,
      shortfall: 1_500_000,
      direction: 'increase',
    });
  });

  it('reads as a floor when only a minimum is set', () => {
    const floorOnly = numericWithinBand<Ctx>({
      id: 'amount_band',
      label: 'Loan amount',
      figure: 'money',
      minimum: 2_500_000,
      maximum: null,
      read: identity,
    });
    expect(floorOnly.evaluate(known(60_000_000)).status).toBe('pass');
    expect(floorOnly.evaluate(known(1_000_000)).explain).toBe(
      'Needs $25,000.00 or more -- you are at $10,000.00. Increase by $15,000.00.',
    );
  });

  it('reads as a cap when only a maximum is set', () => {
    const capOnly = numericWithinBand<Ctx>({
      id: 'amount_band',
      label: 'Loan amount',
      figure: 'money',
      minimum: null,
      maximum: 50_000_000,
      read: identity,
    });
    expect(capOnly.evaluate(known(60_000_000)).explain).toBe(
      'Must be $500,000.00 or less -- you are at $600,000.00. Reduce by $100,000.00.',
    );
  });

  // A product with neither bound still renders a row, so the panel does not
  // gain and lose a line as products load.
  it('passes anything when the product sets no bound at all', () => {
    const unbounded = numericWithinBand<Ctx>({
      id: 'amount_band',
      label: 'Loan amount',
      figure: 'money',
      minimum: null,
      maximum: null,
      read: identity,
    });
    const result = unbounded.evaluate(known(60_000_000));
    expect(result.status).toBe('pass');
    expect(result.explain).toBe('Any amount -- you asked for $600,000.00.');
  });
});

describe('readings', () => {
  it('turns a present value into a known reading', () => {
    expect(readNumber(200, 'total_acres', 'total acres')).toEqual({
      known: true,
      value: 200,
      inputs: {},
    });
  });

  it('turns an absent value into a reading that names what it wants', () => {
    expect(readNumber(null, 'total_acres', 'total acres')).toEqual({
      known: false,
      missing: [{ field: 'total_acres', label: 'total acres' }],
      inputs: {},
    });
  });

  // Zero is a number the applicant entered, not an absence. Conflating the two
  // is how a form reports "we need more information" about a field already
  // filled in.
  it('treats zero as entered', () => {
    expect(readNumber(0, 'total_acres', 'total acres').known).toBe(true);
  });
});
