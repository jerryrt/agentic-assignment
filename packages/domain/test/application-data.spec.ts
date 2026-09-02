import { describe, expect, it } from 'vitest';

import {
  APPLICATION_STEPS,
  APPLICATION_STEP_REQUIREMENTS,
  ApplicationDataSchema,
  EMPTY_APPLICATION_DATA,
  applicationStepIndex,
  deriveApplicationFigures,
  isApplicationStep,
  parseApplicationData,
  requirementsForStep,
  unmetRequirements,
  type ApplicationData,
} from '../src/index.ts';

/**
 * The two payloads supabase/migrations/0004_demo_data.sql actually seeds,
 * copied verbatim.
 *
 * Verbatim matters: the migration is applied and append-only, so if the schema
 * and the seeded rows disagree the schema is what is wrong. Anything the
 * migration writes that this package no longer models -- `farm.total_acres`,
 * which is now derived from the parcels -- must survive the parse by being
 * stripped, not by failing it.
 */
const DEMO_DRAFT: unknown = {
  borrower: {
    entity_type: 'corporation',
    legal_name: 'Fenwick Grain Co.',
    trade_name: 'Fenwick Grain',
    incorporation_year: 2011,
    years_farming: 14,
    province: 'SK',
    postal_code: 'S7K 1A1',
    contact_email: 'borrower@example.test',
    contact_phone: '306-555-0142',
  },
  farm: {
    total_acres: 2400,
    primary_commodity: 'grain',
    parcels: [
      { legal_description: 'NW-14-35-05-W3', acres: 1600, tenure: 'owned', commodity: 'grain' },
      { legal_description: 'SE-22-35-05-W3', acres: 800, tenure: 'leased', commodity: 'oilseed' },
    ],
  },
  financials: {
    gross_revenue_minor: 182000000,
    operating_expenses_minor: 121000000,
    existing_debt_service_minor: 34000000,
    current_assets_minor: 96000000,
    current_liabilities_minor: 41000000,
  },
};

const DEMO_UNDER_REVIEW: unknown = {
  borrower: {
    entity_type: 'sole_trader',
    legal_name: 'Beau Marchand',
    years_farming: 2,
    province: 'AB',
    postal_code: 'T1J 4B4',
    contact_email: 'grower@example.test',
    contact_phone: '403-555-0119',
  },
  farm: {
    total_acres: 310,
    primary_commodity: 'mixed',
    parcels: [
      { legal_description: 'SW-08-09-22-W4', acres: 310, tenure: 'owned', commodity: 'mixed' },
    ],
  },
  financials: {
    gross_revenue_minor: 41000000,
    operating_expenses_minor: 29500000,
    existing_debt_service_minor: 7200000,
    current_assets_minor: 18000000,
    current_liabilities_minor: 9500000,
  },
  request: {
    product_id: '00000000-0000-4000-8000-0000000000b2',
    amount_requested_minor: 9500000,
    term_months: 60,
    purpose: 'Replace a 1998 combine ahead of harvest',
    collateral_value_minor: 12500000,
  },
};

function parsed(value: unknown): ApplicationData {
  const outcome = ApplicationDataSchema.safeParse(value);
  if (!outcome.success) {
    throw new Error('expected the payload to parse: ' + JSON.stringify(outcome.error.issues));
  }
  return outcome.data;
}

describe('the step vocabulary', () => {
  it('is the four steps of plan 05, in the order they are walked', () => {
    expect(APPLICATION_STEPS).toEqual(['borrower', 'farm', 'financials', 'request']);
  });

  // These are the values already sitting in application.furthest_step, so a
  // rename here silently strands every seeded draft.
  it('matches the furthest_step values the demo data seeds', () => {
    expect(isApplicationStep('financials')).toBe(true);
    expect(isApplicationStep('request')).toBe(true);
    expect(isApplicationStep('business')).toBe(false);
  });

  it('orders steps so a deep link can be compared against the furthest reached', () => {
    expect(applicationStepIndex('borrower')).toBe(0);
    expect(applicationStepIndex('request')).toBe(3);
  });
});

describe('ApplicationDataSchema', () => {
  it('parses both payloads the demo migration seeds', () => {
    expect(() => parsed(DEMO_DRAFT)).not.toThrow();
    expect(() => parsed(DEMO_UNDER_REVIEW)).not.toThrow();
  });

  // A draft is partial by definition: the seeded one stops at step 3 and the
  // form autosaves from the first keystroke. A schema that refused a half
  // filled form could not parse a single real draft.
  it('parses an empty payload into fully unanswered sections', () => {
    const empty = parsed({});
    expect(empty).toEqual(EMPTY_APPLICATION_DATA);
    expect(empty.borrower.legal_name).toBeNull();
    expect(empty.farm.parcels).toEqual([]);
    expect(empty.request.amount_requested_minor).toBeNull();
  });

  // Every section is present after a parse, so no consumer writes
  // `data.borrower?.legal_name`. An optional section would put that `?.` in
  // every template and every rule.
  it('fills in a section the payload omitted', () => {
    expect(parsed(DEMO_DRAFT).request.purpose).toBeNull();
  });

  it('strips a key the schema does not model rather than failing on it', () => {
    const value = parsed(DEMO_DRAFT);
    expect(Object.hasOwn(value.farm, 'total_acres')).toBe(false);
  });

  // '' is what an emptied text input produces, and it means the same thing as
  // never having typed in it. Two spellings of "not entered" would make every
  // completeness check test for both.
  it('reads blank and whitespace-only text as unanswered', () => {
    const value = parsed({ borrower: { legal_name: '   ', postal_code: '' } });
    expect(value.borrower.legal_name).toBeNull();
    expect(value.borrower.postal_code).toBeNull();
  });

  it('trims text it does keep', () => {
    expect(parsed({ borrower: { legal_name: '  Fenwick Grain Co. ' } }).borrower.legal_name).toBe(
      'Fenwick Grain Co.',
    );
  });

  it('rejects a fractional amount, because money is integer minor units', () => {
    expect(ApplicationDataSchema.safeParse({ financials: { gross_revenue_minor: 1.5 } }).success).toBe(
      false,
    );
  });

  it('rejects a value outside the closed vocabularies', () => {
    expect(ApplicationDataSchema.safeParse({ borrower: { entity_type: 'llc' } }).success).toBe(false);
    expect(ApplicationDataSchema.safeParse({ borrower: { province: 'CA' } }).success).toBe(false);
  });

  it('keeps a partly filled parcel rather than discarding the row', () => {
    const value = parsed({ farm: { parcels: [{ legal_description: 'NW-14-35-05-W3' }] } });
    expect(value.farm.parcels).toHaveLength(1);
    expect(value.farm.parcels[0]?.acres).toBeNull();
  });

  it('survives a JSON round trip unchanged, because it is stored as jsonb', () => {
    const value = parsed(DEMO_UNDER_REVIEW);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it('reports a problem rather than throwing, so a bad row does not take a screen down', () => {
    const outcome = parseApplicationData({ borrower: { years_farming: 'fourteen' } });
    expect(outcome.ok).toBe(false);
  });
});

describe('deriveApplicationFigures', () => {
  it('sums the parcels into the acreage the criteria read', () => {
    expect(deriveApplicationFigures(parsed(DEMO_DRAFT)).totalAcres).toBe(2400);
    expect(deriveApplicationFigures(parsed(DEMO_UNDER_REVIEW)).totalAcres).toBe(310);
  });

  // The seeded farm.total_acres agrees with its parcels today. Deriving it is
  // what stops the two disagreeing tomorrow, when a parcel is edited and the
  // stored total is not.
  it('derives acreage from the parcels and not from a stored total', () => {
    const value = parsed({ farm: { total_acres: 9999, parcels: [{ acres: 40 }, { acres: 60 }] } });
    expect(deriveApplicationFigures(value).totalAcres).toBe(100);
  });

  it('has no acreage at all until a parcel is entered', () => {
    expect(deriveApplicationFigures(EMPTY_APPLICATION_DATA).totalAcres).toBeNull();
  });

  // A partial sum reported as the total is a wrong number that gets believed.
  // Unknown is the honest answer while a row is still being typed.
  it('has no acreage while any parcel is missing its acres', () => {
    const value = parsed({ farm: { parcels: [{ acres: 40 }, { legal_description: 'SE-22' }] } });
    expect(deriveApplicationFigures(value).totalAcres).toBeNull();
  });

  it('computes net operating income as revenue less operating expenses', () => {
    expect(deriveApplicationFigures(parsed(DEMO_DRAFT)).netOperatingIncome).toBe(61000000);
  });

  it('computes the coverage ratio, the current ratio and loan to value in basis points', () => {
    const figures = deriveApplicationFigures(parsed(DEMO_UNDER_REVIEW));
    // (410000.00 - 295000.00) / 72000.00 = 1.5972...
    expect(figures.debtServiceCoverage).toBe(15_972);
    // 180000.00 / 95000.00 = 1.8947...
    expect(figures.currentRatio).toBe(18_947);
    // 95000.00 / 125000.00 = 0.76
    expect(figures.loanToValue).toBe(7_600);
  });

  // A missing expense figure is not a zero expense, and a coverage ratio
  // nobody entered must not be reported as though they had.
  it('propagates absence rather than substituting a zero', () => {
    const figures = deriveApplicationFigures(parsed({ financials: { gross_revenue_minor: 100 } }));
    expect(figures.netOperatingIncome).toBeNull();
    expect(figures.debtServiceCoverage).toBeNull();
    expect(figures.currentRatio).toBeNull();
    expect(figures.loanToValue).toBeNull();
  });

  it('leaves a ratio unknown when its denominator is zero', () => {
    const figures = deriveApplicationFigures(
      parsed({
        financials: {
          gross_revenue_minor: 10_000,
          operating_expenses_minor: 1_000,
          existing_debt_service_minor: 0,
        },
      }),
    );
    expect(figures.netOperatingIncome).toBe(9_000);
    expect(figures.debtServiceCoverage).toBeNull();
  });
});

describe('APPLICATION_STEP_REQUIREMENTS', () => {
  it('covers every step', () => {
    expect(Object.keys(APPLICATION_STEP_REQUIREMENTS).sort()).toEqual([...APPLICATION_STEPS].sort());
  });

  it('names each requirement once, so a form cannot render a field twice', () => {
    const paths = APPLICATION_STEPS.flatMap((step) =>
      APPLICATION_STEP_REQUIREMENTS[step].map((requirement) => requirement.path),
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('asks a corporation for the two things a sole trader is not asked', () => {
    const corporation = parsed({ borrower: { entity_type: 'corporation' } });
    const soleTrader = parsed({ borrower: { entity_type: 'sole_trader' } });

    const pathsFor = (data: ApplicationData): string[] =>
      requirementsForStep('borrower', data).map((requirement) => requirement.path);

    expect(pathsFor(corporation)).toContain('borrower.incorporation_year');
    expect(pathsFor(corporation)).toContain('borrower.trade_name');
    expect(pathsFor(soleTrader)).not.toContain('borrower.incorporation_year');
    expect(pathsFor(soleTrader)).not.toContain('borrower.trade_name');
  });

  // Until the entity type is answered nobody can say which fields apply, and
  // guessing the commoner one would ask a sole trader for an incorporation
  // year and then take the question away again.
  it('asks only for the entity type until the entity type is answered', () => {
    const paths = requirementsForStep('borrower', EMPTY_APPLICATION_DATA).map((r) => r.path);
    expect(paths).not.toContain('borrower.incorporation_year');
    expect(paths).toContain('borrower.entity_type');
  });
});

describe('unmetRequirements', () => {
  it('finds nothing outstanding on a step the demo data completed', () => {
    expect(unmetRequirements('borrower', parsed(DEMO_UNDER_REVIEW))).toEqual([]);
    expect(unmetRequirements('request', parsed(DEMO_UNDER_REVIEW))).toEqual([]);
  });

  it('names what a half-finished step is still waiting for', () => {
    const outstanding = unmetRequirements('request', parsed(DEMO_DRAFT)).map((r) => r.path);
    expect(outstanding).toContain('request.amount_requested_minor');
    expect(outstanding).toContain('request.purpose');
  });

  // The path is what a form focuses and what a RuleResult's `missing` array
  // carries, so it has to address the control rather than describe it.
  it('addresses a control by a path a form can focus', () => {
    const outstanding = unmetRequirements('borrower', EMPTY_APPLICATION_DATA);
    expect(outstanding.every((r) => r.path.startsWith('borrower.'))).toBe(true);
    expect(outstanding.every((r) => r.label.trim().length > 0)).toBe(true);
  });

  // The parcels FormArray is step 2's whole point: an empty list is a farm
  // nobody has described, and one row missing its acreage is a row that would
  // otherwise silently drop out of the acreage the criteria read.
  it('treats the parcels list as one requirement over the whole array', () => {
    const none = unmetRequirements('farm', parsed({ farm: { primary_commodity: 'grain' } }));
    expect(none.map((r) => r.path)).toContain('farm.parcels');

    const incomplete = unmetRequirements(
      'farm',
      parsed({ farm: { parcels: [{ legal_description: 'NW-14', tenure: 'owned' }] } }),
    );
    expect(incomplete.map((r) => r.path)).toContain('farm.parcels');
  });
});
