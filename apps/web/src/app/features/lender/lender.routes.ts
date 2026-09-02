import type { Routes } from '@angular/router';

import { QueueStore } from './queue.store.ts';
import { ReviewStore } from './review.store.ts';

/**
 * `/lender` -- the lending desk, which is now the queue rather than a
 * placeholder.
 *
 * `/lender` itself redirects to `/lender/queue` rather than rendering it. The
 * queue is a page with a URL of its own, so a lender can bookmark it, link to
 * it and come back to it; a root that rendered the queue directly would give
 * one screen two addresses, and the second one is the one that gets stale in
 * somebody's bookmarks.
 *
 * Each store is provided on the route that needs it, not at the root
 * (plan/07), so the queue's unfiltered subscription dies when the lender opens
 * a request and a request's file dies when they go back. Two open channels for
 * two screens that are never both mounted is a websocket doing nothing.
 *
 * Both components are lazily loaded: a borrower filling in a form does not
 * download the lending desk.
 */
export const LENDER_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'queue' },
  {
    path: 'queue',
    providers: [QueueStore],
    title: 'Lending queue',
    loadComponent: () => import('./queue.page.ts').then((m) => m.LenderQueuePage),
  },
  {
    path: 'release/:rid',
    providers: [ReviewStore],
    title: 'Credit request',
    loadComponent: () => import('./review.page.ts').then((m) => m.LenderReviewPage),
  },
];
