import { z } from 'zod';

/**
 * The `app_role` enum of plan 02. Declared as a tuple first so that the
 * TypeScript union, the Zod schema and any exhaustive iteration all derive
 * from one list; a hand-written union beside a hand-written enum is two
 * declarations that drift the first time a role is added.
 */
export const APP_ROLES = ['borrower', 'lender', 'admin'] as const;

export const AppRoleSchema = z.enum(APP_ROLES);

export type AppRole = z.infer<typeof AppRoleSchema>;
