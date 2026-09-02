/**
 * Structural questions about a machine, answered without a guard context.
 *
 * "Is this a real event?", "does anything leave this state on it?", "may this
 * role fire it?" are all answered by reading the definition, and none of them
 * needs the evaluated rule sets a guard takes. Separating them is what lets the
 * endpoint reject an incoherent request before it touches the database, and
 * what lets it tell a role refusal apart from a criteria refusal afterwards.
 *
 * Nothing here restates a transition. Every function reads `ALL_MACHINES`, so
 * legality still has exactly one definition and the SQL guard table is still
 * generated from that same one (CLAUDE.md section 9).
 */

import type { AppRole, WorkflowMachine } from '@lj/domain';
import { ALL_MACHINES, type MachineShape, type TransitionShape } from '@lj/workflow';

const BY_ID: ReadonlyMap<string, MachineShape> = new Map(
  ALL_MACHINES.map((machine) => [machine.id, machine]),
);

/** The definition behind a machine id, or null if no definition claims it. */
export function machineShapeFor(id: WorkflowMachine): MachineShape | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Every event this machine declares, in a stable order.
 *
 * Derived from the transitions rather than from the exported event tuples, so
 * an event that exists in a tuple but in no transition -- which is an event
 * nothing can ever fire -- is not advertised as accepted input.
 */
export function eventNamesOf(machine: MachineShape): readonly string[] {
  return [...new Set(machine.transitions.map((transition) => transition.event))].sort();
}

/** The transitions that leave `from` on `event`, for any role. */
export function transitionsFrom(
  machine: MachineShape,
  from: string,
  event: string,
): readonly TransitionShape[] {
  return machine.transitions.filter(
    (transition) => transition.event === event && transition.from.includes(from),
  );
}

/** Whether any of those transitions admits this role. */
export function anyPermits(
  transitions: readonly TransitionShape[],
  role: AppRole,
): boolean {
  return transitions.some((transition) => transition.actor.includes(role));
}
