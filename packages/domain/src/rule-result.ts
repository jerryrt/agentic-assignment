import { z } from 'zod';

import type { BasisPoints } from './finance.js';
import type { Money } from './money.js';

/**
 * The one vocabulary for "here is where you stand, and why".
 *
 * Eligibility criteria (Option 2), document completeness and consistency
 * (Option 1) and credit availability (Option 3) all reduce to
 * `evaluate(context) -> RuleResult[]`, and a workflow guard returns the same
 * type when it refuses a transition. One shape means one `<lj-rule-list>`
 * component and one explanation drawer across all three surfaces, and it means
 * a blocked transition and an unmet criterion read identically to the user --
 * because to the user they are the same thing.
 *
 * Three decisions in this file are load-bearing:
 *
 * 1. **`unknown` is a status, not an absence.** On step one of a four-step form
 *    nothing has been entered, so every criterion is "we need more information"
 *    -- not "you do not qualify". Showing a wall of red on a form the applicant
 *    has barely started is the failure this type exists to prevent. An
 *    `unknown` must name the inputs it is waiting for, which is what makes it
 *    actionable rather than merely vague.
 *
 * 2. **A failure carries its delta to passing.** "LTV 88% (max 80%) -- borrow
 *    $164,000, or add $30,000 down" is a product; "ineligible" is a wall. The
 *    delta is structured rather than only prose so the UI can render it as a
 *    control (a slider, a suggested amount) instead of only as a sentence.
 *
 * 3. **Every field is present, and absent values are null.** An
 *    `eligibility_snapshot` row stores these results as jsonb and they are read
 *    back later, so the shape has to survive `JSON.parse(JSON.stringify(x))`
 *    unchanged. An optional property does not: it disappears on serialisation
 *    and comes back as a different object.
 */

export const RULE_STATUSES = ['pass', 'fail', 'unknown'] as const;
export const RuleStatusSchema = z.enum(RULE_STATUSES);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

/** A warning explains; only an error blocks. */
export const RULE_SEVERITIES = ['error', 'warning'] as const;
export const RuleSeveritySchema = z.enum(RULE_SEVERITIES);
export type RuleSeverity = z.infer<typeof RuleSeveritySchema>;

/**
 * What a delta's figures are counted in. The unit travels with the numbers so
 * that a renderer can format them without knowing which rule produced them --
 * money through formatMoney, a ratio through formatBasisPointsAsRatio.
 */
export const RULE_DELTA_UNITS = [
  'money_minor_units',
  'basis_points',
  'count',
  'years',
  'acres',
] as const;
export const RuleDeltaUnitSchema = z.enum(RULE_DELTA_UNITS);
export type RuleDeltaUnit = z.infer<typeof RuleDeltaUnitSchema>;

export const RuleDeltaSchema = z
  .object({
    unit: RuleDeltaUnitSchema,
    /** Where the applicant is. */
    actual: z.number().int(),
    /** Where the criterion needs them to be. */
    required: z.number().int(),
    /** How far apart those are, as a magnitude. Never negative. */
    shortfall: z.number().int().nonnegative(),
    /** Which way `actual` has to move to reach `required`. */
    direction: z.enum(['increase', 'decrease']),
  })
  .refine((delta) => delta.shortfall === Math.abs(delta.required - delta.actual), {
    message: 'shortfall must be the distance between actual and required',
    path: ['shortfall'],
  })
  .refine((delta) => delta.direction === (delta.actual <= delta.required ? 'increase' : 'decrease'), {
    message: 'direction must follow from actual and required',
    path: ['direction'],
  });

export type RuleDelta = z.infer<typeof RuleDeltaSchema>;

export const RuleResultSchema = z
  .object({
    /** Stable across evaluations and across releases: snapshots are compared by it. */
    id: z.string().min(1),
    /** The criterion, in the applicant's words. */
    label: z.string().min(1),
    status: RuleStatusSchema,
    severity: RuleSeveritySchema,
    /** One sentence saying where they stand. Shown, not logged. */
    explain: z.string().min(1),
    /** The values the rule read, for the explanation drawer and for audit. */
    inputs: z.record(z.string(), z.unknown()),
    /** Field names still needed. Non-empty exactly when status is 'unknown'. */
    missing: z.array(z.string()),
    /** The gap to passing. Present only on a failure. */
    delta: RuleDeltaSchema.nullable(),
  })
  .superRefine((result, context) => {
    if (result.status === 'unknown' && result.missing.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['missing'],
        message:
          "An 'unknown' result must name the inputs it is waiting for, otherwise it is an " +
          'absence rather than a status.',
      });
    }
    if (result.status !== 'unknown' && result.missing.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['missing'],
        message: "A '" + result.status + "' result has everything it needs; 'missing' must be empty.",
      });
    }
    if (result.status !== 'fail' && result.delta !== null) {
      context.addIssue({
        code: 'custom',
        path: ['delta'],
        message: "Only a 'fail' has a gap to passing; 'delta' must be null otherwise.",
      });
    }
  });

export type RuleResult = z.infer<typeof RuleResultSchema>;

interface RuleResultInput {
  readonly id: string;
  readonly label: string;
  readonly explain: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly severity?: RuleSeverity;
}

export function rulePassed(input: RuleResultInput): RuleResult {
  return {
    id: input.id,
    label: input.label,
    status: 'pass',
    severity: input.severity ?? 'error',
    explain: input.explain,
    inputs: { ...input.inputs },
    missing: [],
    delta: null,
  };
}

export function ruleFailed(
  input: RuleResultInput & { readonly delta?: RuleDelta | null },
): RuleResult {
  return {
    id: input.id,
    label: input.label,
    status: 'fail',
    severity: input.severity ?? 'error',
    explain: input.explain,
    inputs: { ...input.inputs },
    missing: [],
    delta: input.delta ?? null,
  };
}

export function ruleUnknown(
  input: RuleResultInput & { readonly missing: readonly string[] },
): RuleResult {
  return {
    id: input.id,
    label: input.label,
    status: 'unknown',
    severity: input.severity ?? 'error',
    explain: input.explain,
    inputs: { ...input.inputs },
    missing: [...input.missing],
    delta: null,
  };
}

function buildDelta(unit: RuleDeltaUnit, actual: number, required: number): RuleDelta {
  return {
    unit,
    actual,
    required,
    shortfall: Math.abs(required - actual),
    // A met threshold is a zero shortfall pointing the way it would have to
    // move, not a negative one: the sign lives in `direction` so that the UI
    // never has to interpret a negative gap.
    direction: actual <= required ? 'increase' : 'decrease',
  };
}

/**
 * Deltas are built through these rather than by hand so that `shortfall` and
 * `direction` cannot contradict `actual` and `required` -- the schema rejects
 * that combination, and there is no reason for a caller to have to get it right
 * twice.
 */
export function moneyDelta(figures: { readonly actual: Money; readonly required: Money }): RuleDelta {
  return buildDelta('money_minor_units', figures.actual, figures.required);
}

export function basisPointsDelta(figures: {
  readonly actual: BasisPoints | number;
  readonly required: BasisPoints | number;
}): RuleDelta {
  return buildDelta('basis_points', figures.actual, figures.required);
}

export function countDelta(figures: { readonly actual: number; readonly required: number }): RuleDelta {
  return buildDelta('count', figures.actual, figures.required);
}

export function yearsDelta(figures: { readonly actual: number; readonly required: number }): RuleDelta {
  return buildDelta('years', figures.actual, figures.required);
}

export function acresDelta(figures: { readonly actual: number; readonly required: number }): RuleDelta {
  return buildDelta('acres', figures.actual, figures.required);
}

function blocks(result: RuleResult): boolean {
  return result.severity === 'error';
}

/** The blocking criteria that have already failed. */
export function blockingRuleResults(results: readonly RuleResult[]): readonly RuleResult[] {
  return results.filter((result) => blocks(result) && result.status === 'fail');
}

/** The blocking criteria that cannot be decided yet, and what they still need. */
export function unresolvedRuleResults(results: readonly RuleResult[]): readonly RuleResult[] {
  return results.filter((result) => blocks(result) && result.status === 'unknown');
}

/**
 * Fold a criteria set into one answer.
 *
 * 'fail' outranks 'unknown' because a decided failure stays a failure however
 * much more the applicant enters -- telling them "we need more information"
 * when one criterion has already ruled them out would be the same dishonesty as
 * the wall of red, pointing the other way. An empty set passes: nothing
 * disqualifies.
 */
export function overallRuleStatus(results: readonly RuleResult[]): RuleStatus {
  if (blockingRuleResults(results).length > 0) {
    return 'fail';
  }
  return unresolvedRuleResults(results).length > 0 ? 'unknown' : 'pass';
}
