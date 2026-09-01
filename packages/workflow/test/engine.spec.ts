import { describe, expect, it } from 'vitest';

import { rulePassed } from '@lj/domain';

import { can, apply, defineMachine, reachableStates, terminalStates } from '../src/index.js';
import type { GuardResult } from '../src/index.js';

/**
 * The engine is exercised through a throwaway machine rather than through the
 * three real ones. A test that uses `application` to prove `can()` refuses an
 * unknown event fails for two different reasons after an edit -- the engine
 * broke, or the machine changed -- and the message does not say which.
 */

interface ToyContext {
  readonly approvals: readonly ReturnType<typeof rulePassed>[];
}

function toyMachine() {
  return defineMachine<'red' | 'amber' | 'green', 'go' | 'stop' | 'halt', ToyContext>({
    id: 'application',
    initial: 'red',
    states: ['red', 'amber', 'green'],
    transitions: [
      { from: 'red', event: 'go', to: 'amber', actor: ['borrower'] },
      {
        from: 'amber',
        event: 'go',
        to: 'green',
        actor: ['lender', 'admin'],
        guard: (context: ToyContext): GuardResult =>
          context.approvals.length > 0
            ? { ok: true }
            : { ok: false, reason: 'nobody approved', blockers: [] },
      },
      { from: ['amber', 'green'], event: 'stop', to: 'red', actor: ['borrower'] },
    ],
  });
}

const PASSING: ToyContext = {
  approvals: [rulePassed({ id: 'toy', label: 'Toy', explain: 'fine' })],
};
const EMPTY: ToyContext = { approvals: [] };

describe('defineMachine', () => {
  it('normalises a single `from` state into a list', () => {
    const machine = toyMachine();
    const stop = machine.transitions.find((transition) => transition.event === 'stop');
    const go = machine.transitions.find((transition) => transition.from.includes('red'));

    expect(stop?.from).toEqual(['amber', 'green']);
    expect(go?.from).toEqual(['red']);
  });

  it('rejects an initial state that is not declared', () => {
    expect(() =>
      defineMachine<'red', 'go', ToyContext>({
        id: 'application',
        initial: 'red',
        states: [],
        transitions: [],
      }),
    ).toThrow(/initial state 'red'/);
  });

  it('rejects a transition into an undeclared state', () => {
    expect(() =>
      defineMachine<'red' | 'blue', 'go', ToyContext>({
        id: 'application',
        initial: 'red',
        states: ['red'],
        transitions: [{ from: 'red', event: 'go', to: 'blue', actor: ['borrower'] }],
      }),
    ).toThrow(/'blue'/);
  });

  it('rejects a transition with no actor, because the SQL row needs one', () => {
    expect(() =>
      defineMachine<'red' | 'amber', 'go', ToyContext>({
        id: 'application',
        initial: 'red',
        states: ['red', 'amber'],
        transitions: [{ from: 'red', event: 'go', to: 'amber', actor: [] }],
      }),
    ).toThrow(/actor/);
  });

  /**
   * The primary key of `workflow_transition` is (machine, from_state, event,
   * actor_role). Two definitions sharing that key would emit two rows the
   * database refuses, and the migration would fail at apply time rather than
   * here.
   */
  it('rejects two transitions sharing the generated primary key', () => {
    expect(() =>
      defineMachine<'red' | 'amber' | 'green', 'go', ToyContext>({
        id: 'application',
        initial: 'red',
        states: ['red', 'amber', 'green'],
        transitions: [
          { from: 'red', event: 'go', to: 'amber', actor: ['borrower'] },
          { from: 'red', event: 'go', to: 'green', actor: ['borrower'] },
        ],
      }),
    ).toThrow(/already defined|duplicate/i);
  });
});

describe('can', () => {
  it('allows a declared transition for a declared actor', () => {
    expect(can(toyMachine(), 'red', 'go', 'borrower', EMPTY)).toEqual({ ok: true });
  });

  it('refuses an event the machine does not know', () => {
    const verdict = can(toyMachine(), 'red', 'halt', 'borrower', EMPTY);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/no transition 'halt' from 'red'/);
    expect(verdict.ok === false && verdict.blockers).toEqual([]);
  });

  it('refuses an event that is legal from a different state', () => {
    const verdict = can(toyMachine(), 'red', 'stop', 'borrower', EMPTY);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/from 'red'/);
  });

  /**
   * Authorisation is server-side and is re-checked against the machine on every
   * transition (CLAUDE.md section 10), so a wrong role is a refusal here rather
   * than something only the API remembers to check.
   */
  it('refuses a role the transition does not name', () => {
    const verdict = can(toyMachine(), 'amber', 'go', 'borrower', PASSING);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/borrower/);
  });

  it('accepts any one of several named roles', () => {
    expect(can(toyMachine(), 'amber', 'go', 'lender', PASSING)).toEqual({ ok: true });
    expect(can(toyMachine(), 'amber', 'go', 'admin', PASSING)).toEqual({ ok: true });
  });

  it('returns the guard refusal unchanged when the guard says no', () => {
    const verdict = can(toyMachine(), 'amber', 'go', 'lender', EMPTY);

    expect(verdict).toEqual({ ok: false, reason: 'nobody approved', blockers: [] });
  });
});

describe('apply', () => {
  it('reports the destination, the actor and the effects of a legal transition', () => {
    const outcome = apply(toyMachine(), 'red', 'go', 'borrower', EMPTY);

    expect(outcome).toEqual({
      ok: true,
      machine: 'application',
      from: 'red',
      to: 'amber',
      event: 'go',
      actorRole: 'borrower',
      effects: [],
    });
  });

  it('refuses with the same shape `can` uses, so one renderer serves both', () => {
    const outcome = apply(toyMachine(), 'amber', 'go', 'lender', EMPTY);

    expect(outcome).toEqual({ ok: false, reason: 'nobody approved', blockers: [] });
  });

  it('does not mutate anything: the machine is data', () => {
    const machine = toyMachine();
    apply(machine, 'red', 'go', 'borrower', EMPTY);

    expect(can(machine, 'red', 'go', 'borrower', EMPTY)).toEqual({ ok: true });
  });
});

describe('graph helpers', () => {
  it('walks the graph from `initial` to find the reachable states', () => {
    expect(reachableStates(toyMachine())).toEqual(new Set(['red', 'amber', 'green']));
  });

  it('calls a state terminal when nothing leaves it', () => {
    const machine = defineMachine<'red' | 'amber', 'go', ToyContext>({
      id: 'application',
      initial: 'red',
      states: ['red', 'amber'],
      transitions: [{ from: 'red', event: 'go', to: 'amber', actor: ['borrower'] }],
    });

    expect(terminalStates(machine)).toEqual(new Set(['amber']));
    expect(terminalStates(toyMachine())).toEqual(new Set([]));
  });
});
