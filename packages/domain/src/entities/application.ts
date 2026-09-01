import { z } from 'zod';

import { JsonObjectSchema, TimestampSchema, UuidSchema } from '../primitives.js';
import { ApplicationStateSchema } from '../states.js';

/**
 * The aggregate root, and the two projections over it.
 *
 * "Two roles seeing different truths from the same data" is implemented by
 * column omission in a view, not by hiding a field in a template (plan 02).
 * `application_borrower_v` has no `decision_note` and no `risk_grade` column at
 * all, so ApplicationBorrowerViewSchema does not list them.
 *
 * Zod strips unknown keys by default, and that default is doing security work
 * here: if the view ever regressed and started selecting a lender-only column,
 * the borrower schema would drop it on the way through rather than pass it to a
 * component that renders whatever it is given. The view is the boundary; this
 * is the second layer behind it.
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
  decided_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
};

const lenderOnlyColumns = {
  decision_note: z.string().nullable(),
  risk_grade: z.string().nullable(),
};

/** `application_borrower_v`. */
export const ApplicationBorrowerViewSchema = z.object(applicationSharedColumns);
export type ApplicationBorrowerView = z.infer<typeof ApplicationBorrowerViewSchema>;

/** `application_lender_v`: the full row plus the queue's derived columns. */
export const ApplicationLenderViewSchema = z.object({
  ...applicationSharedColumns,
  ...lenderOnlyColumns,
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

/** The base table, as the API's service role sees it. */
export const ApplicationSchema = z.object({
  ...applicationSharedColumns,
  ...lenderOnlyColumns,
});
export type Application = z.infer<typeof ApplicationSchema>;
