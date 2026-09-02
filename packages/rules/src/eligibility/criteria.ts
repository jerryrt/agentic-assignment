import { RULE_SEVERITIES, type RuleSeverity } from '@lj/domain';

import { figureUnitNoun } from '../engine/figures.ts';
import {
  ELIGIBILITY_FIELDS,
  type EligibilityFieldName,
  isEligibilityFieldName,
} from './fields.ts';

/**
 * `loan_product.criteria`, parsed.
 *
 * The column is `jsonb` and @lj/domain deliberately leaves it opaque: giving it
 * a shape down there would put the schema for a rule below the layer that owns
 * the rule (CLAUDE.md section 8). So this is the one place that decides what a
 * criteria set may say, and it is the trust boundary for it.
 *
 * The parse is hand-written narrowing over `unknown` rather than a Zod schema
 * because zod is a dependency of @lj/domain alone; pnpm's isolated
 * node_modules does not hoist it, and adding it here would put this scope in
 * the lockfile for the sake of a fixed grammar of three shapes.
 *
 * Two properties matter more than the mechanism:
 *
 * 1. **It fails closed.** An unknown field, a mismatched comparison, a
 *    duplicated id or a version this code was not written for is a rejection,
 *    never a criterion quietly dropped. A dropped criterion is invisible: the
 *    panel renders one row fewer and nobody notices until an ineligible
 *    applicant is approved.
 * 2. **Thresholds are integers in the field's own unit.** A coverage floor of
 *    1.25 is `12500` basis points, a loan-to-value cap of 80% is `8000`, and an
 *    amount is minor units. A float threshold makes ">= 1.25" undecidable
 *    exactly at 1.25, which is the one value a boundary test cares about.
 */

export const ELIGIBILITY_CRITERIA_VERSION = 1;

export interface NumericEligibilityCriterion {
  readonly id: string;
  readonly label: string;
  readonly kind: 'min' | 'max';
  readonly field: EligibilityFieldName;
  /** Integer, in the unit the field is counted in. */
  readonly threshold: number;
  readonly severity: RuleSeverity;
}

export interface CategoricalEligibilityCriterion {
  readonly id: string;
  readonly label: string;
  readonly kind: 'one_of';
  readonly field: EligibilityFieldName;
  readonly allowed: readonly string[];
  readonly severity: RuleSeverity;
}

export type EligibilityCriterion =
  | NumericEligibilityCriterion
  | CategoricalEligibilityCriterion;

export interface EligibilityCriteria {
  readonly version: number;
  readonly rules: readonly EligibilityCriterion[];
}

export type EligibilityCriteriaParse =
  | { readonly ok: true; readonly criteria: EligibilityCriteria }
  | { readonly ok: false; readonly problems: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function severityOf(value: unknown, where: string, problems: string[]): RuleSeverity {
  if (value === undefined) {
    // A criterion that does not say otherwise blocks. An advisory criterion is
    // a decision somebody has to have made on purpose.
    return 'error';
  }
  if (typeof value === 'string' && (RULE_SEVERITIES as readonly string[]).includes(value)) {
    return value as RuleSeverity;
  }
  problems.push(where + ": severity must be one of " + RULE_SEVERITIES.join(', '));
  return 'error';
}

function parseCriterion(
  raw: unknown,
  index: number,
  problems: string[],
): EligibilityCriterion | null {
  const where = 'criterion ' + String(index);
  if (!isRecord(raw)) {
    problems.push(where + ': must be an object');
    return null;
  }

  const id = raw['id'];
  const label = raw['label'];
  const kind = raw['kind'];
  const field = raw['field'];

  if (!nonEmptyString(id)) {
    problems.push(where + ': id must be a non-empty string');
    return null;
  }
  const named = "criterion '" + id + "'";
  if (!nonEmptyString(label)) {
    problems.push(named + ': label must be a non-empty string');
    return null;
  }
  if (!nonEmptyString(field) || !isEligibilityFieldName(field)) {
    problems.push(
      named + ": field '" + String(field) + "' is not one of the fields this engine can read",
    );
    return null;
  }

  const severity = severityOf(raw['severity'], named, problems);
  const definition = ELIGIBILITY_FIELDS[field];

  if (kind === 'min' || kind === 'max') {
    if (definition.sort !== 'numeric') {
      problems.push(named + ": '" + kind + "' compares numbers, and " + field + ' is a category');
      return null;
    }
    const threshold = raw['threshold'];
    if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold)) {
      problems.push(
        named +
          ': threshold must be an integer number of ' +
          figureUnitNoun(definition.figure) +
          '; received ' +
          String(threshold),
      );
      return null;
    }
    return { id, label, kind, field, threshold, severity };
  }

  if (kind === 'one_of') {
    if (definition.sort !== 'categorical') {
      problems.push(named + ": 'one_of' compares categories, and " + field + ' is a number');
      return null;
    }
    const allowed = raw['allowed'];
    if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every(nonEmptyString)) {
      problems.push(named + ': allowed must be a non-empty array of non-empty strings');
      return null;
    }
    return { id, label, kind, field, allowed: [...allowed], severity };
  }

  problems.push(named + ": kind must be one of min, max, one_of; received '" + String(kind) + "'");
  return null;
}

export function parseEligibilityCriteria(value: unknown): EligibilityCriteriaParse {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return { ok: false, problems: ['criteria must be a JSON object'] };
  }
  if (value['version'] !== ELIGIBILITY_CRITERIA_VERSION) {
    problems.push(
      'criteria version must be ' +
        String(ELIGIBILITY_CRITERIA_VERSION) +
        '; received ' +
        String(value['version']),
    );
  }
  const rawRules = value['rules'];
  if (!Array.isArray(rawRules)) {
    problems.push('criteria must carry a rules array');
    return { ok: false, problems };
  }

  const rules: EligibilityCriterion[] = [];
  const seen = new Set<string>();
  rawRules.forEach((raw, index) => {
    const criterion = parseCriterion(raw, index, problems);
    if (criterion === null) {
      return;
    }
    if (seen.has(criterion.id)) {
      problems.push("criterion '" + criterion.id + "': id appears twice in one criteria set");
      return;
    }
    seen.add(criterion.id);
    rules.push(criterion);
  });

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, criteria: { version: ELIGIBILITY_CRITERIA_VERSION, rules } };
}
