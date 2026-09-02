// Which declared effects this API can carry out, and what happens to the ones
// it cannot.
//
// The set is data, so it is testable without a database. What each runner
// actually writes is proved end to end in transition.spec.ts, against the real
// schema -- a mock of the snapshot write would agree with whatever this code
// believes, which is the one thing that must not be assumed.

import { describe, expect, it } from 'vitest';

import { RUNNABLE_EFFECT_KINDS, unrunnableEffects } from '../lib/effects.ts';

describe('the effects this API can run', () => {
  it('runs the eligibility snapshot the submit transition declares', () => {
    expect(RUNNABLE_EFFECT_KINDS.has('write_eligibility_snapshot')).toBe(true);
    expect(unrunnableEffects([{ kind: 'write_eligibility_snapshot' }])).toEqual([]);
  });

  /**
   * The refusal that matters more than the runner. `create_loan` needs a `loan`
   * table that does not exist, so funding an application would otherwise move
   * it to a state that says money changed hands when nothing did -- discovered
   * later, by whoever reconciles.
   */
  it('names an effect it has no runner for, rather than skipping it', () => {
    expect(RUNNABLE_EFFECT_KINDS.has('create_loan')).toBe(false);
    expect(unrunnableEffects([{ kind: 'create_loan' }])).toEqual(['create_loan']);
    expect(unrunnableEffects([{ kind: 'post_ledger_entry' }])).toEqual([
      'post_ledger_entry',
    ]);
  });

  it('reports the unrunnable ones in the order they were declared', () => {
    expect(
      unrunnableEffects([
        { kind: 'write_eligibility_snapshot' },
        { kind: 'post_ledger_entry' },
        { kind: 'create_loan' },
      ]),
    ).toEqual(['post_ledger_entry', 'create_loan']);
  });
});
