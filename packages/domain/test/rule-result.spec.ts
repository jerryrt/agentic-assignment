import { describe, expect, it } from 'vitest';

import {
  RULE_DELTA_UNITS,
  RULE_SEVERITIES,
  RULE_STATUSES,
  RuleResultSchema,
  basisPointsDelta,
  blockingRuleResults,
  moneyDelta,
  moneyFromNumericString,
  overallRuleStatus,
  ruleFailed,
  rulePassed,
  ruleUnknown,
  unresolvedRuleResults,
} from '../src/index.js';

const money = moneyFromNumericString;

describe('the vocabulary', () => {
  it('has exactly three statuses, with unknown among them', () => {
    expect([...RULE_STATUSES]).toEqual(['pass', 'fail', 'unknown']);
  });

  it('separates a blocking criterion from an advisory one', () => {
    expect([...RULE_SEVERITIES]).toEqual(['error', 'warning']);
  });

  it('names the units a delta can be measured in', () => {
    expect([...RULE_DELTA_UNITS]).toEqual([
      'money_minor_units',
      'basis_points',
      'count',
      'years',
      'acres',
    ]);
  });
});

describe('constructing a result', () => {
  it('builds a pass with no gap and nothing missing', () => {
    const result = rulePassed({
      id: 'min_acreage',
      label: 'Minimum acreage',
      explain: 'Needs 200 acres -- you have 480',
      inputs: { acreage: 480 },
    });
    expect(result.status).toBe('pass');
    expect(result.severity).toBe('error');
    expect(result.delta).toBeNull();
    expect(result.missing).toEqual([]);
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('builds a fail that carries the delta to passing', () => {
    const result = ruleFailed({
      id: 'max_ltv',
      label: 'Maximum loan to value',
      explain: 'LTV 88% (max 80%) -- borrow $164,000, or add $30,000 down',
      inputs: { ltv_bps: 8_800 },
      delta: basisPointsDelta({ actual: 8_800, required: 8_000 }),
    });
    expect(result.status).toBe('fail');
    expect(result.delta).toEqual({
      unit: 'basis_points',
      actual: 8_800,
      required: 8_000,
      shortfall: 800,
      direction: 'decrease',
    });
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  // 'unknown' is the load-bearing status: on step one nothing has been entered,
  // and a wall of red on a form the applicant has barely started is the exact
  // failure this vocabulary exists to prevent.
  it('builds an unknown that names the inputs it is still waiting for', () => {
    const result = ruleUnknown({
      id: 'dscr_floor',
      label: 'Debt service coverage',
      explain: 'Enter net operating income and annual debt service to see this',
      missing: ['net_operating_income', 'annual_debt_service'],
    });
    expect(result.status).toBe('unknown');
    expect(result.missing).toEqual(['net_operating_income', 'annual_debt_service']);
    expect(result.delta).toBeNull();
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('lets a criterion be advisory rather than blocking', () => {
    const result = ruleFailed({
      id: 'years_farming',
      label: 'Years farming',
      explain: 'Under three years -- a guarantor may be requested',
      severity: 'warning',
    });
    expect(result.severity).toBe('warning');
  });

  it('defaults inputs to an empty record so the explain drawer never sees undefined', () => {
    expect(rulePassed({ id: 'a', label: 'A', explain: 'ok' }).inputs).toEqual({});
  });
});

describe('building a delta', () => {
  it('derives the shortfall and the direction from the two figures', () => {
    expect(moneyDelta({ actual: money('10000.00'), required: money('25000.00') })).toEqual({
      unit: 'money_minor_units',
      actual: 1_000_000,
      required: 2_500_000,
      shortfall: 1_500_000,
      direction: 'increase',
    });
    expect(moneyDelta({ actual: money('600000.00'), required: money('500000.00') })).toEqual({
      unit: 'money_minor_units',
      actual: 60_000_000,
      required: 50_000_000,
      shortfall: 10_000_000,
      direction: 'decrease',
    });
  });

  it('reports a met threshold as a zero shortfall, not as a negative one', () => {
    const delta = basisPointsDelta({ actual: 12_500, required: 12_500 });
    expect(delta.shortfall).toBe(0);
    expect(delta.direction).toBe('increase');
  });
});

describe('the schema, which is what an eligibility snapshot round-trips through', () => {
  const valid = {
    id: 'min_acreage',
    label: 'Minimum acreage',
    status: 'pass',
    severity: 'error',
    explain: 'Needs 200 acres -- you have 480',
    inputs: { acreage: 480 },
    missing: [],
    delta: null,
  };

  it('accepts a well-formed result', () => {
    expect(RuleResultSchema.parse(valid)).toEqual(valid);
  });

  it('survives a JSON round trip unchanged', () => {
    const parsed: unknown = JSON.parse(JSON.stringify(valid));
    expect(RuleResultSchema.parse(parsed)).toEqual(valid);
  });

  it('rejects an unknown that cannot say what is missing', () => {
    expect(RuleResultSchema.safeParse({ ...valid, status: 'unknown' }).success).toBe(false);
  });

  it('rejects a resolved status that still claims a missing input', () => {
    expect(RuleResultSchema.safeParse({ ...valid, missing: ['acreage'] }).success).toBe(false);
  });

  it('rejects a delta on anything but a failure, because only a failure has a gap', () => {
    const delta = { unit: 'acres', actual: 120, required: 200, shortfall: 80, direction: 'increase' };
    expect(RuleResultSchema.safeParse({ ...valid, delta }).success).toBe(false);
    expect(
      RuleResultSchema.safeParse({ ...valid, status: 'fail', explain: 'short', delta }).success,
    ).toBe(true);
  });

  it('rejects a delta whose shortfall disagrees with its own figures', () => {
    const delta = { unit: 'acres', actual: 120, required: 200, shortfall: 999, direction: 'increase' };
    expect(RuleResultSchema.safeParse({ ...valid, status: 'fail', delta }).success).toBe(false);
  });

  it('rejects a delta whose direction disagrees with its own figures', () => {
    const delta = { unit: 'acres', actual: 120, required: 200, shortfall: 80, direction: 'decrease' };
    expect(RuleResultSchema.safeParse({ ...valid, status: 'fail', delta }).success).toBe(false);
  });

  it('rejects an empty id, label or explanation', () => {
    expect(RuleResultSchema.safeParse({ ...valid, id: '' }).success).toBe(false);
    expect(RuleResultSchema.safeParse({ ...valid, label: '' }).success).toBe(false);
    expect(RuleResultSchema.safeParse({ ...valid, explain: '' }).success).toBe(false);
  });

  it('rejects a status outside the vocabulary', () => {
    expect(RuleResultSchema.safeParse({ ...valid, status: 'maybe' }).success).toBe(false);
  });
});

describe('folding many results into one answer', () => {
  const pass = rulePassed({ id: 'a', label: 'A', explain: 'ok' });
  const fail = ruleFailed({ id: 'b', label: 'B', explain: 'no' });
  const pending = ruleUnknown({ id: 'c', label: 'C', explain: 'tell us', missing: ['x'] });
  const warn = ruleFailed({ id: 'd', label: 'D', explain: 'hm', severity: 'warning' });

  it('treats an empty criteria set as passing: nothing disqualifies', () => {
    expect(overallRuleStatus([])).toBe('pass');
  });

  it('passes only when every blocking criterion passes', () => {
    expect(overallRuleStatus([pass, pass])).toBe('pass');
  });

  it('reports unknown while a blocking criterion is still unevaluable', () => {
    expect(overallRuleStatus([pass, pending])).toBe('unknown');
  });

  it('lets a known failure outrank a missing input, because it is already decided', () => {
    expect(overallRuleStatus([pending, fail])).toBe('fail');
  });

  it('never lets a warning change the answer', () => {
    expect(overallRuleStatus([pass, warn])).toBe('pass');
    expect(blockingRuleResults([pass, warn])).toEqual([]);
  });

  it('lists exactly the results that block, and exactly those still unevaluable', () => {
    expect(blockingRuleResults([pass, fail, pending, warn])).toEqual([fail]);
    expect(unresolvedRuleResults([pass, fail, pending, warn])).toEqual([pending]);
  });
});
