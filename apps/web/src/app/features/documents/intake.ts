import { InjectionToken } from '@angular/core';
import {
  ACCEPTED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  isAcceptedUploadMimeType,
} from '@lj/domain';

/**
 * THE SEAM. Everything this feature cannot do from a browser goes through here,
 * and there is exactly one implementation to write when apps/api catches up.
 *
 * Two operations, and neither of them is possible from a browser today:
 *
 * 1. **Putting bytes in the bucket.** `supabase/migrations/0006_documents.sql`
 *    grants NO insert policy on `storage.objects` for the `documents` bucket,
 *    deliberately, and the probe in @lj/db asserts a borrower is refused even
 *    under their own application. A client-supplied path is a client choosing
 *    which application's folder to write into, so the path has to be minted by
 *    the API and handed back as a signed upload URL. That route is issue #42's
 *    and does not exist yet.
 * 2. **Recording a human correction.** `authenticated` holds SELECT and
 *    nothing else on `document_upload`, and the table is append-only even for
 *    the service role. A typed-in value is therefore a write only the API can
 *    make, and #42 does not currently declare a route for one -- raised on the
 *    issue.
 *
 * So the screens are built against this interface and the default binding
 * refuses, in a sentence a person can read, naming the reason. It is NOT a
 * fake that pretends the write happened: a local "uploaded" the server never
 * saw would put a state on the checklist that a refresh silently deletes, and
 * a local correction would move a slot from "could not read that" to accepted
 * on nothing but the client's word. plan/04's whole subject is a screen that
 * does not lie about where the borrower stands.
 *
 * Both methods resolve with nothing. The server is the truth after either one,
 * so the store re-reads rather than adopting a value this layer invented --
 * which also means #42's implementation owes this interface no response shape
 * beyond "it worked".
 */

export interface UploadRequest {
  readonly applicationId: string;
  readonly slotId: string;
  /** The slot's code, which is the second segment of the storage path. */
  readonly slotCode: string;
  readonly file: File;
}

export interface CorrectionRequest {
  readonly applicationId: string;
  readonly slotId: string;
  readonly field: string;
  /** As typed. The API parses it; a browser is not the trust boundary. */
  readonly value: string;
}

export interface DocumentIntake {
  upload(request: UploadRequest): Promise<void>;
  correct(request: CorrectionRequest): Promise<void>;
}

/** What the seam says while nothing is behind it. Shown, not swallowed. */
export const INTAKE_NOT_WIRED =
  'Sending files is not connected in this build yet, so nothing was uploaded.';

export const CORRECTION_NOT_WIRED =
  'Typing a value in is not connected in this build yet, so nothing was changed.';

/**
 * The default binding: it refuses, and says so.
 *
 * Rejecting rather than resolving is the point. `AggregateStore.write()` turns
 * a rejection into the error surface the screen already renders, so the
 * borrower is told the truth in the place they are already looking, and no
 * state moves.
 */
export class UnwiredDocumentIntake implements DocumentIntake {
  upload(_request: UploadRequest): Promise<void> {
    return Promise.reject(new Error(INTAKE_NOT_WIRED));
  }

  correct(_request: CorrectionRequest): Promise<void> {
    return Promise.reject(new Error(CORRECTION_NOT_WIRED));
  }
}

export const DOCUMENT_INTAKE = new InjectionToken<DocumentIntake>('lj.document-intake', {
  providedIn: 'root',
  factory: () => new UnwiredDocumentIntake(),
});

/**
 * Why a file cannot be sent, or null.
 *
 * The server checks all of this again and its check is the one that counts
 * (CLAUDE.md section 10). This one exists so that a borrower who picks a
 * 40 MB scan is told immediately instead of after a minute of uploading, and
 * both readers take the limits from the single statement of them in
 * @lj/domain rather than restating either number.
 *
 * The message names the next action, like every other failure on this screen.
 */
export function fileRefusal(file: { readonly size: number; readonly type: string }): string | null {
  if (file.size <= 0) {
    return 'That file is empty -- choose the scan itself rather than a shortcut to it.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return (
      'That file is larger than ' +
      String(Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))) +
      ' MB -- send a smaller scan, or split it.'
    );
  }
  if (!isAcceptedUploadMimeType(file.type)) {
    return 'Send a PDF or a photo (' + readableMimeList() + ').';
  }
  return null;
}

function readableMimeList(): string {
  return ACCEPTED_UPLOAD_MIME_TYPES.map((mime) => mime.replace(/^.*\//, '').toUpperCase()).join(
    ', ',
  );
}
