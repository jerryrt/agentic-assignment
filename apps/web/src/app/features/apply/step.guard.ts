import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { applicationStepIndex, isApplicationStep } from '@lj/domain';

import { ApplicationStore } from './application.store.ts';

/**
 * "You cannot deep-link past where you have got to."
 *
 * The step is in the URL because the URL is the position
 * (plan/03-workflow-engine.md section 4), and the price of that is that anyone
 * can type `/apply/<id>/request` on a form they started five minutes ago. This
 * guard is the answer: it reads `furthest_step`, which the store advances as
 * each step is completed, and sends a link beyond it back to where the
 * applicant actually is.
 *
 * It is NOT a security control and nothing here pretends otherwise. Every step
 * of one application shows the same row, which row-level security already
 * decides the applicant may read; jumping ahead reveals nothing. What it
 * prevents is a worse experience -- landing on step four of a form whose first
 * three steps are empty, with an eligibility panel that cannot say anything.
 *
 * The store is opened here rather than in the component so that the decision is
 * made against the server's `furthest_step` and not against a default. `open`
 * is safe to call again: the shell calls it too, and a second read would drop
 * the applicant's unsaved typing.
 */
export const applyStepGuard: CanActivateFn = async (route) => {
  const router = inject(Router);
  const store = inject(ApplicationStore);

  const applicationId = route.parent?.paramMap.get('id') ?? null;
  if (applicationId === null) {
    return router.parseUrl('/apply');
  }

  const step = route.paramMap.get('step') ?? '';
  if (!isApplicationStep(step)) {
    return router.parseUrl('/apply/' + applicationId + '/borrower');
  }

  await store.open(applicationId);

  // An application that could not be read has no furthest step, and
  // redirecting on that default would bounce the applicant to step one and
  // hide the reason. The shell renders the failure instead.
  if (store.status() === 'error') {
    return true;
  }

  const furthest = store.furthestStep();
  if (applicationStepIndex(step) > applicationStepIndex(furthest)) {
    return router.parseUrl('/apply/' + applicationId + '/' + furthest);
  }
  return true;
};
