/**
 * Extraction, at the seam plan/04 names.
 *
 * REAL OCR IS OUT OF SCOPE AND THE SEAM IS THE DELIVERABLE. `Extractor` is the
 * whole interface a real one would implement -- it is handed a reference to a
 * file and the slot that file is meant to satisfy, and it answers fields. The
 * shipped implementation is a stub that reads the FILENAME, and it says so in
 * its name, in this comment, and in the `extraction_state` it records. An
 * undisclosed stub reads as a gap; a stated one at a named interface reads as
 * scoping judgment.
 *
 * Two decisions here are not stubbable and are the real content:
 *
 * CONFIDENCE IS IN BASIS POINTS, and the floor lives in packages/rules
 * (EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS). A proportion carried as a float
 * has the same undecidable boundary a float threshold has: 0.7 compared against
 * a value that arrived as 0.7 through arithmetic is not a comparison anybody
 * should stake a decision on. Nothing in this file knows the floor -- it emits
 * a figure and the rules decide what it is worth.
 *
 * A PARTIAL READ IS NOT AN ERROR. The slot still goes uploaded -> extracted;
 * the fields that were not read surface as completeness failures, which is what
 * the borrower can act on ("upload a clearer scan, or type the value in").
 * Modelling a failed read as a failed state would put the document in a state
 * no event moves it out of, and would tell the borrower their upload was
 * rejected when it was merely unreadable.
 */

import type { JsonValue } from '@lj/domain';

/** What a real extractor would be handed: where the bytes are, and what they are. */
export interface FileRef {
  /** The name the person chose. The stub's only input; a real one's last resort. */
  readonly filename: string;
  readonly storagePath: string;
  readonly mime: string;
  readonly bytes: number;
}

/** The requirement the file is meant to satisfy, as the product stated it. */
export interface SlotDefinition {
  readonly code: string;
  readonly label: string;
  readonly extractRequired: readonly string[];
}

/**
 * One field, in the shape `document_upload.extracted` stores.
 *
 * snake_case because it is a database column's content and is read back by SQL,
 * by the browser and by apps/api; packages/rules reads it through a camelCase
 * view (`ExtractedField`) built at the boundary. The `source` distinction is
 * load-bearing: extraction PROPOSES and a human CONFIRMS, and a field a person
 * typed is trusted whatever the machine thought of its own reading.
 */
export interface ExtractedFieldRecord {
  readonly value: JsonValue;
  readonly confidence_basis_points: number;
  readonly source: 'ocr' | 'human';
}

export interface Extraction {
  readonly fields: Readonly<Record<string, ExtractedFieldRecord>>;
  /**
   * `extracted` when every field the slot asked for was read, `partial`
   * otherwise. Recorded rather than derived later so that "what did the
   * extractor manage" stays answerable after the rules have moved on.
   */
  readonly state: 'extracted' | 'partial';
  /**
   * An expiry the extractor read off the document, copied onto the slot.
   * `expired` is not a state (plan/03) -- it is derived from this date and the
   * clock -- so this is where a document's shelf life enters the system.
   */
  readonly validUntil: string | null;
}

export interface Extractor {
  extract(file: FileRef, slot: SlotDefinition): Promise<Extraction>;
}

/* -------------------------------------------------------------------------
 * The stub
 * ---------------------------------------------------------------------- */

/**
 * What the stub is willing to claim about a value it read from a filename.
 *
 * High, and deliberately so: it did not read a scan, it read a name somebody
 * typed. A stub that emitted low confidence would exercise the floor by
 * accident and make every uploaded document unreadable, which is a different
 * system from the one being demonstrated. A name is a shade lower because
 * capitalising "smith-farms" into "Smith Farms" is a guess about a person's
 * name, and a real extractor would say so too.
 */
const PATTERN_CONFIDENCE_BASIS_POINTS = 9_000;
const NAME_CONFIDENCE_BASIS_POINTS = 8_000;

const ACRES = /^(\d+)ac$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOLLARS = /^(\d+)usd$/;
const YEAR = /^\d{4}$/;
const NAME = /^[a-z][a-z-]*$/;

interface Tokens {
  readonly acres: number | null;
  readonly date: string | null;
  readonly moneyMinor: number | null;
  readonly year: number | null;
  /** The last name-shaped token, excluding the first, which names the document. */
  readonly name: string | null;
}

/** 'smith-farms' as a person writes it. */
function titleCase(token: string): string {
  return token
    .split('-')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The filename, read as a small grammar.
 *
 * Underscores separate tokens and hyphens do not, so a multi-word name survives
 * as one token: `deed_1240ac_smith-farms.pdf` is three tokens, and the first
 * says what the document is rather than what it says. Everything is anchored,
 * so a token either matches a pattern exactly or contributes nothing -- a
 * near-miss must not become a figure a lender then reads.
 */
function readTokens(filename: string): Tokens {
  const withoutExtension = filename.replace(/\.[A-Za-z0-9]+$/, '');
  const tokens = withoutExtension.toLowerCase().split('_').filter((token) => token !== '');

  let acres: number | null = null;
  let date: string | null = null;
  let moneyMinor: number | null = null;
  let year: number | null = null;
  let name: string | null = null;

  tokens.forEach((token, index) => {
    const acreMatch = ACRES.exec(token);
    if (acreMatch?.[1] !== undefined) {
      acres = Number(acreMatch[1]);
      return;
    }
    if (ISO_DATE.test(token)) {
      date = token;
      return;
    }
    const dollarMatch = DOLLARS.exec(token);
    if (dollarMatch?.[1] !== undefined) {
      // Whole dollars in the name, minor units in the record. Money is integer
      // minor units everywhere in TypeScript (CLAUDE.md section 10), and a
      // figure that changed scale between the extractor and the rule would be
      // wrong by a factor of a hundred in a comparison nobody re-checks.
      moneyMinor = Number(dollarMatch[1]) * 100;
      return;
    }
    if (YEAR.test(token)) {
      year = Number(token);
      return;
    }
    if (index > 0 && NAME.test(token)) {
      name = titleCase(token);
    }
  });

  return { acres, date, moneyMinor, year, name };
}

/**
 * Which token answers which field.
 *
 * By suffix rather than by an exhaustive list of field names, because the field
 * names are content: they arrive from a product's `required_docs` and this file
 * must not become a second place where a product's vocabulary is written down.
 */
function valueFor(field: string, tokens: Tokens): ExtractedFieldRecord | null {
  const record = (value: JsonValue, confidence: number): ExtractedFieldRecord => ({
    value,
    confidence_basis_points: confidence,
    source: 'ocr',
  });

  if (field.endsWith('_acres') && tokens.acres !== null) {
    return record(tokens.acres, PATTERN_CONFIDENCE_BASIS_POINTS);
  }
  if ((field === 'valid_until' || field.endsWith('_date') || field.endsWith('_end')) && tokens.date !== null) {
    return record(tokens.date, PATTERN_CONFIDENCE_BASIS_POINTS);
  }
  if (
    (field.endsWith('_income') ||
      field.endsWith('_price') ||
      field.endsWith('_value') ||
      field.endsWith('_assets') ||
      field.endsWith('_amount')) &&
    tokens.moneyMinor !== null
  ) {
    return record(tokens.moneyMinor, PATTERN_CONFIDENCE_BASIS_POINTS);
  }
  if (field.endsWith('_year') && tokens.year !== null) {
    return record(tokens.year, PATTERN_CONFIDENCE_BASIS_POINTS);
  }
  if (field.endsWith('_name') && tokens.name !== null) {
    return record(tokens.name, NAME_CONFIDENCE_BASIS_POINTS);
  }
  return null;
}

/**
 * The shipped extractor: deterministic, offline, and honest about it.
 *
 * Deterministic matters beyond the demo. The same file re-extracted must give
 * the same answer, or a lender and a borrower looking at one document on two
 * days see two different documents.
 */
export const stubExtractor: Extractor = {
  extract(file: FileRef, slot: SlotDefinition): Promise<Extraction> {
    const tokens = readTokens(file.filename);
    const fields: Record<string, ExtractedFieldRecord> = {};

    for (const field of slot.extractRequired) {
      const value = valueFor(field, tokens);
      if (value !== null) {
        fields[field] = value;
      }
    }

    // An expiry is recorded whether or not the pack asked for one: it is what
    // makes a document go stale, and a certificate that says when it runs out
    // says so regardless of what the checklist wanted from it.
    if (tokens.date !== null && fields['valid_until'] === undefined) {
      fields['valid_until'] = {
        value: tokens.date,
        confidence_basis_points: PATTERN_CONFIDENCE_BASIS_POINTS,
        source: 'ocr',
      };
    }

    const read = slot.extractRequired.every((field) => fields[field] !== undefined);
    return Promise.resolve({
      fields,
      state: read ? 'extracted' : 'partial',
      validUntil: tokens.date,
    });
  },
};
