import { z } from 'zod';

import { AppRoleSchema } from '../roles.js';
import {
  BigSerialIdSchema,
  JsonValueSchema,
  NonEmptyTextSchema,
  TimestampSchema,
  UuidSchema,
} from '../primitives.js';
import { WorkflowMachineSchema } from '../states.js';

/**
 * The append-only log: audit trail, timeline component, and the explanation of
 * how a file reached the state it is in.
 *
 * `from_state` and `to_state` are text rather than any one machine's union
 * because one log serves all three machines. Narrowing them here would force
 * either three tables or a discriminated union that no SQL query can produce.
 * `machine` is the discriminator, and it is validated; the reader narrows the
 * state names once it knows which machine it is reading.
 *
 * `subject_id` has no foreign key, in the table or here, for the same reason.
 * That trade is stated in plan 02: no referential integrity on the subject, in
 * exchange for one event log, one audit trail and one timeline component.
 */
export const WorkflowEventSchema = z.object({
  id: BigSerialIdSchema,
  machine: WorkflowMachineSchema,
  subject_id: UuidSchema,
  /** Null on the first event: nothing preceded it. */
  from_state: z.string().nullable(),
  to_state: NonEmptyTextSchema,
  /** The transition name, e.g. 'submit'. */
  event: NonEmptyTextSchema,
  /** Null when the actor was the system rather than a person. */
  actor_id: UuidSchema.nullable(),
  actor_role: AppRoleSchema.nullable(),
  payload: JsonValueSchema.nullable(),
  created_at: TimestampSchema,
});

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
