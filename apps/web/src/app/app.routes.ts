import type { Routes } from '@angular/router';

import { authGuard, roleGuard, signedOutOnlyGuard } from './core/auth/auth.guards.ts';

/**
 * The route table, and the handoff every feature scope depends on.
 *
 * ---------------------------------------------------------------------------
 * HOW A FEATURE REGISTERS ITSELF -- one file, one entry.
 *
 * 1. Write `apps/web/src/app/features/<name>/<name>.routes.ts` exporting a
 *    `Routes` array, and provide the feature's store there rather than at the
 *    root, so it dies when the visitor leaves (plan/07-frontend.md):
 *
 *      export const APPLY_ROUTES: Routes = [
 *        {
 *          path: ':id',
 *          providers: [ApplicationStore],
 *          children: [
 *            { path: '', pathMatch: 'full', redirectTo: 'business' },
 *            { path: ':step', component: ApplyStepPage },
 *          ],
 *        },
 *      ];
 *
 * 2. Add ONE entry to the array below, above the wildcard:
 *
 *      {
 *        path: 'apply',
 *        canActivate: [authGuard],
 *        loadChildren: () => import('./features/apply/apply.routes.ts')
 *          .then((m) => m.APPLY_ROUTES),
 *      },
 *
 * Nothing else in `core/` changes. `loadChildren` is what keeps the feature out
 * of the initial bundle; a `component:` reference here would pull it in whether
 * or not anyone visits it.
 *
 * Two rules that are not negotiable:
 *
 * - **The wildcard stays last.** Angular matches in order, so a route added
 *   below it is unreachable and nothing reports that.
 * - **`/apply/:id/:step` shaped URLs, with the step in the path.** The URL is
 *   the position (plan/03-workflow-engine.md section 4): a refresh restores the
 *   step because the step is in the address bar, and no client state is needed
 *   for that to work. A step held in a store and not in the URL is a step lost
 *   on reload, which is the exact question the brief asks about.
 * ---------------------------------------------------------------------------
 */
export const routes: Routes = [
  {
    path: 'signin',
    title: 'Sign in',
    canActivate: [signedOutOnlyGuard],
    loadComponent: () => import('./core/auth/sign-in.page.ts').then((m) => m.SignInPage),
  },
  {
    path: 'signup',
    title: 'Create an account',
    canActivate: [signedOutOnlyGuard],
    loadComponent: () => import('./core/auth/sign-up.page.ts').then((m) => m.SignUpPage),
  },

  // The borrower root.
  {
    path: '',
    pathMatch: 'full',
    title: 'Your land loans',
    canActivate: [authGuard],
    loadComponent: () => import('./shared/home.page.ts').then((m) => m.HomePage),
  },

  // The lender root: the work queue, and one request opened out of it.
  // `roleGuard` shapes navigation only -- row-level security is what actually
  // keeps a borrower out of this data (see auth.guards.ts), and every decision
  // taken through these screens is re-checked against the machine by
  // POST /api/transition.
  //
  // It replaced `shared/home.page.ts`, which said in its own header that a
  // feature scope would: a placeholder root is indistinguishable from a broken
  // one, and the desk now has work on it.
  {
    path: 'lender',
    canActivate: [authGuard, roleGuard('lender', 'admin')],
    loadChildren: () =>
      import('./features/lender/lender.routes.ts').then((m) => m.LENDER_ROUTES),
  },

  // ---- FEATURE ROUTES GO HERE, above the wildcard ----

  /**
   * Option 1's document pack, at the URL plan/04 fixes.
   *
   * It sits ABOVE `apply` and that placement is load-bearing: routes match in
   * order, and `apply/:id/:step` below would otherwise swallow
   * `/apply/x/documents` as a step named "documents" and the step guard would
   * redirect it. Three literal-and-parameter segments are more specific than
   * two, so declaring it first is what makes the more specific one win.
   *
   * Component-less, like every `loadChildren` entry here, so `:id` is
   * inherited by the components underneath it.
   */
  {
    path: 'apply/:id/documents',
    canActivate: [authGuard],
    loadChildren: () =>
      import('./features/documents/documents.routes.ts').then((m) => m.DOCUMENTS_ROUTES),
  },

  {
    path: 'apply',
    canActivate: [authGuard],
    loadChildren: () => import('./features/apply/apply.routes.ts').then((m) => m.APPLY_ROUTES),
  },

  /**
   * Option 3's borrower screens: the loans, one loan, and one credit request.
   *
   * `/loans/:id/release/:rid` carries the request id in the URL because the URL
   * is the position (plan/03 section 4): the row is created while it is still
   * being composed, the address bar is replaced with its id, and a refresh from
   * that moment re-reads rather than restoring. `new` is a value of `:rid`
   * rather than a route of its own, so the component -- and the half-typed form
   * in it -- survives that replacement.
   */
  {
    path: 'loans',
    canActivate: [authGuard],
    loadChildren: () =>
      import('./features/servicing/servicing.routes.ts').then((m) => m.SERVICING_ROUTES),
  },

  {
    path: '**',
    title: 'Page not found',
    loadComponent: () => import('./shared/not-found.page.ts').then((m) => m.NotFoundPage),
  },
];
