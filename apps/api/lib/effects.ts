/**
 * The declared effects this API can actually carry out.
 *
 * A machine declares an effect rather than holding a callback, so the runner
 * decides how to execute it (plan/03). This file is the runner's half of that
 * contract.
 *
 * The load-bearing decision is what an unrunnable effect does. Skipping it
 * would move an application to `funded` with no loan behind it: a state that
 * says money moved when nothing did, discovered later by whoever reconciles.
 * So an effect nothing can execute REFUSES the transition, and refuses it
 * before the update, so that nothing is written and nothing has to be undone.
 * That is the same direction the empty `workflow_transition` table failed in
 * before it was generated, and the same direction an unevaluated rule set fails
 * in: closed.
 *
 * No declared effect is in that position any more: every kind the three
 * machines name has a table -- `0005_application_submit.sql`,
 * `0006_documents.sql` and `0007_servicing.sql` -- and a runner below. The
 * refusal stays, because it is a property of this file and not a phase of the
 * build: a kind added to `EffectSpec` without a runner here must refuse the
 * transition that declares it rather than move a subject and skip what the move
 * promised.
 *
 * An effect whose INPUT cannot be prepared refuses in the same direction and at
 * the same moment, before the update. See `EffectContext.requiredDocs`.
 *
 * Which kinds are runnable is derived from the runner map rather than listed
 * beside it. Two lists would be two answers the first time one was edited
 * (CLAUDE.md section 9), and the answer they disagreed about is whether a
 * transition writes what it promised.
 */

import {
  appendWorkflowEvent,
  insertDocumentSlots,
  insertDocumentUpload,
  insertEligibilitySnapshot,
  insertLedgerEntry,
  insertLoan,
  listDocumentSlots,
  type DatabaseClient,
  type Json,
} from '@lj/db';
import { moneyToNumericString } from '@lj/domain';
import type { ProductEligibility, RequiredDocSlot } from '@lj/rules';
import type { EffectSpec } from '@lj/workflow';

import type { CreditReleaseSubject, LoanSubject } from './credit-release-subject.ts';
import { documentSlotRows, todayInUtc } from './document-pack.ts';
import { advanceDocumentSlot, type DocumentSlotSubject } from './document-slot-subject.ts';
import type { PreparedUpload } from './document-upload.ts';
import { stubExtractor, type Extractor } from './extraction.ts';
import type { SubjectSnapshot } from './http.ts';
import { loanInsertRow, type LoanTerms } from './loan-terms.ts';

export type EffectKind = EffectSpec['kind'];

/**
 * Everything a runner may read.
 *
 * It is assembled by the handler from the decision it has just taken, and it
 * carries the evaluation the GUARD was decided on rather than a fresh one. A
 * runner that re-evaluated could record criteria the applicant was never shown,
 * which is the failure the snapshot exists to prevent.
 */
export interface EffectContext {
  readonly applicationId: string;
  /** The application's revision after the state change landed. */
  readonly revision: number;
  /** Every product this application was evaluated against, as evaluated. */
  readonly eligibility: readonly ProductEligibility[];
  /**
   * The pack `create_document_slots` is to generate, resolved from the product
   * BEFORE the state change (see `resolveRequiredDocs`).
   *
   * Prepared by the caller rather than read here for the same reason the
   * evaluation is: a pack that cannot be read has to refuse the transition,
   * and by the time a runner is called the application has already moved. The
   * runner therefore has nothing left to decide -- it writes what it was
   * handed, or it fails loudly.
   */
  readonly requiredDocs: readonly RequiredDocSlot[];
  /**
   * The slot being moved, and the file `extract_document` is to read. Both are
   * null for an application transition, and both are prepared before the state
   * change for the same reason the pack is: an upload with no file behind it
   * has to refuse rather than leave a slot claiming a document nobody sent.
   */
  readonly slot: DocumentSlotSubject | null;
  readonly upload: PreparedUpload | null;
  /**
   * The facility `create_loan` is to open, resolved from the application BEFORE
   * the state change (see `resolveLoanTerms`).
   *
   * Null for every transition that does not fund. Prepared by the caller for
   * the same reason the document pack is: terms that cannot be assembled have
   * to refuse the transition, and by the time a runner is called the
   * application has already moved to `funded` -- which is precisely the state
   * this effect exists to keep honest.
   */
  readonly loanTerms: LoanTerms | null;
  /**
   * The request being disbursed and the facility it draws against. Both null
   * for every transition of the other two machines.
   *
   * Unlike the pack and the loan terms, these need no preparation: they are the
   * subject the adjudicator already loaded and the loan it already resolved to
   * decide who may act. There is nothing here that could fail to assemble, so
   * nothing is refused ahead of the state change on their account.
   */
  readonly release: CreditReleaseSubject | null;
  readonly loan: LoanSubject | null;
}

export type EffectOutcome =
  | {
      readonly ok: true;
      /**
       * Where the subject ended up, when an effect moved it further than the
       * transition did. `extract_document` does: a slot that has just been
       * uploaded to is extracted from immediately, so the state the caller must
       * be told about is the one after the effect, not the one before it.
       */
      readonly subject: SubjectSnapshot | null;
    }
  | { readonly ok: false; readonly kind: EffectKind; readonly reason: string };

type EffectRunner = (
  client: DatabaseClient,
  context: EffectContext,
) => Promise<SubjectSnapshot | null>;

/**
 * The extractor this API ships with.
 *
 * One line, and it is the seam: a real OCR service arrives by replacing this
 * binding, and nothing else in the file changes. See lib/extraction.ts for why
 * the stub is stated rather than hidden.
 */
const extractor: Extractor = stubExtractor;

/**
 * The evaluation as jsonb.
 *
 * `ProductEligibility[]` is JSON by construction: `RuleResult` was designed so
 * that every field is present and every absence is null, precisely so that a
 * snapshot stores and reads back as the same object. TypeScript cannot infer
 * that from a type carrying `Record<string, unknown>`, so the fact is asserted
 * once, here, rather than at a call site where it would be invisible.
 */
function asJson(eligibility: readonly ProductEligibility[]): Json {
  return eligibility as unknown as Json;
}

async function writeEligibilitySnapshot(
  client: DatabaseClient,
  context: EffectContext,
): Promise<SubjectSnapshot | null> {
  const written = await insertEligibilitySnapshot(client, {
    applicationId: context.applicationId,
    revision: context.revision,
    eligibility: asJson(context.eligibility),
  });
  if (written === null) {
    // PostgREST accepted the statement and returned no row. Nothing can be
    // said about whether it landed, so it is reported as a failure: a snapshot
    // that might not exist is not a snapshot.
    throw new Error('the insert returned no row');
  }
  return null;
}

/**
 * Generate the checklist the product asks for.
 *
 * Idempotent by the unique constraint on (application_id, code) rather than by
 * checking first: a check-then-insert is a race, and the failure it produces is
 * a doubled checklist nobody can explain. `insertDocumentSlots` therefore
 * returns the rows THIS call inserted, which is empty on a retry -- so an empty
 * result is not evidence of anything, and the pack is read back to tell a retry
 * apart from a write that did not land. Moving an application to `docs_pending`
 * with no checklist is the one outcome this effect exists to prevent.
 */
async function createDocumentSlots(
  client: DatabaseClient,
  context: EffectContext,
): Promise<SubjectSnapshot | null> {
  if (context.requiredDocs.length === 0) {
    throw new Error('no document pack was prepared for this transition');
  }

  const inserted = await insertDocumentSlots(
    client,
    documentSlotRows(context.applicationId, context.requiredDocs),
  );
  if (inserted.length > 0) {
    return null;
  }

  const existing = await listDocumentSlots(client, context.applicationId);
  if (existing.length === 0) {
    throw new Error('the pack was neither inserted nor already present');
  }
  return null;
}

/**
 * Read the uploaded document, record what it says, and move the slot on.
 *
 * Three writes, in the only order that leaves a repairable failure at every
 * step. The upload row goes first because it is the record of what was
 * submitted and it is append-only -- there is no UPDATE grant on
 * `document_upload` for anyone, service role included, so `extracted` has to be
 * written AT INSERT or never. Then the slot moves `uploaded -> extracted`,
 * matched on the revision the transition just produced. Then the audit entry.
 *
 * The move is fired here rather than left to the client because `extract` is
 * the platform's own event: the machine names its actor `admin` because
 * `workflow_transition.actor_role` is not null and there is no `system` role,
 * and the log records `actor_id` and `actor_role` as null because no person was
 * behind it. A borrower cannot fire it and should not have to.
 *
 * A PARTIAL READ STILL ADVANCES THE SLOT. The fields that were not read surface
 * as completeness failures with a next action attached; refusing to advance
 * would leave the document in `uploaded` with nothing able to move it.
 */
async function extractDocument(
  client: DatabaseClient,
  context: EffectContext,
): Promise<SubjectSnapshot | null> {
  const { slot, upload } = context;
  if (slot === null || upload === null) {
    throw new Error('no uploaded file was prepared for this transition');
  }

  const extraction = await extractor.extract(
    {
      filename: upload.filename,
      storagePath: upload.storagePath,
      mime: upload.mime,
      bytes: upload.bytes,
    },
    { code: slot.code, label: slot.label, extractRequired: slot.extractRequired },
  );

  const recorded = await insertDocumentUpload(client, {
    slot_id: slot.id,
    storage_path: upload.storagePath,
    filename: upload.filename,
    bytes: upload.bytes,
    mime: upload.mime,
    extracted: extraction.fields as unknown as Json,
    extraction_state: extraction.state,
  });
  if (recorded === null) {
    throw new Error('the upload record returned no row');
  }

  const advanced = await advanceDocumentSlot(client, {
    slotId: slot.id,
    expectedRevision: context.revision,
    to: 'extracted',
    // Only when the document said so. Writing null otherwise would make an
    // expired certificate current again on its next extraction.
    ...(extraction.validUntil === null ? {} : { validUntil: extraction.validUntil }),
  });
  if (advanced === null) {
    throw new Error('the slot moved before its extraction could be recorded');
  }

  const appended = await appendWorkflowEvent(client, {
    machine: 'document_slot',
    subject_id: slot.id,
    from_state: 'uploaded',
    to_state: advanced.state,
    event: 'extract',
    actor_id: null,
    actor_role: null,
    payload: {
      revision: advanced.revision,
      extractor: 'stub',
      extraction_state: extraction.state,
    },
  });
  if (appended === null) {
    throw new Error('the extraction landed but its audit entry did not');
  }

  return advanced;
}

/**
 * Open the facility the application was approved for.
 *
 * One insert, and nothing decided here: the terms were resolved and checked
 * before the state change, so this runner writes what it was handed or fails
 * loudly. That is the same division `create_document_slots` keeps, and for the
 * same reason -- by the time it runs, the application says `funded`.
 *
 * There is no idempotency check and none is needed. `fund` leaves `approved`
 * only, so a repeat is refused by the machine with a state conflict before it
 * reaches an effect, and the revision-matched update is what makes two lender
 * tabs serialise. A check-then-insert here would add a race in place of a
 * guarantee that already holds one level up.
 */
async function createLoan(
  client: DatabaseClient,
  context: EffectContext,
): Promise<SubjectSnapshot | null> {
  const terms = context.loanTerms;
  if (terms === null) {
    throw new Error('no loan terms were prepared for this transition');
  }

  const opened = await insertLoan(client, loanInsertRow(terms));
  if (opened === null) {
    // PostgREST accepted the statement and returned no row, so nothing can be
    // said about whether the facility exists. Reported as a failure: a loan
    // that might be there is the state this effect exists to rule out.
    throw new Error('the insert returned no row');
  }
  return null;
}

/**
 * Record the money leaving the facility.
 *
 * ONE ENTRY, AND THE DATABASE ENFORCES IT. `ledger_entry.release_id` is UNIQUE,
 * so a second insert for one release is refused by Postgres rather than by this
 * function remembering to look first. That is deliberate and it is not merely
 * tidier: a check-then-insert is a race, and the failure it produces is a
 * doubled disbursement -- a balance nobody can explain, on a table that has no
 * UPDATE and no DELETE grant for anyone, service role included. A correction to
 * a ledger is a compensating entry, so the entry that must not be written twice
 * is the one it is cheapest to make impossible.
 *
 * THE AMOUNT IS POSITIVE because it is signed and a draw raises what is
 * outstanding. That sign convention is what lets `loan_balance_v` sum the
 * column rather than branch on `kind`, and it is why `kind` is a label for the
 * reader rather than an input to the arithmetic (0007_servicing.sql).
 *
 * `memo` is left null. The provenance is `release_id`, which is a join to the
 * borrower's own words about what the money was for; copying that text onto an
 * append-only row would put a second, uncorrectable copy of it in the one place
 * nothing can amend.
 *
 * WHAT IS NOT ATOMIC. This runs AFTER the state change, because PostgREST gives
 * each request its own transaction and the revision-matched UPDATE is the only
 * serialisation point available -- see the note on the transaction boundary in
 * src/routes/transition.ts. The ordering is the safe one of the two: a stale
 * revision writes no entry at all, and the failure that remains -- a release at
 * `funded` whose entry did not land -- is loud, detectable by joining the two
 * tables, and repairable by posting the entry that is known to be missing. The
 * other order would post money for a transition that then lost on the revision,
 * onto a table from which it could never be removed.
 *
 * Closing that window properly needs both statements inside one database
 * transaction, which means a `security definer` function called over PostgREST
 * RPC. That is a migration and it belongs to the data scope, not here.
 */
async function postLedgerEntry(
  client: DatabaseClient,
  context: EffectContext,
): Promise<SubjectSnapshot | null> {
  const { release, loan } = context;
  if (release === null || loan === null) {
    throw new Error('no credit release was prepared for this transition');
  }

  const posted = await insertLedgerEntry(client, {
    loan_id: loan.id,
    kind: 'draw',
    amount: moneyToNumericString(release.amount),
    // A calendar day, in UTC and stated rather than defaulted, for the reason
    // the document rules take today the same way: money moves on a day, and the
    // server's zone is an accident of where the request was answered.
    effective: todayInUtc(),
    release_id: release.id,
    memo: null,
  });
  if (posted === null) {
    // PostgREST accepted the statement and returned no row, so nothing can be
    // said about whether the money is on the ledger. Reported as a failure: an
    // entry that might exist is the one thing a ledger may not have.
    throw new Error('the insert returned no row');
  }
  return null;
}

const RUNNERS: Partial<Record<EffectKind, EffectRunner>> = {
  write_eligibility_snapshot: writeEligibilitySnapshot,
  create_document_slots: createDocumentSlots,
  extract_document: extractDocument,
  create_loan: createLoan,
  post_ledger_entry: postLedgerEntry,
};

/** The kinds this API has an implementation for. Derived, never restated. */
export const RUNNABLE_EFFECT_KINDS: ReadonlySet<EffectKind> = new Set(
  Object.keys(RUNNERS) as EffectKind[],
);

/** Whether a transition declares one particular effect. */
export function declaresEffect(
  effects: readonly EffectSpec[],
  kind: EffectKind,
): boolean {
  return effects.some((effect) => effect.kind === kind);
}

/** The declared kinds this API has no implementation for, in declared order. */
export function unrunnableEffects(effects: readonly EffectSpec[]): readonly EffectKind[] {
  return effects
    .map((effect) => effect.kind)
    .filter((kind) => !RUNNABLE_EFFECT_KINDS.has(kind));
}

/**
 * Carry out the declared effects, in the order the transition declares them.
 *
 * Stops at the first failure and names the kind that failed. The caller has
 * already moved the state by the time this runs -- see the note on the
 * transaction boundary in src/routes/transition.ts -- so "which one" is what a
 * person repairing the row needs to know.
 *
 * The database's own message is logged and never returned: it quotes
 * constraints and column names, and a response body is not the place to publish
 * the schema.
 */
export async function runEffects(
  client: DatabaseClient,
  effects: readonly EffectSpec[],
  context: EffectContext,
): Promise<EffectOutcome> {
  let subject: SubjectSnapshot | null = null;

  for (const effect of effects) {
    const runner = RUNNERS[effect.kind];
    if (runner === undefined) {
      // Unreachable: unrunnableEffects refuses the transition before the
      // update. Stated rather than assumed, because the alternative to this
      // branch is a silently skipped effect.
      return { ok: false, kind: effect.kind, reason: 'this API has no runner for it' };
    }
    try {
      subject = (await runner(client, context)) ?? subject;
    } catch (error: unknown) {
      const described = error instanceof Error ? error.name + ': ' + error.message : 'unknown';
      console.error("effect '" + effect.kind + "' failed: " + described);
      return { ok: false, kind: effect.kind, reason: 'the write did not land' };
    }
  }
  return { ok: true, subject };
}
