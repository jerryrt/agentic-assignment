/**
 * The RLS-bound client: safe in a browser, and the default everywhere else.
 *
 * Every function in this module builds a client that carries the anon
 * (publishable) key, so every statement it issues is filtered by the row-level
 * security policies.  That is the security boundary of CLAUDE.md section 10 --
 * the API is a convenience layer over it, never the only gate.  The
 * RLS-bypassing client lives in ./service-role and is reachable only through
 * the `@lj/db/service-role` entry point.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { AnonClientConfig } from './config.ts';
import type { Database } from './database.types.ts';

/**
 * A Supabase client typed against the generated schema.
 *
 * Query helpers accept this type rather than a narrower one, because an anon
 * client and a service-role client are structurally identical: they differ in
 * authority, not in shape, and authority is decided by Postgres.  A helper that
 * demanded one or the other would be asserting something TypeScript cannot
 * check.
 */
export type DatabaseClient = SupabaseClient<Database>;

/**
 * A client for a signed-in browser session.
 *
 * Supabase's defaults are the right ones here -- the session is persisted, the
 * token is refreshed, and a token in the URL after an email confirmation is
 * detected -- so they are left alone rather than restated.
 */
export function createAnonClient(config: AnonClientConfig): DatabaseClient {
  return createClient<Database>(config.url, config.anonKey);
}

/**
 * A client that acts as one specific end user, for a server handling that
 * user's request.
 *
 * This is how an API handler reads under RLS instead of around it: the
 * caller's access token travels on the request, so `auth.uid()` inside every
 * policy is the caller, and a forged `borrower_id` in the request body buys
 * nothing.  Prefer it to the service-role client for reads; reach for
 * service-role only where the operation is genuinely the system's own.
 *
 * The session options are the inverse of the browser's on purpose.  A server
 * process handles many users, so persisting or refreshing a session would
 * leak one request's identity into the next.
 */
export function createAnonClientForAccessToken(
  config: AnonClientConfig,
  accessToken: string,
): DatabaseClient {
  return createClient<Database>(config.url, config.anonKey, {
    global: { headers: { Authorization: 'Bearer ' + accessToken } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
