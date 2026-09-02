/**
 * `@lj/db` -- the persistence layer.  Knows Supabase; knows nothing about HTTP
 * or Angular (`plan/01-architecture.md`).
 *
 * This barrel is the browser-safe surface, and everything it re-exports is
 * bound by row-level security.  The RLS-bypassing client is **not** here: it
 * lives behind a second entry point and is imported as
 *
 *     import { createServiceRoleClient } from '@lj/db/service-role';
 *
 * The omission is the mechanism, not an oversight.  A bundler following
 * `apps/web`'s import graph reaches this file and stops; it never reaches the
 * module that names the service role key's environment variable, so neither
 * that name nor its value can appear in a browser bundle even unused.  See the
 * header of ./service-role.ts for the other two layers of the same guarantee.
 * Adding a re-export of that module here would remove the protection silently,
 * and no test would fail.
 */

// The generated schema. Regenerate with the Supabase CLI; never hand-edit.
export type {
  Database,
  Enums,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from './database.types.ts';
export { Constants } from './database.types.ts';

export type { AnonClientConfig, EnvironmentSource } from './config.ts';
export {
  MissingConfigurationError,
  readAnonClientConfig,
  requireVariable,
  SUPABASE_ANON_KEY_VAR,
  SUPABASE_URL_VAR,
} from './config.ts';

export type { DatabaseClient } from './client.ts';
export { createAnonClient, createAnonClientForAccessToken } from './client.ts';

export type { QueryOutcome } from './errors.ts';
export { DatabaseQueryError, unwrapList, unwrapMaybe } from './errors.ts';

export * from './queries/index.ts';
