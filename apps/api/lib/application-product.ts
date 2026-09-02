/**
 * The product one application was made against, resolved from the payload and
 * checked before anything is written.
 *
 * Two transitions need it and they need the SAME answer. `request_docs`
 * generates the checklist from the product's `required_docs`; `fund` opens the
 * facility against the product the application chose. A loan funded against one
 * product whose checklist came from another is a file nobody can explain, so
 * the two are not merely similar -- they must provably stay in lockstep, which
 * is the second half of CLAUDE.md section 9's threshold and the reason this is
 * one function rather than two matching paragraphs.
 *
 * WHY THE PRODUCT IS READ BY ID rather than taken from the active list: an
 * application submitted against a product since withdrawn still has to be
 * workable, and the terms it was made under are that product's terms.
 *
 * WHY THE ORGANISATION IS CHECKED: the payload is written by the borrower's own
 * autosave, so the product id in it is caller-influenced. The lender
 * adjudicating is at the application's organisation, and the product decides
 * what that lender may demand and what facility they open. Reading it off
 * another organisation's product would let a payload choose the checklist and
 * the terms.
 */

import { getLoanProduct, type DatabaseClient, type LoanProduct } from '@lj/db';
import { UuidSchema, type ApplicationData } from '@lj/domain';

/**
 * The product, or why the transition that needed it cannot go ahead.
 *
 * A refusal here refuses the whole transition, before the state change. Every
 * reason names something about the stored application rather than anything the
 * caller sent, so quoting it diagnoses rather than echoes untrusted input.
 */
export type ApplicationProductResolution =
  | { readonly ok: true; readonly product: LoanProduct }
  | { readonly ok: false; readonly reason: string };

/**
 * Which product this application names, if it names one this organisation has.
 *
 * `request.product_id` is answered by the time either caller runs: reaching
 * `submitted` needs the submit guard to pass, and that guard requires every
 * step to be complete -- of which the product is one. So an application that
 * names no product here reached its state by some other route, and refusing is
 * the only honest answer.
 */
export async function resolveApplicationProduct(
  client: DatabaseClient,
  application: { readonly orgId: string },
  data: ApplicationData,
): Promise<ApplicationProductResolution> {
  const productId = data.request.product_id;
  if (productId === null) {
    return { ok: false, reason: 'the application names no product' };
  }
  if (!UuidSchema.safeParse(productId).success) {
    // Refused here rather than sent to the database, where a malformed uuid is
    // an error about a cast and not about a loan application.
    return { ok: false, reason: 'the application names a product id that is not a uuid' };
  }

  const product = await getLoanProduct(client, productId);
  if (product === null) {
    return { ok: false, reason: 'the application names a product that no longer exists' };
  }
  if (product.org_id !== application.orgId) {
    return {
      ok: false,
      reason: 'the application names a product belonging to another organisation',
    };
  }
  return { ok: true, product };
}
