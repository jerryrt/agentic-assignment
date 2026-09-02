import {
  ApplicationDataSchema,
  isApplicationStep,
  type ApplicationData,
  type ApplicationStep,
} from '@lj/domain';

/**
 * The seatbelt: what the browser keeps for itself, and who wins when it and
 * the server disagree.
 *
 * `plan/03-workflow-engine.md` puts a draft in three layers -- the URL holds
 * the step, the server holds the payload, and localStorage is the seatbelt
 * under both. This file is the third layer and, more importantly, the rule for
 * reconciling it with the second. That rule is the whole value of the seatbelt:
 * a copy nobody knows how to compare is a copy that either does nothing or
 * silently overwrites something.
 *
 * **Why localStorage and not `navigator.sendBeacon`.** plan/05 says to flush on
 * `visibilitychange -> hidden` with a beacon. A beacon cannot set headers, so
 * it cannot carry the `Authorization` bearer token PostgREST requires: the
 * write would arrive anonymous, be refused by the row policy, and report
 * nothing, because a beacon has no response. `fetch(..., { keepalive: true })`
 * can carry headers, but the Supabase client owns its own fetch and does not
 * expose the option per request.
 *
 * So the flush is a SYNCHRONOUS localStorage write, which cannot be cut short
 * by the page going away, plus a best-effort network save that may or may not
 * land. The reconciliation below is what turns "may or may not" into a
 * guarantee: whichever of the two the browser managed, the next load is
 * correct. That is a better property than the beacon would have given, because
 * it also covers the tab being killed outright, which no flush of any kind
 * survives.
 *
 * Nothing here throws. Storage is unavailable in a private window, over quota,
 * or disabled outright, and losing the seatbelt is a degradation; taking the
 * screen down over it would be the bug.
 */

const KEY_PREFIX = 'lj.draft.';

export interface DraftSnapshot {
  readonly applicationId: string;
  /** The server revision this payload was built on top of. */
  readonly revision: number;
  readonly data: ApplicationData;
  readonly furthestStep: ApplicationStep;
  /** ISO 8601, for telling the applicant how old the recovered copy is. */
  readonly savedAt: string;
}

/**
 * What to show when an application is opened.
 *
 * `local` means the browser holds edits the server never received -- the tab
 * was killed, or the last save was in flight when the page went away.
 */
export type DraftReconciliation =
  | { readonly source: 'server' }
  | { readonly source: 'local'; readonly snapshot: DraftSnapshot };

function keyFor(applicationId: string): string {
  return KEY_PREFIX + applicationId;
}

export function readDraftSnapshot(
  storage: Storage | null,
  applicationId: string,
): DraftSnapshot | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(keyFor(applicationId));
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }

  // Anything unreadable is discarded rather than repaired. It is a cache, the
  // authoritative copy is on the server, and a half-parsed payload restored
  // over a good one is worse than no seatbelt at all.
  try {
    const parsed: unknown = JSON.parse(raw);
    return asSnapshot(parsed, applicationId);
  } catch {
    return null;
  }
}

function asSnapshot(value: unknown, applicationId: string): DraftSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['applicationId'] !== applicationId) {
    return null;
  }
  const revision = candidate['revision'];
  const furthestStep = candidate['furthestStep'];
  const savedAt = candidate['savedAt'];
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    typeof furthestStep !== 'string' ||
    !isApplicationStep(furthestStep) ||
    typeof savedAt !== 'string'
  ) {
    return null;
  }
  const data = ApplicationDataSchema.safeParse(candidate['data']);
  if (!data.success) {
    return null;
  }
  return { applicationId, revision, data: data.data, furthestStep, savedAt };
}

export function writeDraftSnapshot(storage: Storage | null, snapshot: DraftSnapshot): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(keyFor(snapshot.applicationId), JSON.stringify(snapshot));
  } catch {
    // Full, or disabled. The server copy is the authoritative one; carry on.
  }
}

export function clearDraftSnapshot(storage: Storage | null, applicationId: string): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(keyFor(applicationId));
  } catch {
    // As above.
  }
}

/**
 * Which copy to open.
 *
 * The comparison is on `revision`, which is the optimistic-concurrency token
 * the server already maintains, so this needs no clock and no trust in one --
 * two devices' wall clocks disagreeing is not a thing a draft should have to
 * survive.
 *
 *   snapshot older than the server   the server has moved on since this
 *                                    browser last wrote. Discard: a later
 *                                    revision means somebody saved something
 *                                    this copy never saw.
 *   snapshot at the server's revision, payload identical
 *                                    the last save landed. Nothing to recover.
 *   snapshot at the server's revision, payload different
 *                                    the browser had edits the server never
 *                                    received. THIS is the case the seatbelt
 *                                    exists for.
 *   snapshot ahead of the server     a save landed but this read did not see
 *                                    it yet. The local copy is the later of
 *                                    the two, so it wins.
 *
 * Note what this deliberately does not do: it never merges. A merge of two
 * form payloads has no correct answer and would produce a third state neither
 * side entered.
 */
export function reconcileDraft(
  snapshot: DraftSnapshot | null,
  server: { readonly revision: number; readonly data: ApplicationData },
): DraftReconciliation {
  if (snapshot === null || snapshot.revision < server.revision) {
    return { source: 'server' };
  }
  if (snapshot.revision > server.revision) {
    return { source: 'local', snapshot };
  }
  return sameData(snapshot.data, server.data)
    ? { source: 'server' }
    : { source: 'local', snapshot };
}

/**
 * Payload equality, by serialisation.
 *
 * Correct here and nowhere near general: both sides came out of
 * ApplicationDataSchema, so both have every key, in the schema's order, with no
 * undefined and no cycles. A hand-written deep compare would be more code and
 * one more thing to keep in step with the schema.
 */
function sameData(left: ApplicationData, right: ApplicationData): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
