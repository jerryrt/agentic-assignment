import { z } from 'zod';

/**
 * The state names of the three machines in plan 03.
 *
 * The names live here, one layer below packages/workflow, and the transitions
 * live there. That is not a split of one thing across two packages: the state
 * *names* are part of the data model -- `application.state` is a column,
 * `workflow_event.to_state` is a column, and the label map below is keyed by
 * them -- while transition *legality* is behaviour. packages/workflow imports
 * these unions and is the only place that says which pairs are legal, so there
 * is still exactly one definition of each (CLAUDE.md section 9).
 */

export const APPLICATION_STATES = [
  'draft',
  'submitted',
  'docs_pending',
  'under_review',
  'needs_borrower_action',
  'approved',
  'declined',
  'funded',
  'withdrawn',
] as const;

export const ApplicationStateSchema = z.enum(APPLICATION_STATES);
export type ApplicationState = z.infer<typeof ApplicationStateSchema>;

/**
 * `funded` is terminal for this machine and is the hand-off point: funding
 * creates a loan row and Option 3's machines take over from there.
 */
export const TERMINAL_APPLICATION_STATES = [
  'funded',
  'declined',
  'withdrawn',
] as const satisfies readonly ApplicationState[];

export function isTerminalApplicationState(state: ApplicationState): boolean {
  return (TERMINAL_APPLICATION_STATES as readonly ApplicationState[]).includes(state);
}

/**
 * `expired` is deliberately absent. Expiry is a function of `valid_until` and
 * the clock, so it is derived in packages/rules; a state that changes without
 * an event is a state machine that lies (plan 03).
 */
export const DOCUMENT_SLOT_STATES = [
  'required',
  'uploaded',
  'extracted',
  'accepted',
  'rejected',
] as const;

export const DocumentSlotStateSchema = z.enum(DOCUMENT_SLOT_STATES);
export type DocumentSlotState = z.infer<typeof DocumentSlotStateSchema>;

export const CREDIT_RELEASE_STATES = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'declined',
  'funded',
  'cancelled',
] as const;

export const CreditReleaseStateSchema = z.enum(CREDIT_RELEASE_STATES);
export type CreditReleaseState = z.infer<typeof CreditReleaseStateSchema>;

/**
 * The `machine` discriminator on `workflow_event` and `workflow_transition`.
 * One append-only log serves all three, which is why those tables carry state
 * as text rather than as any one of the unions above.
 */
export const WORKFLOW_MACHINES = ['application', 'document_slot', 'credit_release'] as const;

export const WorkflowMachineSchema = z.enum(WORKFLOW_MACHINES);
export type WorkflowMachine = z.infer<typeof WorkflowMachineSchema>;
