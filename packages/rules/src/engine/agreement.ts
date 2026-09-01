import {
  type RuleSeverity,
  formatBasisPointsAsPercentage,
  moneyFromMinorUnits,
  ratioBasisPoints,
  ruleFailed,
  rulePassed,
  ruleUnknown,
} from '@lj/domain';

import { type RuleFigureKind, figureDelta, formatFigure, joinWords } from './figures.js';
import {
  type AgreementSource,
  combineInputs,
  combineMissing,
  missingFields,
  missingLabels,
} from './reading.js';
import type { Rule } from './rule.js';

/**
 * Cross-checking one figure against the same figure elsewhere.
 *
 * Tolerance rather than equality, because real documents disagree slightly and
 * always will. A rule with no tolerance produces noise, the borrower learns to
 * ignore red, and the checklist is worse than nothing (plan 04). The tolerance
 * is per rule and is shown in the explanation, so a disagreement the system
 * accepts is visible rather than silent.
 */
export type Tolerance =
  /** No slack at all. Correct for an identifier, wrong for a measurement. */
  | { readonly kind: 'exact' }
  /** Slack in the figure's own unit: minor units for money, acres for acres. */
  | { readonly kind: 'absolute'; readonly value: number }
  /**
   * Slack as a proportion, in basis points, because a percentage written as a
   * float is the same boundary problem as a float threshold: 2% must mean 200,
   * not 0.02.
   */
  | { readonly kind: 'percent'; readonly basisPoints: number };

export interface NumericAgreementSpec<Context> {
  readonly id: string;
  readonly label: string;
  readonly severity?: RuleSeverity;
  readonly figure: RuleFigureKind;
  readonly tolerance: Tolerance;
  readonly left: AgreementSource<Context, number>;
  readonly right: AgreementSource<Context, number>;
}

/**
 * A proportion of two integer quantities of the same unit, in basis points.
 *
 * ratioBasisPoints carries the exact half-away-from-zero integer division this
 * must not reimplement (CLAUDE.md section 9). Its parameters are typed as
 * Money because that is the workspace's integer-quantity type; both operands
 * here are always in one unit, so the ratio they produce is unit-free.
 */
function proportionBasisPoints(numerator: number, denominator: number): number | null {
  return ratioBasisPoints(moneyFromMinorUnits(numerator), moneyFromMinorUnits(denominator));
}

export function numericAgreement<Context>(
  spec: NumericAgreementSpec<Context>,
): Rule<Context> {
  const severity: RuleSeverity = spec.severity ?? 'error';
  return {
    id: spec.id,
    label: spec.label,
    severity,
    evaluate: (context) => {
      const leftReading = spec.left.read(context);
      const rightReading = spec.right.read(context);
      const readings = [leftReading, rightReading];
      const missing = combineMissing(readings);
      const inputs: Record<string, unknown> = {
        ...combineInputs(readings),
        tolerance: spec.tolerance,
      };

      if (missing.length > 0 || !leftReading.known || !rightReading.known) {
        return ruleUnknown({
          id: spec.id,
          label: spec.label,
          severity,
          explain: 'Cannot compare until we have ' + joinWords(missingLabels(missing)) + '.',
          inputs,
          missing: missingFields(missing),
        });
      }

      const left = leftReading.value;
      const right = rightReading.value;
      inputs[spec.left.name] = left;
      inputs[spec.right.name] = right;

      const stated =
        spec.left.name +
        ': ' +
        formatFigure(spec.figure, left) +
        '; ' +
        spec.right.name +
        ': ' +
        formatFigure(spec.figure, right);

      const difference = Math.abs(left - right);
      if (difference === 0) {
        return rulePassed({
          id: spec.id,
          label: spec.label,
          severity,
          explain:
            spec.left.name +
            ' and ' +
            spec.right.name +
            ' agree: ' +
            formatFigure(spec.figure, left) +
            '.',
          inputs,
        });
      }

      if (spec.tolerance.kind === 'exact') {
        return ruleFailed({
          id: spec.id,
          label: spec.label,
          severity,
          explain: stated + ' -- these must match exactly.',
          inputs,
          delta: figureDelta(spec.figure, difference, 0),
        });
      }

      if (spec.tolerance.kind === 'absolute') {
        const allowance = spec.tolerance.value;
        const gapText = formatFigure(spec.figure, difference);
        const allowanceText = formatFigure(spec.figure, allowance);
        if (difference <= allowance) {
          return rulePassed({
            id: spec.id,
            label: spec.label,
            severity,
            explain: stated + ' -- ' + gapText + ' apart, within the ' + allowanceText + ' we allow.',
            inputs,
          });
        }
        return ruleFailed({
          id: spec.id,
          label: spec.label,
          severity,
          explain: stated + ' -- ' + gapText + ' apart, we allow ' + allowanceText + '.',
          inputs,
          delta: figureDelta(spec.figure, difference, allowance),
        });
      }

      // The gap is measured against the larger of the two figures so that
      // swapping the sides cannot change the verdict. Dividing by whichever was
      // named first would make the rule depend on the order of its arguments,
      // which is not a property a cross-check may have.
      const reference = Math.max(Math.abs(left), Math.abs(right));
      const gapBasisPoints = proportionBasisPoints(difference, reference);
      if (gapBasisPoints === null) {
        throw new Error('unreachable: a non-zero difference implies a non-zero reference');
      }
      const allowance = spec.tolerance.basisPoints;
      const gapText = formatBasisPointsAsPercentage(gapBasisPoints);
      const allowanceText = formatBasisPointsAsPercentage(allowance);
      inputs['gap_basis_points'] = gapBasisPoints;

      if (gapBasisPoints <= allowance) {
        return rulePassed({
          id: spec.id,
          label: spec.label,
          severity,
          explain: stated + ' -- ' + gapText + ' apart, within the ' + allowanceText + ' we allow.',
          inputs,
        });
      }
      return ruleFailed({
        id: spec.id,
        label: spec.label,
        severity,
        explain: stated + ' -- ' + gapText + ' apart, we allow ' + allowanceText + '.',
        inputs,
        delta: figureDelta('percentage', gapBasisPoints, allowance),
      });
    },
  };
}
