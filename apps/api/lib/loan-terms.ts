/**
 * The facility a funded application becomes: where each of its terms comes
 * from, and what happens when one has nowhere to come from.
 *
 * `create_loan` is declared on `application: approved -> fund -> funded` and had
 * no runner for four phases, so `fund` refused with 501. That refusal was the
 * right shape while it lasted -- an application at `funded` with no loan behind
 * it says money moved when nothing did -- and this file is what replaces it.
 *
 * WHERE THE TERMS COME FROM. All of them from the application, none of them
 * from the request body:
 *
 *   application_id, borrower_id, org_id   the application being funded
 *   product_id                            the product it was made against
 *   approved_limit                        the amount its request step asked for
 *   opened_at, status                     the column defaults: today, active
 *
 * `borrower_id` and `org_id` are denormalised onto the loan (0007_servicing.sql
 * argues why), and they are copied from the subject this handler loaded and
 * checked, never from anything a caller sent. `product_id` goes through
 * `resolveApplicationProduct`, so the checklist the borrower was asked for and
 * the facility they are given come from one product.
 *
 * WHY THE LIMIT IS THE AMOUNT REQUESTED. Nothing in the schema records an
 * approved amount distinct from the requested one: `application_decision`
 * carries a note and a risk grade and no figure, and there is no column
 * anywhere for a counter-offer. So the only figure that exists is the one the
 * borrower asked for, and opening the facility at it is the narrowest reading
 * available. A lender who wants to fund less than was asked for has no way to
 * say so today, and inventing a place for them to say it in the delivery layer
 * would be a policy this layer does not get to make (CLAUDE.md section 8). It
 * is a schema question -- one column on `application_decision` -- and it is
 * raised on the issue rather than answered here.
 *
 * A MISSING FIGURE REFUSES. Every leaf of the payload is nullable, because a
 * draft is partial by definition, so a missing amount parses. It must not
 * become a facility at zero: `approved_limit > 0` would refuse the insert
 * anyway, but by then the application has already moved to `funded`, and the
 * failure this file exists to prevent is exactly a `funded` application with no
 * loan. The refusal therefore happens while the input is being assembled,
 * before the state change, which is where `create_document_slots` refuses too.
 */

import type { DatabaseClient, LoanInsert } from '@lj/db';
import { moneyToNumericString, type ApplicationData, type Money } from '@lj/domain';

import { resolveApplicationProduct } from './application-product.ts';

/**
 * The rate a loan opens at, in the absence of anywhere to read one from.
 *
 * There is no rate in the application payload, none on `loan_product` -- which
 * holds a name, an amount band, eligibility criteria and a document pack -- and
 * none in the decision. `loan.rate_bps` is `not null`, so the row cannot simply
 * omit it, and this delivery layer must not pick a number: a rate is a price,
 * and a price nobody agreed to is worse than a missing one because it is
 * believed and then charged.
 *
 * Zero is the narrowest reading of "no rate has been recorded". It is the only
 * value that cannot overstate what the borrower owes, `rate_bps >= 0` admits
 * it, and nothing computes with it: interest reaches a loan as a ledger entry a
 * lender posts, never as a function of this column. When a rate acquires a
 * source -- a column on the product, or a figure the lender enters with the
 * funding decision -- it is read from there and this constant goes.
 */
const UNRECORDED_RATE_BPS = 0;

/** Everything one `loan` row needs, resolved before the application moves. */
export interface LoanTerms {
  readonly applicationId: string;
  readonly borrowerId: string;
  readonly orgId: string;
  readonly productId: string;
  readonly approvedLimit: Money;
  readonly rateBps: number;
}

/**
 * The terms, or why the funding cannot go ahead.
 *
 * A refusal refuses the whole transition, before the update, exactly as an
 * unreadable document pack does. Every reason names something about the stored
 * application rather than anything the caller sent.
 */
export type LoanTermsResolution =
  | { readonly ok: true; readonly terms: LoanTerms }
  | { readonly ok: false; readonly reason: string };

export async function resolveLoanTerms(
  client: DatabaseClient,
  application: {
    readonly id: string;
    readonly borrowerId: string;
    readonly orgId: string;
  },
  data: ApplicationData,
): Promise<LoanTermsResolution> {
  const resolved = await resolveApplicationProduct(client, application, data);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason + ', so there is no facility to open' };
  }

  const approvedLimit = data.request.amount_requested_minor;
  if (approvedLimit === null) {
    return {
      ok: false,
      reason: 'the application asks for no amount, so there is no limit to open a facility at',
    };
  }
  if (approvedLimit <= 0) {
    // The column refuses this too, but only after the application has moved.
    return {
      ok: false,
      reason: 'the application asks for an amount that is not positive',
    };
  }

  return {
    ok: true,
    terms: {
      applicationId: application.id,
      borrowerId: application.borrowerId,
      orgId: application.orgId,
      productId: resolved.product.id,
      approvedLimit,
      rateBps: UNRECORDED_RATE_BPS,
    },
  };
}

/**
 * The terms as a row.
 *
 * `approved_limit` is rendered as the exact decimal text `numeric(14,2)` wants,
 * per the note on `LoanInsert` in @lj/db: the generated type asks for a number
 * because Postgres reports a numeric column, and passing a float would put a
 * rounding error at the only boundary that matters. `opened_at` and `status`
 * are left to their column defaults -- today, and active -- because saying so
 * here would be a second statement of what 0007_servicing.sql already decides.
 */
export function loanInsertRow(terms: LoanTerms): LoanInsert {
  return {
    application_id: terms.applicationId,
    borrower_id: terms.borrowerId,
    org_id: terms.orgId,
    product_id: terms.productId,
    approved_limit: moneyToNumericString(terms.approvedLimit),
    rate_bps: terms.rateBps,
  };
}
