/**
 * The document pack: the slots a product asked for, and the files submitted
 * against them.
 *
 * Reads are ordinary and go through row-level security; the policies in
 * `0006_documents.sql` admit the application's own audience and nobody else.
 * Writes are narrower than they look, and the narrowness is the point:
 *
 *   - `authenticated` holds SELECT and nothing else on either table, so every
 *     helper below that writes is reachable only with the service role, from
 *     `apps/api`.  A borrower who could write a slot's `state` could accept
 *     their own documents, and `accept` is a lender's decision.
 *   - there is no helper that updates or deletes an upload, because no grant
 *     exists for one -- not even for the service role.  An upload is a record
 *     of what was submitted; a replacement is a new row, which is what
 *     `replace` on the slot machine means.
 *
 * The `Json` in and out of `extracted` stays `Json`.  packages/rules owns the
 * confidence floor and the ocr-versus-human distinction, so it owns what a
 * field means; a shape decided here would be a second definition of it
 * (CLAUDE.md section 9).
 */

import type { DatabaseClient } from '../client.ts';
import type { Database } from '../database.types.ts';
import { unwrapList, unwrapMaybe } from '../errors.ts';

type SlotTable = Database['public']['Tables']['document_slot'];
type UploadTable = Database['public']['Tables']['document_upload'];

export type DocumentSlotRow = SlotTable['Row'];
export type DocumentSlotInsert = SlotTable['Insert'];
export type DocumentUploadRow = UploadTable['Row'];
export type DocumentUploadInsert = UploadTable['Insert'];

/**
 * What a slot write returns.
 *
 * Four columns rather than the row, for the reason `ApplicationWriteAck` gives:
 * these are what a caller needs to reconcile its local copy, and echoing back
 * the `extract_required` array it just sent is noise on every acceptance.
 */
export type DocumentSlotWriteAck = Pick<
  DocumentSlotRow,
  'id' | 'application_id' | 'state' | 'revision'
>;

const SLOT_WRITE_ACK_COLUMNS = 'id, application_id, state, revision';

/**
 * One application's pack, in the order the product declared it.
 *
 * Ordered by `created_at` and then `code`: slots are generated in one statement
 * from the product's list, so insertion order is the product's order, and the
 * code breaks a tie deterministically rather than letting the checklist
 * reshuffle between two reads.  A list that reorders while somebody is working
 * down it is a list they lose their place in.
 */
export async function listDocumentSlots(
  client: DatabaseClient,
  applicationId: string,
): Promise<readonly DocumentSlotRow[]> {
  return unwrapList(
    'document_slot.list',
    await client
      .from('document_slot')
      .select('*')
      .eq('application_id', applicationId)
      .order('created_at', { ascending: true })
      .order('code', { ascending: true }),
  );
}

export async function getDocumentSlot(
  client: DatabaseClient,
  slotId: string,
): Promise<DocumentSlotRow | null> {
  return unwrapMaybe(
    'document_slot.get',
    await client.from('document_slot').select('*').eq('id', slotId).maybeSingle(),
  );
}

/**
 * Generate a pack.  Service role only.
 *
 * `ignoreDuplicates` on the application/code unique constraint is what makes
 * this idempotent, and it is deliberately the constraint doing the work rather
 * than a read-then-write: checking whether a slot exists and inserting it if
 * not is a race, and the failure it produces is a doubled checklist that nobody
 * can explain.  A retried `request_docs` therefore adds nothing and reports
 * nothing missing.
 *
 * Returns the slots this call inserted, which is empty on a retry.  The caller
 * that wants the whole pack asks for it.
 */
export async function insertDocumentSlots(
  client: DatabaseClient,
  rows: readonly DocumentSlotInsert[],
): Promise<readonly DocumentSlotRow[]> {
  if (rows.length === 0) {
    return [];
  }
  return unwrapList(
    'document_slot.generate',
    await client
      .from('document_slot')
      .upsert([...rows], { onConflict: 'application_id,code', ignoreDuplicates: true })
      .select('*'),
  );
}

export interface DocumentSlotUpdateRequest {
  readonly slotId: string;
  /**
   * The `revision` the caller last read.  The update matches no row if it has
   * moved on, which is what makes two lenders accepting one document serialise
   * rather than race -- the same optimistic concurrency `application` uses.
   */
  readonly expectedRevision: number;
  readonly patch: SlotTable['Update'];
}

/**
 * Apply a patch to one slot, bumping the revision.  Service role only.
 *
 * Returns `null` when nothing matched, which is the interesting outcome: the
 * revision moved, or the policies did not permit the write.  The caller
 * reconciles; this layer will not guess which.
 *
 * `revision` and `updated_at` in the caller's patch are overwritten -- they are
 * bookkeeping this helper owns, and letting a caller set them would let a
 * client freeze the revision and defeat the guard.  Whether a state change is
 * ALLOWED is not decided here either: the machine in packages/workflow decides
 * it and `assert_legal_transition` re-checks it, and a rule in this layer would
 * be a second copy of the first.
 */
export async function updateDocumentSlot(
  client: DatabaseClient,
  request: DocumentSlotUpdateRequest,
): Promise<DocumentSlotWriteAck | null> {
  return unwrapMaybe(
    'document_slot.update',
    await client
      .from('document_slot')
      .update({
        ...request.patch,
        revision: request.expectedRevision + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', request.slotId)
      .eq('revision', request.expectedRevision)
      .select(SLOT_WRITE_ACK_COLUMNS)
      .maybeSingle(),
  );
}

/** Record a submitted file.  Service role only; there is no client grant. */
export async function insertDocumentUpload(
  client: DatabaseClient,
  values: DocumentUploadInsert,
): Promise<DocumentUploadRow | null> {
  return unwrapMaybe(
    'document_upload.insert',
    await client.from('document_upload').insert(values).select('*').maybeSingle(),
  );
}

/**
 * Every file submitted against one slot, most recent first.
 *
 * The whole history rather than only the current file, because a rejected
 * document and its replacement are both part of what happened and the timeline
 * shows both.  A caller that wants the current one takes the first.
 */
export async function listDocumentUploads(
  client: DatabaseClient,
  slotId: string,
): Promise<readonly DocumentUploadRow[]> {
  return unwrapList(
    'document_upload.list',
    await client
      .from('document_upload')
      .select('*')
      .eq('slot_id', slotId)
      .order('uploaded_at', { ascending: false }),
  );
}

/**
 * Every upload across a whole pack, most recent first.
 *
 * One round trip rather than one per slot: the pack screen and the completeness
 * evaluation both need every slot's latest extraction at once, and N+1 reads to
 * build one context is the shape that turns a five-slot pack into six requests.
 */
export async function listDocumentUploadsForApplication(
  client: DatabaseClient,
  applicationId: string,
): Promise<readonly DocumentUploadRow[]> {
  return unwrapList(
    'document_upload.list-for-application',
    await client
      .from('document_upload')
      .select('*, document_slot!inner(application_id)')
      .eq('document_slot.application_id', applicationId)
      .order('uploaded_at', { ascending: false }),
  );
}
