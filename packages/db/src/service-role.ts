/**
 * The RLS-bypassing client.  Server only.  Never imported by the barrel.
 *
 * CLAUDE.md section 10: "The service role key never enters a browser bundle -
 * not unused, not present."  Three independent mechanisms hold that line, and
 * this module is arranged around them:
 *
 *   1. A separate entry point.  `packages/db/package.json` maps `.` to
 *      ./index.ts and `./service-role` to this file, and nothing reachable
 *      from ./index.ts imports this module.  A bundler following the web app's
 *      import graph therefore never reaches this file at all.  One module with
 *      a `serviceRole: true` flag would have failed exactly here: the flag is
 *      a runtime value, both branches are in the graph, and the key-reading
 *      code ships to the browser whether or not it runs.
 *
 *   2. The variable name exists only here.  `SUPABASE_SERVICE_ROLE_KEY` is not
 *      spelled anywhere under ./config.ts or ./index.ts, so grepping a built
 *      browser bundle for that string is a real test with a real answer, and
 *      it is a test that stays honest as this package grows.  It is also
 *      absent from the `build` task's `env` list in `turbo.json`, so a stray
 *      read under `apps/web` gets a blank string at build time rather than a
 *      live key.
 *
 *   3. A runtime guard.  If the first two are ever defeated by a
 *      misconfiguration, `createServiceRoleClient` throws in a browser instead
 *      of quietly handing out an unrestricted database connection.
 *
 * Layer 3 is last for a reason: by the time it fires the key is already in the
 * bundle.  It exists so the mistake is loud, not so the mistake is survivable.
 */

import { createClient } from '@supabase/supabase-js';

import type { DatabaseClient } from './client';
import {
  requireVariable,
  SUPABASE_URL_VAR,
  type EnvironmentSource,
} from './config';
import type { Database } from './database.types';

/** See the note in ./config.ts on why names, and only names, are written down. */
export const SUPABASE_SERVICE_ROLE_KEY_VAR = 'SUPABASE_SERVICE_ROLE_KEY';

/**
 * The service-role key.  Bypasses every row-level security policy, which is
 * why it is a distinct type from `AnonClientConfig` rather than a second
 * optional field on it: the two are never interchangeable and the compiler
 * should say so.
 */
export interface ServiceRoleClientConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
}

/**
 * Structurally a `DatabaseClient`; named separately because the authority it
 * carries is the thing a reader needs to notice, and the type system cannot
 * express it.  A function taking this alias is announcing that it operates
 * with RLS switched off.
 */
export type ServiceRoleClient = DatabaseClient;

/** Read the service-role configuration, or throw naming the missing variable. */
export function readServiceRoleClientConfig(
  env: EnvironmentSource,
): ServiceRoleClientConfig {
  return {
    url: requireVariable(env, SUPABASE_URL_VAR),
    serviceRoleKey: requireVariable(env, SUPABASE_SERVICE_ROLE_KEY_VAR),
  };
}

/**
 * True when the current global object looks like a browser's.
 *
 * `globalThis` is retyped through `unknown` because this package compiles
 * without the DOM lib -- which is itself part of the defence, since a file
 * that cannot name `window` cannot casually use one.  The check is for
 * presence, not for a value, so a server that defines a stub `window` for
 * rendering is not caught by accident.
 */
function runningInBrowser(): boolean {
  const globals = globalThis as unknown as Record<string, unknown>;
  return 'window' in globals && 'document' in globals;
}

/**
 * Build a client that bypasses row-level security.  API only.
 *
 * Use it for the operations that are the system's own -- adjudicating a
 * workflow transition, appending to the event log -- and nothing else.  Every
 * read that can be attributed to a user should go through
 * `createAnonClientForAccessToken` instead, so that the policies remain the
 * thing being trusted.
 *
 * Sessions are disabled outright: a service-role client has no user to be, and
 * persisting a session derived from this key would write it into whatever
 * storage the runtime happens to offer.
 */
export function createServiceRoleClient(
  config: ServiceRoleClientConfig,
): ServiceRoleClient {
  if (runningInBrowser()) {
    throw new Error(
      'createServiceRoleClient was called in a browser. The service role key ' +
        'bypasses row-level security and must exist only in the API environment ' +
        '(CLAUDE.md section 10). Use createAnonClient from @lj/db instead, and ' +
        'treat this as a build configuration fault: the key is already in the bundle.',
    );
  }

  return createClient<Database>(config.url, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
