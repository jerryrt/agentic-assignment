import { z } from 'zod';

import { TimestampSchema, UuidSchema } from '../primitives.js';
import { AppRoleSchema } from '../roles.js';

/**
 * A row of `profile`, keyed by `auth.users.id`.
 *
 * `role` has a database default but no default here. A role is an authorisation
 * decision, and a schema that supplies one would let a payload missing the
 * field parse as a borrower -- quietly, at the trust boundary, which is the
 * worst place for a default to live (CLAUDE.md section 10).
 */
export const ProfileSchema = z.object({
  id: UuidSchema,
  role: AppRoleSchema,
  /** Null for borrowers: they belong to no lending organisation. */
  org_id: UuidSchema.nullable(),
  full_name: z.string().nullable(),
  created_at: TimestampSchema,
});

export type Profile = z.infer<typeof ProfileSchema>;
