// Which declared effects this API can carry out, and what happens to the ones
// it cannot.
//
// The set is data, so it is testable without a database. What each runner
// actually writes is proved end to end in transition.spec.ts, against the real
// schema -- a mock of the snapshot write would agree with whatever this code
// believes, which is the one thing that must not be assumed.

import { applicationMachine, apply } from '@lj/workflow';
import { describe, expect, it } from 'vitest';

import { declaresEffect, RUNNABLE_EFFECT_KINDS, unrunnableEffects } from '../lib/effects.ts';

/** No guard on `request_docs`, so an empty context is the whole context. */
const NO_RULES_EVALUATED = { completeness: [], eligibility: [], documentPack: [] };

// The machine definition is data, so what a transition declares is testable
// without a database. That matters most for the two effects whose absence would
// be silent: an application at `docs_pending` with no checklist, and a `funded`
// application with no loan.
describe('what the application machine declares', () => {
  it('creates the document slots when a lender asks for documents', () => {
    const outcome = apply(
      applicationMachine,
      'submitted',
      'request_docs',
      'lender',
      NO_RULES_EVALUATED,
    );

    expect(outcome.ok === true && outcome.effects).toEqual([
      { kind: 'create_document_slots' },
    ]);
  });

  /**
   * The other effect whose absence would be silent. An application at `funded`
   * with no loan behind it says money moved when nothing did, and nothing in
   * the application's own row would show it.
   */
  it('creates the loan when a lender funds an approved application', () => {
    const outcome = apply(
      applicationMachine,
      'approved',
      'fund',
      'lender',
      NO_RULES_EVALUATED,
    );

    expect(outcome.ok === true && outcome.effects).toEqual([{ kind: 'create_loan' }]);
  });
});

describe('the effects this API can run', () => {
  it('generates the document pack the request_docs transition declares', () => {
    expect(RUNNABLE_EFFECT_KINDS.has('create_document_slots')).toBe(true);
    expect(unrunnableEffects([{ kind: 'create_document_slots' }])).toEqual([]);
  });

  it('answers whether a transition declares one particular effect', () => {
    expect(declaresEffect([{ kind: 'create_document_slots' }], 'create_document_slots')).toBe(
      true,
    );
    expect(declaresEffect([{ kind: 'write_eligibility_snapshot' }], 'create_document_slots')).toBe(
      false,
    );
    expect(declaresEffect([], 'create_document_slots')).toBe(false);
  });

  it('runs the eligibility snapshot the submit transition declares', () => {
    expect(RUNNABLE_EFFECT_KINDS.has('write_eligibility_snapshot')).toBe(true);
    expect(unrunnableEffects([{ kind: 'write_eligibility_snapshot' }])).toEqual([]);
  });

  it('opens the facility the fund transition declares', () => {
    expect(RUNNABLE_EFFECT_KINDS.has('create_loan')).toBe(true);
    expect(unrunnableEffects([{ kind: 'create_loan' }])).toEqual([]);
  });

  /**
   * The refusal that matters more than the runner. `post_ledger_entry` has no
   * runner yet, so disbursing a release would otherwise move it to `funded`
   * with nothing on the ledger -- money said to have moved that no statement
   * shows, discovered later by whoever reconciles.
   */
  it('names an effect it has no runner for, rather than skipping it', () => {
    expect(RUNNABLE_EFFECT_KINDS.has('post_ledger_entry')).toBe(false);
    expect(unrunnableEffects([{ kind: 'post_ledger_entry' }])).toEqual([
      'post_ledger_entry',
    ]);
  });

  it('reports the unrunnable ones in the order they were declared', () => {
    expect(
      unrunnableEffects([
        { kind: 'write_eligibility_snapshot' },
        { kind: 'post_ledger_entry' },
        { kind: 'create_document_slots' },
      ]),
    ).toEqual(['post_ledger_entry']);
  });
});
