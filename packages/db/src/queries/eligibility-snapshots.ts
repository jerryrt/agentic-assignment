/**
 * What the borrower was told when they submitted, kept as it was said.
 *
 * `plan/05-option2-application.md` asks for one row per submit so that a lender
 * reading a file later sees the criteria as they stood at the time, even after
 * a product's thresholds have been edited.  The row is written by the API,
 * inside the `write_eligibility_snapshot` effect the `submit` transition
 * declares, and read by both audiences afterwards.
 *
 * Append-only, and meant literally.  There is no update helper and no delete
 * helper, and there will not be one: `0005_application_submit.sql` withholds
 * both grants from every role including `service_role`, so a helper that
 * offered either would be offering a statement the database refuses.  A
 * snapshot that can be edited is not a snapshot.
 *
 * `eligibility` is typed as `Json` rather than as `ProductEligibility[]`.  That
 * type belongs to packages/rules, which sits ABOVE this layer, and importing it
 * here would point a dependency the wrong way (CLAUDE.md section 8).  The API
 * knows what it stored; this module knows only that it is jsonb.
 */

import type { DatabaseClient } from '../client.ts';
import type { Database, Json } from '../database.types.ts';
import { unwrapList, unwrapMaybe } from '../errors.ts';

type EligibilitySnapshotTable = Database['public']['Tables']['eligibility_snapshot'];

/** One evaluation, as it stood at one submission. */
export type EligibilitySnapshot = EligibilitySnapshotTable['Row'];

/** What taking a snapshot needs. */
export interface EligibilitySnapshotRecord {
  readonly applicationId: string;
  /**
   * The application's revision as it stands submitted.
   *
   * Paired with the application id it identifies the submission, and the
   * database holds a unique constraint on the pair.  A second write at the same
   * revision therefore FAILS rather than quietly adding a row, which is what
   * keeps "what was the borrower told when they submitted" a question with one
   * answer.
   */
  readonly revision: number;
  /** The evaluated `ProductEligibility[]`, as produced by packages/rules. */
  readonly eligibility: Json;
}

/**
 * Take one snapshot.
 *
 * Throws rather than returning null when the row cannot be written -- a unique
 * violation, a foreign key that no longer resolves -- because the caller has
 * already moved the application to `submitted` by the time this runs and must
 * be able to tell "written" from "not written".  `unwrapMaybe` is what does the
 * throwing; the null it can still return means PostgREST accepted the insert
 * and returned no row, which the caller treats the same way.
 */
export async function insertEligibilitySnapshot(
  client: DatabaseClient,
  record: EligibilitySnapshotRecord,
): Promise<EligibilitySnapshot | null> {
  return unwrapMaybe(
    'eligibility_snapshot.insert',
    await client
      .from('eligibility_snapshot')
      .insert({
        application_id: record.applicationId,
        revision: record.revision,
        eligibility: record.eligibility,
      })
      .select('*')
      .maybeSingle(),
  );
}

/**
 * One application's snapshots, oldest first.
 *
 * Ordered by `revision` rather than by `created_at` or by `id`: the revision
 * only ever increases, it is unique per application, and it is what the
 * snapshot is keyed on.  `created_at` can tie and `id` is a random uuid, so
 * neither orders anything.  The newest snapshot is therefore the last element.
 *
 * An empty list is the ordinary answer twice over -- an application that has
 * never been submitted has none, and a caller no policy admits reads none --
 * and the two are deliberately indistinguishable.
 */
export async function listEligibilitySnapshots(
  client: DatabaseClient,
  applicationId: string,
): Promise<readonly EligibilitySnapshot[]> {
  return unwrapList(
    'eligibility_snapshot.list',
    await client
      .from('eligibility_snapshot')
      .select('*')
      .eq('application_id', applicationId)
      .order('revision', { ascending: true }),
  );
}
