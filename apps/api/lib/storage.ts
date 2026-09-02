/**
 * The private bucket, and the one place an object key is decided.
 *
 * THE API MINTS EVERY PATH AND ACCEPTS NONE. A client-supplied path is a client
 * choosing which application's folder to write into, and the storage policy in
 * 0006_documents.sql can only gate on what the path says -- it reads the first
 * segment as the application id and asks the same question the table policies
 * ask. So the convention is part of the contract:
 *
 *     <application_id>/<slot_code>/<uuid>.<ext>
 *
 * and the two leading segments come from the slot row this server loaded, never
 * from the request. The random segment is what stops a second upload against
 * one slot from overwriting the first, which matters because `document_upload`
 * is append-only: a replaced file that still has to be explainable later cannot
 * have been written over.
 *
 * The extension is derived from the MIME type rather than taken from the
 * caller's filename. A name is a label the person chose and may say anything;
 * the type is what the bucket enforces, and deriving one from the other keeps
 * the key honest about what is behind it.
 *
 * Nothing here is SQL, so nothing here belongs in packages/db: this is the
 * storage service's HTTP API, reached through the same Supabase client, and it
 * is the delivery layer's business (CLAUDE.md section 8).
 */

import { randomUUID } from 'node:crypto';

import type { DatabaseClient } from '@lj/db';
import { ACCEPTED_UPLOAD_MIME_TYPES, isAcceptedUploadMimeType } from '@lj/domain';

/** Created by 0006_documents.sql. Private, 10 MB, pdf and images only. */
export const DOCUMENT_BUCKET = 'documents';

/**
 * One extension per accepted type, and the type says so rather than a comment:
 * a MIME type added to @lj/domain without an extension here fails to compile,
 * which is the only moment anybody would think to add one.
 */
const EXTENSIONS: Record<(typeof ACCEPTED_UPLOAD_MIME_TYPES)[number], string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export function extensionForMimeType(mime: string): string | null {
  if (!isAcceptedUploadMimeType(mime)) {
    return null;
  }
  return EXTENSIONS[mime as (typeof ACCEPTED_UPLOAD_MIME_TYPES)[number]] ?? null;
}

/**
 * A slot code that cannot disturb the path.
 *
 * The code arrives from the product's own `required_docs`, which is content and
 * is not written by this scope. A code carrying a slash would add a segment and
 * a code carrying `..` would climb one, and while the read policy would survive
 * both -- it reads the FIRST segment either way -- the convention that everyone
 * else relies on would not.
 */
const SAFE_SLOT_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type MintedPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export function mintStoragePath(
  applicationId: string,
  slotCode: string,
  mime: string,
): MintedPath {
  const extension = extensionForMimeType(mime);
  if (extension === null) {
    return { ok: false, reason: "no extension is defined for '" + mime + "'" };
  }
  if (!SAFE_SLOT_CODE.test(slotCode)) {
    return {
      ok: false,
      reason: "the slot code '" + slotCode + "' cannot appear in a storage path",
    };
  }
  return {
    ok: true,
    path: applicationId + '/' + slotCode + '/' + randomUUID() + '.' + extension,
  };
}

/** The folder every file for one slot lives in, and nothing else does. */
export function slotFolder(applicationId: string, slotCode: string): string {
  return applicationId + '/' + slotCode;
}

export interface SignedUpload {
  readonly path: string;
  readonly signedUrl: string;
  /** What `uploadToSignedUrl` takes; the signature, not a session token. */
  readonly token: string;
}

/**
 * A URL the browser may PUT one file to, once, at a path it did not choose.
 *
 * The bytes never pass through this API (plan/04). Proxying them would put a
 * 10 MB body through a serverless function for no gain: the storage service
 * authorises the write from the signature rather than from the policies, which
 * is precisely why no client holds an INSERT on storage.objects for this
 * bucket.
 */
export async function createSignedUpload(
  client: DatabaseClient,
  path: string,
): Promise<SignedUpload | null> {
  const { data, error } = await client.storage
    .from(DOCUMENT_BUCKET)
    .createSignedUploadUrl(path);
  if (error !== null || data === null) {
    if (error !== null) {
      // The storage service's own message names buckets and paths; it is
      // logged and never returned, for the reason a database message is not.
      console.error('createSignedUploadUrl failed: ' + error.message);
    }
    return null;
  }
  return { path: data.path, signedUrl: data.signedUrl, token: data.token };
}

/**
 * A URL the browser may GET one file from, for a few minutes.
 *
 * The bucket is private, so this is the only way to read an object -- and the
 * expiry is short because the URL carries its own authorisation: anyone holding
 * it can read that file, and a link pasted into a chat should stop working
 * before the conversation does.
 */
export const DOWNLOAD_URL_SECONDS = 300;

export async function createSignedDownload(
  client: DatabaseClient,
  path: string,
): Promise<string | null> {
  const { data, error } = await client.storage
    .from(DOCUMENT_BUCKET)
    .createSignedUrl(path, DOWNLOAD_URL_SECONDS);
  if (error !== null || data === null) {
    if (error !== null) {
      console.error('createSignedUrl failed: ' + error.message);
    }
    return null;
  }
  return data.signedUrl;
}
