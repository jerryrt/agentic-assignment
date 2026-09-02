import { describe, expect, it } from 'vitest';

import { APPLICATION_STEPS, type ApplicationData } from '@lj/domain';

import { applicationCompletenessRuleId, evaluateApplicationCompleteness } from '../src/index.ts';

import { COMPLETE, DEMO_DRAFT, DEMO_UNDER_REVIEW, parsed } from './fixtures/application-payloads.ts';

const EMPTY_APPLICATION_DATA = parsed({});

describe('evaluateApplicationCompleteness', () => {
  it('reports one result per step, in the order the form walks them', () => {
    const results = evaluateApplicationCompleteness(EMPTY_APPLICATION_DATA);
    expect(results.map((result) => result.id)).toEqual(
      APPLICATION_STEPS.map(applicationCompletenessRuleId),
    );
  });

  // The one property this whole rule set exists for. An applicant who has
  // answered nothing has answered nothing WRONG, and a form that opens on four
  // red rows is the failure mode plan 05 was written to expose.
  it('calls an unanswered step unknown, never failed', () => {
    const results = evaluateApplicationCompleteness(EMPTY_APPLICATION_DATA);
    expect(results.every((result) => result.status === 'unknown')).toBe(true);
    expect(results.some((result) => result.status === 'fail')).toBe(false);
  });

  it('never fails a step however little has been entered', () => {
    for (const data of [EMPTY_APPLICATION_DATA, parsed(DEMO_DRAFT), parsed(DEMO_UNDER_REVIEW)]) {
      expect(evaluateApplicationCompleteness(data).some((r) => r.status === 'fail')).toBe(false);
    }
  });

  it('passes every step of a fully answered application', () => {
    const results = evaluateApplicationCompleteness(parsed(COMPLETE));
    expect(results.every((result) => result.status === 'pass')).toBe(true);
  });

  it('blocks the submit guard until every step passes', () => {
    // requireRules folds this set with overallRuleStatus, so what the guard
    // sees is exactly this.
    const partial = evaluateApplicationCompleteness(parsed(DEMO_DRAFT));
    expect(partial.filter((result) => result.status === 'unknown').length).toBeGreaterThan(0);
    expect(evaluateApplicationCompleteness(parsed(COMPLETE)).every((r) => r.status === 'pass')).toBe(
      true,
    );
  });

  // Every RuleResult is stored in an eligibility_snapshot as jsonb and read
  // back later, so it has to survive the round trip and its severity has to
  // block: an advisory completeness rule would let an empty form submit.
  it('produces blocking results that survive a JSON round trip', () => {
    const results = evaluateApplicationCompleteness(parsed(DEMO_DRAFT));
    expect(results.every((result) => result.severity === 'error')).toBe(true);
    expect(JSON.parse(JSON.stringify(results))).toEqual(results);
  });

  it('names the outstanding fields by a path a form can focus', () => {
    const financials = evaluateApplicationCompleteness(parsed(DEMO_DRAFT)).find(
      (result) => result.id === applicationCompletenessRuleId('financials'),
    );
    expect(financials?.status).toBe('unknown');
    expect(financials?.missing).toContain('financials.statements_basis');
    expect(financials?.missing).not.toContain('financials.gross_revenue_minor');
  });

  it('reads the outstanding fields back to the applicant in words, not paths', () => {
    const farm = evaluateApplicationCompleteness(parsed(DEMO_DRAFT)).find(
      (result) => result.id === applicationCompletenessRuleId('farm'),
    );
    expect(farm?.explain).toContain('Irrigation');
    expect(farm?.explain).not.toContain('farm.irrigation');
  });

  // The conditional fields of step one. A sole trader is not asked for an
  // incorporation year, so withholding one cannot make their step incomplete.
  it('holds a corporation to two questions a sole trader is not asked', () => {
    const corporation = parsed({
      borrower: {
        entity_type: 'corporation',
        legal_name: 'Fenwick Grain Co.',
        years_farming: 14,
        province: 'SK',
        postal_code: 'S7K 1A1',
        contact_email: 'borrower@example.test',
        contact_phone: '306-555-0142',
      },
    });
    const soleTrader = parsed({
      borrower: {
        entity_type: 'sole_trader',
        legal_name: 'Beau Marchand',
        years_farming: 2,
        province: 'AB',
        postal_code: 'T1J 4B4',
        contact_email: 'grower@example.test',
        contact_phone: '403-555-0119',
      },
    });
    const borrowerStep = (data: ApplicationData) =>
      evaluateApplicationCompleteness(data).find(
        (result) => result.id === applicationCompletenessRuleId('borrower'),
      );

    expect(borrowerStep(corporation)?.status).toBe('unknown');
    expect(borrowerStep(corporation)?.missing).toContain('borrower.incorporation_year');
    expect(borrowerStep(soleTrader)?.status).toBe('pass');
  });

  it('counts how far through a step the applicant is, for the progress display', () => {
    const borrower = evaluateApplicationCompleteness(parsed(DEMO_DRAFT)).find(
      (result) => result.id === applicationCompletenessRuleId('borrower'),
    );
    expect(borrower?.inputs).toMatchObject({ answered: 9, required: 9 });
  });

  // Step two's whole subject. An empty parcels list is a farm nobody has
  // described; a row missing its acres is a row that would otherwise drop
  // silently out of the acreage the criteria read.
  it('treats the parcels list as one outstanding item', () => {
    const withoutParcels = parsed({
      farm: { primary_commodity: 'grain', irrigation: 'none', has_crop_insurance: false },
    });
    const farmStep = evaluateApplicationCompleteness(withoutParcels).find(
      (result) => result.id === applicationCompletenessRuleId('farm'),
    );
    expect(farmStep?.missing).toEqual(['farm.parcels']);
  });
});
