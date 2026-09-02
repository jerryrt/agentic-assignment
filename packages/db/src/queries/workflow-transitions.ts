/**
 * The legal-transition table, read only.
 *
 * These rows are generated from the machine definitions in
 * `packages/workflow` and applied as a migration; they are the SQL half of the
 * guard, and the `assert_legal_transition` trigger is their only consumer at
 * runtime.  This layer offers a reader and no writer on purpose: a helper that
 * could insert a transition would be a way to widen the state machine without
 * touching the definition it is generated from, which is precisely the
 * duplication the generator exists to prevent (CLAUDE.md section 9).
 *
 * The reader earns its place as the SQL side of the TS/SQL parity check that
 * `packages/workflow` owns: comparing the generated rows against the machine
 * is what proves the two have not drifted.
 */

import type { DatabaseClient } from '../client.js';
import type { Database } from '../database.types.js';
import { unwrapList } from '../errors.js';

export type WorkflowTransition =
  Database['public']['Tables']['workflow_transition']['Row'];

/** Every legal transition for one machine, in a stable order. */
export async function listWorkflowTransitions(
  client: DatabaseClient,
  machine: string,
): Promise<readonly WorkflowTransition[]> {
  return unwrapList(
    'workflow_transition.list',
    await client
      .from('workflow_transition')
      .select('*')
      .eq('machine', machine)
      .order('from_state')
      .order('event')
      .order('actor_role'),
  );
}
