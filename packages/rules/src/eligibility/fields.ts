import {
  type Money,
  debtServiceCoverageRatioBasisPoints,
  loanToValueBasisPoints,
} from '@lj/domain';

import type { RuleFigureKind } from '../engine/figures.ts';
import {
  type Reading,
  awaiting,
  known,
  missingInput,
  readNumber,
  readText,
} from '../engine/reading.ts';
import type { EligibilityContext } from './context.ts';

/**
 * The closed vocabulary a `loan_product.criteria` row may name.
 *
 * The split between this file and the criteria data is deliberate: *policy*
 * (which threshold, which commodities) is data a lender can change without a
 * deploy, but *what a field means and how to read it* is code, because it has
 * to agree with the context type. Making the field catalogue data too would
 * mean a product row could name a field nothing can read.
 *
 * It is also the reason an unrecognised field is a parse error rather than a
 * skipped rule: a typo that silently switched a criterion off would let an
 * ineligible applicant through, and nothing downstream would ever notice a rule
 * that is not there.
 */
export const ELIGIBILITY_FIELD_NAMES = [
  'total_acres',
  'years_farming',
  'requested_amount',
  'dscr',
  'ltv',
  'province',
  'primary_commodity',
] as const;

export type EligibilityFieldName = (typeof ELIGIBILITY_FIELD_NAMES)[number];

export interface NumericEligibilityField {
  readonly sort: 'numeric';
  readonly figure: RuleFigureKind;
  readonly read: (context: EligibilityContext) => Reading<number>;
}

export interface CategoricalEligibilityField {
  readonly sort: 'categorical';
  readonly read: (context: EligibilityContext) => Reading<string>;
}

export type EligibilityField = NumericEligibilityField | CategoricalEligibilityField;

const NET_OPERATING_INCOME = missingInput('net_operating_income', 'net operating income');
const ANNUAL_DEBT_SERVICE = missingInput('annual_debt_service', 'annual debt service');
const REQUESTED_AMOUNT = missingInput('requested_amount', 'the amount you want to borrow');
const COLLATERAL_VALUE = missingInput('collateral_value', 'the value of the security');

/**
 * A ratio of two amounts the applicant entered.
 *
 * ratioBasisPoints returns null on a zero denominator, and that null is carried
 * through as an unknown rather than collapsed to zero: "no debt service was
 * entered" is not "a coverage ratio of zero", and treating it as one would put
 * a failure in front of an applicant who has answered nothing wrong.
 */
function ratioField(
  numerator: Money | null,
  denominator: Money | null,
  numeratorInput: ReturnType<typeof missingInput>,
  denominatorInput: ReturnType<typeof missingInput>,
  compute: (top: Money, bottom: Money) => number | null,
): Reading<number> {
  const absent = [
    ...(numerator === null ? [numeratorInput] : []),
    ...(denominator === null ? [denominatorInput] : []),
  ];
  if (numerator === null || denominator === null) {
    return awaiting(absent);
  }
  const inputs = {
    [numeratorInput.field]: numerator,
    [denominatorInput.field]: denominator,
  };
  const ratio = compute(numerator, denominator);
  if (ratio === null) {
    return awaiting([denominatorInput], inputs);
  }
  return known(ratio, inputs);
}

export const ELIGIBILITY_FIELDS: { readonly [K in EligibilityFieldName]: EligibilityField } = {
  total_acres: {
    sort: 'numeric',
    figure: 'acres',
    read: (context) => readNumber(context.totalAcres, 'total_acres', 'total acres'),
  },
  years_farming: {
    sort: 'numeric',
    figure: 'years',
    read: (context) => readNumber(context.yearsFarming, 'years_farming', 'years farming'),
  },
  requested_amount: {
    sort: 'numeric',
    figure: 'money',
    read: (context) =>
      readNumber(context.requestedAmount, REQUESTED_AMOUNT.field, REQUESTED_AMOUNT.label),
  },
  dscr: {
    sort: 'numeric',
    figure: 'ratio',
    read: (context) =>
      ratioField(
        context.netOperatingIncome,
        context.annualDebtService,
        NET_OPERATING_INCOME,
        ANNUAL_DEBT_SERVICE,
        debtServiceCoverageRatioBasisPoints,
      ),
  },
  ltv: {
    sort: 'numeric',
    figure: 'percentage',
    read: (context) =>
      ratioField(
        context.requestedAmount,
        context.collateralValue,
        REQUESTED_AMOUNT,
        COLLATERAL_VALUE,
        loanToValueBasisPoints,
      ),
  },
  province: {
    sort: 'categorical',
    read: (context) => readText(context.province, 'province', 'the province you farm in'),
  },
  primary_commodity: {
    sort: 'categorical',
    read: (context) =>
      readText(context.primaryCommodity, 'primary_commodity', 'your main commodity'),
  },
};

export function isEligibilityFieldName(value: string): value is EligibilityFieldName {
  return (ELIGIBILITY_FIELD_NAMES as readonly string[]).includes(value);
}
