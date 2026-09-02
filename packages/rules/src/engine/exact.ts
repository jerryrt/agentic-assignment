import { type RuleSeverity, ruleFailed, rulePassed, ruleUnknown } from '@lj/domain';

import { joinWords } from './figures.ts';
import {
  type AgreementSource,
  type Reading,
  combineInputs,
  combineMissing,
  missingFields,
  missingLabels,
} from './reading.ts';
import type { Rule } from './rule.ts';

/**
 * The comparators for values that are not quantities.
 *
 * A category has no distance, so these never carry a delta: "you farm
 * livestock, we lend on grain" cannot be closed by moving a number, and
 * inventing a shortfall for it would put a meaningless figure in front of the
 * applicant.
 */

export interface OneOfRuleSpec<Context> {
  readonly id: string;
  readonly label: string;
  readonly severity?: RuleSeverity;
  /** The accepted set, stated once, here. */
  readonly allowed: readonly string[];
  readonly read: (context: Context) => Reading<string>;
}

export function oneOf<Context>(spec: OneOfRuleSpec<Context>): Rule<Context> {
  const severity: RuleSeverity = spec.severity ?? 'error';
  const allowed = [...spec.allowed];
  const prefix = 'Accepted: ' + joinWords(allowed);
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
          explain: prefix + ' -- enter ' + joinWords(missingLabels(reading.missing)) + '.',
          inputs: { ...reading.inputs, allowed },
          missing: missingFields(reading.missing),
        });
      }
      const explain = prefix + ' -- you entered ' + reading.value + '.';
      const inputs = { ...reading.inputs, actual: reading.value, allowed };
      return allowed.includes(reading.value)
        ? rulePassed({ id: spec.id, label: spec.label, severity, explain, inputs })
        : ruleFailed({ id: spec.id, label: spec.label, severity, explain, inputs });
    },
  };
}

export interface ExactAgreementSpec<Context> {
  readonly id: string;
  readonly label: string;
  readonly severity?: RuleSeverity;
  readonly sources: readonly AgreementSource<Context, string>[];
  /**
   * Applied before comparison, never before display. The applicant should see
   * what their documents actually say, not what the comparison reduced them to.
   */
  readonly normalise?: (value: string) => string;
}

/**
 * A legal entity name very often ends in a full stop ("Smith Farms Ltd."), and
 * a sentence built by appending one would read "Ltd..". Ending the sentence
 * with the value's own stop is the only place this matters, so it is handled
 * here rather than by mangling the value.
 */
function endSentence(text: string): string {
  return text.endsWith('.') ? text : text + '.';
}

export function exactAgreement<Context>(spec: ExactAgreementSpec<Context>): Rule<Context> {
  const severity: RuleSeverity = spec.severity ?? 'error';
  const normalise = spec.normalise ?? ((value: string) => value);
  return {
    id: spec.id,
    label: spec.label,
    severity,
    evaluate: (context) => {
      const readings = spec.sources.map((source) => source.read(context));
      const missing = combineMissing(readings);
      if (missing.length > 0) {
        return ruleUnknown({
          id: spec.id,
          label: spec.label,
          severity,
          explain: 'Cannot compare until we have ' + joinWords(missingLabels(missing)) + '.',
          inputs: combineInputs(readings),
          missing: missingFields(missing),
        });
      }

      const values = readings.map((reading) => (reading.known ? reading.value : ''));
      const inputs: Record<string, unknown> = { ...combineInputs(readings) };
      spec.sources.forEach((source, index) => {
        inputs[source.name] = values[index];
      });

      const normalised = values.map(normalise);
      const first = normalised[0];
      if (normalised.every((value) => value === first)) {
        return rulePassed({
          id: spec.id,
          label: spec.label,
          severity,
          explain: endSentence(
            joinWords(spec.sources.map((source) => source.name)) + ' agree: ' + String(values[0]),
          ),
          inputs,
        });
      }

      return ruleFailed({
        id: spec.id,
        label: spec.label,
        severity,
        explain:
          spec.sources
            .map((source, index) => source.name + ': "' + String(values[index]) + '"')
            .join('; ') + ' -- these must match.',
        inputs,
      });
    },
  };
}
