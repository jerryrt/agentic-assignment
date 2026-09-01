import { describe, expect, it } from 'vitest';

import { RuleResultSchema, moneyFromNumericString } from '@lj/domain';

import { numericAgreement, readNumber, type Tolerance } from '../src/index.js';

interface Pair {
  readonly left: number | null;
  readonly right: number | null;
}

function acreageRule(tolerance: Tolerance) {
  return numericAgreement<Pair>({
    id: 'acreage_matches_application',
    label: 'Acreage on the deed matches the application',
    figure: 'acres',
    tolerance,
    left: {
      name: 'The deed',
      read: (context) => readNumber(context.left, 'land_title.total_acres', 'the acreage on the deed'),
    },
    right: {
      name: 'your application',
      read: (context) => readNumber(context.right, 'farm.total_acres', 'the acreage on your application'),
    },
  });
}

const twoPercent = acreageRule({ kind: 'percent', basisPoints: 200 });

describe('numericAgreement with a percent tolerance', () => {
  it('passes when the two figures are identical', () => {
    const result = twoPercent.evaluate({ left: 1240, right: 1240 });
    expect(result.status).toBe('pass');
    expect(result.explain).toBe('The deed and your application agree: 1240 acres.');
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('passes inside the tolerance and shows both values and the tolerance', () => {
    const result = twoPercent.evaluate({ left: 1240, right: 1220 });
    expect(result.status).toBe('pass');
    expect(result.explain).toBe(
      'The deed: 1240 acres; your application: 1220 acres -- 1.61% apart, ' +
        'within the 2% we allow.',
    );
  });

  // Exactly at the tolerance: 20 acres on 1000 is 2.00%, and a rule that says
  // "we allow 2%" has to allow 2%.
  it('passes exactly at the tolerance', () => {
    expect(twoPercent.evaluate({ left: 1000, right: 980 }).status).toBe('pass');
  });

  it('fails one basis point past the tolerance', () => {
    const result = twoPercent.evaluate({ left: 1000, right: 979 });
    expect(result.status).toBe('fail');
    expect(result.explain).toBe(
      'The deed: 1000 acres; your application: 979 acres -- 2.1% apart, we allow 2%.',
    );
  });

  // The gap is measured against the larger figure so that swapping the two
  // sides cannot change the verdict. Dividing by whichever happened to be
  // named first would make the rule depend on the order of its arguments.
  it('gives the same answer whichever side is named first', () => {
    const forward = twoPercent.evaluate({ left: 1000, right: 979 });
    const reversed = acreageRule({ kind: 'percent', basisPoints: 200 }).evaluate({
      left: 979,
      right: 1000,
    });
    expect(reversed.status).toBe(forward.status);
    expect(reversed.delta).toEqual(forward.delta);
  });

  it('measures the gap against the tolerance, in basis points', () => {
    expect(twoPercent.evaluate({ left: 1000, right: 979 }).delta).toEqual({
      unit: 'basis_points',
      actual: 210,
      required: 200,
      shortfall: 10,
      direction: 'decrease',
    });
  });

  it('is unknown while either side is missing, and names it', () => {
    const result = twoPercent.evaluate({ left: null, right: 1240 });
    expect(result.status).toBe('unknown');
    expect(result.missing).toEqual(['land_title.total_acres']);
    expect(result.explain).toBe('Cannot compare until we have the acreage on the deed.');
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('is unknown naming both sides when neither has arrived', () => {
    expect(twoPercent.evaluate({ left: null, right: null }).missing).toEqual([
      'land_title.total_acres',
      'farm.total_acres',
    ]);
  });

  it('passes two zeroes rather than dividing by one', () => {
    expect(twoPercent.evaluate({ left: 0, right: 0 }).status).toBe('pass');
  });
});

describe('numericAgreement with an absolute tolerance', () => {
  const fiftyAcres = acreageRule({ kind: 'absolute', value: 50 });

  it('passes exactly at the tolerance', () => {
    expect(fiftyAcres.evaluate({ left: 1240, right: 1190 }).status).toBe('pass');
  });

  it('fails one unit past it, in the figure own unit', () => {
    const result = fiftyAcres.evaluate({ left: 1240, right: 1189 });
    expect(result.status).toBe('fail');
    expect(result.explain).toBe(
      'The deed: 1240 acres; your application: 1189 acres -- 51 acres apart, ' +
        'we allow 50 acres.',
    );
    expect(result.delta).toEqual({
      unit: 'acres',
      actual: 51,
      required: 50,
      shortfall: 1,
      direction: 'decrease',
    });
  });
});

describe('numericAgreement with no tolerance at all', () => {
  const exact = acreageRule({ kind: 'exact' });

  it('passes only on equality', () => {
    expect(exact.evaluate({ left: 1240, right: 1240 }).status).toBe('pass');
  });

  it('fails on any difference and says so plainly', () => {
    const result = exact.evaluate({ left: 1240, right: 1239 });
    expect(result.status).toBe('fail');
    expect(result.explain).toBe(
      'The deed: 1240 acres; your application: 1239 acres -- these must match exactly.',
    );
  });
});

describe('numericAgreement over money', () => {
  const money = moneyFromNumericString;

  // The worked example from plan 04: a tax return and a financial statement
  // that disagree by more than the 5 percent a real pack is allowed.
  const incomeAgrees = numericAgreement<Pair>({
    id: 'income_matches_financials',
    label: 'Net farm income agrees across tax return and financial statement',
    figure: 'money',
    severity: 'warning',
    tolerance: { kind: 'percent', basisPoints: 500 },
    left: {
      name: 'The 2024 tax return',
      read: (context) => readNumber(context.left, 'tax_return_2024.net_farm_income', 'net farm income on the tax return'),
    },
    right: {
      name: 'the financial statements',
      read: (context) => readNumber(context.right, 'financial_statements.net_income', 'net income on the financial statements'),
    },
  });

  it('fails the plan worked example, as an advisory rather than a block', () => {
    const result = incomeAgrees.evaluate({
      left: money('184200.00'),
      right: money('171500.00'),
    });
    expect(result.status).toBe('fail');
    expect(result.severity).toBe('warning');
    expect(result.explain).toBe(
      'The 2024 tax return: $184,200.00; the financial statements: $171,500.00 ' +
        '-- 6.89% apart, we allow 5%.',
    );
  });
});
