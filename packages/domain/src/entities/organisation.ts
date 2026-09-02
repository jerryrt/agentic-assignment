import { z } from 'zod';

import { NonEmptyTextSchema, TimestampSchema, UuidSchema } from '../primitives.ts';

/**
 * The lending organisation. Products, applications and loans all hang off it,
 * and `profile.org_id` is what the RLS policies compare against, so it is the
 * tenancy boundary as well as an entity.
 *
 * Column names mirror the database exactly, in snake_case, throughout this
 * folder. These schemas exist to validate a row as it arrives from PostgREST;
 * renaming on the way in would create a second vocabulary for every column and
 * a mapping layer that can drift from the migration without failing anything.
 */
export const OrganisationSchema = z.object({
  id: UuidSchema,
  name: NonEmptyTextSchema,
  created_at: TimestampSchema,
});

export type Organisation = z.infer<typeof OrganisationSchema>;
