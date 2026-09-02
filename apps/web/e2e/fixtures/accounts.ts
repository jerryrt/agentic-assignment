// The seeded demo accounts, named once.
//
// These are the rows supabase/migrations/0004_demo_data.sql writes into auth.users.  The suite uses
// them rather than signing up fresh users, because the seed is where the
// INTERESTING states live -- a draft stopped mid-form, an application waiting on
// a lender, a decision only the lender may read -- and a freshly created user
// owns none of them.  The one place that must still sign up is the auth journey
// itself, which is testing signup.
//
// The password below is published in supabase/migrations/0004_demo_data.sql, under a banner saying
// the file must never reach a hosted project.  It is a local-stack demo
// credential, not a secret, and repeating it here would still be a second copy
// of a value with one owner -- so assertSeedMatches() checks the copy against
// the file at run time and fails loudly instead of failing as "invalid login
// credentials" three fixtures later.

/// <reference types="node" />

import { readFileSync } from 'node:fs';

import { repoRoot } from './stack';

export type Role = 'borrower' | 'lender' | 'grower';

export interface Account {
  readonly role: Role;
  readonly email: string;
  /** The profile id, which is also the auth.users id. Handy for RLS assertions. */
  readonly id: string;
  /** What this account is for, so a journey picks the right one. */
  readonly holds: string;
}

/** Identical for every seeded account, on purpose. See supabase/migrations/0004_demo_data.sql. */
export const SEEDED_PASSWORD = 'demo-only-not-a-secret';

export const ACCOUNTS: Readonly<Record<Role, Account>> = {
  borrower: {
    role: 'borrower',
    email: 'borrower@example.test',
    id: '00000000-0000-4000-8000-0000000000c2',
    holds: 'a draft stopped mid-form and an approved application',
  },
  lender: {
    role: 'lender',
    email: 'lender@example.test',
    id: '00000000-0000-4000-8000-0000000000c1',
    holds: 'the lender side of Meadowbank Agricultural Credit, including the private decision row',
  },
  grower: {
    role: 'grower',
    email: 'grower@example.test',
    id: '00000000-0000-4000-8000-0000000000c3',
    holds: 'one application under review, so a second borrower exists to be isolated from',
  },
};

export const SEED_PATH = `${repoRoot}supabase/migrations/0004_demo_data.sql`;

/**
 * Fails if this file and the seed have drifted.
 *
 * Cheap enough to run in the setup project, and it converts the whole class of
 * "the seed was edited and every test now fails at login" into one sentence
 * naming the file to fix.
 */
export function assertSeedMatches(): void {
  const seed = readFileSync(SEED_PATH, 'utf8');
  if (!seed.includes(`crypt('${SEEDED_PASSWORD}'`)) {
    throw new Error(
      `supabase/migrations/0004_demo_data.sql no longer hashes the password this suite uses. ` +
        `Update SEEDED_PASSWORD in apps/web/e2e/fixtures/accounts.ts to match the seed.`,
    );
  }
  for (const account of Object.values(ACCOUNTS)) {
    if (!seed.includes(account.email)) {
      throw new Error(
        `supabase/migrations/0004_demo_data.sql no longer seeds ${account.email}. ` +
          `Update ACCOUNTS in apps/web/e2e/fixtures/accounts.ts to match the seed.`,
      );
    }
    if (!seed.includes(account.id)) {
      throw new Error(
        `supabase/migrations/0004_demo_data.sql no longer seeds the id recorded for ${account.email}. ` +
          `Update ACCOUNTS in apps/web/e2e/fixtures/accounts.ts to match the seed.`,
      );
    }
  }
}
