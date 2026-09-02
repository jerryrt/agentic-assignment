/** Lending organisations.  The tenant boundary every lender policy is written against. */

import type { DatabaseClient } from '../client.ts';
import type { Database } from '../database.types.ts';
import { unwrapList, unwrapMaybe } from '../errors.ts';

export type Organisation = Database['public']['Tables']['organisation']['Row'];

export async function getOrganisation(
  client: DatabaseClient,
  orgId: string,
): Promise<Organisation | null> {
  return unwrapMaybe(
    'organisation.get',
    await client.from('organisation').select('*').eq('id', orgId).maybeSingle(),
  );
}

/**
 * Every organisation, by name.
 *
 * This is the borrower's counterparty list, and it exists because
 * `application` requires an `org_id` at insert while a borrower's
 * `profile.org_id` is null -- that column is for lenders.  Someone starting an
 * application has to choose who they are applying to, which means the choice
 * has to be listable.
 *
 * `0002_rls.sql` anticipated it: `organisation_read` grants select to every
 * authenticated user, on the grounds that "a borrower who cannot read it
 * cannot be shown who they are applying to".  Nothing confidential lives on
 * this table; when something does, it belongs in a table with a narrower
 * policy rather than a wider one here.
 *
 * Ordered by name because the caller is rendering a chooser, and a list whose
 * order depends on insertion order moves under the reader every time a row is
 * added.
 */
export async function listOrganisations(
  client: DatabaseClient,
): Promise<readonly Organisation[]> {
  return unwrapList(
    'organisation.list',
    await client.from('organisation').select('*').order('name'),
  );
}
