import { blockingRuleResults, unresolvedRuleResults, overallRuleStatus } from '@lj/domain';
import type { RuleResult } from '@lj/domain';

import type { GuardRefusal, GuardResult } from './types.js';

/**
 * Guard composition.
 *
 * A guard never evaluates a rule. packages/rules does that, and it sits beside
 * this package rather than below it, so importing it would point a dependency
 * sideways and would put I/O-free logic behind an argument the caller cannot
 * see. Evaluated `RuleResult[]` therefore arrive in the guard's context, and
 * these two helpers are all a guard needs to turn them into a verdict.
 */

export const PASSES: GuardResult = { ok: true };

/**
 * Turn an evaluated rule set into a verdict.
 *
 * Both a failed criterion and an undecided one block, and both are reported.
 * "We do not know yet" is not permission, and the fields an undecided criterion
 * is waiting for are exactly what the borrower has to be told next.
 *
 * An empty set refuses. That is the load-bearing decision in this file: an
 * empty set means the caller did not evaluate this rule set, and reading "no
 * criteria" as "no objections" would let a forgotten evaluation open a
 * transition with nothing to show for it. It fails closed, in the same
 * direction as the empty `workflow_transition` table.
 */
export function requireRules(reason: string, results: readonly RuleResult[]): GuardResult {
  if (results.length === 0) {
    return {
      ok: false,
      reason: reason + ' (the criteria for it have not been evaluated)',
      blockers: [],
    };
  }
  if (overallRuleStatus(results) === 'pass') {
    return PASSES;
  }
  return {
    ok: false,
    reason,
    blockers: [...blockingRuleResults(results), ...unresolvedRuleResults(results)],
  };
}

/**
 * Combine guards, keeping every refusal rather than the first.
 *
 * Short-circuiting would be cheaper and would produce the wall the whole
 * RuleResult vocabulary exists to avoid: an applicant fixing one problem only to
 * be shown the next one. Every reason and every blocker survives.
 */
export function requireAll(parts: readonly GuardResult[]): GuardResult {
  const refusals = parts.filter((part): part is GuardRefusal => !part.ok);
  if (refusals.length === 0) {
    return PASSES;
  }
  return {
    ok: false,
    reason: refusals.map((refusal) => refusal.reason).join('; '),
    blockers: refusals.flatMap((refusal) => [...refusal.blockers]),
  };
}
