import type { Routes } from '@angular/router';

import { DocumentPackStore } from './document-pack.store.ts';

/**
 * `/apply/:id/documents` -- Option 1's screens.
 *
 * `DocumentPackStore` is provided on the pathless route below rather than at
 * the root (plan/07), so one instance serves every screen under this URL and
 * it dies when the visitor leaves the application. Two stores over one pack
 * would be two answers to "is this complete".
 *
 * The application id comes from the parameter in `app.routes.ts` and reaches
 * both pages through `withComponentInputBinding()`: every route between the
 * one that declares `:id` and the one that renders a component is
 * component-less, and Angular's default `emptyOnly` inheritance passes
 * parameters down through exactly those.
 *
 * Both components are lazily loaded, so a borrower filling in a form does not
 * download the lender's review screen and a lender does not download the
 * upload controls.
 */
export const DOCUMENTS_ROUTES: Routes = [
  {
    path: '',
    providers: [DocumentPackStore],
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Your documents',
        loadComponent: () => import('./pack.page.ts').then((m) => m.DocumentPackPage),
      },
    ],
  },
];
