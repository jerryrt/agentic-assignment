import { moneyFromNumericString, type Money } from '@lj/domain';

/**
 * The seatbelt under a credit request that is still being written, and the rule
 * for reconciling it with the server.
 *
 * `plan/06-option3-servicing.md` names three refresh cases and this file serves
 * the first: MID-COMPOSE. The release row is created in `draft` on the first
 * keystroke, so the URL becomes `/loans/:id/release/:rid` and the payload
 * autosaves to a row that exists -- and the browser keeps its own copy under
 * both of them, because the network save is best effort and the tab can go away
 * between two keystrokes.
 *
 * WHY IT IS KEYED BY LOAN AS WELL AS BY RELEASE. There is a window in which
 * someone is typing and no row exists yet: one keystroke wide when the insert
 * succeeds, and open-ended when it does not, which is exactly the case an
 * offline borrower hits. Keying only by release id would drop that typing on
 * the floor, so the unsent copy is kept under `<loan>.new` and moved onto the
 * release once the row arrives.
 *
 * WHY THE COMPARISON IS ON `revision` AND NOT ON A CLOCK. It is the
 * optimistic-concurrency token the server already maintains, so no wall clock
 * has to be trusted -- two devices disagreeing about the time is not something
 * a draft should have to survive. The rule is the same one
 * `features/apply/draft.ts` states for the application form, and it is written
 * out again rather than shared: that file belongs to another feature's scope
 * (docs/03-agent-scopes.md) and may not be imported from here. This is the
 * third occurrence in `apps/web` of one storage-backed draft, so the shared home
 * is `core/`, which is web-core's to create; see the handoff on issue #53.
 *
 * Nothing here throws. Storage is refused outright in some privacy
 * configurations, and losing the seatbelt is a degradation -- taking the screen
 * down over it would be the bug.
 */

const KEY_PREFIX = 'lj.release.';

/** The key of a release with no row yet. Not a uuid, so it cannot collide. */
const UNSENT = 'new';

export interface ComposeSnapshot {
  readonly loanId: string;
  /** Null while the row has not been created yet. */
  readonly releaseId: string | null;
  /** The server revision this payload was built on; 0 for an uncreated row. */
  readonly revision: number;
  /** As TYPED, separators and all. See `amountToMoney`. */
  readonly amountText: string;
  readonly purpose: string;
  /** ISO 8601, for telling the borrower how old the recovered copy is. */
  readonly savedAt: string;
}

/** What the server holds, reduced to the two fields a compose screen edits. */
export interface ComposeServerCopy {
  readonly revision: number;
  readonly amountText: string;
  readonly purpose: string;
}

export type ComposeReconciliation =
  | { readonly source: 'server' }
  | { readonly source: 'local'; readonly snapshot: ComposeSnapshot };

function keyFor(loanId: string, releaseId: string | null): string {
  return KEY_PREFIX + loanId + '.' + (releaseId ?? UNSENT);
}

/**
 * Both keys one loan's compose can occupy, unsent first.
 *
 * Exported so the store can move the unsent copy onto the row the first
 * keystroke created without restating the key format, which is the kind of
 * string that gets edited in one place and not the other.
 */
export function composeSnapshotsFor(
  loanId: string,
  releaseId: string | null,
): readonly string[] {
  return [keyFor(loanId, null), keyFor(loanId, releaseId)];
}

/**
 * A person types separators; `moneyFromNumericString` refuses them, and it is
 * right to -- '12,000' is not a Postgres numeric literal and guessing at one is
 * how a wrong amount gets stored. Commas and spaces are stripped here, at the
 * form boundary, and nothing else is: a currency symbol or a second decimal
 * point still fails, because each means the value came from somewhere this
 * field cannot interpret.
 *
 * Total, and it never throws. A half-typed amount is not an error to show
 * someone mid-keystroke; it is a value that has not arrived, which the rules
 * report as `unknown` rather than as a refusal.
 */
export function amountToMoney(text: string): Money | null {
  if (text.trim() === '') {
    return null;
  }
  try {
    return moneyFromNumericString(text.replaceAll(',', '').replaceAll(' ', ''));
  } catch {
    return null;
  }
}

export function readComposeSnapshot(
  storage: Storage | null,
  loanId: string,
  releaseId: string | null,
): ComposeSnapshot | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(keyFor(loanId, releaseId));
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    return asSnapshot(JSON.parse(raw), loanId, releaseId);
  } catch {
    // A cache that will not parse is discarded rather than repaired: the
    // authoritative copy is on the server, and half a payload restored over a
    // whole one is worse than no seatbelt at all.
    return null;
  }
}

function asSnapshot(
  value: unknown,
  loanId: string,
  releaseId: string | null,
): ComposeSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const storedRelease = candidate['releaseId'] ?? null;
  if (candidate['loanId'] !== loanId || storedRelease !== releaseId) {
    return null;
  }
  const revision = candidate['revision'];
  const amountText = candidate['amountText'];
  const purpose = candidate['purpose'];
  const savedAt = candidate['savedAt'];
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    typeof amountText !== 'string' ||
    typeof purpose !== 'string' ||
    typeof savedAt !== 'string'
  ) {
    return null;
  }
  return { loanId, releaseId, revision, amountText, purpose, savedAt };
}

export function writeComposeSnapshot(storage: Storage | null, snapshot: ComposeSnapshot): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(keyFor(snapshot.loanId, snapshot.releaseId), JSON.stringify(snapshot));
  } catch {
    // Full, or disabled. The server copy is the authoritative one; carry on.
  }
}

export function clearComposeSnapshot(
  storage: Storage | null,
  loanId: string,
  releaseId: string | null,
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(keyFor(loanId, releaseId));
  } catch {
    // As above.
  }
}

/**
 * Which copy to open with.
 *
 *   snapshot older than the server   somebody saved something this browser
 *                                    never saw. Discard it.
 *   same revision, same payload      the last save landed. Nothing to recover.
 *   same revision, different payload the browser holds edits the server never
 *                                    received. THIS is what the seatbelt is for.
 *   snapshot ahead of the server     a save landed that this read has not seen
 *                                    yet, so the local copy is the later one.
 *
 * It never merges. A merge of two payloads has no correct answer and would
 * produce a third state neither side entered.
 */
export function reconcileCompose(
  snapshot: ComposeSnapshot | null,
  server: ComposeServerCopy,
): ComposeReconciliation {
  if (snapshot === null || snapshot.revision < server.revision) {
    return { source: 'server' };
  }
  if (snapshot.revision > server.revision) {
    return { source: 'local', snapshot };
  }
  return sameCompose(snapshot, server) ? { source: 'server' } : { source: 'local', snapshot };
}

/**
 * The amount is compared as an AMOUNT and the purpose as text.
 *
 * '12,000' and '12000.00' are one value typed two ways -- the server renders
 * the column at full scale and the borrower did not -- so comparing the strings
 * would offer to recover a difference that is not one. Two amounts that will
 * not parse compare as equal on their text, which is the only reading available
 * and is harmless: neither can be saved.
 */
function sameCompose(snapshot: ComposeSnapshot, server: ComposeServerCopy): boolean {
  if (snapshot.purpose !== server.purpose) {
    return false;
  }
  const held = amountToMoney(snapshot.amountText);
  const theirs = amountToMoney(server.amountText);
  return held === null || theirs === null
    ? snapshot.amountText.trim() === server.amountText.trim()
    : held === theirs;
}
