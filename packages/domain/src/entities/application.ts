import { z } from 'zod';

import { JsonObjectSchema, TimestampSchema, UuidSchema } from '../primitives.js';
import { ApplicationStateSchema } from '../states.js';

/**
 * The aggregate root, the lender-only half of a decision, and the two
 * projections over them.
 *
 * "Two roles seeing different truths from the same data" is implemented in the
 * schema, not by hiding a field in a template (plan 02). The lender-only
 * fields are a separate TABLE rather than columns omitted from a view, because
 * row-level security filters rows and never columns: PostgREST publishes every
 * table in `public`, so a borrower holding a select policy on their own
 * application row could read those columns straight off the base table however
 * carefully a view omitted them. Splitting the table turns the column question
 * back into a row question, which is the shape RLS is good at.
 *
 * Zod strips unknown keys by default, and that default is doing security work
 * here: if a view ever regressed and started selecting a lender-only column,
 * the borrower schema would drop it on the way through rather than pass it to
 * a component that renders whatever it is given. The row policy is the
 * boundary; this is the second layer behind it.
 */
const applicationSharedColumns = {
  id: UuidSchema,
  borrower_id: UuidSchema,
  org_id: UuidSchema,
  state: ApplicationStateSchema,
  /** Optimistic concurrency. Every transition checks it; see plan 03. */
  revision: z.number().int().nonnegative(),
  /** The multi-step form payload. Its shape belongs to the form, not to the row. */
  data: JsonObjectSchema,
  /** Resume hint: the furthest step the applicant has completed. */
  furthest_step: z.string().nullable(),
  submitted_at: TimestampSchema.nullable(),
  /**
   * Stays on `application`, and is deliberately not moved into
   * `application_decision`: that an application was decided, and when, is a
   * fact the borrower is entitled to. Only the reasoning behind the decision
   * is lender-only.
   */
  decided_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
};

/**
 * The columns `application_decision` contributes, in the nullability the table
 * declares. Named once because both the table schema and the lender view are
 * built from them, and two hand-written copies would disagree the first time a
 * column moved.
 */
const applicationDecisionColumns = {
  decision_note: z.string().nullable(),
  risk_grade: z.string().nullable(),
  /** Null when a job rather than a person recorded the decision. */
  decided_by: UuidSchema.nullable(),
  /**
   * When the internal note was written -- not a second `decided_at`. The two
   * stop being the same instant the first time a note is amended after the
   * fact, and one name for two answers is how they come to disagree silently.
   */
  recorded_at: TimestampSchema,
};

/** `application_borrower_v`. */
export const ApplicationBorrowerViewSchema = z.object(applicationSharedColumns);
export type ApplicationBorrowerView = z.infer<typeof ApplicationBorrowerViewSchema>;

/** `application_lender_v`: the application joined to its decision, plus the queue's derived columns. */
export const ApplicationLenderViewSchema = z.object({
  ...applicationSharedColumns,
  ...applicationDecisionColumns,
  /**
   * The view left-joins `application_decision`, because an application nobody
   * has decided yet is the normal case -- it is every row in the queue that
   * still needs work. A left join makes every column from that side nullable,
   * including the one the table declares `not null`.
   */
  recorded_at: TimestampSchema.nullable(),
  borrower_name: z.string().nullable(),
  /**
   * How many document slots are still open, for the lender queue. It counts
   * `document_slot` rows, and that table arrives with the Option 1 migration,
   * so the view does not select the column until then. Null means "the view did
   * not report it", which is deliberately not the same as 0: telling a loan
   * officer a file has no outstanding documents when nobody counted them is a
   * worse failure than telling them nothing.
   */
  open_doc_count: z.number().int().nonnegative().nullable().default(null),
});
export type ApplicationLenderView = z.infer<typeof ApplicationLenderViewSchema>;

/** The `application` base table, as the API's service role sees it. */
export const ApplicationSchema = z.object(applicationSharedColumns);
export type Application = z.infer<typeof ApplicationSchema>;

/**
 * The `application_decision` base table: the lender-only half of a decision.
 *
 * One row per application, so the primary key is the foreign key. Reaching it
 * requires a row that the caller's policy admits, which is the whole point of
 * it being a table.
 */
export const ApplicationDecisionSchema = z.object({
  application_id: UuidSchema,
  ...applicationDecisionColumns,
});
export type ApplicationDecision = z.infer<typeof ApplicationDecisionSchema>;
