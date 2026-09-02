import type { DocumentSlotView, ExtractedField } from '@lj/rules';

/**
 * `document_upload.extracted`, read into what the rules take.
 *
 * The column is `jsonb` and both @lj/domain and @lj/db leave it opaque on
 * purpose: packages/rules owns the confidence floor and the ocr-versus-human
 * distinction, so it owns what a field means. What neither of them owns is the
 * WIRE SHAPE -- `{ field: { value, confidence_basis_points, source } }` --
 * which supabase/migrations/0006_documents.sql states and apps/api writes.
 *
 * This is the second reader of that shape and the first one that is not the
 * writer, which is worth saying out loud rather than leaving for someone to
 * discover: if apps/api renames a key, nothing here fails to compile and the
 * screen quietly reports every field unreadable. A shared parser belongs in
 * @lj/rules beside the floor it feeds, and that is raised on the issue rather
 * than done here, because packages/rules is not this scope's to edit.
 *
 * **It fails towards distrust, never towards trust.** Every branch below turns
 * a doubtful field into an absent or a zero-confidence one, which surfaces as
 * "could not read that -- upload a clearer scan, or type the value in": an
 * instruction the borrower can act on. The opposite mistake -- accepting a
 * field on bad evidence -- tells them a document is finished and puts a figure
 * nobody read in front of a lender.
 */

/**
 * Exactly the shape `DocumentSlotView.extracted` declares, taken from it
 * rather than restated: a second spelling of the same map would differ on the
 * `| undefined` and every caller would need a cast to cross between them.
 */
export type ExtractedFields = DocumentSlotView['extracted'];

/** 0 to 10000, as `EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS` is measured. */
const MAX_BASIS_POINTS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A confidence that is not an integer in range is read as zero rather than
 * dropped. Zero is a reading the machine has no confidence in, which is
 * exactly what an unparseable one is, and it keeps the field visible in the
 * correction panel so somebody can type the value in.
 */
function confidenceOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return 0;
  }
  return raw < 0 || raw > MAX_BASIS_POINTS ? 0 : raw;
}

/**
 * Only the exact string `human` is a human. Anything else -- a spelling the
 * API has not written yet, a value forged into a jsonb column -- is the
 * machine, and the machine still has to clear the confidence floor.
 */
function sourceOf(raw: unknown): ExtractedField['source'] {
  return raw === 'human' ? 'human' : 'ocr';
}

export function readExtractedFields(value: unknown): ExtractedFields {
  if (!isRecord(value)) {
    return {};
  }

  const fields: Record<string, ExtractedField> = {};
  for (const [field, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      continue;
    }
    const extracted = raw['value'];
    if (extracted === null || extracted === undefined) {
      continue;
    }
    fields[field] = {
      value: extracted,
      confidenceBasisPoints: confidenceOf(raw['confidence_basis_points']),
      source: sourceOf(raw['source']),
    };
  }
  return fields;
}
