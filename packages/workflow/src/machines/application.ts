import { APPLICATION_STATES } from '@lj/domain';
import type { ApplicationState } from '@lj/domain';

import type { ApplicationGuardContext } from '../context.ts';
import { defineMachine } from '../engine.ts';
import { requireAll, requireRules } from '../guards.ts';

/**
 * Option 2 into Option 1 into funding: the application's life, as the state
 * diagram in plan/03-workflow-engine.md draws it.
 *
 * `funded` is terminal here and is the hand-off point. Funding creates a `loan`
 * row and Option 3's machines take over from there -- two machines with one
 * seam, rather than one machine that sprawls across the whole product.
 */

export const APPLICATION_EVENTS = [
  'submit',
  'request_docs',
  'begin_review',
  'approve',
  'decline',
  'request_info',
  'resubmit',
  'fund',
  'withdraw',
] as const;

export type ApplicationEvent = (typeof APPLICATION_EVENTS)[number];

export const applicationMachine = defineMachine<
  ApplicationState,
  ApplicationEvent,
  ApplicationGuardContext
>({
  id: 'application',
  initial: 'draft',
  states: APPLICATION_STATES,
  transitions: [
    /**
     * Submitting records what the borrower was told.
     *
     * A product's criteria are content and they change; a decision made under
     * the old ones has to stay explicable afterwards, so the evaluated
     * eligibility is written out as it stood at this instant
     * (plan/05-option2-application.md). It is declared here rather than written
     * inline by the handler for the reason every effect is declared: the
     * browser reads the machine too, so "submitting records your eligibility"
     * is legible before the round trip, from the definition the server runs.
     */
    {
      from: 'draft',
      event: 'submit',
      to: 'submitted',
      actor: ['borrower'],
      guard: (context) =>
        requireAll([
          requireRules('the application is not complete', context.completeness),
          requireRules('no product matches this application', context.eligibility),
        ]),
      effects: [{ kind: 'write_eligibility_snapshot' }],
    },
    { from: 'submitted', event: 'request_docs', to: 'docs_pending', actor: ['lender'] },
    {
      from: 'docs_pending',
      event: 'begin_review',
      to: 'under_review',
      actor: ['lender'],
      guard: (context) =>
        requireRules('the document pack is not complete', context.documentPack),
    },
    { from: 'under_review', event: 'approve', to: 'approved', actor: ['lender'] },
    { from: 'under_review', event: 'decline', to: 'declined', actor: ['lender'] },
    {
      from: 'under_review',
      event: 'request_info',
      to: 'needs_borrower_action',
      actor: ['lender'],
    },
    {
      from: 'needs_borrower_action',
      event: 'resubmit',
      to: 'under_review',
      actor: ['borrower'],
    },
    {
      from: 'approved',
      event: 'fund',
      to: 'funded',
      actor: ['lender'],
      effects: [{ kind: 'create_loan' }],
    },
    /**
     * One transition, four origins. A borrower may walk away at any point
     * before a decision has been made; writing the four separately is four
     * places to forget when a fifth pre-decision state appears.
     */
    {
      from: ['draft', 'submitted', 'docs_pending', 'needs_borrower_action'],
      event: 'withdraw',
      to: 'withdrawn',
      actor: ['borrower'],
    },
  ],
});
