import { type ApplicationData, deriveApplicationFigures } from '@lj/domain';

import type { EligibilityContext } from '../eligibility/context.ts';

/**
 * The form payload, projected onto what the eligibility criteria read.
 *
 * This lived in `apps/api/lib/application-data.ts`, whose own header said it
 * would move down once @lj/domain had a schema for the payload. It could not
 * move into @lj/domain -- `EligibilityContext` is declared here and this
 * package sits above that one -- so it moves here, which is the layer that owns
 * both ends of it.
 *
 * The move is not tidying. The browser evaluates this context on every
 * keystroke to draw the eligibility panel, and the server evaluates it again
 * inside the submit guard; two copies of the projection is the drift that would
 * let a form show "eligible" against a server that says otherwise. One
 * function, run in both places, over bytes that are byte-identical because they
 * are the same jsonb row.
 *
 * It is a projection and not a rule: nothing here compares a figure against a
 * threshold or decides an outcome. It lifts values out of a parsed payload and
 * hands them on. Net operating income and total acreage arrive derived from
 * @lj/domain rather than being recomputed, so the figure the applicant reads on
 * step three is the figure the criterion compares.
 */
export function eligibilityContextFromApplication(data: ApplicationData): EligibilityContext {
  const figures = deriveApplicationFigures(data);

  return {
    totalAcres: figures.totalAcres,
    yearsFarming: data.borrower.years_farming,
    province: data.borrower.province,
    primaryCommodity: data.farm.primary_commodity,
    requestedAmount: data.request.amount_requested_minor,
    netOperatingIncome: figures.netOperatingIncome,
    annualDebtService: data.financials.existing_debt_service_minor,
    collateralValue: data.request.collateral_value_minor,
  };
}
