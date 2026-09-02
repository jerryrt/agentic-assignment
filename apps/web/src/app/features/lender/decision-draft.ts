/**
 * The seatbelt under a decision the lender has typed and not yet sent.
 *
 * plan/06 names three refresh cases and this file serves the third:
 * MID-DECISION. "Lenders lose work too" -- a decline reason typed into a box and
 * abandoned by a reload is exactly as gone as a borrower's half-written
 * application, and the borrower's is the one everybody remembers to protect.
 *
 * Two fields with two different homes, and the difference is a security
 * property rather than an accident:
 *
 *   internal_note   LENDER-ONLY, and a row in `credit_release_note` that a
 *                   lender may write directly. It is autosaved to the server
 *                   (upsertCreditReleaseNote), so the copy here only ever
 *                   protects the debounce window.
 *
 *   decline_reason  LENDER-AUTHORED AND BORROWER-READABLE, so it is a column on
 *                   `credit_release` -- and NO CLIENT MAY WRITE IT. A borrower
 *                   and a lender are the same database role, so a grant wide
 *                   enough to let a lender autosave this field is wide enough
 *                   to let a borrower forge one onto their own draft, and a
 *                   forged lender-authored field is worse than a missing one
 *                   because it is believed (issue #50). It therefore travels
 *                   WITH the decline transition, written by the service role in
 *                   the same statement that moves the state -- and until then
 *                   this browser copy is the only thing standing between a
 *                   typed reason and a reload.
 *
 * Nothing here throws: storage is refused outright in some privacy
 * configurations, and losing the seatbelt is a degradation rather than a
 * failure.
 */

const KEY_PREFIX = 'lj.decision.';

export interface DecisionSnapshot {
  readonly releaseId: string;
  /** Lender-only. Autosaved to `credit_release_note`; this covers the gap. */
  readonly internalNote: string;
  /** Shared with the borrower. Has no server copy until the decline is sent. */
  readonly declineReason: string;
  /** ISO 8601, for telling the lender how old the recovered copy is. */
  readonly savedAt: string;
}

/** What the server holds. There is no decline reason here, by design. */
export interface DecisionServerCopy {
  readonly internalNote: string;
}

export type DecisionReconciliation = {
  readonly internalNote: string;
  readonly declineReason: string;
  /** True when the browser is showing something the server has never seen. */
  readonly recovered: boolean;
};

function keyFor(releaseId: string): string {
  return KEY_PREFIX + releaseId;
}

export function readDecisionSnapshot(
  storage: Storage | null,
  releaseId: string,
): DecisionSnapshot | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(keyFor(releaseId));
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    return asSnapshot(JSON.parse(raw), releaseId);
  } catch {
    return null;
  }
}

function asSnapshot(value: unknown, releaseId: string): DecisionSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const internalNote = candidate['internalNote'];
  const declineReason = candidate['declineReason'];
  const savedAt = candidate['savedAt'];
  if (
    candidate['releaseId'] !== releaseId ||
    typeof internalNote !== 'string' ||
    typeof declineReason !== 'string' ||
    typeof savedAt !== 'string'
  ) {
    return null;
  }
  return { releaseId, internalNote, declineReason, savedAt };
}

export function writeDecisionSnapshot(
  storage: Storage | null,
  snapshot: DecisionSnapshot,
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(keyFor(snapshot.releaseId), JSON.stringify(snapshot));
  } catch {
    // Full, or disabled. The note's server copy is the authoritative one.
  }
}

export function clearDecisionSnapshot(storage: Storage | null, releaseId: string): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(keyFor(releaseId));
  } catch {
    // As above.
  }
}

/**
 * What to put in the two boxes.
 *
 * There is no `revision` on `credit_release_note`, so this cannot be the
 * monotonicity comparison the compose seatbelt makes -- and it does not need to
 * be. The note is autosaved by this same browser, so a local copy that differs
 * from the server's is either typing the debounce has not sent yet or another
 * lender's tab having saved one since. Both are cases where the human in front
 * of the screen has to decide, so the unsent typing is kept and flagged as
 * recovered rather than being silently dropped or silently preferred.
 *
 * A decline reason always comes from the snapshot, because the server holds
 * none until the decline is sent.
 */
export function reconcileDecision(
  snapshot: DecisionSnapshot | null,
  server: DecisionServerCopy,
): DecisionReconciliation {
  if (snapshot === null) {
    return { internalNote: server.internalNote, declineReason: '', recovered: false };
  }
  const noteDiffers = snapshot.internalNote !== server.internalNote;
  return {
    internalNote: noteDiffers ? snapshot.internalNote : server.internalNote,
    declineReason: snapshot.declineReason,
    recovered: noteDiffers || snapshot.declineReason.trim() !== '',
  };
}
