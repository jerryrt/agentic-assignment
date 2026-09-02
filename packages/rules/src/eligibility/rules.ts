import {
  type Money,
  type RuleResult,
  type RuleStatus,
  countDelta,
  overallRuleStatus,
  ruleFailed,
  rulePassed,
  ruleUnknown,
} from '@lj/domain';

import { joinWords } from '../engine/figures.ts';
import { numericAtLeast, numericAtMost, numericWithinBand } from '../engine/numeric.ts';
import { oneOf } from '../engine/exact.ts';
import { type Rule, evaluate } from '../engine/rule.ts';
import type { EligibilityContext } from './context.ts';
import type { EligibilityCriteria, EligibilityCriterion } from './criteria.ts';
import { ELIGIBILITY_FIELDS } from './fields.ts';

/**
 * Compiling a product's criteria into rules, and matching an application
 * against several products at once.
 *
 * The amount band is not in `criteria`: `min_amount` and `max_amount` are
 * columns on `loan_product`, and a threshold that appears in two places becomes
 * two thresholds the first time one is edited (CLAUDE.md section 9). It is
 * synthesised here so the panel shows one row per criterion including the band,
 * from one source each.
 */

export const AMOUNT_BAND_RULE_ID = 'amount_band';

export interface EligibilityProduct {
  readonly id: string;
  readonly name: string;
  readonly minAmount: Money | null;
  readonly maxAmount: Money | null;
  readonly criteria: EligibilityCriteria;
}

function criterionRule(criterion: EligibilityCriterion): Rule<EligibilityContext> {
  const field = ELIGIBILITY_FIELDS[criterion.field];

  if (criterion.kind === 'one_of') {
    if (field.sort !== 'categorical') {
      throw new Error("criterion '" + criterion.id + "' compares a number against a list");
    }
    return oneOf({
      id: criterion.id,
      label: criterion.label,
      severity: criterion.severity,
      allowed: criterion.allowed,
      read: field.read,
    });
  }

  if (field.sort !== 'numeric') {
    throw new Error("criterion '" + criterion.id + "' compares a category against a threshold");
  }
  const spec = {
    id: criterion.id,
    label: criterion.label,
    severity: criterion.severity,
    figure: field.figure,
    read: field.read,
  };
  return criterion.kind === 'min'
    ? numericAtLeast({ ...spec, minimum: criterion.threshold })
    : numericAtMost({ ...spec, maximum: criterion.threshold });
}

export function eligibilityRules(product: EligibilityProduct): Rule<EligibilityContext>[] {
  const rules = product.criteria.rules.map(criterionRule);
  if (product.minAmount === null && product.maxAmount === null) {
    return rules;
  }
  const requestedAmount = ELIGIBILITY_FIELDS.requested_amount;
  if (requestedAmount.sort !== 'numeric') {
    throw new Error('requested_amount must be a numeric field');
  }
  rules.push(
    numericWithinBand({
      id: AMOUNT_BAND_RULE_ID,
      label: 'Loan amount',
      figure: requestedAmount.figure,
      read: requestedAmount.read,
      minimum: product.minAmount,
      maximum: product.maxAmount,
    }),
  );
  return rules;
}

export interface ProductEligibility {
  readonly productId: string;
  readonly productName: string;
  readonly status: RuleStatus;
  readonly results: readonly RuleResult[];
}

export function evaluateEligibility(
  products: readonly EligibilityProduct[],
  context: EligibilityContext,
): ProductEligibility[] {
  return products.map((product) => {
    const results = evaluate(context, eligibilityRules(product));
    return {
      productId: product.id,
      productName: product.name,
      status: overallRuleStatus(results),
      results,
    };
  });
}

export function eligibleProducts(
  evaluated: readonly ProductEligibility[],
): ProductEligibility[] {
  return evaluated.filter((product) => product.status === 'pass');
}

/**
 * The submit guard of plan 03, as a rule result.
 *
 * "At least one", not "all": a borrower who qualifies for the equipment loan
 * and not the operating line is a borrower with an application worth taking.
 * While the form is still being filled in this is unknown rather than a
 * refusal, which is the difference between a panel that guides and one that
 * shouts.
 */
export function atLeastOneEligibleProduct(
  evaluated: readonly ProductEligibility[],
): RuleResult {
  const id = 'at_least_one_eligible_product';
  const label = 'At least one product matches this application';
  const eligible = eligibleProducts(evaluated);
  const inputs = { products: evaluated.length, eligible: eligible.length };

  if (eligible.length > 0) {
    return rulePassed({
      id,
      label,
      explain:
        'You qualify for ' +
        String(eligible.length) +
        ' of ' +
        String(evaluated.length) +
        ' products: ' +
        joinWords(eligible.map((product) => product.productName)) +
        '.',
      inputs,
    });
  }

  const undecided = evaluated.filter((product) => product.status === 'unknown');
  if (undecided.length > 0) {
    const missing: string[] = [];
    for (const product of undecided) {
      for (const result of product.results) {
        for (const field of result.missing) {
          if (!missing.includes(field)) {
            missing.push(field);
          }
        }
      }
    }
    return ruleUnknown({
      id,
      label,
      explain: 'Keep going -- we need more before any product can be matched.',
      inputs,
      missing,
    });
  }

  return ruleFailed({
    id,
    label,
    explain: 'No product matches this application yet.',
    inputs,
    delta: countDelta({ actual: 0, required: 1 }),
  });
}
