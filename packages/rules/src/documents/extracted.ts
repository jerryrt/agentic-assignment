import type { ExtractedField } from './context.ts';

/**
 * `document_upload.extracted`, read into the fields the rules take.
 *
 * The column is jsonb and both @lj/domain and @lj/db leave it opaque, because
 * this package owns the confidence floor and the ocr-versus-human distinction
 * and therefore owns what a field means. What was missing was a reader, and its
 * absence produced exactly the failure CLAUDE.md section 9 describes: apps/api
 * wrote the shape, apps/web read it, and each had its own copy of the parse. A
 * renamed key would have failed nothing and quietly reported every field
 * unreadable -- which reads to a borrower as "upload a clearer scan" for a
 * document that was fine.
 *
 * The wire shape is snake_case because it crosses a jsonb column, and the
 * column comment in `supabase/migrations/0006_documents.sql` states it:
 *
 *     { "<field>": { "value": ..., "confidence_basis_points": <int>,
 *                    "source": "ocr" | "human" } }
 *
 * **It fails towards distrust, never towards trust**, and every branch below is
 * that rule applied. Accepting a field on bad evidence tells a borrower a
 * document is finished and puts a figure nobody read in front of a lender;
 * refusing one tells them to upload a clearer scan or type the value in, which
 * is an instruction they can act on. Only one of those mistakes is recoverable.
 *
 * The two copies this replaces disagreed on one point, and the disagreement is
 * resolved here in favour of the more useful behaviour rather than the simpler
 * one. A field whose confidence is unreadable is KEPT, with a confidence of
 * zero, rather than dropped. Both readings block the pack -- `isReadable`
 * refuses a zero-confidence machine reading exactly as it refuses an absent
 * field, and `documentSlotRule` iterates the slot's `extractRequired` rather
 * than the extracted keys, so the verdict is identical either way. What differs
 * is the screen: a kept field can be offered in the correction panel for
 * somebody to type the value into, and a dropped one cannot.
 */
export function parseExtractedFields(
  value: unknown,
): Readonly<Record<string, ExtractedField>> {
  if (!isRecord(value)) {
    return {};
  }

  const fields: Record<string, ExtractedField> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      continue;
    }
    const extracted = raw['value'];
    // A field with no value is not a field that was read badly, it is one that
    // was not read. Keeping it with a null value would make `isReadable` the
    // only thing standing between an empty reading and a satisfied
    // requirement, and that is a thinner margin than this deserves.
    if (extracted === null || extracted === undefined) {
      continue;
    }
    fields[name] = {
      value: extracted,
      confidenceBasisPoints: confidenceOf(raw['confidence_basis_points']),
      source: sourceOf(raw['source']),
    };
  }
  return fields;
}

const MAX_BASIS_POINTS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A confidence that is not an integer in range reads as zero.
 *
 * Zero is a reading nothing has confidence in, which is precisely what an
 * unparseable one is. Defaulting the other way -- to the floor, or to full
 * confidence -- would let a malformed row satisfy a requirement.
 */
function confidenceOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return 0;
  }
  return raw < 0 || raw > MAX_BASIS_POINTS ? 0 : raw;
}

/**
 * Only the exact string `human` is a human.
 *
 * Anything else -- a spelling nothing has written yet, a value forged into a
 * jsonb column -- is the machine, and the machine still has to clear the
 * confidence floor. Reading an unknown source as human would hand the trust
 * that belongs to a person's confirmation to whatever wrote the row.
 */
function sourceOf(raw: unknown): ExtractedField['source'] {
  return raw === 'human' ? 'human' : 'ocr';
}
