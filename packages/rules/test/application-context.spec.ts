import { describe, expect, it } from 'vitest';

import { eligibilityContextFromApplication } from '../src/index.ts';

import { DEMO_DRAFT, DEMO_UNDER_REVIEW, parsed } from './fixtures/application-payloads.ts';

const EMPTY_APPLICATION_DATA = parsed({});

describe('eligibilityContextFromApplication', () => {
  // The regression test for moving this projection out of apps/api. These are
  // the values apps/api/lib/application-data.ts produced for the same payloads
  // before the move; the context the browser evaluates and the context the
  // submit guard evaluates are now one function over one shape.
  it('projects the seeded draft exactly as the API projection did', () => {
    expect(eligibilityContextFromApplication(parsed(DEMO_DRAFT))).toEqual({
      totalAcres: 2400,
      yearsFarming: 14,
      province: 'SK',
      primaryCommodity: 'grain',
      requestedAmount: null,
      netOperatingIncome: 61000000,
      annualDebtService: 34000000,
      collateralValue: null,
    });
  });

  it('projects the seeded submitted application exactly as the API projection did', () => {
    expect(eligibilityContextFromApplication(parsed(DEMO_UNDER_REVIEW))).toEqual({
      totalAcres: 310,
      yearsFarming: 2,
      province: 'AB',
      primaryCommodity: 'mixed',
      requestedAmount: 9500000,
      netOperatingIncome: 11500000,
      annualDebtService: 7200000,
      collateralValue: 12500000,
    });
  });

  it('reads nothing at all out of an untouched application', () => {
    expect(eligibilityContextFromApplication(EMPTY_APPLICATION_DATA)).toEqual({
      totalAcres: null,
      yearsFarming: null,
      province: null,
      primaryCommodity: null,
      requestedAmount: null,
      netOperatingIncome: null,
      annualDebtService: null,
      collateralValue: null,
    });
  });

  // The acreage a criterion compares is the sum of the parcels, not the stale
  // farm.total_acres the seed also carries. One number, one source.
  it('takes acreage from the parcels rather than from the stored total', () => {
    const context = eligibilityContextFromApplication(
      parsed({ farm: { total_acres: 9999, parcels: [{ acres: 120 }, { acres: 80 }] } }),
    );
    expect(context.totalAcres).toBe(200);
  });
});
