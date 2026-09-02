/**
 * The two Supabase configurations this API needs, read from the function's own
 * environment at request time.
 *
 * Read at request time rather than at module load for the same reason
 * `api/health.ts` does it: Turbo 2 runs tasks in strict env mode and
 * `turbo.json` declares only SUPABASE_URL, SUPABASE_ANON_KEY and VERCEL_ENV for
 * `build`, so anything captured during a build would be blank. The serverless
 * runtime is a separate process with its own environment that Turbo never sees.
 *
 * SUPABASE_SERVICE_ROLE_KEY is deliberately absent from that `build` list, and
 * must stay absent: it is what makes a stray read of the key under `apps/web`
 * produce an empty string at build time instead of baking a live key into a
 * browser bundle. Reading it here is the one place it is legitimate, because
 * this file only ever runs inside the API's process.
 */

import { readAnonClientConfig, type AnonClientConfig, type EnvironmentSource } from '@lj/db';
import {
  readServiceRoleClientConfig,
  type ServiceRoleClientConfig,
} from '@lj/db/service-role';

export interface ApiEnvironment {
  /** Subject to row-level security. Used to act as the caller. */
  readonly anon: AnonClientConfig;
  /** Bypasses row-level security. Used only to adjudicate and to append. */
  readonly serviceRole: ServiceRoleClientConfig;
}

/**
 * Both configurations, or a `MissingConfigurationError` naming the one variable
 * that is unset. Failing here rather than at the first query is deliberate: a
 * client built with an undefined key fails later, as an opaque 401 nowhere near
 * the cause.
 */
export function readApiEnvironment(env: EnvironmentSource): ApiEnvironment {
  return {
    anon: readAnonClientConfig(env),
    serviceRole: readServiceRoleClientConfig(env),
  };
}
