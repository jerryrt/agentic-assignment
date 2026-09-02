/**
 * Credit releases: the request to draw against a facility, its two
 * projections, and the lender's private note.
 *
 * This is the one place in Option 3 a client writes.  The grants in
 * `0007_servicing.sql` decide how far that goes, and the helpers below are
 * shaped by them rather than by convenience:
 *
 *   - a borrower may INSERT a draft against their own loan and UPDATE
 *     `amount`, `purpose` and `revision` while it is still a draft.  That is
 *     the compose-and-autosave path -- the row exists from the first keystroke,
 *     so the URL names it and a refresh mid-compose loses nothing.
 *   - no client holds a privilege on `state`, `decided_by` or
 *     `decline_reason`.  Moving a release is a transition, and transitions go
 *     through `POST /api/transition`, which re-checks the actor's role against
 *     the machine and is re-checked by `assert_legal_transition`.
 *   - `internal_note` is not on this table at all.  It is a row in
 *     `credit_release_note`, whose policies admit a lender at the loan's
 *     organisation and nobody else -- because row-level security filters rows
 *     and never columns, so a lender-only COLUMN would be readable by any
 *     caller the row policy admits, whatever a projection omitted.
 *
 * Money crosses this boundary as TEXT, for the reason `./loans.ts` sets out at
 * length: PostgREST renders `numeric` as a JSON number, so an uncast select
 * hands the caller a binary double and looks correct doing it.  Every select
 * list here is written out so that `amount` can carry `::text`.
 */

import type { DatabaseClient } from '../client.ts';
import type { Database } from '../database.types.ts';
import { unwrapList, unwrapMaybe } from '../errors.ts';

type ReleaseTable = Database['public']['Tables']['credit_release'];
type NoteTable = Database['public']['Tables']['credit_release_note'];

/**
 * Money goes IN as text as well as out, for the reason `./loans.ts` sets out:
 * the generated types say `number` because Postgres reports a numeric column,
 * PostgREST accepts the exact decimal string, and passing the float the
 * generated type asks for would put the rounding error back at the write.
 */
export type CreditReleaseInsert = Omit<ReleaseTable['Insert'], 'amount'> & {
  readonly amount: string;
};

export type CreditReleaseUpdate = Omit<ReleaseTable['Update'], 'amount'> & {
  readonly amount?: string;
};
export type CreditReleaseNoteRow = NoteTable['Row'];
export type CreditReleaseNoteInsert = NoteTable['Insert'];

/** The base row, with `amount` as the exact decimal text Postgres rendered. */
export type CreditReleaseRow = Omit<ReleaseTable['Row'], 'amount'> & {
  readonly amount: string;
};

/**
 * `credit_release_borrower_v`.  Structurally the base row, and that is the
 * contract: the projection withholds nothing, because there is nothing on the
 * base table to withhold.
 */
export type CreditReleaseBorrowerRow = CreditReleaseRow;

/**
 * `credit_release_lender_v`: the release, the lender-only note, and the two
 * names.
 *
 * Every column is nullable because Postgres reports no not-null constraint
 * through a view -- and for the added columns the nullability is real. The view
 * is `security_invoker` and left-joins both the note and the deciding lender's
 * profile, so a caller whose policies do not admit those rows reads them as
 * null rather than getting a permission error.  A borrower who reads this view
 * therefore sees their own release with the lender-only half empty.
 */
export interface CreditReleaseLenderRow {
  readonly id: string | null;
  readonly loan_id: string | null;
  readonly amount: string | null;
  readonly purpose: string | null;
  readonly state: string | null;
  readonly revision: number | null;
  readonly requested_by: string | null;
  readonly decided_by: string | null;
  readonly decline_reason: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly borrower_id: string | null;
  readonly org_id: string | null;
  readonly internal_note: string | null;
  readonly note_recorded_by: string | null;
  readonly note_recorded_at: string | null;
  readonly requested_by_name: string | null;
  readonly decided_by_name: string | null;
}

/**
 * What a release write returns.
 *
 * Four columns rather than the row, for the reason `DocumentSlotWriteAck`
 * gives: these are what a caller needs to reconcile its local copy, and echoing
 * back the purpose text it has just sent is noise on every keystroke.
 */
export type CreditReleaseWriteAck = Pick<
  ReleaseTable['Row'],
  'id' | 'loan_id' | 'state' | 'revision'
>;

const RELEASE_WRITE_ACK_COLUMNS = 'id, loan_id, state, revision';

const RELEASE_COLUMNS =
  'id, loan_id, amount::text, purpose, state, revision, requested_by, decided_by, ' +
  'decline_reason, created_at, updated_at';

const LENDER_VIEW_COLUMNS =
  RELEASE_COLUMNS +
  ', borrower_id, org_id, internal_note, note_recorded_by, note_recorded_at, ' +
  'requested_by_name, decided_by_name';

/**
 * The states in which a release holds credit that has not moved yet.
 *
 * The same three `loan_balance_v` sums over and
 * `PENDING_CREDIT_RELEASE_STATES` names in `@lj/domain`.  Repeated here as
 * literals rather than imported, because this is a PostgREST filter value and
 * not a decision: what counts as pending is decided in the domain layer and in
 * the view, and if these three ever disagreed with those, the view is right.
 */
const PENDING_STATES = ['submitted', 'under_review', 'approved'];

/**
 * One loan's releases, newest first, off the base table.
 *
 * The base table rather than a projection, because this is the helper the API
 * reads a subject through -- it needs `revision` and the row as it stands, not
 * an audience's reading of it.  Screens use the two projections below.
 */
export async function listCreditReleases(
  client: DatabaseClient,
  loanId: string,
): Promise<readonly CreditReleaseRow[]> {
  return unwrapList(
    'credit_release.list',
    await client
      .from('credit_release')
      .select(RELEASE_COLUMNS)
      .eq('loan_id', loanId)
      .order('created_at', { ascending: false })
      .returns<CreditReleaseRow[]>(),
  );
}

export async function getCreditRelease(
  client: DatabaseClient,
  releaseId: string,
): Promise<CreditReleaseRow | null> {
  return unwrapMaybe(
    'credit_release.get',
    await client
      .from('credit_release')
      .select(RELEASE_COLUMNS)
      .eq('id', releaseId)
      .maybeSingle()
      .returns<CreditReleaseRow>(),
  );
}

/**
 * Start a request.  Reachable by the borrower themselves, not only by the API.
 *
 * `state` is absent from the client's INSERT grant, so a client-created row can
 * only take the `draft` default however the payload is shaped; the insert
 * policy additionally pins `requested_by` to the caller and the loan to a loan
 * the caller owns as its BORROWER.  A lender can see the same loan, and a
 * lender inserting here would be fabricating a borrower's request.
 */
export async function insertCreditRelease(
  client: DatabaseClient,
  values: CreditReleaseInsert,
): Promise<CreditReleaseWriteAck | null> {
  return unwrapMaybe(
    'credit_release.insert',
    await client
      .from('credit_release')
      // The cast is the money-as-text decision above, made visible: the
      // generated Insert type asks for a number and the wire wants the exact
      // decimal.  Postgres validates the payload either way, so what is
      // asserted away is a type that is wrong rather than a check.
      .insert(values as unknown as ReleaseTable['Insert'])
      .select(RELEASE_WRITE_ACK_COLUMNS)
      .maybeSingle(),
  );
}

export interface CreditReleaseUpdateRequest {
  readonly releaseId: string;
  /**
   * The `revision` the caller last read.  The update matches no row if it has
   * moved on, which is what makes two lender tabs approving one release
   * serialise rather than race -- the same optimistic concurrency `application`
   * and `document_slot` use.
   */
  readonly expectedRevision: number;
  readonly patch: CreditReleaseUpdate;
}

/**
 * Apply a patch to one release, bumping the revision.
 *
 * Returns `null` when nothing matched, which is the interesting outcome: the
 * revision moved, or the policies did not permit the write.  The caller
 * reconciles; this layer will not guess which.
 *
 * `revision` and `updated_at` in the caller's patch are overwritten -- they are
 * bookkeeping this helper owns, and letting a caller set them would let a
 * client freeze the revision and defeat the guard.  Whether a state change is
 * ALLOWED is not decided here either: the machine in `@lj/workflow` decides it
 * and `assert_legal_transition` re-checks it, and a rule in this layer would be
 * a third copy of the first.
 */
export async function updateCreditRelease(
  client: DatabaseClient,
  request: CreditReleaseUpdateRequest,
): Promise<CreditReleaseWriteAck | null> {
  return unwrapMaybe(
    'credit_release.update',
    await client
      .from('credit_release')
      .update({
        ...request.patch,
        revision: request.expectedRevision + 1,
        updated_at: new Date().toISOString(),
      } as unknown as ReleaseTable['Update'])
      .eq('id', request.releaseId)
      .eq('revision', request.expectedRevision)
      .select(RELEASE_WRITE_ACK_COLUMNS)
      .maybeSingle(),
  );
}

/**
 * Abandon a draft.
 *
 * Confined to the borrower's own unsubmitted draft by the delete policy, which
 * is why the machine has no transition out of `draft` other than `submit`: a
 * draft nobody has seen is deleted, and a cancelled record nobody ever read is
 * noise in a timeline.  Returns whether a row went, so a caller can tell a
 * refused delete from a repeated one.
 */
export async function deleteCreditReleaseDraft(
  client: DatabaseClient,
  releaseId: string,
): Promise<boolean> {
  const deleted = unwrapList(
    'credit_release.delete',
    await client.from('credit_release').delete().eq('id', releaseId).select('id'),
  );
  return deleted.length > 0;
}

/** One loan's releases as the borrower's screen reads them, newest first. */
export async function listCreditReleasesForBorrower(
  client: DatabaseClient,
  loanId: string,
): Promise<readonly CreditReleaseBorrowerRow[]> {
  return unwrapList(
    'credit_release_borrower_v.list',
    await client
      .from('credit_release_borrower_v')
      .select(RELEASE_COLUMNS)
      .eq('loan_id', loanId)
      .order('created_at', { ascending: false })
      .returns<CreditReleaseBorrowerRow[]>(),
  );
}

export async function getCreditReleaseForBorrower(
  client: DatabaseClient,
  releaseId: string,
): Promise<CreditReleaseBorrowerRow | null> {
  return unwrapMaybe(
    'credit_release_borrower_v.get',
    await client
      .from('credit_release_borrower_v')
      .select(RELEASE_COLUMNS)
      .eq('id', releaseId)
      .maybeSingle()
      .returns<CreditReleaseBorrowerRow>(),
  );
}

/**
 * The lender's work queue: every request that still holds credit, oldest
 * first.
 *
 * Oldest first is the default because the queue is judged on whether a loan
 * officer can move through it quickly, and the request that has waited longest
 * is the one that costs the most to leave (plan/06).  Rows come from the
 * policies -- a lender sees their organisation's -- so there is no
 * organisation filter here to forget.
 */
export async function listCreditReleaseQueue(
  client: DatabaseClient,
): Promise<readonly CreditReleaseLenderRow[]> {
  return unwrapList(
    'credit_release_lender_v.queue',
    await client
      .from('credit_release_lender_v')
      .select(LENDER_VIEW_COLUMNS)
      .in('state', PENDING_STATES)
      .order('created_at', { ascending: true })
      .returns<CreditReleaseLenderRow[]>(),
  );
}

export async function getCreditReleaseForLender(
  client: DatabaseClient,
  releaseId: string,
): Promise<CreditReleaseLenderRow | null> {
  return unwrapMaybe(
    'credit_release_lender_v.get',
    await client
      .from('credit_release_lender_v')
      .select(LENDER_VIEW_COLUMNS)
      .eq('id', releaseId)
      .maybeSingle()
      .returns<CreditReleaseLenderRow>(),
  );
}

/**
 * One loan's releases as the lender's file view reads them, newest first --
 * including the settled ones the queue filters out.
 */
export async function listCreditReleasesForLender(
  client: DatabaseClient,
  loanId: string,
): Promise<readonly CreditReleaseLenderRow[]> {
  return unwrapList(
    'credit_release_lender_v.list',
    await client
      .from('credit_release_lender_v')
      .select(LENDER_VIEW_COLUMNS)
      .eq('loan_id', loanId)
      .order('created_at', { ascending: false })
      .returns<CreditReleaseLenderRow[]>(),
  );
}

/**
 * The lender's private note on one release.
 *
 * A separate read rather than a column on the release, and that separation is
 * the security property: a borrower calling this gets `null`, because no policy
 * on `credit_release_note` admits them -- not because a view left a column out.
 */
export async function getCreditReleaseNote(
  client: DatabaseClient,
  releaseId: string,
): Promise<CreditReleaseNoteRow | null> {
  return unwrapMaybe(
    'credit_release_note.get',
    await client
      .from('credit_release_note')
      .select('*')
      .eq('release_id', releaseId)
      .maybeSingle(),
  );
}

/**
 * Write, or amend, the lender's note.  Client-callable by a lender.
 *
 * One call either way, because there is at most one note per release and a
 * lender typing into an empty box must not have to know whether they are
 * creating or amending it.  This is plan/06's third refresh case: a lender who
 * has typed a note and not yet decided keeps it, debounced to the row, exactly
 * as a borrower keeps a draft -- and it is safe to autosave client-side
 * precisely because a borrower has no policy on this table at all.
 *
 * It is an UPDATE-then-INSERT rather than a real upsert, and that is a
 * consequence of the grants rather than a preference.  PostgREST's upsert
 * issues `ON CONFLICT ... DO UPDATE SET` for every column in the payload,
 * including the conflict key itself, so it requires an UPDATE privilege on
 * `release_id`.  Granting one would reopen exactly the hole the per-column
 * grant closes: a lender could repoint a note at another release of the same
 * organisation, and both sides would satisfy the row policy, so a note could be
 * moved between files unremarked.  A real upsert here would cost a security
 * property to save a round trip.
 *
 * The read-then-write is not a race in the damaging direction.  Two lenders
 * writing the first note at the same instant both find nothing and both insert;
 * the primary key refuses the second, which surfaces as a duplicate-key error
 * and is answered by calling again.  What cannot happen is two notes on one
 * release, because that is a fact of the schema.
 *
 * `recorded_at` is deliberately not settable: the trigger overwrites it, so a
 * value passed here would be a value silently discarded, and the point of the
 * trigger is that an audit timestamp is not the writer's to choose.
 */
export async function upsertCreditReleaseNote(
  client: DatabaseClient,
  values: CreditReleaseNoteInsert,
): Promise<CreditReleaseNoteRow | null> {
  const amended = unwrapMaybe(
    'credit_release_note.update',
    await client
      .from('credit_release_note')
      // Only the two columns a lender holds an UPDATE privilege on. `?? null`
      // rather than leaving the key out: clearing a note is a thing a lender
      // does, and an absent key would mean "keep what is there".
      .update({ internal_note: values.internal_note ?? null, recorded_by: values.recorded_by })
      .eq('release_id', values.release_id)
      .select('*')
      .maybeSingle(),
  );
  if (amended !== null) {
    return amended;
  }
  return unwrapMaybe(
    'credit_release_note.insert',
    await client.from('credit_release_note').insert(values).select('*').maybeSingle(),
  );
}
