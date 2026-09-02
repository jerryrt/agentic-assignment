/**
 * Who is asking, established server-side and nowhere else.
 *
 * The role never comes from the request. It comes from the caller's `profile`
 * row, which is the only statement of it the caller did not write: the signup
 * trigger in `0001_init.sql` refuses to read a role out of the client's signup
 * payload, and `0002_rls.sql` grants `authenticated` update on `full_name`
 * alone, so a borrower cannot promote themselves afterwards either. That pair
 * of decisions is what makes this one lookup trustworthy.
 *
 * The profile is read with a client carrying the caller's own access token, not
 * with the service role. Row-level security is the boundary (CLAUDE.md section
 * 10), and reading the caller's identity through it means the answer is the one
 * Postgres would give -- rather than a claim this layer makes about a row it
 * could reach either way.
 */

import { createAnonClientForAccessToken, getProfile, type DatabaseClient } from '@lj/db';
import { AppRoleSchema, UuidSchema, type AppRole } from '@lj/domain';

import type { ApiEnvironment } from './environment.ts';
import type { TransitionFailureCode } from './http.ts';

export interface Actor {
  readonly id: string;
  readonly role: AppRole;
  /** The lending organisation a lender belongs to. Null for a borrower. */
  readonly orgId: string | null;
  /** Bound to this caller's token, so every read through it obeys the policies. */
  readonly client: DatabaseClient;
}

export type ActorResult =
  | { readonly ok: true; readonly actor: Actor }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: TransitionFailureCode;
      readonly reason: string;
    };

/**
 * The token out of an `Authorization` header, or null.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is
 * case-insensitive, and a client that sends `bearer` is not making a mistake
 * worth a 401 nobody can explain. Nothing about the header is ever logged or
 * echoed: a token in a log is a token that has left the process.
 */
export function bearerToken(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (header === null) {
    return null;
  }
  const match = /^bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

const UNAUTHENTICATED = {
  ok: false,
  status: 401,
  code: 'unauthenticated',
  reason: 'the request carried no access token the auth server recognises',
} as const satisfies ActorResult;

export async function authenticateActor(
  environment: ApiEnvironment,
  token: string,
): Promise<ActorResult> {
  const client = createAnonClientForAccessToken(environment.anon, token);

  // The token is validated by the auth server rather than decoded here. A JWT
  // this process verified itself would be a second implementation of a check
  // GoTrue already owns, and it would not see a revoked session.
  const { data, error } = await client.auth.getUser(token);
  if (error !== null || data.user === null) {
    return UNAUTHENTICATED;
  }

  const userId = UuidSchema.safeParse(data.user.id);
  if (!userId.success) {
    return UNAUTHENTICATED;
  }

  const profile = await getProfile(client, userId.data);
  if (profile === null) {
    // Authenticated, but with no role. `handle_new_user` creates a profile for
    // every signup, so this means the row was removed out of band -- and an
    // actor with no role must not fall back to a default one.
    return {
      ok: false,
      status: 403,
      code: 'no_profile',
      reason: 'this account has no profile, and therefore no role',
    };
  }

  const role = AppRoleSchema.safeParse(profile.role);
  if (!role.success) {
    // The generated types are a claim about the schema, not a check of it.
    return {
      ok: false,
      status: 403,
      code: 'no_profile',
      reason: 'this account carries a role no machine definition recognises',
    };
  }

  return {
    ok: true,
    actor: { id: userId.data, role: role.data, orgId: profile.org_id, client },
  };
}
