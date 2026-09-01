import {
  type RuleResult,
  type RuleSeverity,
  blockingRuleResults,
  overallRuleStatus,
  unresolvedRuleResults,
} from '@lj/domain';

/**
 * One rule, and the evaluator that runs a set of them.
 *
 * Eligibility criteria, document completeness, cross-document consistency and
 * credit availability are all "read a context, produce a RuleResult", so they
 * share this one evaluator. That shared core is the reason three options are
 * affordable: one engine, one result vocabulary, one component rendering all of
 * it (plan 00).
 *
 * A rule holds no state and performs no I/O. Everything it needs arrives in the
 * context argument, including the clock -- a rule that reads the wall clock
 * cannot be tested and cannot be replayed (CLAUDE.md section 8).
 */
export interface Rule<Context> {
  /** Stable across releases: eligibility snapshots are compared by it. */
  readonly id: string;
  readonly label: string;
  readonly severity: RuleSeverity;
  readonly evaluate: (context: Context) => RuleResult;
}

export function evaluate<Context>(
  context: Context,
  rules: readonly Rule<Context>[],
): RuleResult[] {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      // A snapshot is compared by id and the panel keys its rows by it, so a
      // repeated id loses a row instead of failing. Fail here instead.
      throw new Error("Duplicate rule id '" + rule.id + "' in this rule set");
    }
    seen.add(rule.id);
  }
  return rules.map((rule) => rule.evaluate(context));
}

/**
 * The answer a guard needs: may this proceed, and if not, exactly why.
 *
 * Structurally compatible with the `GuardResult` of plan 03 so that a workflow
 * guard can return it directly. It is declared here rather than imported
 * because packages/rules may not import packages/workflow -- dependencies point
 * one way, and both packages sit on the same layer (CLAUDE.md section 8).
 */
export type RuleDecision =
  | { readonly ok: true; readonly results: readonly RuleResult[] }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly blockers: readonly RuleResult[];
      readonly results: readonly RuleResult[];
    };

function countPhrase(count: number, verbSingular: string, verbPlural: string): string {
  return String(count) + (count === 1 ? ' criterion ' + verbSingular : ' criteria ' + verbPlural);
}

/**
 * Fold results into a decision.
 *
 * An undecided blocking criterion refuses just as a failed one does: a guard
 * that cannot tell whether it is satisfied must fail closed. The two are still
 * reported separately, because "you do not qualify" and "we need more from you"
 * are different sentences to the person reading them.
 */
export function decide(results: readonly RuleResult[]): RuleDecision {
  if (overallRuleStatus(results) === 'pass') {
    return { ok: true, results };
  }

  const failed = blockingRuleResults(results);
  const unresolved = unresolvedRuleResults(results);
  // Filtering the original list keeps blockers in rule order rather than
  // grouping all the failures ahead of all the unknowns; the panel reads top to
  // bottom and the guard's list should match it.
  const blocking = new Set<RuleResult>([...failed, ...unresolved]);
  const blockers = results.filter((result) => blocking.has(result));

  const phrases: string[] = [];
  if (failed.length > 0) {
    phrases.push(countPhrase(failed.length, 'is not met', 'are not met'));
  }
  if (unresolved.length > 0) {
    phrases.push(
      countPhrase(
        unresolved.length,
        'is waiting on information',
        'are waiting on information',
      ),
    );
  }

  return { ok: false, reason: phrases.join(' and ') + '.', blockers, results };
}

/** Evaluate a rule set and fold it into one answer. */
export function requireAll<Context>(
  context: Context,
  rules: readonly Rule<Context>[],
): RuleDecision {
  return decide(evaluate(context, rules));
}
