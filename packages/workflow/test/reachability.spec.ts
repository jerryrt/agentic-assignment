import { describe, expect, it } from 'vitest';

import {
  APPLICATION_STATES,
  CREDIT_RELEASE_STATES,
  DOCUMENT_SLOT_STATES,
  TERMINAL_APPLICATION_STATES,
} from '@lj/domain';

import { reachableStates, terminalStates } from '../src/index.ts';
import { ALL_MACHINES } from '../src/index.ts';
import {
  applicationMachine,
  creditReleaseMachine,
  documentSlotMachine,
} from '../src/index.ts';

/**
 * The orphan-state test.
 *
 * Adding a state to a union in packages/domain and forgetting to wire it up
 * produces a state nothing can ever enter and nothing can ever leave. Nothing
 * else fails: the column accepts it, the label map has an entry for it, and the
 * generated SQL simply never mentions it. Walking the graph from `initial` is
 * the only thing that notices.
 */

describe.each(ALL_MACHINES)('$id', (machine) => {
  it('can reach every state it declares, starting from `initial`', () => {
    const unreachable = machine.states.filter((state) => !reachableStates(machine).has(state));

    expect(unreachable).toEqual([]);
  });

  it('reaches nothing it has not declared', () => {
    expect([...reachableStates(machine)].sort()).toEqual([...machine.states].sort());
  });

  it('names a state the domain knows as its initial state', () => {
    expect(machine.states).toContain(machine.initial);
  });
});

describe('application', () => {
  it('has the terminal states the domain declares terminal', () => {
    expect([...terminalStates(applicationMachine)].sort()).toEqual(
      [...TERMINAL_APPLICATION_STATES].sort(),
    );
  });

  it('covers the whole domain union', () => {
    expect([...applicationMachine.states].sort()).toEqual([...APPLICATION_STATES].sort());
  });
});

describe('document_slot', () => {
  /**
   * No state is terminal here, and that is the point of the machine. `accepted`
   * looks final on the diagram but a borrower may replace an accepted document,
   * and expiry -- the other reason an accepted document stops counting -- is
   * derived from `valid_until` in packages/rules rather than being a state.
   */
  it('has no terminal state, because an accepted document can still be replaced', () => {
    expect([...terminalStates(documentSlotMachine)]).toEqual([]);
  });

  it('does not model expiry as a state', () => {
    expect(documentSlotMachine.states).not.toContain('expired');
    expect([...documentSlotMachine.states].sort()).toEqual([...DOCUMENT_SLOT_STATES].sort());
  });
});

describe('credit_release', () => {
  it('ends at disbursement, decline or cancellation and nowhere else', () => {
    expect([...terminalStates(creditReleaseMachine)].sort()).toEqual(
      ['cancelled', 'declined', 'funded'].sort(),
    );
  });

  it('covers the whole domain union', () => {
    expect([...creditReleaseMachine.states].sort()).toEqual([...CREDIT_RELEASE_STATES].sort());
  });
});
