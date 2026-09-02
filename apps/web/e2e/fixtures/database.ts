// Database isolation for the browser suite.
//
// THE DECISION, stated here because docs/02-browser-testing.md asks for one and
// because an implicit choice is the one that bites:
//
//   The suite resets the database ONCE PER SPEC FILE, and runs in a single
//   worker.
//
// Why not a shared seeded database, never reset?  It is faster, and it works
// right up to the first test that changes something.  The seed exists to hold
// the interesting states -- a draft stopped at step 3, an application waiting on
// a lender, an approved file with the lender's private note (supabase/migrations/0004_demo_data.sql).
// Those are exactly the rows a journey mutates: approve the application and the
// next file's "awaiting your decision" assertion fails, in a different file,
// with no clue that a neighbour caused it.  Order-dependent failures are the
// most expensive kind to diagnose, and they arrive weeks after the test that
// caused them.
//
// Why not per test?  Roughly a second of SQL each, on a suite the plan
// deliberately keeps small; per test buys isolation the file boundary already
// provides, and it makes a ten-test file ten seconds slower for nothing.
//
// Why one worker?  There is one local Postgres.  Two workers would be two files
// running at once against it, and one file's reset would delete rows the other
// is mid-assertion on.  Parallelism would need a database per worker, which the
// Supabase CLI does not give us cheaply; correctness first, and the suite is
// small by design.
//
// Why re-run supabase/migrations/0004_demo_data.sql rather than `supabase db reset`?  A full reset
// drops the database and replays every migration, which is tens of seconds and
// destroys any other work in progress on the same stack.  The seed file is
// written to be applied repeatedly -- it deletes its own previous generation
// first, by fixed id -- so applying it is truncate-and-reseed for exactly the
// rows the suite cares about, and leaves anything else alone.  Schema changes
// still arrive through `pnpm db:reset`; that is a developer action, not a test
// fixture's business.

/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { SEED_PATH } from './accounts';
import { repoRoot } from './stack';

// Set by supabase/config.toml. The container name the CLI creates is
// `supabase_db_<project_id>`.
const PROJECT_ID = 'land-journey';
const DB_CONTAINER = `supabase_db_${PROJECT_ID}`;

/**
 * Runs SQL inside the database container.
 *
 * Through docker rather than a host psql because psql is not a dependency of
 * this repository and requiring one would break the local-first claim on any
 * machine that has Docker and nothing else.  ON_ERROR_STOP makes a failed
 * statement a failed command; without it psql reports success after an error and
 * the suite would run against a half-applied seed.
 */
function runSql(sql: string, what: string): void {
  try {
    execFileSync(
      'docker',
      ['exec', '-i', DB_CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres', '-d', 'postgres', '-f', '-'],
      { cwd: repoRoot, input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (cause) {
    const stderr = extractStderr(cause);
    throw new Error(
      `${what} failed against container ${DB_CONTAINER}. ` +
        `Is the local stack up ("supabase start", docs/01-local-development.md)? ${stderr}`,
      { cause },
    );
  }
}

function extractStderr(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'stderr' in cause) {
    const stderr = (cause as { stderr: unknown }).stderr;
    if (typeof stderr === 'string') {
      return stderr.trim().slice(0, 500);
    }
  }
  return '';
}

/**
 * Proves the reset path works without changing a row.
 *
 * Used by the preflight in auth.setup.ts so that a missing container or a
 * stopped stack is reported once, up front, instead of as a mid-suite reset
 * failure that reads like a data problem.
 */
export function assertDatabaseReachable(): void {
  runSql('select 1;', 'database preflight');
}

/**
 * Truncate and re-seed: re-applies supabase/migrations/0004_demo_data.sql.
 *
 * The seed is read from disk on every call rather than cached, so a developer
 * editing it does not have to restart the runner to see the effect.
 */
export function resetDatabase(): void {
  const seed = readFileSync(SEED_PATH, 'utf8');
  runSql(seed, 'database reset (re-applying supabase/migrations/0004_demo_data.sql)');
}
