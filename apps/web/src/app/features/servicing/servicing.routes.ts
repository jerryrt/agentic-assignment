import type { Routes } from '@angular/router';

import { LoanStore } from './loan.store.ts';
import { ReleaseStore } from './release.store.ts';

/**
 * `/loans` -- Option 3's borrower screens, at the URLs plan/06 fixes.
 *
 * `LoanStore` is provided on the `:id` route and not at the root (plan/07), so
 * the loan screen and the release screen under it share ONE instance. That is
 * the point rather than an optimisation: the figure a request is measured
 * against is then the figure the loan screen displayed, by construction, and it
 * dies when the borrower leaves the loan so nothing of one file bleeds into the
 * next.
 *
 * `ReleaseStore` is provided one level further down, on the release route, and
 * it injects `LoanStore` from the parent injector. A second store reading the
 * same balance would be a second answer to "what is available", which is the
 * failure this option exists to demonstrate the absence of.
 *
 * THE RELEASE ID IS A PARAMETER, AND `new` IS ONE OF ITS VALUES. A separate
 * `release/new` route would be a different route configuration, so Angular
 * would destroy and re-create the component when the row was created and the
 * URL changed -- throwing away the sentence being typed at that moment. One
 * route keeps the instance and the form across the replacement.
 *
 * Every component is lazily loaded: a lender working through their queue does
 * not download the borrower's compose form.
 */
export const SERVICING_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Your land loans',
    loadComponent: () => import('./loan-list.page.ts').then((m) => m.LoanListPage),
  },
  {
    path: ':id',
    providers: [LoanStore],
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Your loan',
        loadComponent: () => import('./loan.page.ts').then((m) => m.LoanPage),
      },
      {
        path: 'release/:rid',
        providers: [ReleaseStore],
        title: 'Credit request',
        loadComponent: () => import('./release.page.ts').then((m) => m.ReleasePage),
      },
    ],
  },
];
