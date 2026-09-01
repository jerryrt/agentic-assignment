import type { DocumentSlotState } from '@lj/domain';

/**
 * What the document rules read.
 *
 * Two things arrive in the context that a careless implementation would reach
 * for directly, and both are the point of this file:
 *
 * 1. **The clock.** `expired` is not a state on the slot machine, because a
 *    machine whose states change without an event is a machine that lies
 *    (plan 03). Expiry is derived from `valid_until` and today, and today
 *    arrives here. A rule calling Date.now() could not be tested and could not
 *    be replayed against the date a decision was actually made.
 * 2. **Confidence, in basis points.** Extraction confidence is a proportion,
 *    and a proportion carried as a float has the same undecidable boundary as a
 *    float threshold: a floor of "0.7" cannot be compared exactly against a
 *    value that arrived as 0.7 through arithmetic. 70% is 7000.
 */

export interface ExtractedField {
  readonly value: unknown;
  /** 0 to 10000. A field a person typed in is trusted regardless of this. */
  readonly confidenceBasisPoints: number;
  /** Extraction proposes; a human confirms. The distinction is load-bearing. */
  readonly source: 'ocr' | 'human';
}

export interface DocumentSlotView {
  readonly code: string;
  readonly label: string;
  readonly required: boolean;
  readonly state: DocumentSlotState;
  /** ISO calendar date, or null when the document does not expire. */
  readonly validUntil: string | null;
  /** The fields this slot must yield for the pack to be complete. */
  readonly extractRequired: readonly string[];
  readonly extracted: Readonly<Record<string, ExtractedField | undefined>>;
}

export interface DocumentContext {
  /** ISO calendar date. The clock, injected. */
  readonly today: string;
  readonly slots: readonly DocumentSlotView[];
}

/**
 * Below this, a machine reading is not a reading. The figure is a policy and
 * lives here alone: a copy in a template would be a second policy the first
 * time either moved.
 */
export const EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS = 7_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Dates are compared as strings, which is exact for zero-padded ISO dates and
 * introduces neither a timezone nor a Date object into a pure package. That
 * only holds if the strings really are ISO dates, so anything else throws
 * rather than compares wrong: silently expiring a valid document, or accepting
 * an expired one, is not a failure anybody would notice.
 */
export function assertIsoDate(value: string, what: string): string {
  const match = ISO_DATE.exec(value);
  if (match === null) {
    throw new RangeError(what + " must be an ISO calendar date (YYYY-MM-DD); received '" + value + "'");
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(what + " is not a calendar date; received '" + value + "'");
  }
  return value;
}

/** `valid_until` is inclusive: a certificate valid until today is valid today. */
export function isExpired(validUntil: string | null, today: string): boolean {
  if (validUntil === null) {
    return false;
  }
  return assertIsoDate(validUntil, 'valid_until') < assertIsoDate(today, 'today');
}

/**
 * A field is readable when something is there and either a person confirmed it
 * or the extractor was confident enough. Once a human has typed the value in,
 * the machine's confidence in its own reading is no longer the question.
 */
export function isReadable(field: ExtractedField | undefined): field is ExtractedField {
  if (field === undefined || field.value === null || field.value === undefined) {
    return false;
  }
  return (
    field.source === 'human' ||
    field.confidenceBasisPoints >= EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS
  );
}

/** 'net_income' as a person would read it in a sentence. */
export function humaniseFieldName(field: string): string {
  return field.replace(/_/g, ' ');
}
