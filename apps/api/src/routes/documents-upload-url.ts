/**
 * POST /api/documents/upload-url -- somewhere to put one file, for one slot.
 *
 * THE API NEVER SEES THE BYTES (plan/04). The browser uploads straight to
 * Supabase Storage on a signed URL, and this route is what decides that a write
 * may happen at all: it authenticates the caller, re-makes the read policy's
 * decision about the slot, asks the machine whether a file may go there at all,
 * checks the size and the type, and MINTS the path itself.
 *
 * Minting is the security property, and it is the reason no client holds an
 * INSERT on `storage.objects` for this bucket. A client-supplied path is a
 * client choosing which application's folder to write into, and the storage
 * policy can only gate on what the path says -- it reads the first segment as
 * an application id. So the two leading segments come from the slot row this
 * server loaded and nothing in the request reaches them.
 *
 * The size and type are checked here as well as by the bucket, and both checks
 * are worth having: the bucket enforces against the bytes, and this one refuses
 * before a minute is spent sending them. The browser's own check is a courtesy
 * to the person, not a gate.
 *
 * Exported as `POST` alone, so the runtime rejects every other method for us.
 */

import {
  ACCEPTED_UPLOAD_MIME_TYPES,
  isAcceptedUploadMimeType,
  MAX_UPLOAD_BYTES,
} from '@lj/domain';
import { documentSlotMachine } from '@lj/workflow';

import { authoriseSlotRequest } from '../../lib/document-access.ts';
import { failure, success } from '../../lib/http.ts';
import { anyPermits, transitionsFrom } from '../../lib/machines.ts';
import { parseUploadUrlRequest } from '../../lib/request.ts';
import { createSignedUpload, DOCUMENT_BUCKET, mintStoragePath } from '../../lib/storage.ts';

/**
 * The two events that put a file against a slot, in the order a slot meets
 * them. Which one applies is read off the machine rather than decided here: a
 * slot at `required` is uploaded to and one at `accepted` or `rejected` is
 * replaced, and that is a fact about the machine definition.
 */
const FILE_EVENTS = ['upload', 'replace'] as const;

export async function POST(request: Request): Promise<Response> {
  try {
    return await issueUploadUrl(request);
  } catch (error: unknown) {
    const described = error instanceof Error ? error.name + ': ' + error.message : 'unknown';
    console.error('POST /api/documents/upload-url failed: ' + described);
    return failure(500, 'internal_error', 'the upload url could not be issued');
  }
}

async function issueUploadUrl(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, 'invalid_request', 'the request body must be JSON');
  }

  const parsed = parseUploadUrlRequest(body);
  if (!parsed.ok) {
    return failure(400, 'invalid_request', parsed.problems.join('; '));
  }

  const authorised = await authoriseSlotRequest(request, parsed.request.slotId);
  if (!authorised.ok) {
    return authorised.response;
  }
  const { actor, service, slot } = authorised.access;

  // May a file go here at all, and may this caller be the one to put it there?
  // Asked of the machine, so that "the borrower supplies the file" has one
  // definition and this route is not a second one.
  const candidates = FILE_EVENTS.flatMap((event) =>
    transitionsFrom(documentSlotMachine, slot.state, event),
  );
  if (candidates.length === 0) {
    return failure(
      409,
      'state_conflict',
      "no file may be added to a document in state '" + slot.state + "'",
      { blockers: [], current: { state: slot.state, revision: slot.revision } },
    );
  }
  if (!anyPermits(candidates, actor.role)) {
    return failure(
      403,
      'role_not_permitted',
      "role '" + actor.role + "' may not add a file to a document",
      { blockers: [], current: { state: slot.state, revision: slot.revision } },
    );
  }

  // The policy, server-side. Refused before a path exists, so a refusal leaves
  // nothing behind in the bucket to tidy up.
  if (!isAcceptedUploadMimeType(parsed.request.mime)) {
    return failure(
      415,
      'upload_type_not_accepted',
      "'" +
        parsed.request.mime +
        "' is not accepted; this bucket holds " +
        ACCEPTED_UPLOAD_MIME_TYPES.join(', '),
    );
  }
  if (parsed.request.bytes > MAX_UPLOAD_BYTES) {
    return failure(
      413,
      'upload_too_large',
      'a document may be at most ' + String(MAX_UPLOAD_BYTES) + ' bytes',
    );
  }

  const minted = mintStoragePath(slot.applicationId, slot.code, parsed.request.mime);
  if (!minted.ok) {
    // Not the caller's doing: the slot code is the product's content and the
    // type has already been accepted. Reported as this API's fault, because it
    // is one.
    console.error('could not mint a storage path: ' + minted.reason);
    return failure(500, 'internal_error', 'a storage path could not be minted for this slot');
  }

  const signed = await createSignedUpload(service, minted.path);
  if (signed === null) {
    return failure(502, 'storage_unavailable', 'storage did not issue an upload url');
  }

  // The event the browser must fire once the bytes have landed, taken from the
  // machine rather than restated: firing it is what records the file and moves
  // the slot, and until it is fired nothing but an object in a bucket exists.
  const event = candidates.find((transition) => transition.actor.includes(actor.role))?.event;

  return success({
    slotId: slot.id,
    applicationId: slot.applicationId,
    bucket: DOCUMENT_BUCKET,
    path: signed.path,
    token: signed.token,
    signedUrl: signed.signedUrl,
    filename: parsed.request.filename,
    event: event ?? null,
    expectedRevision: slot.revision,
    maxBytes: MAX_UPLOAD_BYTES,
    acceptedMimeTypes: ACCEPTED_UPLOAD_MIME_TYPES,
  });
}
