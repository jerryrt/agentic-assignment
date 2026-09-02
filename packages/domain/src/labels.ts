import type { AppRole } from './roles.ts';
import type { ApplicationState, CreditReleaseState } from './states.ts';

/**
 * "Two roles, two truths" (plan 02), at the vocabulary layer.
 *
 * One `state` value reads differently depending on who is looking at it:
 * `under_review` is "With your lender" to the borrower and "Awaiting your
 * decision" to the lender. Both are true. The mapping lives here, once, because
 * a status string hardcoded in a template is a blank cell waiting for the next
 * state to be added (CLAUDE.md section 9).
 *
 * StateLabelMap is a mapped type with no optional modifier, so a state added to
 * one of the unions in states.ts and forgotten here does not render as an empty
 * string in production -- it fails `tsc`. That is the whole point of writing
 * the maps this way rather than as Record<string, ...> or a lookup with a
 * fallback: a fallback would make the omission invisible, which is exactly the
 * bug being designed out.
 */

export const LABEL_AUDIENCES = ['borrower', 'lender'] as const;

export type LabelAudience = (typeof LABEL_AUDIENCES)[number];

export type AudienceLabels = { readonly [A in LabelAudience]: string };

export type StateLabelMap<S extends string> = { readonly [K in S]: AudienceLabels };

/**
 * An admin reads the lender vocabulary. They are on the lending side of the
 * file and need the operational reading ("awaiting your decision"), not the
 * reassuring one; inventing a third vocabulary would be two more strings per
 * state for an audience of one.
 */
export function audienceForRole(role: AppRole): LabelAudience {
  return role === 'borrower' ? 'borrower' : 'lender';
}

export const APPLICATION_STATE_LABELS: StateLabelMap<ApplicationState> = {
  draft: { borrower: 'Draft', lender: 'Draft -- not yet submitted' },
  submitted: { borrower: 'Submitted', lender: 'New -- awaiting triage' },
  docs_pending: { borrower: 'Documents needed', lender: 'Awaiting documents' },
  under_review: { borrower: 'With your lender', lender: 'Awaiting your decision' },
  needs_borrower_action: {
    borrower: 'Action needed from you',
    lender: 'Waiting on borrower',
  },
  approved: { borrower: 'Approved', lender: 'Approved -- awaiting funding' },
  declined: { borrower: 'Declined', lender: 'Declined' },
  funded: { borrower: 'Funded', lender: 'Funded' },
  withdrawn: { borrower: 'Withdrawn', lender: 'Withdrawn by borrower' },
};

export const CREDIT_RELEASE_STATE_LABELS: StateLabelMap<CreditReleaseState> = {
  draft: { borrower: 'Draft', lender: 'Draft -- not yet submitted' },
  submitted: {
    borrower: 'Submitted -- with your lender',
    lender: 'New request -- awaiting triage',
  },
  under_review: { borrower: 'Under review', lender: 'In review' },
  approved: { borrower: 'Approved -- awaiting disbursement', lender: 'Approved -- ready to disburse' },
  declined: { borrower: 'Declined', lender: 'Declined' },
  funded: { borrower: 'Disbursed', lender: 'Disbursed' },
  cancelled: { borrower: 'Cancelled', lender: 'Cancelled by borrower' },
};

export function applicationStateLabel(state: ApplicationState, audience: LabelAudience): string {
  return APPLICATION_STATE_LABELS[state][audience];
}

export function creditReleaseStateLabel(
  state: CreditReleaseState,
  audience: LabelAudience,
): string {
  return CREDIT_RELEASE_STATE_LABELS[state][audience];
}
