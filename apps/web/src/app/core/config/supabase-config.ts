import { InjectionToken, type Provider } from '@angular/core';
import type { AnonClientConfig, EnvironmentSource } from '@lj/db';
import {
  MissingConfigurationError,
  readAnonClientConfig,
  SUPABASE_ANON_KEY_VAR,
  SUPABASE_URL_VAR,
} from '@lj/db';

/**
 * Where the browser's Supabase URL and anon key come from.
 *
 * `@lj/db` deliberately reads no environment of its own (see the header of its
 * config.ts): the delivery layer knows which runtime it is and hands the
 * variables in. This file is the web app's half of that contract, and it is the
 * ONLY place in the browser bundle that names either variable.
 *
 * The values arrive as esbuild `define` substitutions, from the two scripts in
 * apps/web/package.json:
 *
 *     ng serve --define "LJ_SUPABASE_URL='${SUPABASE_URL-}'" ...
 *
 * so the literal is written into the bundle at build time and neither name nor
 * value exists in this repository (docs/01-local-development.md: the local keys
 * "still never enter the repository"). The two variable names match the ones
 * declared on the `build` task in turbo.json, which is what makes them survive
 * Turbo's strict environment mode.
 *
 * `typeof` rather than a bare reference, because an undefined `define` is a
 * ReferenceError at module evaluation -- which is every unit test, where no
 * define is supplied, and the whole application would fail to load rather than
 * one feature failing to configure.
 *
 * The anon key is publishable by design: it is subject to row-level security,
 * which is the actual boundary (CLAUDE.md section 10). The service role key has
 * no path into this bundle -- `@lj/db`'s barrel does not re-export it, and
 * nothing here reaches for `@lj/db/service-role`.
 */

declare const LJ_SUPABASE_URL: string | undefined;
declare const LJ_SUPABASE_ANON_KEY: string | undefined;

/**
 * Configuration, or the name of the variable that is missing.
 *
 * A result rather than a throw. `readAnonClientConfig` throwing at construction
 * is right for a server process, which should refuse to start; a browser that
 * throws during bootstrap renders a blank page and reports the cause only to a
 * console nobody has open. Carrying the failure as a value lets the shell boot
 * and say what is wrong, which is the difference between a diagnosable
 * deployment and a white screen.
 */
export type SupabaseConfigResult =
  | { readonly ok: true; readonly config: AnonClientConfig }
  | { readonly ok: false; readonly missingVariable: string };

/** What the build baked in. Empty in a unit test, and that is a valid answer. */
export function buildTimeEnvironment(): EnvironmentSource {
  return {
    [SUPABASE_URL_VAR]: typeof LJ_SUPABASE_URL === 'string' ? LJ_SUPABASE_URL : undefined,
    [SUPABASE_ANON_KEY_VAR]:
      typeof LJ_SUPABASE_ANON_KEY === 'string' ? LJ_SUPABASE_ANON_KEY : undefined,
  };
}

/**
 * Validate an environment, keeping `@lj/db` as the single definition of which
 * variables are required and what counts as blank.
 */
export function readSupabaseConfig(environment: EnvironmentSource): SupabaseConfigResult {
  try {
    return { ok: true, config: readAnonClientConfig(environment) };
  } catch (cause) {
    if (cause instanceof MissingConfigurationError) {
      // The name only. A truncated key in a log is still a key in a log.
      return { ok: false, missingVariable: cause.variableName };
    }
    throw cause;
  }
}

export const SUPABASE_CONFIG = new InjectionToken<SupabaseConfigResult>('lj.supabase-config');

/**
 * Provide the configuration the build baked in, or an explicit one.
 *
 * The parameter exists for tests and for nothing else, which is why it has a
 * default rather than being required at the call site in app.config.ts.
 */
export function provideSupabaseConfig(
  environment: EnvironmentSource = buildTimeEnvironment(),
): Provider {
  return { provide: SUPABASE_CONFIG, useValue: readSupabaseConfig(environment) };
}
