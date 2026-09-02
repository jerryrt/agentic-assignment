// A test of the harness, not of the app.
//
// Unusual, and deliberate.  Every journey a later scope writes will start from
// `borrowerPage` or `lenderPage` and assume it is signed in as that person.  If
// that assumption is wrong -- a stale token, a storage key the app does not read,
// two roles accidentally sharing one context -- the journeys do not fail with
// "the session is wrong".  They fail on a missing heading, in a feature the
// author is still writing, and the hour goes on the wrong suspect.
//
// So the seam is asserted once, here, where the failure names itself.  It also
// exercises the per-file database reset (this file takes the default policy),
// which is otherwise code that only runs when someone else's test needs it.

import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/test';
import { ACCOUNTS } from '../fixtures/accounts';
import { authStorageKey } from '../fixtures/auth';

interface StoredSession {
  readonly access_token?: string;
  readonly user?: { readonly id?: string; readonly email?: string };
}

async function readStoredSession(page: Page, key: string): Promise<StoredSession> {
  // localStorage is per-origin, so the page has to be ON the origin before the
  // saved state is readable. This navigation is not incidental.
  await page.goto('/');
  const raw = await page.evaluate((name: string) => window.localStorage.getItem(name), key);
  expect(raw, `no session found under localStorage["${key}"]`).not.toBeNull();
  return JSON.parse(raw ?? '{}') as StoredSession;
}

test('each role fixture carries its own session', async ({
  borrowerPage,
  lenderPage,
  stack,
}) => {
  const key = authStorageKey(stack.url);

  const borrower = await readStoredSession(borrowerPage, key);
  const lender = await readStoredSession(lenderPage, key);

  expect(borrower.user?.email).toBe(ACCOUNTS.borrower.email);
  expect(borrower.user?.id).toBe(ACCOUNTS.borrower.id);
  expect(lender.user?.email).toBe(ACCOUNTS.lender.email);

  // Two contexts, two cookie jars, two localStorages. This is what makes the
  // plan's "two roles, two truths" test possible in a single test, so it is
  // worth an explicit assertion rather than an assumption about Playwright.
  expect(borrower.user?.id).not.toBe(lender.user?.id);
});

test('the saved session is a live credential, not just a plausible blob', async ({
  borrowerPage,
  stack,
}) => {
  const key = authStorageKey(stack.url);
  const session = await readStoredSession(borrowerPage, key);
  const token = session.access_token ?? '';
  expect(token, 'the saved session carries no access token').not.toBe('');

  // Ask GoTrue who the token belongs to. A token that parses but is rejected is
  // the failure mode a shape-only assertion would miss.
  const response = await borrowerPage.request.get(new URL('/auth/v1/user', stack.url).toString(), {
    headers: { apikey: stack.anonKey, Authorization: `Bearer ${token}` },
  });
  expect(response.status(), 'the local auth service rejected the saved token').toBe(200);
  const user = (await response.json()) as { email?: string; role?: string };
  expect(user.email).toBe(ACCOUNTS.borrower.email);
  // The claim every policy in supabase/migrations/0002_rls.sql is written
  // against. A token with the wrong role reads as an empty table, not as an
  // error, which is the most expensive kind of wrong.
  expect(user.role).toBe('authenticated');
});
