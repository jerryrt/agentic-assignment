import type { Routes } from '@angular/router';

import { roleGuard } from '../../core/auth/auth.guards.ts';
import { DocumentPackStore } from './document-pack.store.ts';
import { HttpDocumentIntake } from './http-intake.ts';
import { DOCUMENT_INTAKE } from './intake.ts';

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
    providers: [
      DocumentPackStore,
      // The real intake replaces the refusing stub in ./intake.ts. Provided
      // here rather than at the root so a test can supply its own by
      // overriding one route's providers, which is the reason the seam is a
      // token rather than a direct import.
      { provide: DOCUMENT_INTAKE, useClass: HttpDocumentIntake },
    ],
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Your documents',
        loadComponent: () => import('./pack.page.ts').then((m) => m.DocumentPackPage),
      },
      /**
       * The lender's review of the same pack.
       *
       * `roleGuard` shapes navigation only. What actually keeps a borrower out
       * is that `accept` and `reject` are lender-only on the machine and
       * POST /api/transition re-checks the actor's role server-side; the guard
       * is here so a borrower who follows the URL is told, rather than shown
       * two buttons that will be refused.
       */
      {
        path: 'review',
        title: 'Document review',
        canActivate: [roleGuard('lender', 'admin')],
        loadComponent: () => import('./review.page.ts').then((m) => m.DocumentReviewPage),
      },
    ],
  },
];
