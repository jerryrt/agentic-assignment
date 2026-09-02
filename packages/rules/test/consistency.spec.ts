import { describe, expect, it } from 'vitest';

import { RuleResultSchema, moneyFromNumericString } from '@lj/domain';

import {
  FINANCIAL_STATEMENTS_SLOT,
  LAND_TITLE_SLOT,
  TAX_RETURN_SLOT,
  consistencyRules,
  evaluateConsistency,
  type ConsistencyContext,
  type DocumentSlotView,
} from '../src/index.ts';

const money = moneyFromNumericString;

interface Reading {
  readonly value: unknown;
  readonly confidenceBasisPoints?: number;
  readonly source?: 'ocr' | 'human';
}

function slotWith(code: string, fields: Readonly<Record<string, Reading>>): DocumentSlotView {
  const extracted: Record<string, { value: unknown; confidenceBasisPoints: number; source: 'ocr' | 'human' }> = {};
  for (const [field, reading] of Object.entries(fields)) {
    extracted[field] = {
      value: reading.value,
      confidenceBasisPoints: reading.confidenceBasisPoints ?? 9_500,
      source: reading.source ?? 'ocr',
    };
  }
  return {
    code,
    label: code,
    required: true,
    state: 'accepted',
    validUntil: null,
    extractRequired: [],
    extracted,
  };
}

function contextOf(
  slots: readonly DocumentSlotView[],
  application: ConsistencyContext['application'],
): ConsistencyContext {
  return { slots, application };
}

const agreeingApplication = { totalAcres: 1240, legalName: 'Smith Farms Ltd.' };

function resultsById(context: ConsistencyContext) {
  const results = evaluateConsistency(context);
  for (const result of results) {
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  }
  return new Map(results.map((result) => [result.id, result]));
}

describe('the consistency rule set', () => {
  it('is the three cross-document checks plan 04 defines', () => {
    expect(consistencyRules.map((rule) => rule.id)).toEqual([
      'acreage_matches_application',
      'income_matches_financials',
      'entity_name_matches',
    ]);
  });

  // Which check blocks and which merely warns is the credit-policy judgment,
  // so it is asserted rather than left to a reader of the source.
  it('blocks on acreage and on the entity name, and only warns on income', () => {
    expect(consistencyRules.map((rule) => rule.severity)).toEqual(['error', 'warning', 'error']);
  });
});

describe('acreage on the title against the application', () => {
  it('passes when the deed and the form agree exactly', () => {
    const context = contextOf(
      [slotWith(LAND_TITLE_SLOT, { total_acres: { value: 1240 } })],
      agreeingApplication,
    );
    expect(resultsById(context).get('acreage_matches_application')?.status).toBe('pass');
  });

  it('passes inside the two percent a real document pack needs', () => {
    const context = contextOf(
      [slotWith(LAND_TITLE_SLOT, { total_acres: { value: 1220 } })],
      agreeingApplication,
    );
    expect(resultsById(context).get('acreage_matches_application')?.status).toBe('pass');
  });

  it('fails outside it, showing both figures and the tolerance', () => {
    const context = contextOf(
      [slotWith(LAND_TITLE_SLOT, { total_acres: { value: 1000 } })],
      agreeingApplication,
    );
    const result = resultsById(context).get('acreage_matches_application');
    expect(result?.status).toBe('fail');
    expect(result?.explain).toContain('we allow 2%');
  });

  it('is unknown while the title has not been read', () => {
    const result = resultsById(contextOf([], agreeingApplication)).get(
      'acreage_matches_application',
    );
    expect(result?.status).toBe('unknown');
    expect(result?.missing).toEqual(['land_title.total_acres']);
  });

  // A value the extractor is not confident about is not a value: comparing it
  // would raise a cross-check failure that is really an extraction failure.
  it('is unknown when the extracted figure is below the confidence floor', () => {
    const context = contextOf(
      [slotWith(LAND_TITLE_SLOT, { total_acres: { value: 1240, confidenceBasisPoints: 4_000 } })],
      agreeingApplication,
    );
    expect(resultsById(context).get('acreage_matches_application')?.status).toBe('unknown');
  });

  it('uses a value a person typed in whatever the extractor thought', () => {
    const context = contextOf(
      [
        slotWith(LAND_TITLE_SLOT, {
          total_acres: { value: 1240, confidenceBasisPoints: 0, source: 'human' },
        }),
      ],
      agreeingApplication,
    );
    expect(resultsById(context).get('acreage_matches_application')?.status).toBe('pass');
  });

  it('is unknown when the extractor produced something that is not a number', () => {
    const context = contextOf(
      [slotWith(LAND_TITLE_SLOT, { total_acres: { value: 'twelve hundred' } })],
      agreeingApplication,
    );
    expect(resultsById(context).get('acreage_matches_application')?.status).toBe('unknown');
  });
});

describe('net income across the tax return and the statements', () => {
  it('warns rather than blocks when they disagree past five percent', () => {
    const context = contextOf(
      [
        slotWith(TAX_RETURN_SLOT, { net_farm_income: { value: money('184200.00') } }),
        slotWith(FINANCIAL_STATEMENTS_SLOT, { net_income: { value: money('171500.00') } }),
      ],
      agreeingApplication,
    );
    const result = resultsById(context).get('income_matches_financials');
    expect(result?.status).toBe('fail');
    expect(result?.severity).toBe('warning');
    expect(result?.explain).toBe(
      'The 2024 tax return: $184,200.00; the financial statements: $171,500.00 ' +
        '-- 6.89% apart, we allow 5%.',
    );
  });

  it('passes when they agree closely enough', () => {
    const context = contextOf(
      [
        slotWith(TAX_RETURN_SLOT, { net_farm_income: { value: money('184200.00') } }),
        slotWith(FINANCIAL_STATEMENTS_SLOT, { net_income: { value: money('180000.00') } }),
      ],
      agreeingApplication,
    );
    expect(resultsById(context).get('income_matches_financials')?.status).toBe('pass');
  });
});

describe('the legal entity name across documents', () => {
  it('passes through a difference in legal suffix and case', () => {
    const context = contextOf(
      [
        slotWith(LAND_TITLE_SLOT, { owner_name: { value: 'Smith Farms Ltd.' } }),
        slotWith(TAX_RETURN_SLOT, { taxpayer_name: { value: 'SMITH FARMS' } }),
      ],
      agreeingApplication,
    );
    expect(resultsById(context).get('entity_name_matches')?.status).toBe('pass');
  });

  it('fails on a genuinely different name', () => {
    const context = contextOf(
      [
        slotWith(LAND_TITLE_SLOT, { owner_name: { value: 'Smith Farms Ltd.' } }),
        slotWith(TAX_RETURN_SLOT, { taxpayer_name: { value: 'Fenwick Grain Co.' } }),
      ],
      agreeingApplication,
    );
    const result = resultsById(context).get('entity_name_matches');
    expect(result?.status).toBe('fail');
    expect(result?.severity).toBe('error');
  });

  it('is unknown until both documents have been read', () => {
    const context = contextOf(
      [slotWith(LAND_TITLE_SLOT, { owner_name: { value: 'Smith Farms Ltd.' } })],
      agreeingApplication,
    );
    expect(resultsById(context).get('entity_name_matches')?.missing).toEqual([
      'tax_return_2024.taxpayer_name',
    ]);
  });
});

describe('an untouched file', () => {
  it('is entirely unknown rather than a list of disagreements', () => {
    const results = evaluateConsistency(
      contextOf([], { totalAcres: null, legalName: null }),
    );
    for (const result of results) {
      expect(result.status).toBe('unknown');
      expect(RuleResultSchema.safeParse(result).success).toBe(true);
    }
  });
});
