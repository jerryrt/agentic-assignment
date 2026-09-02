import { inject, Injectable } from '@angular/core';

import { ApiClient } from '../../core/api/api-client.ts';
import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import type { CorrectionRequest, DocumentIntake, UploadRequest } from './intake.ts';

/**
 * The real intake: what actually happens when a borrower chooses a file.
 *
 * `intake.ts` declares the seam and ships a stub that refuses; this is the
 * implementation, wired in `documents.routes.ts`. The seam existed because the
 * screens and the routes were built concurrently by two scopes, and it stays
 * because it is also how a test supplies its own.
 *
 * THE THREE STEPS ARE IN THIS ORDER FOR A REASON.
 *
 *   1. Ask the API for a signed upload URL. The API mints the path -- a
 *      client-supplied one is a client choosing which application's folder to
 *      write into -- and refuses a file that is too large, of the wrong type,
 *      or on a slot that takes no file in its current state. All of that
 *      happens before a byte is sent, so a refusal costs the borrower a round
 *      trip rather than a minute of upload on a phone.
 *   2. Send the bytes straight to Storage on that signed URL. The API never
 *      proxies them (plan/04), so there is no serverless function holding a
 *      10 MB body and no cold start in the way.
 *   3. Only then fire the transition. The state must not move until the bytes
 *      have landed: a slot at `uploaded` whose file is missing is a checklist
 *      row that looks answered and is not, and the borrower has no way to tell.
 *
 * The reverse -- transition first, upload after -- would be one round trip
 * cheaper and would produce exactly that. A failed upload after a successful
 * transition is the case with no recovery, because nothing afterwards knows the
 * file never arrived.
 */

/** `POST /api/documents/upload-url`, as the API answers it. */
interface UploadTicket {
  readonly path: string;
  readonly token: string;
  readonly event: string;
  readonly expectedRevision: number;
}

@Injectable()
export class HttpDocumentIntake implements DocumentIntake {
  private readonly api = inject(ApiClient);
  private readonly client = inject(DATABASE_CLIENT);

  async upload(request: UploadRequest): Promise<void> {
    const client = this.client;
    if (client === null) {
      throw new Error('This deployment cannot reach storage, so nothing was uploaded.');
    }

    const ticket = await this.api.post<UploadTicket>('/api/documents/upload-url', {
      slotId: request.slotId,
      filename: request.file.name,
      mime: request.file.type,
      bytes: request.file.size,
    });

    const sent = await client.storage
      .from('documents')
      .uploadToSignedUrl(ticket.path, ticket.token, request.file, {
        contentType: request.file.type,
      });
    if (sent.error !== null) {
      // Deliberately not followed by the transition. The slot stays where it
      // was, which is the honest state: nothing arrived.
      throw new Error(
        'The file could not be sent to storage, so the document was not recorded. ' +
          'Try again, or choose a different scan.',
      );
    }

    await this.api.post('/api/transition', {
      machine: 'document_slot',
      subjectId: request.slotId,
      event: ticket.event,
      expectedRevision: ticket.expectedRevision,
      filename: request.file.name,
    });
  }

  /**
   * Record a value a person typed in.
   *
   * `uploadId` is the upload the correction is against, and the API refuses one
   * that is not the newest on the slot. That is not pedantry: `document_upload`
   * is append-only, so a correction appends a new row carrying the previous
   * extraction with one field replaced, and appending to the head of a list is
   * only safe if the head is the one that was read. Somebody else replacing the
   * document while a correction panel was open is exactly the case it catches.
   */
  async correct(request: CorrectionRequest): Promise<void> {
    await this.api.post('/api/documents/correction', {
      slotId: request.slotId,
      uploadId: request.uploadId,
      field: request.field,
      value: request.value,
    });
  }
}
