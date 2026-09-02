// Per-role authentication, saved once per run.
//
// docs/02-browser-testing.md: "Authenticate once per role by hitting the auth
// API directly and saving storage state, rather than driving the login form in
// every test.  The login form is exercised by auth.spec.ts; everywhere else it
// is setup cost."  A login form replayed 40 times is 40 chances to fail for a
// reason the test was not about.
//
// UNVERIFIED CONTRACT, and the one thing to check first if a role fixture looks
// signed out.  apps/web does not depend on @supabase/supabase-js yet, so the
// shape below is supabase-js v2's documented behaviour and not something this
// suite has observed the app read:
//
//   - the session is a JSON document under a localStorage key
//   - the key is `sb-<first label of the API hostname>-auth-token`
//   - the document is the token endpoint's response body verbatim
//
// The scope that adds authentication to the web app owns that contract.  If it
// configures a different storageKey, set E2E_AUTH_STORAGE_KEY rather than
// editing a test, and if it stores the session anywhere else (a cookie, for
// server-side rendering) this file changes and nothing else does.  That is why
// the shape is built here and not inline in a spec.

/// <reference types="node" />

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ACCOUNTS, SEEDED_PASSWORD, type Account, type Role } from './accounts';
import { repoRoot, type LocalStack } from './stack';

/** Where the saved states land. Git-ignored: they carry live access tokens. */
export const AUTH_STATE_DIR = `${repoRoot}apps/web/e2e/.auth/`;

export function storageStatePath(role: Role): string {
  return `${AUTH_STATE_DIR}${role}.json`;
}

/**
 * supabase-js derives its localStorage key from the project URL: the first
 * label of the hostname.  For the local stack that hostname is 127.0.0.1, so the
 * key is `sb-127-auth-token`.  Deriving it rather than hardcoding it means a
 * change of ports or of host does not silently produce a signed-out browser.
 */
export function authStorageKey(apiUrl: string): string {
  const override = process.env['E2E_AUTH_STORAGE_KEY'];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const firstLabel = new URL(apiUrl).hostname.split('.')[0] ?? 'local';
  return `sb-${firstLabel}-auth-token`;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly expires_at?: number;
  readonly token_type: string;
  readonly user: unknown;
}

/**
 * Exchanges a seeded email and password for a session, through the same
 * endpoint the browser would use.  Nothing is stubbed: this is GoTrue in a
 * container, checking a bcrypt hash written by the seed.
 */
export async function signIn(stack: LocalStack, account: Account): Promise<TokenResponse> {
  const endpoint = new URL('/auth/v1/token?grant_type=password', stack.url);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { apikey: stack.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: SEEDED_PASSWORD }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `sign-in failed for ${account.email} (${response.status}). ` +
        `The seeded accounts come from supabase/migrations/0004_demo_data.sql; run "pnpm db:reset" if the database is empty. ` +
        `Response: ${detail.slice(0, 300)}`,
    );
  }
  const session = (await response.json()) as TokenResponse;
  if (typeof session.access_token !== 'string' || session.access_token.length === 0) {
    throw new Error(`sign-in for ${account.email} returned no access token`);
  }
  return session;
}

/**
 * Re-issues every role's session, in place.
 *
 * Needed after a database reset, and the reason is not obvious: supabase/migrations/0004_demo_data.sql
 * deletes and recreates auth.users, which cascades to auth.sessions, so every
 * token saved before the reset names a session that no longer exists.  The JWT
 * still parses and still looks valid; GoTrue answers 403 and the browser looks
 * signed out for no visible reason.  Found by the harness self-test in
 * apps/web/e2e/system/harness.spec.ts, which is why that test exists.
 */

/**
 * Writes a Playwright storage state for one role against one origin.
 *
 * The origin matters: localStorage is per-origin, so a state saved for
 * 127.0.0.1:4200 is invisible to a page served from localhost:4200.  It is
 * passed in rather than assumed so that a suite run against a preview
 * deployment keeps working.
 */
export async function refreshStorageStates(stack: LocalStack, origin: string): Promise<void> {
  for (const account of Object.values(ACCOUNTS)) {
    await saveStorageState(stack, account.role, origin);
  }
}

export async function saveStorageState(
  stack: LocalStack,
  role: Role,
  origin: string,
): Promise<string> {
  const account = ACCOUNTS[role];
  const session = await signIn(stack, account);
  const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in;
  const state = {
    cookies: [],
    origins: [
      {
        origin: new URL(origin).origin,
        localStorage: [
          {
            name: authStorageKey(stack.url),
            value: JSON.stringify({ ...session, expires_at: expiresAt }),
          },
        ],
      },
    ],
  };
  const path = storageStatePath(role);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return path;
}
