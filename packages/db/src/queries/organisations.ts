/** Lending organisations.  The tenant boundary every lender policy is written against. */

import type { DatabaseClient } from '../client.js';
import type { Database } from '../database.types.js';
import { unwrapMaybe } from '../errors.js';

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
