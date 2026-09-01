import { z } from 'zod';

/**
 * The scalar shapes every entity in this package is built from.
 *
 * Each one is declared once here rather than inline at each column, because a
 * timestamp that is validated three different ways is three different
 * contracts. When PostgREST changes how it renders a type, exactly one line in
 * this file has to move.
 */

/** A Postgres `uuid`, in the canonical lower-case rendering PostgREST emits. */
export const UuidSchema = z.uuid();

/**
 * A Postgres `timestamptz` as PostgREST renders it: ISO 8601 with an explicit
 * offset, and an unbounded fractional-second part because Postgres keeps
 * microseconds. Kept as a string rather than coerced to `Date`: a Date carries
 * a local-time reading this layer has no business choosing, and it does not
 * survive a JSON round trip unchanged.
 */
export const TimestampSchema = z.iso.datetime({ offset: true });

/**
 * Text that is `not null` in Postgres and meaningless when empty. Postgres will
 * happily store '' in a `not null text` column, so the constraint the schema
 * actually needs is length, not nullability.
 */
export const NonEmptyTextSchema = z.string().min(1);

/** Any value that survives a JSON round trip, which is what `jsonb` holds. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** A `jsonb` column that is always an object, such as `application.data`. */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

/** A `bigserial` primary key. Postgres renders it as a JSON number. */
export const BigSerialIdSchema = z.number().int().nonnegative();
