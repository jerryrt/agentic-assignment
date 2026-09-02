import { InjectionToken, type Provider } from '@angular/core';
import type { DatabaseClient } from '@lj/db';
import { createAnonClient } from '@lj/db';

import { SUPABASE_CONFIG, type SupabaseConfigResult } from '../config/supabase-config.ts';

/**
 * The browser's one Supabase client, and how a feature obtains it.
 *
 * `core/api/api-client.ts` is deliberately POST-only and says why: reads go
 * straight to Supabase under row-level security, through the query helpers in
 * `@lj/db`. What was missing was any way for a feature to hold a client,
 * because the only one in the browser was private to `SupabaseAuthService` and
 * `features/` may not reach into `core/`.
 *
 * A feature calling `createAnonClient` for itself would be a second GoTrue
 * client persisting a second copy of the session, and the failure is the one
 * nobody reproduces: whichever of the two refreshed last holds a token the
 * other has already replaced. `createAnonClientForAccessToken` is worse again
 * -- it neither persists nor refreshes, by design, so a store built on one
 * stops working an hour into a sitting.
 *
 * So the construction lives here, once, and `SupabaseAuthService` injects it
 * rather than owning it. A feature injects the token and passes it to a query
 * helper:
 *
 *     private readonly client = inject(DATABASE_CLIENT);
 *     ...
 *     if (this.client === null) { ... }
 *     const row = await getBorrowerApplication(this.client, id);
 *
 * **Null is a real answer, not an oversight.** A build that carried no
 * Supabase configuration has no client, and throwing here would take the whole
 * application down and report the cause to a console nobody has open. The
 * sign-in screen renders the explanation instead; a feature that finds null
 * says it cannot reach the database and stops.
 *
 * The anon key is publishable and the row policies are the boundary
 * (CLAUDE.md section 10). Nothing in this file can reach the service role key:
 * `@lj/db`'s barrel does not re-export that module, so a bundler following
 * this import graph never sees it.
 */
export const DATABASE_CLIENT = new InjectionToken<DatabaseClient | null>('lj.database-client');

function clientFor(result: SupabaseConfigResult): DatabaseClient | null {
  return result.ok ? createAnonClient(result.config) : null;
}

export function provideDatabaseClient(): Provider {
  return { provide: DATABASE_CLIENT, useFactory: clientFor, deps: [SUPABASE_CONFIG] };
}
