/**
 * POST /api/documents/download-url -- a short-lived link to one stored file.
 *
 * The bucket is private (0006_documents.sql), which is the whole point: a
 * public bucket serves every object to anyone holding the URL, and a loan
 * file's documents are the last thing that should be one guessed path away from
 * the internet. So a read is a signed URL, issued only after this code has
 * re-made the decision the read policy would have made.
 *
 * The caller names the RECORD it wants -- a slot and one of its uploads -- and
 * never a path. Taking a path would let a caller ask about any object in the
 * bucket and rely on this handler to work out whether they may have it; taking
 * an id means the path comes from a row whose ownership was just established.
 *
 * A POST rather than a GET, deliberately. The answer is a credential: it is
 * never cacheable, never a link that can be shared by copying the address bar,
 * and never something a proxy or a history entry should keep.
 */

import { listDocumentUploads } from '@lj/db';

import { authoriseSlotRequest } from '../../lib/document-access.ts';
import { failure, success } from '../../lib/http.ts';
import { parseDownloadUrlRequest } from '../../lib/request.ts';
import {
  createSignedDownload,
  DOCUMENT_BUCKET,
  DOWNLOAD_URL_SECONDS,
} from '../../lib/storage.ts';

export async function POST(request: Request): Promise<Response> {
  try {
    return await issueDownloadUrl(request);
  } catch (error: unknown) {
    const described = error instanceof Error ? error.name + ': ' + error.message : 'unknown';
    console.error('POST /api/documents/download-url failed: ' + described);
    return failure(500, 'internal_error', 'the download url could not be issued');
  }
}

async function issueDownloadUrl(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, 'invalid_request', 'the request body must be JSON');
  }

  const parsed = parseDownloadUrlRequest(body);
  if (!parsed.ok) {
    return failure(400, 'invalid_request', parsed.problems.join('; '));
  }

  const authorised = await authoriseSlotRequest(request, parsed.request.slotId);
  if (!authorised.ok) {
    return authorised.response;
  }
  const { service, slot } = authorised.access;

  // Read through the slot whose audience has just been checked, rather than by
  // upload id alone: an upload named with the wrong slot is then a file this
  // caller has no claim to, and it is answered as absent.
  const uploads = await listDocumentUploads(service, slot.id);
  const upload = uploads.find((row) => row.id === parsed.request.uploadId);
  if (upload === undefined) {
    return failure(404, 'subject_not_found', 'no such document on this slot');
  }

  const url = await createSignedDownload(service, upload.storage_path);
  if (url === null) {
    return failure(502, 'storage_unavailable', 'storage did not issue a download url');
  }

  return success({
    slotId: slot.id,
    uploadId: upload.id,
    bucket: DOCUMENT_BUCKET,
    filename: upload.filename,
    mime: upload.mime,
    bytes: upload.bytes,
    url,
    expiresInSeconds: DOWNLOAD_URL_SECONDS,
  });
}
