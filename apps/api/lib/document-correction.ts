/**
 * The audit entry a correction leaves.
 *
 * A correction is not a transition -- nothing changes state, so the machine is
 * not consulted and no revision moves -- but it does change what a lender
 * reads, so it has to be attributable. `workflow_event` already carries
 * entries that are not machine transitions: `0004_demo_data.sql` records
 * `create` with a null `from_state`, which no machine declares either. Using
 * the one log rather than a second table keeps the document's timeline in one
 * place, which is where a person looks when a figure is disputed.
 *
 * `from_state` and `to_state` are the same state on purpose. The pair is what
 * `assert_legal_transition` reads on an UPDATE to `document_slot`, and no
 * update happens here; writing them equal says plainly that nothing moved,
 * rather than leaving a null that would read as the beginning of a history.
 */

import { appendWorkflowEvent, type DatabaseClient } from '@lj/db';

import type { Actor } from './actor.ts';
import type { DocumentSlotSubject } from './document-slot-subject.ts';

export interface CorrectionRecord {
  readonly slot: DocumentSlotSubject;
  readonly actor: Actor;
  readonly field: string;
  /** The row the correction created. */
  readonly uploadId: string;
  /** The row it corrected, which is left exactly as it was. */
  readonly correctedUploadId: string;
}

/**
 * The value itself is deliberately not in the payload.
 *
 * It is in the row the payload names, which is append-only, so the log points
 * at the evidence rather than keeping a second copy that could disagree with
 * it. What the log adds is the part the row cannot hold: who typed it.
 */
export async function appendCorrectionEvent(
  client: DatabaseClient,
  record: CorrectionRecord,
): Promise<boolean> {
  try {
    const appended = await appendWorkflowEvent(client, {
      machine: 'document_slot',
      subject_id: record.slot.id,
      from_state: record.slot.state,
      to_state: record.slot.state,
      event: 'correct',
      actor_id: record.actor.id,
      actor_role: record.actor.role,
      payload: {
        field: record.field,
        upload_id: record.uploadId,
        corrected_upload_id: record.correctedUploadId,
      },
    });
    return appended !== null;
  } catch (error: unknown) {
    const described = error instanceof Error ? error.name + ': ' + error.message : 'unknown';
    console.error('correction event append failed: ' + described);
    return false;
  }
}
