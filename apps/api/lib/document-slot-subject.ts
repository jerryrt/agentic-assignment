/**
 * The `document_slot` subject: loading it, deciding who may act on it, and
 * advancing it.
 *
 * The second machine with a table, and it is what tells us what the first one
 * really had in common with it. The answer is less than a registry would have
 * assumed: the two subjects are loaded from different tables, validated by
 * different schemas, and advanced by different helpers, and only two things are
 * genuinely shared -- who the audience is, and how the audit entry is written.
 * Both are imported rather than restated, and nothing else is factored out. A
 * wrong abstraction costs more than the duplication it removes (CLAUDE.md
 * section 9), and two straight-line adjudicators read better than one generic
 * one with a switch inside every step.
 *
 * A SLOT'S AUDIENCE IS ITS APPLICATION'S AUDIENCE. That is the shape
 * `document_slot_read_visible_application` in 0006_documents.sql has -- one
 * policy that reads `application` under the caller's own policies, rather than
 * a second copy of "who may read this loan file". The service role bypasses
 * every one of those policies, so this file has to make the same decision, and
 * it makes it the same way: resolve the application, then ask
 * `applicationReadableBy`. A predicate written out again here would be the
 * second answer the first time either changed.
 */

import { getDocumentSlot, updateDocumentSlot, type DatabaseClient } from '@lj/db';
import { DocumentSlotSchema, type DocumentSlotState } from '@lj/domain';
import { DOCUMENT_SLOT_EVENTS, type DocumentSlotEvent } from '@lj/workflow';

import type { SubjectSnapshot } from './http.ts';

export interface DocumentSlotSubject {
  readonly id: string;
  readonly applicationId: string;
  /** Stable per product, and the second segment of every storage path. */
  readonly code: string;
  readonly label: string;
  readonly required: boolean;
  readonly state: DocumentSlotState;
  readonly revision: number;
  /** The fields this slot must yield, as the product asked at generation time. */
  readonly extractRequired: readonly string[];
  readonly validUntil: string | null;
}

/**
 * The slot, read with the service role and then validated.
 *
 * Parsed with the schema from packages/domain even though the row came from our
 * own database, for the reason `loadApplication` gives: the generated types are
 * a claim about the schema rather than a check of it, and a `state` no machine
 * declares must not reach the engine as a string that happens to typecheck.
 */
export async function loadDocumentSlot(
  client: DatabaseClient,
  slotId: string,
): Promise<DocumentSlotSubject | null> {
  const row = await getDocumentSlot(client, slotId);
  if (row === null) {
    return null;
  }
  const parsed = DocumentSlotSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error('document slot ' + slotId + ' does not match the schema that describes it');
  }
  return {
    id: parsed.data.id,
    applicationId: parsed.data.application_id,
    code: parsed.data.code,
    label: parsed.data.label,
    required: parsed.data.required,
    state: parsed.data.state,
    revision: parsed.data.revision,
    extractRequired: parsed.data.extract_required,
    validUntil: parsed.data.valid_until,
  };
}

/** The machine's events, narrowed from the string the request carried. */
export function asDocumentSlotEvent(event: string): DocumentSlotEvent | null {
  return (DOCUMENT_SLOT_EVENTS as readonly string[]).includes(event)
    ? (event as DocumentSlotEvent)
    : null;
}

/**
 * No transition in the slot machine is guarded, so the context is empty.
 *
 * Written out rather than passed inline so the emptiness is a statement: this
 * is not a rule set somebody forgot to evaluate. Uploading, accepting and
 * rejecting are decisions in themselves, not conditional ones -- the
 * conditional one is `begin_review` on the application, which reads the whole
 * pack.
 */
export const NO_DOCUMENT_SLOT_CRITERIA: Readonly<Record<string, never>> = {};

export interface SlotAdvanceRequest {
  readonly slotId: string;
  readonly expectedRevision: number;
  readonly to: DocumentSlotState;
  /**
   * Set only by extraction, which is where an expiry date comes from. Absent
   * means "leave it alone": a lender accepting a document does not restate when
   * it expires, and a patch that wrote null would quietly make an expired
   * certificate current.
   */
  readonly validUntil?: string | null;
}

/**
 * The state change, guarded by the revision the caller believes it holds.
 *
 * Null means nothing matched, which is the interesting outcome: the revision
 * moved under the caller. Two lenders accepting one document therefore
 * serialise rather than race, exactly as two lenders on one application do --
 * the same optimistic concurrency, on a second table.
 */
export async function advanceDocumentSlot(
  client: DatabaseClient,
  request: SlotAdvanceRequest,
): Promise<SubjectSnapshot | null> {
  const patch =
    request.validUntil === undefined
      ? { state: request.to }
      : { state: request.to, valid_until: request.validUntil };

  const ack = await updateDocumentSlot(client, {
    slotId: request.slotId,
    expectedRevision: request.expectedRevision,
    patch,
  });
  return ack === null ? null : { state: ack.state, revision: ack.revision };
}
