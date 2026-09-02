/**
 * Profiles: the application-visible half of an `auth.users` row.
 *
 * `role` is what every authorisation decision above this layer keys on, and it
 * is read from here rather than from a JWT claim: the signup trigger in
 * `0001_init.sql` refuses to take a role from the client's metadata, so the
 * profile row is the only statement of it that was not supplied by the user.
 */

import type { DatabaseClient } from '../client.ts';
import type { Database } from '../database.types.ts';
import { unwrapList, unwrapMaybe } from '../errors.ts';

export type Profile = Database['public']['Tables']['profile']['Row'];

/** The `app_role` enum, re-exported from the generated types so it has one definition. */
export type AppRole = Database['public']['Enums']['app_role'];

/** One profile by user id, or `null` if it is absent or not visible. */
export async function getProfile(
  client: DatabaseClient,
  userId: string,
): Promise<Profile | null> {
  return unwrapMaybe(
    'profile.get',
    await client.from('profile').select('*').eq('id', userId).maybeSingle(),
  );
}

/** Everyone attached to one lending organisation. */
export async function listOrganisationProfiles(
  client: DatabaseClient,
  orgId: string,
): Promise<readonly Profile[]> {
  return unwrapList(
    'profile.list-by-org',
    await client.from('profile').select('*').eq('org_id', orgId).order('full_name'),
  );
}
