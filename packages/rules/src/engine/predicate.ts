import { type RuleSeverity, ruleFailed, rulePassed, ruleUnknown } from '@lj/domain';

import { joinWords } from './figures.ts';
import { type Reading, missingFields, missingLabels } from './reading.ts';
import type { Rule } from './rule.ts';

/**
 * A criterion that is neither a quantity nor a category: a fact that either
 * holds or does not.
 *
 * The two sentences are supplied rather than generated because there is nothing
 * to generate them from -- "this loan is closed, no further credit can be
 * released" cannot be derived from a boolean. Both are stated so the failing
 * one can name the next action, which is what plan 04 asks of every failure.
 */
export interface PredicateRuleSpec<Context> {
  readonly id: string;
  readonly label: string;
  readonly severity?: RuleSeverity;
  readonly read: (context: Context) => Reading<boolean>;
  readonly whenTrue: string;
  readonly whenFalse: string;
}

export function predicate<Context>(spec: PredicateRuleSpec<Context>): Rule<Context> {
  const severity: RuleSeverity = spec.severity ?? 'error';
  return {
    id: spec.id,
    label: spec.label,
    severity,
    evaluate: (context) => {
      const reading = spec.read(context);
      if (!reading.known) {
        return ruleUnknown({
          id: spec.id,
          label: spec.label,
          severity,
          explain: 'Waiting on ' + joinWords(missingLabels(reading.missing)) + '.',
          inputs: reading.inputs,
          missing: missingFields(reading.missing),
        });
      }
      const inputs = { ...reading.inputs, actual: reading.value };
      return reading.value
        ? rulePassed({ id: spec.id, label: spec.label, severity, explain: spec.whenTrue, inputs })
        : ruleFailed({ id: spec.id, label: spec.label, severity, explain: spec.whenFalse, inputs });
    },
  };
}
