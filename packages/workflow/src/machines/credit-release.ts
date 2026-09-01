import { CREDIT_RELEASE_STATES } from '@lj/domain';
import type { CreditReleaseState } from '@lj/domain';

import type { CreditReleaseGuardContext } from '../context.js';
import { defineMachine } from '../engine.js';
import { requireRules } from '../guards.js';

/**
 * Option 3: a draw against an existing facility.
 *
 * It reads like a small application on purpose -- draft, review, decision,
 * money -- but it is a separate machine because it is a separate subject with a
 * separate lifetime: a loan has many releases, and the application that created
 * the loan is long since `funded`.
 *
 * The one guard is the one invariant: a release may not exceed the undrawn
 * balance. It is checked here, and again in the ledger when the disbursement is
 * posted, because the balance can move between submission and approval.
 */

export const CREDIT_RELEASE_EVENTS = [
  'submit',
  'begin_review',
  'approve',
  'decline',
  'disburse',
  'cancel',
] as const;

export type CreditReleaseEvent = (typeof CREDIT_RELEASE_EVENTS)[number];

export const creditReleaseMachine = defineMachine<
  CreditReleaseState,
  CreditReleaseEvent,
  CreditReleaseGuardContext
>({
  id: 'credit_release',
  initial: 'draft',
  states: CREDIT_RELEASE_STATES,
  transitions: [
    {
      from: 'draft',
      event: 'submit',
      to: 'submitted',
      actor: ['borrower'],
      guard: (context) =>
        requireRules('the request exceeds available credit', context.availableCredit),
    },
    { from: 'submitted', event: 'begin_review', to: 'under_review', actor: ['lender'] },
    { from: 'under_review', event: 'approve', to: 'approved', actor: ['lender'] },
    { from: 'under_review', event: 'decline', to: 'declined', actor: ['lender'] },
    {
      from: 'approved',
      event: 'disburse',
      to: 'funded',
      actor: ['lender'],
      effects: [{ kind: 'post_ledger_entry' }],
    },
    /**
     * Cancellable while it is still with the lender, and not from `draft`: an
     * unsubmitted draft is deleted, not cancelled, and a cancelled record that
     * was never seen by anyone is noise in the borrower's timeline.
     */
    { from: ['submitted', 'under_review'], event: 'cancel', to: 'cancelled', actor: ['borrower'] },
  ],
});
