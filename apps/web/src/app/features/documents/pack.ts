import {
  DocumentSlotStateSchema,
  deriveApplicationFigures,
  type ApplicationData,
  type ApplicationState,
  type DocumentSlot,
  type DocumentUpload,
} from '@lj/domain';
import { isExpired, isReadable, type ApplicationFacts, type DocumentSlotView } from '@lj/rules';

import { readExtractedFields } from './extraction.ts';

/**
 * The document pack, and the four pure decisions the screens make over it.
 *
 * Everything here is a plain function of plain data, for the reason
 * `features/apply/refusal.ts` gives: these are the pieces with a decision in
 * them, and an `apps/web` unit test cannot render a component that binds an
 * @lj/ui input (issue #33), so a decision left inside a template is a decision
 * with no test. The components around these functions only render.
 *
 * **Nothing here decides what "complete" means.** That is
 * `evaluateCompleteness` in @lj/rules and it is not restated, wrapped, or
 * second-guessed. What this file does is assemble the context those rules read
 * -- the slot rows joined to the newest file's extraction -- and map the same
 * slot to the CONTROL the borrower needs beside the verdict.
 */

/** What one screen holds: one application, its pack, and every file against it. */
export interface DocumentPackValue {
  readonly applicationId: string;
  readonly applicationState: ApplicationState;
  readonly applicationRevision: number;
  /** The submitted payload. Only the cross-checks read it. */
  readonly data: ApplicationData;
  readonly slots: readonly DocumentSlot[];
  readonly uploads: readonly DocumentUpload[];
}

/**
 * The newest file submitted against a slot, or null.
 *
 * `document_upload` is append-only, so a replacement is a new row and the
 * newest row is the one that counts -- showing an earlier extraction would put
 * the figures from a document the borrower has already replaced in front of
 * them. @lj/db returns uploads newest first, and this re-establishes that
 * rather than trusting it: a helper that depends on its caller's ordering
 * starts reading the wrong file the day a second query feeds it.
 */
export function latestUploadFor(
  uploads: readonly DocumentUpload[],
  slotId: string,
): DocumentUpload | null {
  let newest: DocumentUpload | null = null;
  for (const upload of uploads) {
    if (upload.slot_id !== slotId) {
      continue;
    }
    if (newest === null || upload.uploaded_at > newest.uploaded_at) {
      newest = upload;
    }
  }
  return newest;
}

/**
 * The pack as the rules read it.
 *
 * `extractRequired` comes off the SLOT and never off the product: a slot keeps
 * the terms it was generated under, which is the same argument the eligibility
 * snapshot makes about criteria (issue #41, note 6).
 */
export function slotViewsOf(pack: DocumentPackValue): readonly DocumentSlotView[] {
  return pack.slots.map((slot) => {
    const newest = latestUploadFor(pack.uploads, slot.id);
    return {
      code: slot.code,
      label: slot.label,
      required: slot.required,
      state: slot.state,
      validUntil: slot.valid_until,
      extractRequired: slot.extract_required,
      extracted: newest === null ? {} : readExtractedFields(newest.extracted),
    };
  });
}

/**
 * What the cross-checks compare a document against.
 *
 * The acreage is the DERIVED figure from @lj/domain, not a form field: it is
 * summed from the parcels, and it is null while any parcel is missing its
 * acres so a partial total is never reported as the total. Recomputing it here
 * would be a second copy of that decision (CLAUDE.md section 9).
 */
export function applicationFactsOf(data: ApplicationData): ApplicationFacts {
  return {
    totalAcres: deriveApplicationFigures(data).totalAcres,
    legalName: data.borrower.legal_name,
  };
}

/**
 * Which control belongs beside a slot.
 *
 * `kind` drives the screen; `label` is what the button says. plan/04's third
 * honesty rule is that a failure names the NEXT ACTION and not the problem --
 * "upload a current one", never "expired" -- so the label is always a verb the
 * borrower can act on.
 */
export type SlotActionKind = 'upload' | 'replace' | 'renew' | 'correct' | 'wait' | 'done';

export interface SlotAction {
  readonly kind: SlotActionKind;
  readonly label: string;
  /** For `correct`: the fields a person would type in. Empty otherwise. */
  readonly fields: readonly string[];
}

function action(kind: SlotActionKind, label: string, fields: readonly string[] = []): SlotAction {
  return { kind, label, fields };
}

/**
 * The next action on one slot.
 *
 * THE BRANCH ORDER MIRRORS `documentSlotRule` IN @lj/rules, deliberately and
 * exactly: state, then expiry, then readability. The rule writes the row and
 * this writes the button beside it, and a row saying one thing while its
 * button offers another is worse than either being wrong on its own.
 *
 * It is `isExpired` and `isReadable` doing the work, not a reimplementation of
 * them, so the only thing restated is the order. The verdict itself is never
 * computed here -- that arrives from the rules as a `RuleResult`.
 *
 * plan/04 keeps missing, stale and unreadable apart because the borrower's
 * next action differs in each: upload something, upload a newer one, upload a
 * clearer scan or type the value in. Collapsing them into one red dot is the
 * lazy version, and it is this function that refuses to.
 */
export function nextActionFor(slot: DocumentSlotView, today: string): SlotAction {
  if (slot.state === 'required') {
    return action('upload', 'Upload it');
  }
  if (slot.state === 'uploaded' || slot.state === 'extracted') {
    // Not the borrower's move. Offering them a control here would invite them
    // to replace a document their lender is in the middle of reading.
    return action('wait', 'With your lender');
  }
  if (slot.state === 'rejected') {
    return action('replace', 'Upload a replacement');
  }
  if (isExpired(slot.validUntil, today)) {
    return action('renew', 'Upload a current one');
  }

  const unreadable = slot.extractRequired.filter((field) => !isReadable(slot.extracted[field]));
  if (unreadable.length > 0) {
    return action('correct', 'Type the value in', unreadable);
  }
  return action('done', 'Accepted', []);
}

/**
 * Whether this action is the BORROWER's to take.
 *
 * It is what "N things need your attention" counts, and the interesting case
 * is `wait`: a document sitting with the lender is outstanding, but nothing
 * the borrower does moves it, and counting it would send them looking for work
 * that is not theirs. An honest count of what somebody can act on is worth
 * more than a complete count of what is unfinished.
 */
export function isBorrowerAction(action: SlotAction): boolean {
  return (
    action.kind === 'upload' ||
    action.kind === 'replace' ||
    action.kind === 'renew' ||
    action.kind === 'correct'
  );
}

/** The part of a transition acknowledgement a pack can act on. */
export interface SlotAcknowledgement {
  readonly subjectId: string;
  /** The state the server moved the slot to. A string: it arrived as JSON. */
  readonly to: string;
  readonly revision: number;
}

/**
 * Take the server's answer to a slot transition into the held pack.
 *
 * This is `AggregateStore`'s ordering policy applied where a pack can apply
 * it. A pack has no single revision -- it has one per slot -- so
 * `revisionOf()` is left at its default of null and the monotonicity rule is
 * enforced here instead: an acknowledgement carrying a revision that is not
 * newer than the one held is a view of the past and is dropped silently,
 * because it is a race resolving correctly rather than an error.
 *
 * Returns the pack unchanged, by reference, when there is nothing to apply --
 * which is what lets a caller skip a needless signal write.
 */
export function applySlotAck(
  pack: DocumentPackValue,
  ack: SlotAcknowledgement,
): DocumentPackValue {
  const state = DocumentSlotStateSchema.safeParse(ack.to);
  if (!state.success) {
    // A state the machine does not have must not reach the rules, which switch
    // on it. It typechecks because it crossed a fetch boundary as a string.
    return pack;
  }

  const index = pack.slots.findIndex((slot) => slot.id === ack.subjectId);
  const held = pack.slots[index];
  if (held === undefined || ack.revision <= held.revision) {
    return pack;
  }

  const slots = [...pack.slots];
  slots[index] = { ...held, state: state.data, revision: ack.revision };
  return { ...pack, slots };
}
