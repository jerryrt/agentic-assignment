/**
 * Where a Supabase client's URL and key come from.
 *
 * Nothing here reads `process.env` itself, and that is deliberate rather than
 * awkward.  This package extends the environment-agnostic tsconfig, so it can
 * see neither Node's `process` nor the browser's `import.meta.env`; a factory
 * that reached for either would tie the persistence layer to one runtime and
 * would have to be duplicated for the other.  The delivery layer knows which
 * runtime it is, hands the variables in, and this layer only says which names
 * it needs and refuses to start without them.
 *
 * The service-role key is deliberately absent from this module.  Its variable
 * name and its reader live in ./service-role, which the package barrel does
 * not re-export -- see the comment at the top of that file.
 */

/**
 * Variable names, never values.  CLAUDE.md section 10: `.env.example` holds
 * names and shapes; a literal key must not exist anywhere in this repository.
 *
 * These two are also the names declared on the `build` task in `turbo.json`,
 * and the match has to be exact: Turbo 2 runs tasks in strict env mode, so a
 * variable the task does not declare arrives blank rather than missing.
 */
export const SUPABASE_URL_VAR = 'SUPABASE_URL';
export const SUPABASE_ANON_KEY_VAR = 'SUPABASE_ANON_KEY';

/**
 * Whatever the caller's runtime offers as a bag of environment variables:
 * `process.env` in the API, the build-time environment object in the web app,
 * a literal in a test.  Typed structurally so this package needs no ambient
 * platform types.
 */
export interface EnvironmentSource {
  readonly [name: string]: string | undefined;
}

/** The anon (publishable) key.  Subject to row-level security. */
export interface AnonClientConfig {
  readonly url: string;
  readonly anonKey: string;
}

/**
 * Thrown when a required variable is absent or blank.
 *
 * Failing at client construction is the point: the alternative is a client
 * built with `undefined` for its key, which does not fail until the first
 * request and then fails as an opaque 401 far from the cause.  The message
 * carries the variable *name* only -- never the value, and never a prefix of
 * it, because a truncated key in a log is still a key in a log.
 */
export class MissingConfigurationError extends Error {
  readonly variableName: string;

  constructor(variableName: string) {
    super(
      'Supabase configuration is incomplete: ' +
        variableName +
        ' is unset or empty. Set it in the environment; it is never defaulted here.',
    );
    this.name = 'MissingConfigurationError';
    this.variableName = variableName;
  }
}

/**
 * Read one required variable.
 *
 * Blank is treated as absent because that is how the failure actually shows
 * up: a shell exporting an empty string, or Turbo's strict env mode blanking a
 * variable the task did not declare.  Both would otherwise construct a client
 * that looks configured.
 */
export function requireVariable(env: EnvironmentSource, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new MissingConfigurationError(name);
  }
  return value;
}

/** Read the anon client's configuration, or throw naming the missing variable. */
export function readAnonClientConfig(env: EnvironmentSource): AnonClientConfig {
  return {
    url: requireVariable(env, SUPABASE_URL_VAR),
    anonKey: requireVariable(env, SUPABASE_ANON_KEY_VAR),
  };
}
