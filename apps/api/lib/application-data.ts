/**
 * Reading `application.data` into the context the eligibility rules take.
 *
 * This is a projection, not a rule. Nothing here compares a figure against a
 * threshold, decides an outcome, or knows what any criterion is: it lifts leaf
 * values out of a jsonb blob and hands them to packages/rules, which owns every
 * decision made about them. That distinction is what keeps CLAUDE.md section 8
 * intact -- a delivery layer may adapt data, it may not adjudicate it.
 *
 * The payload's shape is PROVISIONAL. `supabase/seed.sql` says so, and the
 * multi-step form in Phase 5 owns it; packages/domain has no
 * ApplicationDataSchema yet. When it gains one, this file moves down into
 * packages/domain and this comment goes with it. Until then it is written to
 * fail soft: an absent or wrongly-typed field reads as null, which the rules
 * engine renders as "we need more information" rather than as a refusal, and
 * that is the honest answer for a form that is half filled in.
 *
 * Amounts in the payload are integer MINOR units, per the money rule, and the
 * `_minor` suffix on each field name is what stops a reader taking 45000000 for
 * dollars.
 */

import {
  MoneyMinorUnitsSchema,
  subtractMoney,
  type JsonValue,
  type Money,
} from '@lj/domain';
import type { EligibilityContext } from '@lj/rules';

type JsonRecord = Readonly<Record<string, JsonValue>>;

function section(data: JsonRecord, name: string): JsonRecord | null {
  const value = data[name];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readNumber(source: JsonRecord | null, field: string): number | null {
  const value = source?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readText(source: JsonRecord | null, field: string): string | null {
  const value = source?.[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readMoney(source: JsonRecord | null, field: string): Money | null {
  const parsed = MoneyMinorUnitsSchema.safeParse(source?.[field]);
  return parsed.success ? parsed.data : null;
}

/**
 * Net operating income: revenue less operating expenses, before debt service.
 *
 * Derived rather than read, because the form asks for the two figures a farmer
 * has on a statement and not for their difference. It is an accounting
 * identity rather than a policy -- no threshold, no judgement -- and it is
 * computed with @lj/domain's money arithmetic so no float ever touches it.
 *
 * Null unless both sides are present: a missing expense figure is not a zero
 * expense, and treating it as one would report a coverage ratio nobody entered.
 */
function netOperatingIncome(financials: JsonRecord | null): Money | null {
  const revenue = readMoney(financials, 'gross_revenue_minor');
  const expenses = readMoney(financials, 'operating_expenses_minor');
  return revenue === null || expenses === null ? null : subtractMoney(revenue, expenses);
}

export function eligibilityContextFrom(data: JsonRecord): EligibilityContext {
  const borrower = section(data, 'borrower');
  const farm = section(data, 'farm');
  const financials = section(data, 'financials');
  const request = section(data, 'request');

  return {
    totalAcres: readNumber(farm, 'total_acres'),
    yearsFarming: readNumber(borrower, 'years_farming'),
    province: readText(borrower, 'province'),
    primaryCommodity: readText(farm, 'primary_commodity'),
    requestedAmount: readMoney(request, 'amount_requested_minor'),
    netOperatingIncome: netOperatingIncome(financials),
    annualDebtService: readMoney(financials, 'existing_debt_service_minor'),
    collateralValue: readMoney(request, 'collateral_value_minor'),
  };
}
