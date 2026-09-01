import { describe, expect, it } from 'vitest';

import { countDelta, ruleFailed, rulePassed, ruleUnknown } from '@lj/domain';
import type { RuleResult } from '@lj/domain';

import { can, requireAll, requireRules } from '../src/index.js';
import { applicationMachine, creditReleaseMachine } from '../src/index.js';
import type { ApplicationGuardContext, CreditReleaseGuardContext } from '../src/index.js';

/**
 * Guards are pure and take everything they need in their context argument
 * (CLAUDE.md section 8), so "a passing and a failing context" is the entire
 * test surface. The rule results themselves are built here rather than
 * evaluated: packages/rules produces them in production, and importing it would
 * point a dependency sideways.
 */

function passing(id: string): RuleResult {
  return rulePassed({ id, label: id, explain: 'satisfied' });
}

function failing(id: string): RuleResult {
  return ruleFailed({
    id,
    label: id,
    explain: 'not satisfied',
    delta: countDelta({ actual: 0, required: 1 }),
  });
}

function undecided(id: string, missing: readonly string[]): RuleResult {
  return ruleUnknown({ id, label: id, explain: 'more information needed', missing });
}

function applicationContext(
  overrides: Partial<ApplicationGuardContext> = {},
): ApplicationGuardContext {
  return {
    completeness: [passing('steps_complete')],
    eligibility: [passing('at_least_one_eligible_product')],
    documentPack: [passing('document_pack_complete')],
    ...overrides,
  };
}

function creditReleaseContext(
  overrides: Partial<CreditReleaseGuardContext> = {},
): CreditReleaseGuardContext {
  return { availableCredit: [passing('within_available_credit')], ...overrides };
}

describe('requireRules', () => {
  it('passes when every blocking criterion passes', () => {
    expect(requireRules('nope', [passing('a'), passing('b')])).toEqual({ ok: true });
  });

  it('reports the failed criteria as blockers, so the UI can render them', () => {
    const verdict = requireRules('the application is not complete', [
      passing('a'),
      failing('b'),
    ]);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('the application is not complete');
    expect(verdict.ok === false && verdict.blockers.map((blocker) => blocker.id)).toEqual(['b']);
  });

  /**
   * An undecided criterion blocks. "We do not know yet" is not permission, and
   * the missing fields are exactly what the borrower needs to be told.
   */
  it('blocks on an undecided criterion and carries what it is waiting for', () => {
    const verdict = requireRules('the application is not complete', [
      undecided('b', ['annual_income']),
    ]);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.blockers[0]?.missing).toEqual(['annual_income']);
  });

  it('does not block on a warning: a warning explains, only an error blocks', () => {
    const warning = ruleFailed({
      id: 'w',
      label: 'w',
      explain: 'worth knowing',
      severity: 'warning',
    });

    expect(requireRules('nope', [warning])).toEqual({ ok: true });
  });

  /**
   * Fail closed. An empty bucket means the API did not evaluate this rule set,
   * and treating "no criteria" as "no objections" would let a forgotten
   * evaluation open a transition silently -- the same failure direction the
   * empty workflow_transition table is deliberately on the safe side of.
   */
  it('refuses when it was handed no criteria at all', () => {
    const verdict = requireRules('the application is not complete', []);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/not been evaluated/);
    expect(verdict.ok === false && verdict.blockers).toEqual([]);
  });
});

describe('requireAll', () => {
  it('passes only when every part passes', () => {
    expect(requireAll([{ ok: true }, { ok: true }])).toEqual({ ok: true });
  });

  it('collects the blockers of every failing part, not just the first', () => {
    const verdict = requireAll([
      requireRules('first', [failing('a')]),
      requireRules('second', [failing('b')]),
    ]);

    expect(verdict.ok === false && verdict.blockers.map((blocker) => blocker.id)).toEqual([
      'a',
      'b',
    ]);
    expect(verdict.ok === false && verdict.reason).toBe('first; second');
  });

  it('still refuses when a failing part carried no blockers', () => {
    const verdict = requireAll([{ ok: false, reason: 'structural', blockers: [] }]);

    expect(verdict.ok).toBe(false);
  });
});

describe("the application machine's submit guard", () => {
  it('allows submission when the steps are complete and a product fits', () => {
    expect(
      can(applicationMachine, 'draft', 'submit', 'borrower', applicationContext()),
    ).toEqual({ ok: true });
  });

  it('refuses an incomplete application and says which criterion is unmet', () => {
    const verdict = can(applicationMachine, 'draft', 'submit', 'borrower', {
      ...applicationContext(),
      completeness: [failing('steps_complete')],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/not complete/);
    expect(verdict.ok === false && verdict.blockers.map((blocker) => blocker.id)).toEqual([
      'steps_complete',
    ]);
  });

  it('refuses when no product matches', () => {
    const verdict = can(applicationMachine, 'draft', 'submit', 'borrower', {
      ...applicationContext(),
      eligibility: [failing('at_least_one_eligible_product')],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/no product/);
  });

  it('reports both refusals at once rather than one at a time', () => {
    const verdict = can(applicationMachine, 'draft', 'submit', 'borrower', {
      ...applicationContext(),
      completeness: [failing('steps_complete')],
      eligibility: [failing('at_least_one_eligible_product')],
    });

    expect(verdict.ok === false && verdict.blockers).toHaveLength(2);
  });
});

describe("the application machine's begin_review guard", () => {
  it('allows review to start once the document pack is complete', () => {
    expect(
      can(applicationMachine, 'docs_pending', 'begin_review', 'lender', applicationContext()),
    ).toEqual({ ok: true });
  });

  it('refuses while a required document is missing', () => {
    const verdict = can(applicationMachine, 'docs_pending', 'begin_review', 'lender', {
      ...applicationContext(),
      documentPack: [failing('document_pack_complete')],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/document pack/);
  });
});

describe("the credit release machine's submit guard", () => {
  it('allows a request that sits within available credit', () => {
    expect(
      can(creditReleaseMachine, 'draft', 'submit', 'borrower', creditReleaseContext()),
    ).toEqual({ ok: true });
  });

  it('refuses a request that exceeds available credit', () => {
    const verdict = can(creditReleaseMachine, 'draft', 'submit', 'borrower', {
      availableCredit: [failing('within_available_credit')],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/available credit/);
    expect(verdict.ok === false && verdict.blockers.map((blocker) => blocker.id)).toEqual([
      'within_available_credit',
    ]);
  });
});
