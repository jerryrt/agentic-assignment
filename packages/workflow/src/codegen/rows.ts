import type { WorkflowTransition } from '@lj/domain';

import { ALL_MACHINES } from '../machines/index.ts';
import type { MachineShape } from '../types.ts';

/**
 * Machine definitions flattened into `workflow_transition` rows.
 *
 * The table's primary key is (machine, from_state, event, actor_role), so both
 * shorthands a definition uses have to be expanded: a transition leaving four
 * states is four rows, and one naming two roles is two rows. That expansion is
 * the entire semantic content of the code generator -- everything else is
 * formatting.
 */

/**
 * The primary key as one comparable string. Compared by code point rather than
 * by `localeCompare`, because a collation that treats `_` as ignorable would
 * order the file differently on a different machine, and a generated file whose
 * order depends on the generator's locale cannot be diffed.
 */
export function transitionKey(row: WorkflowTransition): string {
  return [row.machine, row.from_state, row.event, row.actor_role].join('|');
}

function byPrimaryKey(left: WorkflowTransition, right: WorkflowTransition): number {
  const leftKey = transitionKey(left);
  const rightKey = transitionKey(right);
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
}

export function transitionRows(machine: MachineShape): readonly WorkflowTransition[] {
  const rows: WorkflowTransition[] = [];

  for (const transition of machine.transitions) {
    for (const from of transition.from) {
      for (const actor of transition.actor) {
        rows.push({
          machine: machine.id,
          from_state: from,
          event: transition.event,
          to_state: transition.to,
          actor_role: actor,
        });
      }
    }
  }

  return rows.sort(byPrimaryKey);
}

/**
 * Every row of the table, in primary-key order.
 *
 * The order is not cosmetic: it is what makes regeneration byte-stable, which
 * is what lets `workflow:check` be a diff instead of a judgement call. Sorting
 * by the key rather than by definition order also means reordering a machine's
 * transitions produces no migration at all.
 */
export function allTransitionRows(
  machines: readonly MachineShape[] = ALL_MACHINES,
): readonly WorkflowTransition[] {
  return machines.flatMap((machine) => transitionRows(machine)).sort(byPrimaryKey);
}
