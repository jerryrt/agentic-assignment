import type { Money } from '@lj/domain';

/**
 * Everything the eligibility criteria read, and nothing else.
 *
 * Only what the applicant entered is here; DSCR and loan-to-value are absent on
 * purpose. They are derived from these figures by the field catalogue, once, so
 * that the read-only figure shown on the financials step and the figure the
 * criterion compares are the same computation (CLAUDE.md section 9). A context
 * carrying a pre-computed dscr would let a caller supply a different one.
 *
 * Every field is nullable because the panel renders from step one, when none of
 * them has been answered. Null is "not entered", never "zero".
 */
export interface EligibilityContext {
  readonly totalAcres: number | null;
  readonly yearsFarming: number | null;
  readonly province: string | null;
  readonly primaryCommodity: string | null;
  readonly requestedAmount: Money | null;
  readonly netOperatingIncome: Money | null;
  readonly annualDebtService: Money | null;
  readonly collateralValue: Money | null;
}

/** Step one of four: nothing entered, so every criterion is unknown. */
export const EMPTY_ELIGIBILITY_CONTEXT: EligibilityContext = {
  totalAcres: null,
  yearsFarming: null,
  province: null,
  primaryCommodity: null,
  requestedAmount: null,
  netOperatingIncome: null,
  annualDebtService: null,
  collateralValue: null,
};
