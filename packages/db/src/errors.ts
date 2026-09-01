/**
 * Turning PostgREST's `{ data, error }` pair into values and exceptions.
 *
 * The pair is easy to ignore: `const { data } = await client.from(...)` is
 * valid TypeScript and silently treats a denied read as an empty result.  A
 * row-level security refusal looks exactly like "no such row" from the client
 * side, so a helper that swallowed the error would make the security boundary
 * indistinguishable from an absent record.  Every helper in ./queries
 * therefore routes through one of the two functions below.
 */

import type { PostgrestError } from '@supabase/supabase-js';

/**
 * The shape every PostgREST call resolves to.  Declared structurally rather
 * than imported as `PostgrestSingleResponse`, because the builders return
 * several near-identical response types and the unwrappers care about none of
 * the differences.
 */
export interface QueryOutcome<T> {
  readonly data: T | null;
  readonly error: PostgrestError | null;
}

/**
 * A failed database call, with the operation that failed attached.
 *
 * The operation label is what makes the exception useful: PostgREST's own
 * message names the constraint or the policy but not the query, and a bare
 * "new row violates row-level security policy" in a log is unattributable.
 */
export class DatabaseQueryError extends Error {
  readonly operation: string;
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(operation: string, cause: PostgrestError) {
    super(operation + ' failed: ' + cause.message);
    this.name = 'DatabaseQueryError';
    this.operation = operation;
    this.code = cause.code ?? null;
    this.details = cause.details ?? null;
    this.hint = cause.hint ?? null;
  }
}

/**
 * One row, or `null` when there is none.
 *
 * `null` is a real answer here and covers two cases that are the same answer
 * from outside: the row does not exist, and the caller is not permitted to see
 * it.  Callers must handle it; CLAUDE.md section 11 forbids asserting it away.
 */
export function unwrapMaybe<T>(operation: string, outcome: QueryOutcome<T>): T | null {
  if (outcome.error !== null) {
    throw new DatabaseQueryError(operation, outcome.error);
  }
  return outcome.data;
}

/**
 * Many rows.
 *
 * `readonly` because these arrays are query results, not working buffers: a
 * caller that sorts one in place is mutating something it does not own, and
 * the next reader has no way to know it happened.
 */
export function unwrapList<T>(
  operation: string,
  outcome: QueryOutcome<T[]>,
): readonly T[] {
  if (outcome.error !== null) {
    throw new DatabaseQueryError(operation, outcome.error);
  }
  return outcome.data ?? [];
}
