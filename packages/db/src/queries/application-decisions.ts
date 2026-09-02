/**
 * The lender-only half of a decision.
 *
 * `decision_note` and `risk_grade` are a table rather than two columns on
 * `application` because row-level security filters ROWS and never COLUMNS:
 * PostgREST publishes the base table, so a borrower holding a select policy on
 * their own application row would read those columns straight off it however
 * carefully `application_borrower_v` omitted them.  `0001_init.sql` carries the
 * full reasoning.  The consequence for this module is that the access rule is
 * `application_decision_read_as_lender` and nothing here -- there is no filter
 * below that a caller could omit and no filter that would add a second gate.
 *
 * One row per application, so every helper is keyed on `application_id` and
 * `maybeSingle()` is always the right cardinality.  A `null` result is the
 * ordinary answer twice over: an application awaiting a decision has no row,
 * and a caller no policy admits reads no row -- indistinguishable from outside,
 * and deliberately so.
 */

import type { DatabaseClient } from '../client.js';
import type { Database } from '../database.types.js';
import { unwrapMaybe } from '../errors.js';

/** Postgres unique_violation; here it means the decision already exists. */
const UNIQUE_VIOLATION = '23505';

type ApplicationDecisionTable = Database['public']['Tables']['application_decision'];

/** The lender-only fields, plus who recorded them and when. */
export type ApplicationDecision = ApplicationDecisionTable['Row'];

/**
 * What recording a decision needs.
 *
 * The generated `Insert` type is deliberately not exported and not accepted
 * here.  It makes `decided_by` optional, because the column is nullable, and a
 * caller taking that at face value would compose an insert that every client
 * write must fail: `application_decision_insert_as_lender` pins `decided_by` to
 * `auth.uid()`, and a null never equals it.  Requiring the field turns that
 * into a compile error instead of a 42501 at run time.
 *
 * `decisionNote` and `riskGrade` stay nullable: a lender may grade a file
 * before writing the note, or the reverse, and the schema allows both.
 */
export interface ApplicationDecisionRecord {
  readonly applicationId: string;
  /**
   * The lender the decision is attributed to.
   *
   * Taken as an argument rather than derived here, for two reasons.  This layer
   * cannot see `auth.uid()` -- it would have to ask the auth server for it, a
   * network round trip to learn something the caller already knows -- and the
   * API's service-role client bypasses RLS entirely, so for that path nothing
   * would pin the column at all and the attribution would silently be null.  A
   * missing attribution in an audit trail is the failure this column exists to
   * prevent, so the value is required and every call site states it.
   *
   * That is not a second enforcement point.  For a user client the policy still
   * decides, and a forged value is refused by Postgres; requiring the argument
   * only stops the write that could never have succeeded.
   */
  readonly decidedBy: string;
  readonly decisionNote: string | null;
  readonly riskGrade: string | null;
}

/**
 * The decision recorded against one application, or `null` if there is none
 * the caller may read.
 */
export async function getApplicationDecision(
  client: DatabaseClient,
  applicationId: string,
): Promise<ApplicationDecision | null> {
  return unwrapMaybe(
    'application_decision.get',
    await client
      .from('application_decision')
      .select('*')
      .eq('application_id', applicationId)
      .maybeSingle(),
  );
}

/**
 * Record a decision, or amend the one already recorded.
 *
 * Insert first and fall back to an update on a unique violation, rather than an
 * upsert.  PostgREST compiles an upsert to `on conflict do update set` over
 * every column in the payload, `application_id` included, so it requires update
 * privilege on the primary key.  `0002_rls.sql` deliberately withholds that:
 * with no DELETE granted to anyone, repointing a decision at a sibling
 * application is the only way a lender could make a note disappear from a file,
 * and that is an audit-erasure path rather than a convenience.
 *
 * The race is real but benign and self-correcting: two concurrent first
 * decisions produce one insert and one unique violation, and the loser amends
 * what the winner wrote, which is the same outcome as arriving second.
 *
 * `recorded_at` is never sent. A trigger stamps it on insert and on update,
 * because the column default fires only on insert and an amended note would
 * otherwise keep the instant of the original decision and misdate the trail.
 * The same reason it stays out of the update grant: an audit timestamp the
 * writer chooses is not an audit timestamp.
 */
export async function recordApplicationDecision(
  client: DatabaseClient,
  record: ApplicationDecisionRecord,
): Promise<ApplicationDecision | null> {
  const inserted = await client
    .from('application_decision')
    .insert({
      application_id: record.applicationId,
      decided_by: record.decidedBy,
      decision_note: record.decisionNote,
      risk_grade: record.riskGrade,
    })
    .select('*')
    .maybeSingle();

  // 23505 is unique_violation: a decision already exists, so this is an amendment.
  if (inserted.error === null || inserted.error.code !== UNIQUE_VIOLATION) {
    return unwrapMaybe('application_decision.record', inserted);
  }

  return unwrapMaybe(
    'application_decision.amend',
    await client
      .from('application_decision')
      .update({
        decided_by: record.decidedBy,
        decision_note: record.decisionNote,
        risk_grade: record.riskGrade,
      })
      .eq('application_id', record.applicationId)
      .select('*')
      .maybeSingle(),
  );
}
