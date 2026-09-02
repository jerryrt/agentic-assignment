import { inject } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import type { AppRole } from '@lj/domain';

import { SupabaseAuthService } from './auth.service.ts';

/**
 * Navigation guards.
 *
 * READ THIS BEFORE RELYING ON ONE FOR ANYTHING.
 *
 * These guards decide what to *render*. They are not an authorisation
 * boundary and they cannot be one: every check below runs in the browser,
 * against state the browser holds, in code the visitor can edit. Deleting
 * `roleGuard` from a route in devtools gets you the lender screen; it does not
 * get you a single lender row, because row-level security refuses the read
 * (supabase/migrations/0002_rls.sql) and `POST /api/transition` re-checks the
 * actor's role against the machine definition before it writes anything
 * (CLAUDE.md section 10).
 *
 * They exist because showing someone a screen that will refuse every query is
 * worse than not showing it, not because they keep anyone out. The moment a
 * guard here is the only thing standing between a role and some data, that
 * data is public. Say so in the review rather than adding a check here.
 */

/** Where an unauthenticated visitor is sent, and where they come back from. */
export const SIGN_IN_PATH = '/signin';

/** The query parameter carrying the URL the visitor originally asked for. */
export const RETURN_TO_PARAM = 'next';

/**
 * The root each role lands on.
 *
 * One function rather than a conditional in three templates: "borrower and
 * lender see different roots" is a routing rule, and a rule with three copies
 * is three rules (CLAUDE.md section 9). A feature scope that adds the lender
 * queue changes the string here and nowhere else.
 */
export function roleHomePath(role: AppRole | null): string {
  return role === 'borrower' || role === null ? '/' : '/lender';
}

function signInRedirect(router: Router, returnTo: string): UrlTree {
  return router.createUrlTree([SIGN_IN_PATH], { queryParams: { [RETURN_TO_PARAM]: returnTo } });
}

/**
 * Admit a signed-in visitor; send anyone else to sign in, remembering where
 * they were going so the deep link survives the detour.
 */
export const authGuard: CanActivateFn = async (_route, state): Promise<boolean | UrlTree> => {
  const auth = inject(SupabaseAuthService);
  const router = inject(Router);

  // Decide against a session that has actually been read. Deciding before the
  // restore completes renders the signed-out branch on every reload and then
  // corrects itself, which reads to the user as having been logged out.
  await auth.whenReady();

  return auth.isSignedIn() ? true : signInRedirect(router, state.url);
};

/**
 * Admit one of the named roles.
 *
 * An unknown role -- the profile has not been read, or the read failed -- is
 * refused rather than defaulted. Defaulting to the least-privileged role would
 * look safe and would hide the difference between "not a lender" and "we do not
 * know yet", which is the state a transient network error leaves behind.
 */
export function roleGuard(...allowed: readonly AppRole[]): CanActivateFn {
  return async (_route, state): Promise<boolean | UrlTree> => {
    const auth = inject(SupabaseAuthService);
    const router = inject(Router);

    await auth.whenReady();

    if (!auth.isSignedIn()) {
      return signInRedirect(router, state.url);
    }

    const role = auth.role();
    if (role !== null && allowed.includes(role)) {
      return true;
    }

    // Home, not an error page: someone who followed a stale link is lost, not
    // hostile, and the data is protected by the policies either way.
    return router.parseUrl(roleHomePath(role));
  };
}

/**
 * Keep a signed-in visitor off the sign-in and signup screens.
 *
 * Without it, "sign in" stays reachable from history after a login and offers a
 * form that will either fail or silently replace the session -- neither of which
 * is what the person clicking back expected.
 */
export const signedOutOnlyGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const auth = inject(SupabaseAuthService);
  const router = inject(Router);

  await auth.whenReady();

  return auth.isSignedIn() ? router.parseUrl(roleHomePath(auth.role())) : true;
};
