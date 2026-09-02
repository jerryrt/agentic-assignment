import type { ApplicationConfig } from '@angular/core';
import {
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { provideSupabaseConfig } from './core/config/supabase-config.ts';
import { provideDatabaseClient } from './core/data/database-client.ts';
import { routes } from './app.routes.ts';

/**
 * What the application is wired with, and why each line is here.
 *
 * `withComponentInputBinding()` is the one that carries weight. It binds route
 * parameters straight to component inputs, so `/apply/:id/:step` arrives as
 * `id()` and `step()` with no subscription and no manual wiring -- which is what
 * makes "the URL is the position" cheap enough that nobody is tempted to keep
 * the step in a store instead (plan/03-workflow-engine.md section 4).
 *
 * `provideZonelessChangeDetection()` because the state model is signals
 * (plan/07-frontend.md): with no zone, change detection runs when a signal
 * a template read actually changes, rather than after every timer and every
 * event anywhere in the page. It also removes zone.js from the bundle and stops
 * `async`/`await` in a service from being invisible to change detection, which
 * is the failure mode that makes people reach for `detectChanges()`.
 *
 * `withInMemoryScrolling` restores the scroll position on a back navigation.
 * Cheap, and its absence is one of those things nobody reports and everybody
 * notices.
 *
 * `provideSupabaseConfig()` reads what the build baked in. It is a provider
 * rather than a module-level constant so a test can supply its own environment
 * without touching the build (see core/config/supabase-config.ts).
 *
 * `provideDatabaseClient()` builds the one Supabase client from it. One, so
 * that one session is persisted and refreshed: the auth service and every
 * feature store share it (see core/data/database-client.ts).
 *
 * There is no `provideHttpClient` here. `@lj/db` speaks to Supabase over its own
 * fetch, and `core/api` uses `fetch` directly, so adding Angular's HTTP client
 * would ship a second HTTP stack that nothing calls. Add it when something
 * needs interceptors, not before.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideSupabaseConfig(),
    provideDatabaseClient(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
    ),
  ],
};
