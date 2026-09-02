import type { AppRole, DocumentSlotState } from '@lj/domain';
import { can, documentSlotMachine, type GuardResult } from '@lj/workflow';

import type { ExtractedFields } from './extraction.ts';

/**
 * What a lender may do with one document, and what they are looking at while
 * they decide.
 *
 * A separate function rather than a `computed` inside the review component,
 * for the reason `features/apply/refusal.ts` gives: this is the piece with a
 * decision in it, and a decision left in a template is a decision with no
 * test -- especially here, where an `apps/web` unit test cannot render the
 * component at all (issue #33).
 *
 * THE PREDICTION IS A COURTESY, NOT THE GATE. `can()` runs the same machine
 * definition the server runs, so a button for a move that is not legal is
 * greyed before a round trip. The server re-checks the actor's role against
 * the machine on every transition (core/workflow/transition.service.ts), and
 * a borrower who forges a request is refused there. Nothing here is a control.
 */

/** One extracted field, ready to put on a screen beside the decision. */
export interface ReviewedField {
  readonly field: string;
  readonly value: unknown;
  readonly confidenceBasisPoints: number;
  /** True when a person typed it in, which is why confidence stops mattering. */
  readonly confirmedByHuman: boolean;
  /** True when the slot declares the field required and it was not read. */
  readonly outstanding: boolean;
}

export interface SlotDecision {
  readonly accept: GuardResult;
  readonly reject: GuardResult;
}

/**
 * Whether accept and reject are legal from where this slot stands.
 *
 * Both are lender-only and both leave `extracted` alone, so a slot that is
 * still `uploaded` -- awaiting the platform's extraction -- offers neither.
 * That is the machine's shape and not a rule of this screen's: reading it
 * from `documentSlotMachine` is what stops the two drifting apart when a
 * state is added.
 */
export function decisionFor(state: DocumentSlotState, role: AppRole | null): SlotDecision {
  const unread: GuardResult = {
    ok: false,
    reason: 'the reviewer has not been identified yet',
    blockers: [],
  };
  if (role === null) {
    return { accept: unread, reject: unread };
  }
  // The context is empty because the slot machine declares no guards: accept
  // and reject are questions of authority and of where the slot stands, not of
  // a rule set. `DocumentSlotGuardContext` says so in its own type.
  return {
    accept: can(documentSlotMachine, state, 'accept', role, {}),
    reject: can(documentSlotMachine, state, 'reject', role, {}),
  };
}

/**
 * What was read off the document, in the order the slot asks for it.
 *
 * Fields the slot declares as required come first and keep their place even
 * when nothing was read for them, because an absent field is the reason a
 * lender is looking at this slot at all -- dropping it would leave them
 * comparing a document against a list that no longer mentions what is missing.
 * Anything else the extractor happened to find follows, in name order, so two
 * readings of the same slot present the same way.
 */
export function reviewedFields(
  extractRequired: readonly string[],
  extracted: ExtractedFields,
): readonly ReviewedField[] {
  const required = new Set(extractRequired);
  const extras = Object.keys(extracted)
    .filter((field) => !required.has(field))
    .sort();

  return [...extractRequired, ...extras].map((field) => {
    const read = extracted[field];
    return {
      field,
      value: read === undefined ? null : read.value,
      confidenceBasisPoints: read === undefined ? 0 : read.confidenceBasisPoints,
      confirmedByHuman: read !== undefined && read.source === 'human',
      outstanding: required.has(field) && read === undefined,
    };
  });
}
