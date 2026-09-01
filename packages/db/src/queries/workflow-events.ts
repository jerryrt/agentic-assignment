/**
 * The append-only event log, shared by all three state machines.
 *
 * `plan/02-domain-model.md` identifies the subject by `(machine, subject_id)`
 * rather than by a foreign key, so that one log, one audit trail and one
 * timeline component serve every machine.  The cost is that `subject_id` has
 * no referential integrity; the helpers below take the pair together for that
 * reason -- neither half identifies anything on its own.
 *
 * `machine` is typed as `string` here, not as a union of the three names.  The
 * names belong to `packages/workflow`, which sits above this layer, and
 * restating them here would be the second copy the generator exists to prevent
 * (CLAUDE.md sections 8 and 9).
 */

import type { DatabaseClient } from '../client';
import type { Database } from '../database.types';
import { unwrapList, unwrapMaybe } from '../errors';

type WorkflowEventTable = Database['public']['Tables']['workflow_event'];

export type WorkflowEvent = WorkflowEventTable['Row'];
export type WorkflowEventInsert = WorkflowEventTable['Insert'];

/**
 * Record one transition that has already happened.
 *
 * Append only: there is no update and no delete helper, and there will not be
 * one.  An audit trail that can be edited is not an audit trail.
 */
export async function appendWorkflowEvent(
  client: DatabaseClient,
  event: WorkflowEventInsert,
): Promise<WorkflowEvent | null> {
  return unwrapMaybe(
    'workflow_event.append',
    await client.from('workflow_event').insert(event).select('*').maybeSingle(),
  );
}

/**
 * One subject's history, oldest first.
 *
 * Ordered by `id` rather than by `created_at` so the read matches
 * `workflow_event_subject_idx` exactly and so two events written inside the
 * same transaction still have a defined order; timestamps can tie, a bigserial
 * cannot.
 */
export async function listWorkflowEvents(
  client: DatabaseClient,
  machine: string,
  subjectId: string,
): Promise<readonly WorkflowEvent[]> {
  return unwrapList(
    'workflow_event.list',
    await client
      .from('workflow_event')
      .select('*')
      .eq('machine', machine)
      .eq('subject_id', subjectId)
      .order('id', { ascending: true }),
  );
}
