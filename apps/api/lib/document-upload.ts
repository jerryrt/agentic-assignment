/**
 * Finding the file a borrower has just uploaded, without ever being told where
 * it is.
 *
 * The API minted the path (lib/storage.ts) and the browser PUT the bytes
 * straight to storage, so by the time the `upload` transition arrives the only
 * honest question is "what is actually in this slot's folder?" -- asked of the
 * storage service rather than of the caller. That is what keeps the promise the
 * signed-url route makes: a path is never accepted from a client, not at the
 * moment it is minted and not afterwards either.
 *
 * Two things make it exact rather than approximate:
 *
 *   - the newest object in the folder is the file this transition is about,
 *     because a fresh path is minted per request and objects are never
 *     overwritten;
 *   - an object already recorded in `document_upload` is NOT a new file. Firing
 *     `upload` twice without sending anything would otherwise record the
 *     previous file a second time and move the slot on the strength of it.
 *
 * Size and type are read from the object's own metadata rather than from the
 * request: the caller stated both when it asked for a URL, and what is in the
 * bucket now is the only version of that claim worth recording.
 */

import { listDocumentUploads, type DatabaseClient } from '@lj/db';
import { isAcceptedUploadMimeType, MAX_UPLOAD_BYTES } from '@lj/domain';

import type { DocumentSlotSubject } from './document-slot-subject.ts';
import { DOCUMENT_BUCKET, slotFolder } from './storage.ts';

export interface PreparedUpload {
  readonly slotId: string;
  readonly storagePath: string;
  /** The label the caller gave, or the object's own name when it gave none. */
  readonly filename: string;
  readonly bytes: number;
  readonly mime: string;
}

export type UploadPreparation =
  | { readonly ok: true; readonly upload: PreparedUpload }
  | { readonly ok: false; readonly reason: string };

interface StoredObject {
  readonly name: string;
  readonly size: number;
  readonly mimetype: string;
}

/**
 * The newest object under a prefix, with the two pieces of metadata that
 * matter.
 *
 * Sorted by the storage service rather than here, and read defensively: the
 * metadata is a JSON blob the service fills in, and a missing size or type is a
 * file nothing can be said about, which must not become a row claiming
 * otherwise.
 */
async function newestObject(
  client: DatabaseClient,
  prefix: string,
): Promise<StoredObject | null> {
  const { data, error } = await client.storage
    .from(DOCUMENT_BUCKET)
    .list(prefix, { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });
  if (error !== null || data === null || data.length === 0) {
    if (error !== null) {
      console.error('storage list failed: ' + error.message);
    }
    return null;
  }

  const first = data[0];
  if (first === undefined) {
    return null;
  }
  const metadata = (first.metadata ?? {}) as Record<string, unknown>;
  const size = metadata['size'];
  const mimetype = metadata['mimetype'];
  if (typeof size !== 'number' || typeof mimetype !== 'string') {
    return null;
  }
  return { name: first.name, size, mimetype };
}

/**
 * What the `upload` (or `replace`) transition is about to record, or why it
 * cannot be recorded.
 *
 * A refusal here refuses the transition before the state change, like every
 * other effect input: a slot that said `uploaded` with no file behind it is a
 * checklist row nobody can act on -- the borrower believes they have sent
 * something and the lender has nothing to open.
 */
export async function prepareUpload(
  client: DatabaseClient,
  slot: DocumentSlotSubject,
  filename: string | null,
): Promise<UploadPreparation> {
  const folder = slotFolder(slot.applicationId, slot.code);
  const object = await newestObject(client, folder);
  if (object === null) {
    return {
      ok: false,
      reason:
        'no file has been uploaded for this document; ask for an upload url, send the ' +
        'file, and then fire the transition',
    };
  }

  const storagePath = folder + '/' + object.name;
  const recorded = await listDocumentUploads(client, slot.id);
  if (recorded.some((row) => row.storage_path === storagePath)) {
    return {
      ok: false,
      reason:
        'the newest file against this document is one already recorded; nothing new has ' +
        'been uploaded',
    };
  }

  // The bucket enforces both of these against the bytes as they arrive, so
  // reaching here with a violation means the bucket's configuration and this
  // policy have drifted. Refusing is the direction to be wrong in either way.
  if (object.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: 'the uploaded file is larger than the policy allows' };
  }
  if (!isAcceptedUploadMimeType(object.mimetype)) {
    return {
      ok: false,
      reason: "the uploaded file is of type '" + object.mimetype + "', which is not accepted",
    };
  }

  return {
    ok: true,
    upload: {
      slotId: slot.id,
      storagePath,
      // The object's own name is the fallback rather than an error: it is a
      // real name for a real file, and the extraction that reads nothing from
      // it is a partial read, which is a state the borrower can act on.
      filename: filename ?? object.name,
      bytes: object.size,
      mime: object.mimetype,
    },
  };
}
