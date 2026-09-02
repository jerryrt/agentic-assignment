// The `test` every spec imports.
//
// Import this instead of @playwright/test.  Everything a journey needs to be
// short is here: the roles are already signed in, the database has been reset if
// the file asked for it, and a console error fails the test that caused it
// rather than scrolling past in a log.
//
//   import { expect, test } from '../fixtures/test';
//
//   test.use({ database: 'reset-per-file' });
//
//   test('the lender sees the file the borrower submitted', async ({ lenderPage }) => {
//     await lenderPage.goto('/lender/queue');
//     ...
//   });

/// <reference types="node" />

import { existsSync } from 'node:fs';

import {
  test as base,
  expect,
  type Browser,
  type ConsoleMessage,
  type Page,
} from '@playwright/test';

import { refreshStorageStates, storageStatePath } from './auth';
import { resetDatabase } from './database';
import { readLocalStack, type LocalStack } from './stack';
import type { Role } from './accounts';

/**
 * How a spec file wants the database.
 *
 * `reset-per-file` is the default and the documented policy (see
 * database.ts).  `shared` is for a file that asserts nothing about data and
 * therefore should not pay a second to prove it; it is a claim the file makes
 * about itself, at the top, in one visible line.
 */
export type DatabasePolicy = 'reset-per-file' | 'shared';

interface Options {
  readonly database: DatabasePolicy;
  /**
   * A console error is a defect until someone argues otherwise, so the guard is
   * on by default.  A file that is deliberately provoking one turns it off and
   * says why in a comment next to the line.
   */
  readonly failOnConsoleError: boolean;
}

interface WorkerFixtures {
  readonly stack: LocalStack;
  /** Worker-scoped memory of which spec file was last reset. */
  readonly resetLedger: { lastSpecFile: string | null };
}

interface TestFixtures {
  /** Auto: applies the file's database policy. */
  readonly seededDatabase: void;
  readonly borrowerPage: Page;
  readonly lenderPage: Page;
  readonly growerPage: Page;
}

/** Collected so a failure names the message, not just the fact of one. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      problems.push(`console.error: ${message.text()}`);
    }
  });
  // An uncaught exception never reaches page.on('console') in every browser, and
  // it is the more serious of the two, so it is listened for separately.
  page.on('pageerror', (error: Error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  return problems;
}

async function reportConsole(
  problems: readonly string[],
  failOnConsoleError: boolean,
  label: string,
): Promise<void> {
  if (problems.length === 0) {
    return;
  }
  const detail = problems.join('\n');
  if (!failOnConsoleError) {
    return;
  }
  expect(
    problems,
    `${label} logged ${problems.length} browser error(s). ` +
      `If this is expected, set failOnConsoleError to false in this file and say why.\n${detail}`,
  ).toEqual([]);
}

export const test = base.extend<Options & TestFixtures, WorkerFixtures>({
  database: ['reset-per-file', { option: true }],
  failOnConsoleError: [true, { option: true }],

  stack: [
    async ({}, use) => {
      await use(readLocalStack());
    },
    { scope: 'worker' },
  ],

  resetLedger: [
    async ({}, use) => {
      await use({ lastSpecFile: null });
    },
    { scope: 'worker' },
  ],

  // Per FILE, which Playwright has no scope for: worker scope is too coarse (a
  // worker runs many files) and test scope is too fine.  The ledger closes the
  // gap by remembering which file the worker last reset for.  This is only
  // correct while fullyParallel is false, which is why the config says so and
  // why this comment names the coupling: with tests inside a file spread across
  // workers, a file would be reset several times and mid-file.
  seededDatabase: [
    async ({ database, resetLedger, stack, baseURL }, use, testInfo) => {
      if (database === 'reset-per-file' && resetLedger.lastSpecFile !== testInfo.file) {
        if (baseURL === undefined) {
          throw new Error('baseURL is not configured; the re-issued sessions are origin-scoped');
        }
        resetDatabase();
        // The reset deletes auth.users and the cascade takes auth.sessions with
        // it, so the tokens the setup project saved are now refused. Re-issue
        // them here, where the invalidation happens, rather than leaving every
        // journey to discover it as a mysterious 403. See fixtures/auth.ts.
        await refreshStorageStates(stack, baseURL);
        resetLedger.lastSpecFile = testInfo.file;
      }
      await use();
    },
    { auto: true },
  ],

  // The default page, wrapped so that the console guard applies to it too.
  page: async ({ page, failOnConsoleError }, use) => {
    const problems = watchConsole(page);
    await use(page);
    await reportConsole(problems, failOnConsoleError, 'the page');
  },

  // seededDatabase is destructured, not used: it is how a fixture declares
  // "after that one". A context built from a session file the reset is about to
  // overwrite would be signed in to a user that no longer exists.
  borrowerPage: async ({ browser, failOnConsoleError, seededDatabase }, use) => {
    void seededDatabase;
    await useRolePage(browser, 'borrower', failOnConsoleError, use);
  },
  lenderPage: async ({ browser, failOnConsoleError, seededDatabase }, use) => {
    void seededDatabase;
    await useRolePage(browser, 'lender', failOnConsoleError, use);
  },
  growerPage: async ({ browser, failOnConsoleError, seededDatabase }, use) => {
    void seededDatabase;
    await useRolePage(browser, 'grower', failOnConsoleError, use);
  },
});

/**
 * One browser context per role, so two roles can be open in one test with two
 * separate cookie jars and two separate localStorages.  That is the point of
 * the plan's "two roles, two truths" test, and it is why the roles are fixtures
 * rather than a project-level storageState (a project can hold one role only).
 */
async function useRolePage(
  browser: Browser,
  role: Role,
  failOnConsoleError: boolean,
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const statePath = storageStatePath(role);
  if (!existsSync(statePath)) {
    throw new Error(
      `no saved session for ${role}. The "setup" project writes it; run the suite without ` +
        `--no-deps, or run "playwright test --project setup" first.`,
    );
  }
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();
  const problems = watchConsole(page);
  try {
    await use(page);
    await reportConsole(problems, failOnConsoleError, `the ${role} page`);
  } finally {
    await context.close();
  }
}

/**
 * A fixed wall clock, for anything that renders a date or an expiry.
 *
 * Not applied globally, and that is a judgement worth recording: the saved
 * sessions carry a JWT with an `exp` a hour out, so a browser frozen at an
 * arbitrary instant would consider itself signed out or would refuse to refresh.
 * A spec that needs determinism in dates calls this after the page exists, with
 * a time close to now.
 */
export async function freezeClock(page: Page, when: Date): Promise<void> {
  await page.clock.setFixedTime(when);
}

export { expect };
