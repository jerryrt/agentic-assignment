import type { Routes } from '@angular/router';

import { ApplicationStore } from './application.store.ts';
import { applyStepGuard } from './step.guard.ts';

/**
 * `/apply` -- the borrower's applications, and one of them being filled in.
 *
 * `ApplicationStore` is provided HERE, on the `:id` route, and not at the root
 * (plan/07). Two consequences, and both are the reason:
 *
 *   - the shell, the four steps and the route guard all inject the same
 *     instance, so the guard decides against the same payload the form holds;
 *   - it is destroyed when the applicant leaves this application, so nothing of
 *     one file can bleed into the next.
 *
 * The step is a route parameter rather than a store field because the URL is
 * the position (plan/03-workflow-engine.md section 4). A step held in a store
 * and not in the address bar is a step lost on reload, which is the exact
 * question the brief asks about.
 *
 * Every component is lazily loaded: the four steps together are the largest
 * feature in the app, and `loadComponent` keeps them out of the bundle a lender
 * downloads to look at their queue.
 */
export const APPLY_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Your applications',
    loadComponent: () =>
      import('./application-list.page.ts').then((m) => m.ApplicationListPage),
  },
  {
    path: ':id',
    providers: [ApplicationStore],
    loadComponent: () => import('./apply-shell.page.ts').then((m) => m.ApplyShellPage),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'borrower' },
      {
        path: ':step',
        title: 'Your application',
        canActivate: [applyStepGuard],
        loadComponent: () => import('./step.page.ts').then((m) => m.ApplyStepPage),
      },
    ],
  },
];
