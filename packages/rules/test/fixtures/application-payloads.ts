import { ApplicationDataSchema, type ApplicationData } from '@lj/domain';

/**
 * The application payloads the tests in this package read.
 *
 * Two of them are what supabase/migrations/0004_demo_data.sql actually seeds,
 * copied verbatim, because a rule that disagrees with the seeded rows is a rule
 * that disagrees with the demo. The draft is deliberately INCOMPLETE -- it is
 * the row seeded "stopped part way through step three", which is the resume
 * case the demo exists to show.
 *
 * They are `unknown` rather than ApplicationData so that every test parses them
 * through the real schema rather than being handed a shape a test author
 * asserted.
 */

export const DEMO_DRAFT: unknown = {
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

export const DEMO_UNDER_REVIEW: unknown = {
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

/** Every required field answered, on every step. */
export const COMPLETE: unknown = {
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
    primary_commodity: 'mixed',
    irrigation: 'none',
    has_crop_insurance: true,
    parcels: [
      { legal_description: 'SW-08-09-22-W4', acres: 310, tenure: 'owned', commodity: 'mixed' },
    ],
  },
  financials: {
    statements_basis: 'accrual',
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

export function parsed(value: unknown): ApplicationData {
  return ApplicationDataSchema.parse(value);
}
