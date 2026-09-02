/**
 * POST /api/documents/correction -- a person types in what the machine could
 * not read.
 *
 * plan/04 is explicit that the correction panel is not a cop-out: it is how
 * these products actually ship. Extraction PROPOSES and a human CONFIRMS, and
 * once a person has confirmed a value, the machine's confidence in its own
 * reading stops being the question -- `isReadable` in packages/rules trusts
 * `source: 'human'` whatever the confidence says. Without this route that half
 * of the design is decorative, because nothing can ever write `'human'`.
 *
 * A CORRECTION APPENDS; IT DOES NOT REWRITE. `document_upload` holds no UPDATE
 * grant for anyone, service role included, and that is deliberate: a record of
 * what was submitted that can be edited to agree with what happened afterwards
 * is not a record. So a correction is a NEW ROW against the same object -- same
 * storage_path, same bytes, same file -- carrying the previous extraction with
 * one field replaced. The previous row stays exactly as it was, which is what
 * keeps "what did the extractor actually read" answerable after somebody has
 * disagreed with it.
 *
 * WHY THE BORROWER AND NOT THE LENDER. The lender's remedy for a document they
 * do not believe is `reject`, which is the decision they hold. Letting the
 * party who decides also write the evidence they decide on is a different
 * system, and not one plan/04 describes: the [fix] button is on the borrower's
 * checklist, beside the field that could not be read.
 *
 * THE SLOT DOES NOT MOVE. A correction is not a transition -- no state changes,
 * so no revision changes and the machine is not consulted. It is still recorded
 * in the log as its own entry, with the person who made it, because a value a
 * lender relies on has to be attributable to whoever put it there. The log
 * already carries non-transition entries: `0004_demo_data.sql` records `create`
 * the same way.
 *
 * The corrected slot is deliberately allowed to be `accepted`. That is the only
 * state in which an unreadable field is reported at all (see `documentSlotRule`
 * in packages/rules), so refusing there would make the failure this route
 * exists to fix the one failure it could not reach.
 */

import { insertDocumentUpload, listDocumentUploads, type Json } from '@lj/db';

import { authoriseSlotRequest } from '../../lib/document-access.ts';
import { appendCorrectionEvent } from '../../lib/document-correction.ts';
import { failure, success } from '../../lib/http.ts';
import { parseCorrectionRequest } from '../../lib/request.ts';

/**
 * What is recorded against a value a person typed.
 *
 * `isReadable` ignores confidence entirely for a human source, so the figure is
 * cosmetic -- and it is written as certainty rather than left at zero precisely
 * because it is cosmetic: a reader that did look would otherwise see a
 * confirmed value carrying no confidence at all.
 */
const HUMAN_CONFIDENCE_BASIS_POINTS = 10_000;

const CORRECTED = 'corrected';

export async function POST(request: Request): Promise<Response> {
  try {
    return await recordCorrection(request);
  } catch (error: unknown) {
    const described = error instanceof Error ? error.name + ': ' + error.message : 'unknown';
    console.error('POST /api/documents/correction failed: ' + described);
    return failure(500, 'internal_error', 'the correction could not be recorded');
  }
}

async function recordCorrection(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, 'invalid_request', 'the request body must be JSON');
  }

  const parsed = parseCorrectionRequest(body);
  if (!parsed.ok) {
    return failure(400, 'invalid_request', parsed.problems.join('; '));
  }

  const authorised = await authoriseSlotRequest(request, parsed.request.slotId);
  if (!authorised.ok) {
    return authorised.response;
  }
  const { actor, service, slot } = authorised.access;

  if (actor.role !== 'borrower') {
    return failure(
      403,
      'role_not_permitted',
      "role '" + actor.role + "' may not correct a document; the remedy for a document a " +
        'lender does not believe is to reject it',
      { blockers: [], current: { state: slot.state, revision: slot.revision } },
    );
  }

  // Newest first, so the head is the file that currently satisfies the slot.
  const uploads = await listDocumentUploads(service, slot.id);
  const current = uploads[0];
  if (current === undefined) {
    return failure(404, 'subject_not_found', 'this document has no file to correct');
  }
  if (current.id !== parsed.request.uploadId) {
    // The optimistic-concurrency check an append-only table can have: correcting
    // a superseded upload would append a new newest row carrying values from a
    // file that has already been replaced.
    return failure(
      409,
      'state_conflict',
      'this document has been replaced since that reading was taken; re-read it and ' +
        'correct the current file',
      { blockers: [], current: { state: slot.state, revision: slot.revision } },
    );
  }

  const existing = readExtracted(current.extracted);
  if (!correctable(parsed.request.field, slot.extractRequired, existing)) {
    return failure(
      422,
      'invalid_request',
      "'" +
        parsed.request.field +
        "' is not a field this document was asked for; a correction corrects something " +
        'the pack requires or the extractor read',
    );
  }

  const corrected: Record<string, unknown> = {
    ...existing,
    [parsed.request.field]: {
      value: parsed.request.value,
      confidence_basis_points: HUMAN_CONFIDENCE_BASIS_POINTS,
      source: 'human',
    },
  };

  const written = await insertDocumentUpload(service, {
    slot_id: slot.id,
    // The same bytes. A correction is a claim about what the file says, not a
    // different file, and pointing at the same object is what makes that
    // visible rather than implied.
    storage_path: current.storage_path,
    filename: current.filename,
    bytes: current.bytes,
    mime: current.mime,
    extracted: corrected as Json,
    extraction_state: CORRECTED,
  });
  if (written === null) {
    return failure(500, 'internal_error', 'the correction returned no row');
  }

  const logged = await appendCorrectionEvent(service, {
    slot,
    actor,
    field: parsed.request.field,
    uploadId: written.id,
    correctedUploadId: current.id,
  });
  if (!logged) {
    // The correction stands and the log is short one row. Loud rather than
    // absorbed, and in that order rather than the reverse: an entry written
    // first for a correction that then failed to land is a forged history, and
    // the log has no DELETE for anyone.
    return failure(
      500,
      'event_log_write_failed',
      "the correction to '" +
        parsed.request.field +
        "' was recorded but its audit entry could not be written",
    );
  }

  return success({
    slotId: slot.id,
    uploadId: written.id,
    correctedUploadId: current.id,
    field: parsed.request.field,
    value: parsed.request.value,
    source: 'human',
    // Unchanged, and said so: a correction is not a transition, so a caller
    // holding this revision still holds a current one.
    state: slot.state,
    revision: slot.revision,
  });
}

/**
 * What the previous row said, as a plain object.
 *
 * Anything that is not an object is treated as nothing having been read, which
 * is the same direction the rules fail in: a correction then carries only the
 * field a person typed, rather than propagating a value nobody can parse.
 */
function readExtracted(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

/**
 * A correction corrects something the document was asked for, or something the
 * extractor claimed to read.
 *
 * The first covers the case the panel exists for -- a required field that came
 * back unreadable. The second covers a value the extractor produced wrongly for
 * a field the pack did not require, which is still a value a lender may end up
 * reading. Everything else is a caller writing keys into a jsonb column.
 */
function correctable(
  field: string,
  extractRequired: readonly string[],
  existing: Record<string, unknown>,
): boolean {
  return extractRequired.includes(field) || Object.hasOwn(existing, field);
}
