/**
 * What a rule managed to read out of its context.
 *
 * A rule cannot simply take `number | null` and treat null as "not entered",
 * because the interesting question is not *that* something is missing but
 * *which* thing is: a coverage ratio is unknown when either net operating
 * income or annual debt service is absent, and telling the applicant "enter
 * dscr" would be useless. So a reading either carries a value or carries the
 * list of inputs it is still waiting for, and that list becomes the
 * `missing` array of the RuleResult (CLAUDE.md section 7 -- the unknown case is
 * as much a first-class outcome as pass and fail).
 *
 * Each missing input carries both a machine name and a human label. The name is
 * what a form uses to focus the control that would resolve it; the label is
 * what the sentence shown to the applicant reads. Deriving one from the other
 * works for `total_acres` and fails for a document slot code, so both are
 * stated.
 */

export interface MissingInput {
  /** The field the UI would focus, e.g. 'annual_debt_service'. */
  readonly field: string;
  /** The same thing in the applicant's words, e.g. 'annual debt service'. */
  readonly label: string;
}

export interface KnownReading<T> {
  readonly known: true;
  readonly value: T;
  /** Whatever the reading looked at, for the explanation drawer. */
  readonly inputs: Readonly<Record<string, unknown>>;
}

export interface AwaitingReading {
  readonly known: false;
  readonly missing: readonly MissingInput[];
  readonly inputs: Readonly<Record<string, unknown>>;
}

export type Reading<T> = KnownReading<T> | AwaitingReading;

export function missingInput(field: string, label: string): MissingInput {
  return { field, label };
}

export function known<T>(
  value: T,
  inputs: Readonly<Record<string, unknown>> = {},
): KnownReading<T> {
  return { known: true, value, inputs };
}

export function awaiting(
  missing: readonly MissingInput[],
  inputs: Readonly<Record<string, unknown>> = {},
): AwaitingReading {
  return { known: false, missing: [...missing], inputs };
}

/**
 * Zero is a number the applicant entered; only null is an absence. Conflating
 * the two is how a form asks again for a field that is already filled in.
 */
export function readNumber(
  value: number | null,
  field: string,
  label: string,
): Reading<number> {
  return value === null ? awaiting([missingInput(field, label)]) : known(value);
}

/**
 * Postgres stores '' happily in a `not null text` column, so emptiness rather
 * than nullability is the constraint that decides whether a value is there.
 * The trimmed form is what is carried onward: trailing whitespace out of an
 * extractor is not a difference anybody meant.
 */
export function readText(value: string | null, field: string, label: string): Reading<string> {
  const trimmed = value === null ? '' : value.trim();
  return trimmed === '' ? awaiting([missingInput(field, label)]) : known(trimmed);
}

/** The union of what several readings are waiting for, in order, without repeats. */
export function combineMissing(readings: readonly Reading<unknown>[]): MissingInput[] {
  const combined: MissingInput[] = [];
  const seen = new Set<string>();
  for (const reading of readings) {
    if (reading.known) {
      continue;
    }
    for (const input of reading.missing) {
      if (!seen.has(input.field)) {
        seen.add(input.field);
        combined.push(input);
      }
    }
  }
  return combined;
}

export function missingFields(missing: readonly MissingInput[]): string[] {
  return missing.map((input) => input.field);
}

export function missingLabels(missing: readonly MissingInput[]): string[] {
  return missing.map((input) => input.label);
}

/** The inputs of several readings, merged for the explanation drawer. */
export function combineInputs(
  readings: readonly Reading<unknown>[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const reading of readings) {
    Object.assign(merged, reading.inputs);
  }
  return merged;
}

/**
 * One place a value can be read from, named as the explanation will name it.
 * Cross-document checks compare several of these against each other, so the
 * name has to travel with the reader rather than be supplied at the call site.
 */
export interface AgreementSource<Context, Value> {
  readonly name: string;
  readonly read: (context: Context) => Reading<Value>;
}
