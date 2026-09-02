/**
 * The application aggregate, and the two projections over it.
 *
 * `plan/02-domain-model.md` implements "two roles, two truths" as two views:
 * `application_borrower_v` projects no `decision_note` and no `risk_grade`;
 * `application_lender_v` projects both, plus the borrower's name.  What
 * ENFORCES that is neither view -- both run with `security_invoker` and carry
 * no predicate -- but the row policy on `application_decision`, the table those
 * two fields live in.  The views decide the shape each audience reads; the
 * policy decides what is in it.  The job of this module is to make the shape
 * hard to get wrong by accident, which it does in three ways:
 *
 *   - there is no helper that takes a view name, or a table name, as a string,
 *     so no call site can drift onto the lender view by editing a literal;
 *   - the lender helpers say `Lender` in their names and return a type whose
 *     lender-only columns are visible at every call site;
 *   - the one helper that chooses between them, `getApplicationForAudience`,
 *     is keyed on the audience and returns the type that matches it, so a
 *     caller holding a borrower cannot be handed lender columns.
 *
 * Reads of the base `application` table are deliberately absent.  Everything
 * readable is read through a projection; only writes address the table.  That
 * is a legibility choice rather than a containment one: a caller that reached
 * for the table would get exactly the columns the borrower view has, because
 * the lender-only fields are not there to be read.
 */

import type { DatabaseClient } from '../client.ts';
import type { Database, Json } from '../database.types.ts';
import { unwrapList, unwrapMaybe } from '../errors.ts';

type ApplicationTable = Database['public']['Tables']['application'];

/** What a borrower may see.  No decision note, no risk grade. */
export type BorrowerApplication =
  Database['public']['Views']['application_borrower_v']['Row'];

/** What a lender may see.  Adds the decision note, the risk grade and the borrower's name. */
export type LenderApplication =
  Database['public']['Views']['application_lender_v']['Row'];

/**
 * The two audiences the projections exist for.
 *
 * `admin` is absent on purpose: `app_role` has three values but only two
 * views, and inventing an admin projection here would put a policy decision in
 * the persistence layer.  An admin route picks the projection it means.
 */
export type ApplicationAudience = 'borrower' | 'lender';

interface ApplicationByAudience {
  readonly borrower: BorrowerApplication;
  readonly lender: LenderApplication;
}

/** The row type that goes with an audience. */
export type ApplicationFor<TAudience extends ApplicationAudience> =
  ApplicationByAudience[TAudience];

/**
 * What a write returns.
 *
 * Four columns, listed explicitly, rather than the whole row.  Nothing on the
 * base table is confidential any more -- `decision_note` and `risk_grade` are
 * rows in `application_decision` now -- so this is no longer a containment
 * measure; it is that these four are what a caller needs to reconcile its local
 * copy, and returning a `data` blob the caller just sent is noise on every
 * autosave.
 */
export type ApplicationWriteAck = Pick<
  ApplicationTable['Row'],
  'id' | 'state' | 'revision' | 'updated_at'
>;

const WRITE_ACK_COLUMNS = 'id, state, revision, updated_at';

export type ApplicationInsert = ApplicationTable['Insert'];
export type ApplicationUpdate = ApplicationTable['Update'];

/**
 * `select('*')` is correct against a view: the view is the projection, so
 * widening the select list cannot widen what comes back, and naming the columns
 * here would be a second copy of the view definition for the migration to drift
 * from (CLAUDE.md section 9).
 */
const ALL_PROJECTED_COLUMNS = '*';

/** One application, as its borrower may see it. */
export async function getBorrowerApplication(
  client: DatabaseClient,
  applicationId: string,
): Promise<BorrowerApplication | null> {
  return unwrapMaybe(
    'application_borrower_v.get',
    await client
      .from('application_borrower_v')
      .select(ALL_PROJECTED_COLUMNS)
      .eq('id', applicationId)
      .maybeSingle(),
  );
}

/**
 * Every application belonging to one borrower, most recently touched first --
 * which is the order the borrower's dashboard reads them in.
 *
 * The `borrower_id` filter is not the access control; the policy is.  It is
 * here so that a lender or an admin calling this helper gets the one
 * borrower's applications rather than every application they are entitled to.
 */
export async function listBorrowerApplications(
  client: DatabaseClient,
  borrowerId: string,
): Promise<readonly BorrowerApplication[]> {
  return unwrapList(
    'application_borrower_v.list',
    await client
      .from('application_borrower_v')
      .select(ALL_PROJECTED_COLUMNS)
      .eq('borrower_id', borrowerId)
      .order('updated_at', { ascending: false }),
  );
}

/** One application, as a lender may see it.  Includes the decision note and risk grade. */
export async function getLenderApplication(
  client: DatabaseClient,
  applicationId: string,
): Promise<LenderApplication | null> {
  return unwrapMaybe(
    'application_lender_v.get',
    await client
      .from('application_lender_v')
      .select(ALL_PROJECTED_COLUMNS)
      .eq('id', applicationId)
      .maybeSingle(),
  );
}

/**
 * One organisation's queue, as a lender may see it.
 *
 * Ordered by `submitted_at` because the queue is a work list and the oldest
 * submission is the one waiting longest.  Nulls -- drafts, which a lender's
 * policy will not return anyway -- sort last rather than leading the queue.
 */
export async function listLenderApplications(
  client: DatabaseClient,
  orgId: string,
): Promise<readonly LenderApplication[]> {
  return unwrapList(
    'application_lender_v.list',
    await client
      .from('application_lender_v')
      .select(ALL_PROJECTED_COLUMNS)
      .eq('org_id', orgId)
      .order('submitted_at', { ascending: true, nullsFirst: false }),
  );
}

/**
 * One application, projected for whoever is asking.
 *
 * This is the helper an API handler should reach for: it takes the audience it
 * has already established from `profile.role` and returns the matching row
 * type, so choosing the projection and knowing what is in it are the same
 * decision rather than two that can disagree.
 */
export async function getApplicationForAudience<TAudience extends ApplicationAudience>(
  client: DatabaseClient,
  audience: TAudience,
  applicationId: string,
): Promise<ApplicationFor<TAudience> | null> {
  // The two branches produce different row types, and TypeScript cannot relate
  // either back to the caller's TAudience through a runtime comparison. The
  // correspondence is asserted once, here, where both sides are visible in one
  // screen, rather than at every call site.
  if (audience === 'lender') {
    const row = await getLenderApplication(client, applicationId);
    return row as ApplicationFor<TAudience> | null;
  }
  const row = await getBorrowerApplication(client, applicationId);
  return row as ApplicationFor<TAudience> | null;
}

/** Create an application.  The state defaults to `draft` in the schema. */
export async function insertApplication(
  client: DatabaseClient,
  values: ApplicationInsert,
): Promise<ApplicationWriteAck | null> {
  return unwrapMaybe(
    'application.insert',
    await client.from('application').insert(values).select(WRITE_ACK_COLUMNS).maybeSingle(),
  );
}

/** An update guarded by the revision the caller believes it is holding. */
export interface ApplicationUpdateRequest {
  readonly applicationId: string;
  /**
   * The `revision` the caller last read.  The update matches no row if the
   * value has moved on, which is what makes this optimistic concurrency rather
   * than last-write-wins -- see `plan/02-domain-model.md`.
   */
  readonly expectedRevision: number;
  readonly patch: ApplicationUpdate;
}

/**
 * Apply a patch to one application, bumping the revision.
 *
 * Returns `null` when nothing matched.  That is the interesting outcome: it
 * means either the revision moved -- a second tab, or a lender acting while
 * the borrower typed -- or the policies did not permit the write.  The caller
 * reconciles; this layer will not guess which.
 *
 * `revision` and `updated_at` in the caller's patch are overwritten. They are
 * bookkeeping this helper owns, and letting a caller set them would let a
 * client freeze the revision and defeat the guard above.
 *
 * What this helper deliberately does not do is decide whether the patch is
 * allowed.  A `state` change is adjudicated by the machine in
 * `packages/workflow` and re-checked by the `assert_legal_transition` trigger,
 * which fails the statement outright; a rule in this layer would be a second
 * copy of the first (CLAUDE.md sections 8 and 9).
 */
export async function updateApplication(
  client: DatabaseClient,
  request: ApplicationUpdateRequest,
): Promise<ApplicationWriteAck | null> {
  return unwrapMaybe(
    'application.update',
    await client
      .from('application')
      .update({
        ...request.patch,
        revision: request.expectedRevision + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', request.applicationId)
      .eq('revision', request.expectedRevision)
      .select(WRITE_ACK_COLUMNS)
      .maybeSingle(),
  );
}

/** The autosaved half of a draft: the form payload and the resume hint. */
export interface ApplicationDraftPatch {
  readonly applicationId: string;
  readonly expectedRevision: number;
  readonly data: Json;
  /** The furthest step reached, or `null` to leave the resume hint unset. */
  readonly furthestStep: string | null;
}

/**
 * The borrower's autosave path.
 *
 * Named separately from `updateApplication` because it is the one write the
 * browser makes directly, under the `app_borrower_draft_write` policy, and
 * because naming it stops the columns a draft may touch from being restated at
 * each call site.  It cannot move the state: the policy checks `state =
 * 'draft'` on both sides of the update and the transition trigger rejects the
 * change regardless.
 */
export async function saveApplicationDraft(
  client: DatabaseClient,
  patch: ApplicationDraftPatch,
): Promise<ApplicationWriteAck | null> {
  return updateApplication(client, {
    applicationId: patch.applicationId,
    expectedRevision: patch.expectedRevision,
    patch: { data: patch.data, furthest_step: patch.furthestStep },
  });
}
