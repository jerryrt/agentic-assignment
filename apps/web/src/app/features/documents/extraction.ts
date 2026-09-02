import type { DocumentSlotView } from '@lj/rules';
import { parseExtractedFields } from '@lj/rules';

/**
 * `document_upload.extracted`, read into what the rules take.
 *
 * The parse itself lives in @lj/rules, beside the confidence floor and the
 * ocr-versus-human distinction it feeds. It used to live here as well, and in
 * apps/api a third time -- the writer and two readers each with their own copy
 * of a shape only a migration comment stated. A renamed key would have failed
 * nothing and quietly reported every field unreadable, which reads to a
 * borrower as "upload a clearer scan" for a document that was fine. That is
 * exactly the drift CLAUDE.md section 9 is about, and one definition is the fix.
 *
 * What is left here is the name this feature calls it by, so the call sites do
 * not each have to know that a jsonb column is what they are reading.
 */

/**
 * Exactly the shape `DocumentSlotView.extracted` declares, taken from it rather
 * than restated: a second spelling of the same map would differ on the
 * `| undefined` and every caller would need a cast to cross between them.
 */
export type ExtractedFields = DocumentSlotView['extracted'];

export function readExtractedFields(value: unknown): ExtractedFields {
  return parseExtractedFields(value);
}
