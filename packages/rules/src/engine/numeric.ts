import { type RuleSeverity, ruleFailed, rulePassed, ruleUnknown } from '@lj/domain';

import { type RuleFigureKind, figureDelta, formatFigure, joinWords } from './figures.ts';
import {
  type Reading,
  combineInputs,
  combineMissing,
  known,
  missingFields,
  missingLabels,
} from './reading.ts';
import type { Rule } from './rule.ts';

/**
 * The numeric comparators: at least, at most, and the band that is both.
 *
 * All three are one implementation, because "between 25k and 500k" and "at
 * least 1.25" differ only in which bounds exist. Splitting them would put the
 * same comparison and the same delta arithmetic in three places (CLAUDE.md
 * section 9).
 */

/**
 * A bound is either a policy constant stated in the rule, or a figure derived
 * from the subject -- the credit still available on a loan is a cap that moves
 * with the ledger. Both are "the threshold, stated once, in the rule
 * definition"; only one of them is a literal.
 */
export type FigureLimit<Context> = number | ((context: Context) => Reading<number>);

export interface NumericRuleSpec<Context> {
  readonly id: string;
  readonly label: string;
  /** Defaults to 'error': a criterion blocks unless it is declared advisory. */
  readonly severity?: RuleSeverity;
  readonly figure: RuleFigureKind;
  readonly read: (context: Context) => Reading<number>;
}

function resolveLimit<Context>(
  limit: FigureLimit<Context>,
  context: Context,
): Reading<number> {
  return typeof limit === 'number' ? known(limit) : limit(context);
}

interface Bounds {
  readonly minimum: number | null;
  readonly maximum: number | null;
}

/**
 * A rule with one bound is a threshold and reads "you are at x"; a rule with
 * both (or neither) is a band over a quantity the applicant chose, and reads
 * "you asked for x". The distinction is derived rather than configured because
 * it follows from the shape of the rule, and one more knob on every spec would
 * be one more thing to get wrong.
 */
function prefixOf(figure: RuleFigureKind, bounds: Bounds): string {
  const { minimum, maximum } = bounds;
  if (minimum !== null && maximum !== null) {
    return 'Between ' + formatFigure(figure, minimum) + ' and ' + formatFigure(figure, maximum);
  }
  if (minimum !== null) {
    return 'Needs ' + formatFigure(figure, minimum) + ' or more';
  }
  if (maximum !== null) {
    return 'Must be ' + formatFigure(figure, maximum) + ' or less';
  }
  return 'Any amount';
}

function subjectOf(bounds: Bounds): string {
  const single = (bounds.minimum === null) !== (bounds.maximum === null);
  return single ? ' -- you are at ' : ' -- you asked for ';
}

/**
 * Advice is dropped when the gap rounds away at the precision the figure is
 * quoted to. "Increase by 0.00" tells the reader nothing and reads as a bug.
 */
function adviceFor(figure: RuleFigureKind, verb: string, shortfall: number): string {
  if (formatFigure(figure, shortfall) === formatFigure(figure, 0)) {
    return '';
  }
  return ' ' + verb + ' by ' + formatFigure(figure, shortfall) + '.';
}

function bandRule<Context>(
  spec: NumericRuleSpec<Context> & {
    readonly minimum: FigureLimit<Context> | null;
    readonly maximum: FigureLimit<Context> | null;
  },
): Rule<Context> {
  const severity: RuleSeverity = spec.severity ?? 'error';
  return {
    id: spec.id,
    label: spec.label,
    severity,
    evaluate: (context) => {
      const minimumReading =
        spec.minimum === null ? null : resolveLimit(spec.minimum, context);
      const maximumReading =
        spec.maximum === null ? null : resolveLimit(spec.maximum, context);
      const actualReading = spec.read(context);

      const readings: Reading<number>[] = [actualReading];
      if (minimumReading !== null) {
        readings.push(minimumReading);
      }
      if (maximumReading !== null) {
        readings.push(maximumReading);
      }

      const bounds: Bounds = {
        minimum: minimumReading !== null && minimumReading.known ? minimumReading.value : null,
        maximum: maximumReading !== null && maximumReading.known ? maximumReading.value : null,
      };
      const prefix = prefixOf(spec.figure, bounds);
      const inputs: Record<string, unknown> = {
        ...combineInputs(readings),
        figure: spec.figure,
      };
      if (bounds.minimum !== null) {
        inputs['minimum'] = bounds.minimum;
      }
      if (bounds.maximum !== null) {
        inputs['maximum'] = bounds.maximum;
      }

      const missing = combineMissing(readings);
      if (missing.length > 0) {
        return ruleUnknown({
          id: spec.id,
          label: spec.label,
          severity,
          explain: prefix + ' -- enter ' + joinWords(missingLabels(missing)) + '.',
          inputs,
          missing: missingFields(missing),
        });
      }

      if (!actualReading.known) {
        throw new Error('unreachable: a reading with nothing missing carries a value');
      }
      const actual = actualReading.value;
      inputs['actual'] = actual;
      const stated = prefix + subjectOf(bounds) + formatFigure(spec.figure, actual);

      if (bounds.minimum !== null && actual < bounds.minimum) {
        const delta = figureDelta(spec.figure, actual, bounds.minimum);
        return ruleFailed({
          id: spec.id,
          label: spec.label,
          severity,
          explain: stated + '.' + adviceFor(spec.figure, 'Increase', delta.shortfall),
          inputs,
          delta,
        });
      }
      if (bounds.maximum !== null && actual > bounds.maximum) {
        const delta = figureDelta(spec.figure, actual, bounds.maximum);
        return ruleFailed({
          id: spec.id,
          label: spec.label,
          severity,
          explain: stated + '.' + adviceFor(spec.figure, 'Reduce', delta.shortfall),
          inputs,
          delta,
        });
      }
      return rulePassed({
        id: spec.id,
        label: spec.label,
        severity,
        explain: stated + '.',
        inputs,
      });
    },
  };
}

export function numericAtLeast<Context>(
  spec: NumericRuleSpec<Context> & { readonly minimum: FigureLimit<Context> },
): Rule<Context> {
  return bandRule({ ...spec, minimum: spec.minimum, maximum: null });
}

export function numericAtMost<Context>(
  spec: NumericRuleSpec<Context> & { readonly maximum: FigureLimit<Context> },
): Rule<Context> {
  return bandRule({ ...spec, minimum: null, maximum: spec.maximum });
}

export function numericWithinBand<Context>(
  spec: NumericRuleSpec<Context> & {
    readonly minimum: FigureLimit<Context> | null;
    readonly maximum: FigureLimit<Context> | null;
  },
): Rule<Context> {
  return bandRule(spec);
}
