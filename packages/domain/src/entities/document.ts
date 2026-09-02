import { z } from 'zod';

import {
  JsonObjectSchema,
  NonEmptyTextSchema,
  TimestampSchema,
  UuidSchema,
} from '../primitives.ts';
import { DocumentSlotStateSchema } from '../states.ts';

/**
 * The document pack: one row per thing the product asks for, and one row per
 * file submitted against it.
 *
 * Two columns are deliberately left opaque here, for the reason
 * `loan_product.criteria` is: `extracted` is read by packages/rules, which owns
 * the confidence floor and the ocr-versus-human distinction that decide what a
 * field means, and giving it a shape in this package would put the schema for a
 * rule below the layer that owns the rule (CLAUDE.md section 8). The consuming
 * layer parses it with its own reader.
 *
 * `state` is text in the database with no check constraint, exactly as
 * `application.state` is: legality lives in `workflow_transition`, generated
 * from packages/workflow, and the `assert_legal_transition` trigger enforces
 * it. The schema below narrows it on the way in, which is a second line and not
 * the first.
 */

/**
 * `valid_until` is a `date`, not a `timestamptz`. A certificate expires on a
 * calendar day in the place it was issued, and giving it an instant would make
 * the answer depend on the reader's time zone -- a document valid until the
 * 12th would read as expired to anyone east of the issuer. packages/rules
 * compares it as an ISO calendar string for the same reason.
 */
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'must be an ISO calendar date (YYYY-MM-DD)',
});

export const DocumentSlotSchema = z.object({
  id: UuidSchema,
  application_id: UuidSchema,
  /** Stable per product. `unique (application_id, code)` is keyed on it. */
  code: NonEmptyTextSchema,
  label: NonEmptyTextSchema,
  required: z.boolean(),
  state: DocumentSlotStateSchema,
  /** Optimistic concurrency, as on `application`. Every transition checks it. */
  revision: z.number().int().nonnegative(),
  /**
   * The fields this slot must yield before the pack counts it complete, copied
   * from the product at generation time rather than read back through the
   * product on every evaluation. A product's pack may be edited, and a slot
   * already generated must keep the terms it was created under -- the same
   * argument the eligibility snapshot makes about criteria.
   */
  extract_required: z.array(NonEmptyTextSchema),
  valid_until: CalendarDateSchema.nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type DocumentSlot = z.infer<typeof DocumentSlotSchema>;

/**
 * One file submitted against a slot.
 *
 * Append-only: a replacement is a new row, which is what `replace` on the slot
 * machine means. Nothing updates or deletes one, so what was submitted and when
 * stays answerable after the fact.
 */
export const DocumentUploadSchema = z.object({
  id: UuidSchema,
  slot_id: UuidSchema,
  /**
   * The object key in the private bucket. The convention is
   * `<application_id>/<slot_code>/<uuid>.<ext>` and it is load-bearing: a
   * storage policy can only gate on what the path says, so the application id
   * has to be recoverable from it. See 0006_documents.sql.
   */
  storage_path: NonEmptyTextSchema,
  filename: NonEmptyTextSchema,
  bytes: z.number().int().positive(),
  mime: NonEmptyTextSchema,
  /** `{ field: { value, confidence_basis_points, source } }`, or null before extraction. */
  extracted: JsonObjectSchema.nullable(),
  extraction_state: NonEmptyTextSchema,
  uploaded_at: TimestampSchema,
});
export type DocumentUpload = z.infer<typeof DocumentUploadSchema>;

/**
 * What an upload may carry, checked at the trust boundary as well as in the
 * browser.
 *
 * plan/04 fixes both numbers. They live here rather than in the API because the
 * browser refuses an oversized file before spending a minute uploading it, and
 * the server refuses it because the browser's check is a courtesy -- two
 * readers, one statement of the limit (CLAUDE.md section 9).
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

export function isAcceptedUploadMimeType(mime: string): boolean {
  return (ACCEPTED_UPLOAD_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * How many required slots on an application are not yet accepted.
 *
 * `application_lender_v` projects this so the lender's queue can be ordered by
 * work outstanding. It is a count and not a rule: whether the PACK is complete
 * is `evaluateCompleteness` in packages/rules, which also weighs expiry and
 * readability. A queue that sorted on this and a guard that decided on that are
 * two different questions, and conflating them would put a threshold in a view.
 */
export const OpenDocCountSchema = z.number().int().nonnegative();
