import { describe, expect, it } from 'vitest';

import { RuleResultSchema, moneyFromNumericString, type Money } from '@lj/domain';

import {
  ELIGIBILITY_CRITERIA_VERSION,
  ELIGIBILITY_FIELD_NAMES,
  EMPTY_ELIGIBILITY_CONTEXT,
  atLeastOneEligibleProduct,
  eligibilityRules,
  eligibleProducts,
  evaluateEligibility,
  parseEligibilityCriteria,
  type EligibilityContext,
  type EligibilityProduct,
} from '../src/index.ts';

const money = moneyFromNumericString;

/**
 * The seeded Operating Line of Credit from supabase/seed.sql, in the encoding
 * this package accepts: thresholds are integers in the field's own unit, so a
 * coverage ratio floor of 1.25 is 12500 basis points.
 */
const operatingLineCriteria: unknown = {
  version: 1,
  rules: [
    {
      id: 'min_acreage',
      label: 'Minimum acreage',
      kind: 'min',
      field: 'total_acres',
      threshold: 200,
      severity: 'error',
    },
    {
      id: 'dscr_floor',
      label: 'Debt service coverage',
      kind: 'min',
      field: 'dscr',
      threshold: 12_500,
      severity: 'error',
    },
    {
      id: 'eligible_commodity',
      label: 'Eligible commodity',
      kind: 'one_of',
      field: 'primary_commodity',
      allowed: ['grain', 'oilseed'],
      severity: 'error',
    },
    {
      id: 'years_farming',
      label: 'Years farming',
      kind: 'min',
      field: 'years_farming',
      threshold: 3,
      severity: 'error',
    },
    {
      id: 'in_footprint',
      label: 'Operating region',
      kind: 'one_of',
      field: 'province',
      allowed: ['AB', 'SK', 'MB'],
      severity: 'error',
    },
  ],
};

const equipmentLoanCriteria: unknown = {
  version: 1,
  rules: [
    {
      id: 'dscr_floor',
      label: 'Debt service coverage',
      kind: 'min',
      field: 'dscr',
      threshold: 11_500,
      severity: 'error',
    },
    {
      id: 'max_ltv',
      label: 'Loan to value',
      kind: 'max',
      field: 'ltv',
      threshold: 8_000,
      severity: 'error',
    },
  ],
};

function parseOrThrow(value: unknown) {
  const parsed = parseEligibilityCriteria(value);
  if (!parsed.ok) {
    throw new Error(parsed.problems.join('; '));
  }
  return parsed.criteria;
}

const operatingLine: EligibilityProduct = {
  id: 'product-operating-line',
  name: 'Operating Line of Credit',
  minAmount: money('25000.00'),
  maxAmount: money('500000.00'),
  criteria: parseOrThrow(operatingLineCriteria),
};

const equipmentLoan: EligibilityProduct = {
  id: 'product-equipment-loan',
  name: 'Equipment Term Loan',
  minAmount: money('10000.00'),
  maxAmount: money('250000.00'),
  criteria: parseOrThrow(equipmentLoanCriteria),
};

const qualifying: EligibilityContext = {
  totalAcres: 2400,
  yearsFarming: 14,
  province: 'SK',
  primaryCommodity: 'grain',
  requestedAmount: money('180000.00'),
  netOperatingIncome: money('250000.00'),
  annualDebtService: money('150000.00'),
  collateralValue: money('1000000.00'),
};

function resultsById(context: EligibilityContext, product: EligibilityProduct) {
  const results = evaluateEligibility([product], context)[0]?.results ?? [];
  return new Map(results.map((result) => [result.id, result]));
}

describe('parseEligibilityCriteria', () => {
  it('accepts the seeded shape', () => {
    const parsed = parseEligibilityCriteria(operatingLineCriteria);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error('unreachable');
    }
    expect(parsed.criteria.version).toBe(ELIGIBILITY_CRITERIA_VERSION);
    expect(parsed.criteria.rules.map((rule) => rule.id)).toEqual([
      'min_acreage',
      'dscr_floor',
      'eligible_commodity',
      'years_farming',
      'in_footprint',
    ]);
  });

  it('defaults an omitted severity to blocking', () => {
    const parsed = parseOrThrow({
      version: 1,
      rules: [{ id: 'min_acreage', label: 'Minimum acreage', kind: 'min', field: 'total_acres', threshold: 200 }],
    });
    expect(parsed.rules[0]?.severity).toBe('error');
  });

  // A float threshold is the bug this whole unit system exists to prevent: it
  // makes ">= 1.25" undecidable exactly at 1.25.
  it('rejects a threshold that is not an integer in the field unit', () => {
    const parsed = parseEligibilityCriteria({
      version: 1,
      rules: [{ id: 'dscr_floor', label: 'Debt service coverage', kind: 'min', field: 'dscr', threshold: 1.25 }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error('unreachable');
    }
    expect(parsed.problems.join(' ')).toMatch(/dscr_floor.*integer/i);
  });

  // Fail closed: a typo in a product row must not quietly switch a criterion
  // off, because nothing downstream would ever notice a rule that is not there.
  it('rejects a field it does not know how to read', () => {
    const parsed = parseEligibilityCriteria({
      version: 1,
      rules: [{ id: 'oops', label: 'Oops', kind: 'min', field: 'total_acrs', threshold: 200 }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a numeric comparison against a categorical field', () => {
    const parsed = parseEligibilityCriteria({
      version: 1,
      rules: [{ id: 'in_footprint', label: 'Region', kind: 'min', field: 'province', threshold: 1 }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a list comparison against a numeric field', () => {
    const parsed = parseEligibilityCriteria({
      version: 1,
      rules: [{ id: 'min_acreage', label: 'Acres', kind: 'one_of', field: 'total_acres', allowed: ['200'] }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects two criteria sharing an id', () => {
    const parsed = parseEligibilityCriteria({
      version: 1,
      rules: [
        { id: 'min_acreage', label: 'Acres', kind: 'min', field: 'total_acres', threshold: 200 },
        { id: 'min_acreage', label: 'Acres again', kind: 'min', field: 'total_acres', threshold: 400 },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a version it was not written for', () => {
    expect(parseEligibilityCriteria({ version: 2, rules: [] }).ok).toBe(false);
  });

  it.each([null, 42, 'criteria', [], {}, { version: 1 }])('rejects %j outright', (value) => {
    expect(parseEligibilityCriteria(value).ok).toBe(false);
  });
});

describe('eligibilityRules', () => {
  it('renders one rule per criterion plus the amount band from the columns', () => {
    expect(eligibilityRules(operatingLine).map((rule) => rule.id)).toEqual([
      'min_acreage',
      'dscr_floor',
      'eligible_commodity',
      'years_farming',
      'in_footprint',
      'amount_band',
    ]);
  });

  it('omits the amount band when the product declares neither bound', () => {
    const unbounded: EligibilityProduct = { ...operatingLine, minAmount: null, maxAmount: null };
    expect(eligibilityRules(unbounded).map((rule) => rule.id)).not.toContain('amount_band');
  });
});

describe('evaluating a product against a complete application', () => {
  it('passes every criterion', () => {
    const evaluated = evaluateEligibility([operatingLine], qualifying)[0];
    expect(evaluated?.productId).toBe('product-operating-line');
    expect(evaluated?.productName).toBe('Operating Line of Credit');
    expect(evaluated?.status).toBe('pass');
    for (const result of evaluated?.results ?? []) {
      expect(RuleResultSchema.safeParse(result).success).toBe(true);
      expect(result.status).toBe('pass');
    }
  });

  it('derives the coverage ratio from the figures the applicant entered', () => {
    const dscr = resultsById(qualifying, operatingLine).get('dscr_floor');
    expect(dscr?.status).toBe('pass');
    expect(dscr?.explain).toBe('Needs 1.25 or more -- you are at 1.66.');
  });

  it('derives loan to value for the product that caps it', () => {
    const ltv = resultsById(qualifying, equipmentLoan).get('max_ltv');
    expect(ltv?.status).toBe('pass');
    expect(ltv?.explain).toBe('Must be 80% or less -- you are at 18%.');
  });
});

describe('the boundary of each seeded criterion', () => {
  const cases: readonly (readonly [string, Partial<EligibilityContext>, string, 'pass' | 'fail'])[] = [
    ['acreage exactly at the floor', { totalAcres: 200 }, 'min_acreage', 'pass'],
    ['one acre short', { totalAcres: 199 }, 'min_acreage', 'fail'],
    ['third year of farming', { yearsFarming: 3 }, 'years_farming', 'pass'],
    ['second year of farming', { yearsFarming: 2 }, 'years_farming', 'fail'],
    ['in the footprint', { province: 'MB' }, 'in_footprint', 'pass'],
    ['outside the footprint', { province: 'ON' }, 'in_footprint', 'fail'],
    ['an eligible commodity', { primaryCommodity: 'oilseed' }, 'eligible_commodity', 'pass'],
    ['an ineligible commodity', { primaryCommodity: 'livestock' }, 'eligible_commodity', 'fail'],
    [
      'coverage exactly at the floor',
      { netOperatingIncome: money('125000.00'), annualDebtService: money('100000.00') },
      'dscr_floor',
      'pass',
    ],
    [
      'coverage one basis point under',
      { netOperatingIncome: money('124990.00'), annualDebtService: money('100000.00') },
      'dscr_floor',
      'fail',
    ],
    [
      'amount exactly at the floor of the band',
      { requestedAmount: money('25000.00') },
      'amount_band',
      'pass',
    ],
    [
      'amount one cent under the band',
      { requestedAmount: money('24999.99') },
      'amount_band',
      'fail',
    ],
    [
      'amount exactly at the ceiling of the band',
      { requestedAmount: money('500000.00') },
      'amount_band',
      'pass',
    ],
    [
      'amount one cent over the band',
      { requestedAmount: money('500000.01') },
      'amount_band',
      'fail',
    ],
  ];

  it.each(cases)('%s is a %s for %s', (_name, overrides, ruleId, status) => {
    const context: EligibilityContext = { ...qualifying, ...overrides };
    expect(resultsById(context, operatingLine).get(ruleId)?.status).toBe(status);
  });

  it('offers the shortfall in acres as something to act on', () => {
    const result = resultsById({ ...qualifying, totalAcres: 150 }, operatingLine).get('min_acreage');
    expect(result?.delta).toEqual({
      unit: 'acres',
      actual: 150,
      required: 200,
      shortfall: 50,
      direction: 'increase',
    });
  });
});

describe('an application nobody has started', () => {
  it('is unknown everywhere rather than a wall of red', () => {
    const evaluated = evaluateEligibility([operatingLine, equipmentLoan], EMPTY_ELIGIBILITY_CONTEXT);
    for (const product of evaluated) {
      expect(product.status).toBe('unknown');
      for (const result of product.results) {
        expect(result.status).toBe('unknown');
        expect(result.missing.length).toBeGreaterThan(0);
        expect(RuleResultSchema.safeParse(result).success).toBe(true);
      }
    }
  });

  it('names the form fields it is waiting for, not the derived figure', () => {
    const dscr = resultsById(EMPTY_ELIGIBILITY_CONTEXT, operatingLine).get('dscr_floor');
    expect(dscr?.missing).toEqual(['net_operating_income', 'annual_debt_service']);
  });

  // A zero denominator is not a coverage ratio of zero: nothing was entered.
  it('treats a zero debt service as an unanswered question', () => {
    const context: EligibilityContext = {
      ...qualifying,
      annualDebtService: 0 as Money,
    };
    const dscr = resultsById(context, operatingLine).get('dscr_floor');
    expect(dscr?.status).toBe('unknown');
    expect(dscr?.missing).toEqual(['annual_debt_service']);
  });
});

describe('matching across products', () => {
  it('reports the products the applicant qualifies for', () => {
    const evaluated = evaluateEligibility([operatingLine, equipmentLoan], {
      ...qualifying,
      primaryCommodity: 'livestock',
    });
    expect(eligibleProducts(evaluated).map((product) => product.productName)).toEqual([
      'Equipment Term Loan',
    ]);
  });

  it('passes the submit guard on one qualifying product, not all of them', () => {
    const evaluated = evaluateEligibility([operatingLine, equipmentLoan], {
      ...qualifying,
      primaryCommodity: 'livestock',
    });
    const result = atLeastOneEligibleProduct(evaluated);
    expect(result.status).toBe('pass');
    expect(result.explain).toBe('You qualify for 1 of 2 products: Equipment Term Loan.');
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('is unknown, not a refusal, while the form is still being filled in', () => {
    const evaluated = evaluateEligibility([operatingLine], EMPTY_ELIGIBILITY_CONTEXT);
    const result = atLeastOneEligibleProduct(evaluated);
    expect(result.status).toBe('unknown');
    expect(result.missing).toContain('total_acres');
  });

  it('fails once every product has been ruled out', () => {
    const evaluated = evaluateEligibility([operatingLine, equipmentLoan], {
      ...qualifying,
      netOperatingIncome: money('10000.00'),
      annualDebtService: money('100000.00'),
    });
    const result = atLeastOneEligibleProduct(evaluated);
    expect(result.status).toBe('fail');
    expect(result.delta).toEqual({
      unit: 'count',
      actual: 0,
      required: 1,
      shortfall: 1,
      direction: 'increase',
    });
  });
});

describe('the field catalogue', () => {
  it('is the vocabulary a product criteria row may name', () => {
    expect([...ELIGIBILITY_FIELD_NAMES]).toEqual([
      'total_acres',
      'years_farming',
      'requested_amount',
      'dscr',
      'ltv',
      'province',
      'primary_commodity',
    ]);
  });
});
