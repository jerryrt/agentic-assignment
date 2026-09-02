/**
 * The document pack: turning a product's `required_docs` into the slots one
 * application has to fill.
 *
 * Nothing here decides what a pack may say: `parseRequiredDocs` in
 * packages/rules owns that, and it fails closed. This is the part that package
 * cannot do, because it is the part that needs the database.
 */

import { getLoanProduct, type DatabaseClient, type DocumentSlotInsert } from '@lj/db';
import { UuidSchema, type ApplicationData } from '@lj/domain';
import { parseRequiredDocs, type RequiredDocSlot } from '@lj/rules';

/**
 * The pack a transition is about to generate, or why it cannot be.
 *
 * A refusal here refuses the whole transition. It is never a partial
 * checklist: `parseRequiredDocs` fails closed precisely because a pack short a
 * document reports COMPLETE, and generating the slots that did parse would
 * carry that failure across into the database, where it stops looking like an
 * error and starts looking like the lender's policy.
 */
export type RequiredDocsResolution =
  | { readonly ok: true; readonly slots: readonly RequiredDocSlot[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Which product's pack, decided from the application rather than from the
 * request.
 *
 * `request.product_id` is the product the borrower applied for, and it is
 * always answered by the time this runs: `request_docs` leaves `submitted`
 * alone, reaching `submitted` needs the submit guard to pass, and that guard
 * requires every step to be complete -- of which `request.product_id` is one.
 * So an application that names no product here is one that reached `submitted`
 * by some other route, and refusing is the only honest answer.
 *
 * The product is read by id rather than from the active list. An application
 * submitted against a product since withdrawn still has to be workable, and the
 * documents it was asked for are the ones that product asks for.
 */
export async function resolveRequiredDocs(
  client: DatabaseClient,
  application: { readonly id: string; readonly orgId: string },
  data: ApplicationData,
): Promise<RequiredDocsResolution> {
  const productId = data.request.product_id;
  if (productId === null) {
    return {
      ok: false,
      reason:
        'the application names no product, so there is no document pack to generate; ' +
        'nothing was written',
    };
  }
  if (!UuidSchema.safeParse(productId).success) {
    // Refused here rather than sent to the database, where a malformed uuid is
    // an error about a cast and not about a loan application.
    return { ok: false, reason: 'the application names a product id that is not a uuid' };
  }

  const product = await getLoanProduct(client, productId);
  if (product === null) {
    return {
      ok: false,
      reason: 'the application names a product that no longer exists',
    };
  }
  if (product.org_id !== application.orgId) {
    // The lender adjudicating is at the application's organisation, and the
    // pack decides what that lender may then demand. Reading it off another
    // organisation's product would let a payload choose the checklist.
    return {
      ok: false,
      reason: 'the application names a product belonging to another organisation',
    };
  }

  const parsed = parseRequiredDocs(product.required_docs);
  if (!parsed.ok) {
    // The problems name paths inside the product's own pack, not anything the
    // caller sent, so quoting them diagnoses rather than echoes. Capped for the
    // reason the payload problems are capped: a response body is not a log.
    return {
      ok: false,
      reason:
        "the document pack on product '" +
        product.name +
        "' could not be read, so no checklist was generated: " +
        parsed.problems.slice(0, 3).join('; '),
    };
  }

  return { ok: true, slots: parsed.slots };
}

/**
 * The rows one pack becomes.
 *
 * `extract_required` is copied onto the slot rather than read back through the
 * product when the pack is evaluated. A product's list may be edited, and a
 * slot already generated keeps the terms it was created under -- the same
 * argument the eligibility snapshot makes about criteria. `state` and
 * `revision` are left to their column defaults: a slot starts at `required` at
 * revision 0, and saying so here would be a second statement of it.
 */
export function documentSlotRows(
  applicationId: string,
  slots: readonly RequiredDocSlot[],
): DocumentSlotInsert[] {
  return slots.map((slot) => ({
    application_id: applicationId,
    code: slot.code,
    label: slot.label,
    required: slot.required,
    extract_required: [...slot.extractRequired],
  }));
}
