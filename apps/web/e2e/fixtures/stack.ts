// Discovery of the local Supabase stack.
//
// No key value is written to a file in this repository -- CLAUDE.md section 10.
// The local stack prints its own keys, they are identical on every machine and
// worthless outside 127.0.0.1, so the correct place to read them is the CLI at
// run time.  This is the same approach, and deliberately the same shape, as
// packages/db/test/rls.spec.ts; if the parsing there ever has to change, it has
// to change here too, and matching code is easier to keep in step than
// paraphrased code.

/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/**
 * Absolute path of the repository root, with a trailing separator.
 *
 * Found by walking up from the working directory rather than from this file,
 * which looks like the long way round and is not.  apps/web/package.json
 * declares no "type", so Playwright transpiles everything under apps/web/e2e to
 * CommonJS, where `import.meta.url` is a syntax error -- while the root
 * package.json says "type": "module", so playwright.config.ts is ESM, where
 * `__dirname` does not exist.  Anchoring on a marker file instead is correct
 * under both, and stays correct if apps/web ever gains a "type" of its own.
 */
function findRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(`${dir}${sep}pnpm-workspace.yaml`)) {
      return `${dir}${sep}`;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not find the repository root above ${process.cwd()}: no pnpm-workspace.yaml. ` +
          'Run the browser suite from inside the repository.',
      );
    }
    dir = parent;
  }
}

export const repoRoot = findRepoRoot();

export interface LocalStack {
  /** Kong gateway: REST, Auth, Storage, Realtime. */
  readonly url: string;
  /** The key a browser is allowed to hold. */
  readonly anonKey: string;
  /** Bypasses RLS. Fixtures only, and never inside a page. */
  readonly serviceRoleKey: string;
  /** Direct Postgres connection string, used by the reset fixture. */
  readonly dbUrl: string;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `supabase status did not report ${key}. Run "supabase start" (see docs/01-local-development.md).`,
    );
  }
  return value;
}

// The CLI takes about a second to answer and the answer cannot change while the
// suite runs, so it is read once per worker process.
let cached: LocalStack | undefined;

export function readLocalStack(): LocalStack {
  if (cached !== undefined) {
    return cached;
  }
  let raw: string;
  try {
    // `supabase status` resolves supabase/config.toml relative to its working
    // directory, and Playwright's cwd is not guaranteed to be the root.
    raw = execFileSync('supabase', ['status', '-o', 'json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      // stderr is captured rather than inherited. The CLI writes a "Stopped
      // services: [...]" line there on every call, which is not a problem and
      // would otherwise print into the middle of the test report once per
      // worker, where it reads like one.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw new Error(
      'could not run "supabase status". The browser suite needs the local stack from ' +
        'docs/01-local-development.md; start it with "supabase start".',
      { cause },
    );
  }
  // The CLI prints unstructured lines (for example "Stopped services: [...]")
  // before the JSON document, so the payload starts at the first brace.
  const start = raw.indexOf('{');
  if (start < 0) {
    throw new Error('supabase status printed no JSON; is the local stack running?');
  }
  const parsed: unknown = JSON.parse(raw.slice(start));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('supabase status printed JSON that is not an object');
  }
  const status = parsed as Record<string, unknown>;
  cached = {
    url: requiredString(status, 'API_URL'),
    anonKey: requiredString(status, 'ANON_KEY'),
    serviceRoleKey: requiredString(status, 'SERVICE_ROLE_KEY'),
    dbUrl: requiredString(status, 'DB_URL'),
  };
  return cached;
}

/**
 * Confirms the gateway actually answers, rather than only that the CLI has an
 * opinion about it.  A stack whose containers were killed still reports its
 * ports, and the failure that produces three fixtures later says nothing useful.
 */
export async function assertStackReachable(stack: LocalStack): Promise<void> {
  const health = new URL('/auth/v1/health', stack.url);
  let response: Response;
  try {
    response = await fetch(health, { headers: { apikey: stack.anonKey } });
  } catch (cause) {
    throw new Error(
      `the Supabase gateway at ${stack.url} refused a connection. Run "supabase start".`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(
      `the Supabase auth service at ${stack.url} answered ${response.status}; the stack is up but unhealthy.`,
    );
  }
}
