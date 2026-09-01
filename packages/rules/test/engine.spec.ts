import { describe, expect, it } from 'vitest';

import { RuleResultSchema, ruleFailed, rulePassed, ruleUnknown, type RuleResult } from '@lj/domain';

import { evaluate, requireAll, type Rule } from '../src/index.js';

/** A rule that ignores its context: enough to exercise the evaluator itself. */
function constantRule(result: RuleResult): Rule<null> {
  return {
    id: result.id,
    label: result.label,
    severity: result.severity,
    evaluate: () => result,
  };
}

const passing = rulePassed({ id: 'a', label: 'A', explain: 'A is met' });
const failing = ruleFailed({ id: 'b', label: 'B', explain: 'B is not met' });
const waiting = ruleUnknown({
  id: 'c',
  label: 'C',
  explain: 'C needs more information',
  missing: ['c_input'],
});
const advisory = ruleFailed({
  id: 'd',
  label: 'D',
  explain: 'D disagrees slightly',
  severity: 'warning',
});

describe('evaluate', () => {
  it('runs every rule against the one context and keeps their order', () => {
    const results = evaluate(null, [constantRule(passing), constantRule(failing)]);
    expect(results.map((result) => result.id)).toEqual(['a', 'b']);
    for (const result of results) {
      expect(RuleResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it('passes the context through to each rule', () => {
    const rule: Rule<number> = {
      id: 'doubled',
      label: 'Doubled',
      severity: 'error',
      evaluate: (context) => rulePassed({ id: 'doubled', label: 'Doubled', explain: String(context * 2) }),
    };
    expect(evaluate(21, [rule])[0]?.explain).toBe('42');
  });

  // Snapshots are compared by id and the UI keys rows by it, so two rules
  // sharing one id silently lose a row rather than fail loudly.
  it('refuses a rule set with a duplicate id', () => {
    expect(() => evaluate(null, [constantRule(passing), constantRule(passing)])).toThrow(/duplicate/i);
  });

  it('evaluates an empty rule set to nothing', () => {
    expect(evaluate(null, [])).toEqual([]);
  });
});

describe('requireAll', () => {
  it('allows the action when every blocking criterion passes', () => {
    const decision = requireAll(null, [constantRule(passing)]);
    expect(decision.ok).toBe(true);
    expect(decision.results.map((result) => result.id)).toEqual(['a']);
  });

  it('allows the action with nothing to check', () => {
    expect(requireAll(null, []).ok).toBe(true);
  });

  it('refuses on a failed blocking criterion and names it as a blocker', () => {
    const decision = requireAll(null, [constantRule(passing), constantRule(failing)]);
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.blockers.map((result) => result.id)).toEqual(['b']);
    expect(decision.reason).toContain('1 criterion is not met');
  });

  // A criterion nobody can decide yet is not permission to proceed: the guard
  // has to fail closed, and the reason has to say which of the two it is.
  it('refuses while a blocking criterion is still unknown', () => {
    const decision = requireAll(null, [constantRule(waiting)]);
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.blockers.map((result) => result.id)).toEqual(['c']);
    expect(decision.reason).toContain('1 criterion is waiting on information');
  });

  it('reports both counts when some fail and others are unknown', () => {
    const decision = requireAll(null, [constantRule(failing), constantRule(waiting)]);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.reason).toBe(
      '1 criterion is not met and 1 criterion is waiting on information.',
    );
  });

  it('does not let a warning block: an advisory explains, it does not refuse', () => {
    const decision = requireAll(null, [constantRule(passing), constantRule(advisory)]);
    expect(decision.ok).toBe(true);
    expect(decision.results).toHaveLength(2);
  });
});
