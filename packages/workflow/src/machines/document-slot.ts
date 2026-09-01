import { DOCUMENT_SLOT_STATES } from '@lj/domain';
import type { DocumentSlotState } from '@lj/domain';

import type { DocumentSlotGuardContext } from '../context.js';
import { defineMachine } from '../engine.js';

/**
 * One machine per required document, not per uploaded file.
 *
 * The slot is the requirement -- "proof of income" -- and it survives the file
 * being replaced. That is why `replace` returns an accepted or rejected slot to
 * `uploaded` rather than creating a second slot: the requirement did not change,
 * only what satisfies it.
 *
 * Two consequences of that shape are worth stating, because both look like
 * omissions:
 *
 * `expired` is not a state. Expiry is a function of `valid_until` and the clock,
 * so it is derived in packages/rules. A state machine whose states change
 * without an event is a machine that lies, and the lie would be load-bearing
 * here: the SQL trigger would have to accept a transition into `expired` fired
 * by nobody.
 *
 * No state is terminal. `accepted` is where a slot comes to rest, but a borrower
 * may still replace an accepted document, so nothing leaves the graph.
 */

export const DOCUMENT_SLOT_EVENTS = [
  'upload',
  'extract',
  'accept',
  'reject',
  'replace',
] as const;

export type DocumentSlotEvent = (typeof DOCUMENT_SLOT_EVENTS)[number];

export const documentSlotMachine = defineMachine<
  DocumentSlotState,
  DocumentSlotEvent,
  DocumentSlotGuardContext
>({
  id: 'document_slot',
  initial: 'required',
  states: DOCUMENT_SLOT_STATES,
  transitions: [
    { from: 'required', event: 'upload', to: 'uploaded', actor: ['borrower'] },
    /**
     * Extraction is performed by the platform, and the diagram calls the actor
     * "system". `app_role` has no `system` member and
     * `workflow_transition.actor_role` is `not null`, so the system acts as
     * `admin` here. That is not a fudge: an admin triggering a re-extraction by
     * hand is a real operation, and it is the same authority the platform uses.
     * `workflow_event.actor_role` is nullable precisely so the log can still
     * record that no person was behind it.
     */
    { from: 'uploaded', event: 'extract', to: 'extracted', actor: ['admin'] },
    { from: 'extracted', event: 'accept', to: 'accepted', actor: ['lender'] },
    { from: 'extracted', event: 'reject', to: 'rejected', actor: ['lender'] },
    { from: ['rejected', 'accepted'], event: 'replace', to: 'uploaded', actor: ['borrower'] },
  ],
});
