// The "setup" project: everything that must be true before a journey runs, and
// nothing else.
//
// It runs once per suite run, ahead of every other project (playwright.config.ts
// declares the dependency).  Two jobs:
//
//   1. Preflight.  Say plainly that the stack is down, once, instead of letting
//      thirty tests fail at a redirect and leaving the reader to work out which
//      of the twelve containers is missing.
//   2. Sign each seeded role in and save its storage state, so a journey starts
//      logged in.  See fixtures/auth.ts for the contract that produces.

import { test as setup, expect } from '@playwright/test';

import { ACCOUNTS, assertSeedMatches } from './fixtures/accounts';
import { AUTH_STATE_DIR, saveStorageState } from './fixtures/auth';
import { assertDatabaseReachable } from './fixtures/database';
import { assertStackReachable, readLocalStack } from './fixtures/stack';

setup('preflight: the local stack answers and the seed matches', async () => {
  assertSeedMatches();
  const stack = readLocalStack();
  await assertStackReachable(stack);
  assertDatabaseReachable();
});

setup('save a signed-in session for each seeded role', async ({ baseURL }) => {
  // baseURL comes from the config. localStorage is per-origin, so a session
  // saved against the wrong origin produces a browser that is signed in to
  // nothing and a failure that looks like broken auth.
  expect(baseURL, 'baseURL must be configured; the saved session is origin-scoped').toBeTruthy();
  const origin = baseURL ?? '';
  const stack = readLocalStack();

  for (const account of Object.values(ACCOUNTS)) {
    const path = await saveStorageState(stack, account.role, origin);
    // Reported rather than silent: when a role fixture misbehaves, the first
    // question is whether its state was written at all, and this answers it in
    // the run log.
    setup.info().annotations.push({
      type: 'saved-session',
      description: `${account.role} (${account.email}) -> ${path.replace(AUTH_STATE_DIR, '.auth/')}`,
    });
  }
});
