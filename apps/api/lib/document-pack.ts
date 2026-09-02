/**
 * The document pack in both directions: turning a product's `required_docs`
 * into the slots one application has to fill, and reading those slots back into
 * what the completeness rules judge them by.
 *
 * The two belong together because they are two halves of one contract -- what a
 * slot was created with is what it is later judged against. Neither half
 * decides anything: `parseRequiredDocs` owns what a pack may say and
 * `evaluateCompleteness` owns what complete means, both in packages/rules, and
 * both fail closed. This is the part that package cannot do, because it is the
 * part that needs the database.
 */

import {
  getLoanProduct,
  listDocumentSlots,
  listDocumentUploadsForApplication,
  type DatabaseClient,
  type DocumentSlotInsert,
  type DocumentUploadRow,
} from '@lj/db';
import { DocumentSlotStateSchema, UuidSchema, type ApplicationData } from '@lj/domain';
import {
  parseRequiredDocs,
  type DocumentContext,
  type DocumentSlotView,
  type RequiredDocSlot,
  parseExtractedFields,
} from '@lj/rules';

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

/* -------------------------------------------------------------------------
 * Reading a pack back
 * ---------------------------------------------------------------------- */

/** The newest upload per slot, from one list already ordered newest first. */
function latestUploadBySlot(
  uploads: readonly DocumentUploadRow[],
): ReadonlyMap<string, DocumentUploadRow> {
  const latest = new Map<string, DocumentUploadRow>();
  for (const upload of uploads) {
    if (!latest.has(upload.slot_id)) {
      latest.set(upload.slot_id, upload);
    }
  }
  return latest;
}

/**
 * Today, as the rules take it.
 *
 * UTC, and stated rather than defaulted. `valid_until` is a calendar date in
 * the place the document was issued (see the note in @lj/domain), the server's
 * own zone is an accident of where the function happens to run, and a
 * borderline expiry must not depend on which region answered the request. The
 * clock is injected because a rule that called Date.now() could not be tested
 * and could not be replayed against the date a decision was actually made.
 */
export function todayInUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * What the completeness rules read: every slot, with the extraction from the
 * file that currently satisfies it.
 *
 * Two round trips for a whole pack rather than one per slot -- a five-slot pack
 * asked one query at a time is six requests to answer one guard.
 *
 * The terms come from the SLOT and never from the product: `extract_required`
 * was copied onto the row when the pack was generated, and a product whose list
 * has been edited since must not change what an already generated slot is
 * judged against.
 */
export async function buildDocumentContext(
  client: DatabaseClient,
  applicationId: string,
  today: string = todayInUtc(),
): Promise<DocumentContext> {
  const [slots, uploads] = await Promise.all([
    listDocumentSlots(client, applicationId),
    listDocumentUploadsForApplication(client, applicationId),
  ]);
  const latest = latestUploadBySlot(uploads);

  const views: DocumentSlotView[] = [];
  for (const slot of slots) {
    // The generated types describe `state` as text, because the column is text:
    // legality lives in workflow_transition, not in a check constraint. A state
    // no machine declares must not reach the rules as a string that happens to
    // typecheck, so it is narrowed here -- and a slot that cannot be narrowed is
    // left out, which leaves the pack short a slot it cannot judge and
    // therefore blocks rather than passes.
    const state = DocumentSlotStateSchema.safeParse(slot.state);
    if (!state.success) {
      continue;
    }
    const upload = latest.get(slot.id);
    views.push({
      code: slot.code,
      label: slot.label,
      required: slot.required,
      state: state.data,
      validUntil: slot.valid_until,
      extractRequired: slot.extract_required,
      extracted: upload === undefined ? {} : parseExtractedFields(upload.extracted),
    });
  }

  return { today, slots: views };
}
