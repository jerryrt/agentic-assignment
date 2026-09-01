import type { AppRole } from '@lj/domain';

import { PASSES } from './guards.js';
import type {
  GuardResult,
  Machine,
  MachineDefinition,
  MachineShape,
  NormalisedTransition,
  TransitionOutcome,
} from './types.js';

/**
 * The engine. Roughly a hundred lines, because a machine is data and the engine
 * only reads it.
 *
 * Nothing here touches I/O, a framework, or a clock, which is what lets the
 * browser and the serverless function run byte-identical logic: the client
 * predicts a transition to grey out a button and show its blockers without a
 * round trip, and the server decides it. If the two ever disagree the server
 * wins, because it is the one holding the state.
 */

function statesOf<S extends string>(from: S | readonly S[]): readonly S[] {
  return Array.isArray(from) ? (from as readonly S[]) : [from as S];
}

function primaryKey(machine: string, from: string, event: string, actor: AppRole): string {
  return [machine, from, event, actor].join('|');
}

/**
 * Build a machine, rejecting a definition that could not be represented.
 *
 * The checks are not defensive programming: each one corresponds to a way the
 * generated SQL would be wrong. An undeclared state produces a row the trigger
 * would honour but no column may hold; a missing actor produces a row that
 * violates `actor_role not null`; a repeated (from, event, actor) produces two
 * rows that collide on the primary key, and the migration would fail at apply
 * time -- long after the mistake, and nowhere near it.
 */
export function defineMachine<S extends string, E extends string, Ctx>(
  definition: MachineDefinition<S, E, Ctx>,
): Machine<S, E, Ctx> {
  const declared = new Set<string>(definition.states);

  if (!declared.has(definition.initial)) {
    throw new Error(
      "machine '" +
        definition.id +
        "': initial state '" +
        definition.initial +
        "' is not one of its declared states",
    );
  }

  const seen = new Set<string>();
  const transitions: NormalisedTransition<S, E, Ctx>[] = [];

  for (const transition of definition.transitions) {
    const from = statesOf(transition.from);

    if (from.length === 0) {
      throw new Error(
        "machine '" + definition.id + "': event '" + transition.event + "' leaves no state",
      );
    }
    if (transition.actor.length === 0) {
      throw new Error(
        "machine '" +
          definition.id +
          "': event '" +
          transition.event +
          "' names no actor, and workflow_transition.actor_role is not null",
      );
    }
    for (const state of [...from, transition.to]) {
      if (!declared.has(state)) {
        throw new Error(
          "machine '" + definition.id + "': state '" + state + "' is not declared",
        );
      }
    }
    for (const state of from) {
      for (const actor of transition.actor) {
        const key = primaryKey(definition.id, state, transition.event, actor);
        if (seen.has(key)) {
          throw new Error(
            "machine '" +
              definition.id +
              "': event '" +
              transition.event +
              "' from '" +
              state +
              "' is already defined for role '" +
              actor +
              "'",
          );
        }
        seen.add(key);
      }
    }

    transitions.push({
      from,
      event: transition.event,
      to: transition.to,
      actor: transition.actor,
      guard: transition.guard ?? null,
      effects: transition.effects ?? [],
    });
  }

  return {
    id: definition.id,
    initial: definition.initial,
    states: definition.states,
    transitions,
  };
}

function find<S extends string, E extends string, Ctx>(
  machine: Machine<S, E, Ctx>,
  from: S,
  event: E,
): readonly NormalisedTransition<S, E, Ctx>[] {
  return machine.transitions.filter(
    (transition) => transition.event === event && transition.from.includes(from),
  );
}

/**
 * May this actor fire this event from this state, given this context?
 *
 * Three refusals, in the order a request fails: the machine has no such
 * transition, the actor's role does not hold it, or the transition's guard says
 * no. Only the third carries blockers -- see GuardRefusal.
 */
export function can<S extends string, E extends string, Ctx>(
  machine: Machine<S, E, Ctx>,
  from: S,
  event: E,
  role: AppRole,
  context: Ctx,
): GuardResult {
  const candidates = find(machine, from, event);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        "no transition '" + event + "' from '" + from + "' in machine '" + machine.id + "'",
      blockers: [],
    };
  }

  const permitted = candidates.find((transition) => transition.actor.includes(role));
  if (permitted === undefined) {
    return {
      ok: false,
      reason:
        "role '" +
        role +
        "' may not fire '" +
        event +
        "' from '" +
        from +
        "' in machine '" +
        machine.id +
        "'",
      blockers: [],
    };
  }

  return permitted.guard === null ? PASSES : permitted.guard(context);
}

/**
 * What the caller must persist if the transition is allowed.
 *
 * `apply` moves nothing: it returns the destination, the actor and the declared
 * effects, and the API writes them inside one transaction along with the
 * `workflow_event` row. Keeping the decision separate from the write is what
 * lets the same function answer the browser, where there is nothing to write.
 */
export function apply<S extends string, E extends string, Ctx>(
  machine: Machine<S, E, Ctx>,
  from: S,
  event: E,
  role: AppRole,
  context: Ctx,
): TransitionOutcome<S, E> {
  const verdict = can(machine, from, event, role, context);
  if (!verdict.ok) {
    return verdict;
  }

  const permitted = find(machine, from, event).find((transition) =>
    transition.actor.includes(role),
  );
  if (permitted === undefined) {
    // Unreachable: `can` returned ok, so a permitted transition exists. Handled
    // rather than asserted because a non-null assertion here would be a claim
    // about two functions staying in step, which is what noUncheckedIndexedAccess
    // exists to stop anyone making.
    return {
      ok: false,
      reason: "no transition '" + event + "' from '" + from + "'",
      blockers: [],
    };
  }

  return {
    ok: true,
    machine: machine.id,
    from,
    to: permitted.to,
    event,
    actorRole: role,
    effects: permitted.effects,
  };
}

/**
 * The states a subject can actually end up in, walked from `initial`.
 *
 * Reachability is not decorative. A state added to a domain union and never
 * wired into a transition is accepted by the column, has a label, and appears in
 * no generated row: nothing fails, and the state simply never happens. Walking
 * the graph is the only thing that notices.
 */
export function reachableStates(machine: MachineShape): ReadonlySet<string> {
  const reached = new Set<string>([machine.initial]);
  const queue: string[] = [machine.initial];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const transition of machine.transitions) {
      if (transition.from.includes(current) && !reached.has(transition.to)) {
        reached.add(transition.to);
        queue.push(transition.to);
      }
    }
  }

  return reached;
}

/**
 * The states nothing leaves. Derived from the graph rather than declared, so
 * that adding an exit to a state everybody believed was final cannot be done
 * quietly -- the test that names the terminal set fails.
 */
export function terminalStates(machine: MachineShape): ReadonlySet<string> {
  const hasExit = new Set<string>();
  for (const transition of machine.transitions) {
    for (const state of transition.from) {
      hasExit.add(state);
    }
  }
  return new Set(machine.states.filter((state) => !hasExit.has(state)));
}
