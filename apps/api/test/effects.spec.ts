// Which declared effects this API can carry out, and what happens to the ones
// it cannot.
//
// The set is data, so it is testable without a database. What each runner
// actually writes is proved end to end in transition.spec.ts, against the real
// schema -- a mock of the snapshot write would agree with whatever this code
// believes, which is the one thing that must not be assumed.

import { applicationMachine, apply, creditReleaseMachine, type EffectSpec } from '@lj/workflow';
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

describe('what the credit release machine declares', () => {
  /**
   * The third effect whose absence would be silent, and the one that is about
   * money: a release at `funded` with nothing on the ledger is a disbursement
   * no statement shows.
   */
  it('posts the ledger entry when a lender disburses an approved request', () => {
    const outcome = apply(creditReleaseMachine, 'approved', 'disburse', 'lender', {
      availableCredit: [],
    });

    expect(outcome.ok === true && outcome.effects).toEqual([{ kind: 'post_ledger_entry' }]);
  });

  /** No guard on `disburse`, so the empty context above is not a shortcut. */
  it('guards only the submit, and refuses it on an unevaluated rule set', () => {
    const outcome = apply(creditReleaseMachine, 'draft', 'submit', 'borrower', {
      availableCredit: [],
    });

    expect(outcome.ok).toBe(false);
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

  it('names every effect kind it has a runner for', () => {
    expect([...RUNNABLE_EFFECT_KINDS].sort()).toEqual([
      'create_document_slots',
      'create_loan',
      'extract_document',
      'post_ledger_entry',
      'write_eligibility_snapshot',
    ]);
    expect(
      unrunnableEffects([{ kind: 'create_loan' }, { kind: 'post_ledger_entry' }]),
    ).toEqual([]);
  });

  /**
   * The refusal that matters more than any runner, kept honest with a kind that
   * does not exist.
   *
   * Every effect the three machines declare now has a runner, so there is no
   * real kind left to refuse with -- and the property must not rot for want of
   * a case: an effect nothing can carry out refuses the transition BEFORE the
   * update, rather than moving the subject and skipping what the move promised.
   */
  it('reports an effect with no runner, in the order it was declared', () => {
    const unimplemented = { kind: 'settle_escrow' } as unknown as EffectSpec;

    expect(
      unrunnableEffects([
        { kind: 'write_eligibility_snapshot' },
        unimplemented,
        { kind: 'create_document_slots' },
      ]),
    ).toEqual(['settle_escrow']);
  });
});
