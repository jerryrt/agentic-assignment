import { z } from 'zod';

import { NonEmptyTextSchema } from '../primitives.ts';
import { AppRoleSchema } from '../roles.ts';
import { WorkflowMachineSchema } from '../states.ts';

/**
 * A row of `workflow_transition`: the legal shape of a state change, as the
 * database sees it.
 *
 * This table is **generated** from the machine definitions in
 * packages/workflow, never hand-written (CLAUDE.md section 9). The schema here
 * is what the generator's output and the parity test are checked against, so
 * that belt (the TypeScript machine) and braces (the BEFORE UPDATE trigger)
 * cannot drift.
 *
 * `actor_role` is part of the key because legality is per role: a lender may
 * approve from `under_review`, a borrower may not.
 */
export const WorkflowTransitionSchema = z.object({
  machine: WorkflowMachineSchema,
  from_state: NonEmptyTextSchema,
  event: NonEmptyTextSchema,
  to_state: NonEmptyTextSchema,
  actor_role: AppRoleSchema,
});

export type WorkflowTransition = z.infer<typeof WorkflowTransitionSchema>;
