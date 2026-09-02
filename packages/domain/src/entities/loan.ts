import { z } from 'zod';

import { MoneyFromNumericSchema, subtractMoney } from '../money.ts';
import type { Money } from '../money.ts';
import {
  BigSerialIdSchema,
  NonEmptyTextSchema,
  TimestampSchema,
  UuidSchema,
} from '../primitives.ts';
import { CreditReleaseStateSchema } from '../states.ts';
import type { CreditReleaseState } from '../states.ts';

/**
 * Option 3: the facility a funded application becomes, the ledger that records
 * what moved, and the requests to draw against it (plan/06).
 *
 * Three things in this file are load-bearing and none of them is obvious from
 * the column list.
 *
 * **The balance is derived, never stored.** `LoanBalanceSchema` describes a
 * VIEW, and there is deliberately no balance field on `LoanSchema`. A stored
 * balance is a cache with no invalidation strategy, and every reconciliation
 * bug in lending starts there.
 *
 * **A ledger amount is SIGNED** -- draws positive, repayments negative -- so
 * the outstanding figure is a sum rather than a case expression over `kind`.
 * That is why nothing below refuses a negative amount on a ledger entry, and
 * why `kind` is a label for the reader rather than an input to the arithmetic.
 *
 * **`internal_note` is not a column on a credit release.** It is a row in
 * `credit_release_note`, with a row policy of its own, because row-level
 * security filters ROWS and never COLUMNS: a borrower holding a select policy
 * on their own release would read a lender-only column straight off the base
 * table however carefully a view omitted it. `decline_reason` stays on the
 * release because it is written by the lender FOR the borrower. That
 * difference -- shared versus private -- is what decides which shape a field
 * takes, not who wrote it. 0001_init.sql argues it in full for
 * `application_decision`; 0007_servicing.sql applies the same argument here.
 */

/**
 * A Postgres `date`: a calendar day, with no instant and no zone.
 *
 * A loan opens, and an entry takes effect, on a day in the place the money
 * moved; giving either an instant would make the answer depend on the reader's
 * time zone, exactly as it would for a certificate's expiry. `document.ts`
 * states the same shape for `valid_until` and this is the second occurrence, so
 * it is deliberately not abstracted yet (CLAUDE.md section 9: three
 * occurrences, or a rule that must provably stay in lockstep). At the third it
 * belongs in primitives.ts, which the contracts issue owns.
 */
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'must be an ISO calendar date (YYYY-MM-DD)',
});

/**
 * `delinquent` is a state a human puts a loan into, not one the machine
 * derives: arrears are a function of the ledger and the clock, and a status
 * that changed without an event would be a state machine that lies (plan 03,
 * the same argument that keeps `expired` out of the document slot states).
 */
export const LOAN_STATUSES = ['active', 'closed', 'delinquent'] as const;

export const LoanStatusSchema = z.enum(LOAN_STATUSES);
export type LoanStatus = z.infer<typeof LoanStatusSchema>;

export const LoanSchema = z.object({
  id: UuidSchema,
  /** The application this facility came out of. One loan per funded file. */
  application_id: UuidSchema,
  /**
   * Denormalised from the application on purpose. Every read of a loan filters
   * on one of these two, and reaching them through `application` would put a
   * join in front of the borrower's own dashboard. They cannot drift: a loan is
   * written once, by the funding effect, and no grant lets anything move it to
   * another borrower.
   */
  borrower_id: UuidSchema,
  org_id: UuidSchema,
  product_id: UuidSchema,
  approved_limit: MoneyFromNumericSchema,
  /** Hundredths of a percent, as every ratio in this codebase is. */
  rate_bps: z.number().int().nonnegative(),
  opened_at: CalendarDateSchema,
  status: LoanStatusSchema,
  created_at: TimestampSchema,
});
export type Loan = z.infer<typeof LoanSchema>;

/**
 * What a ledger entry is called. A vocabulary, not a machine: no transition
 * moves an entry from one kind to another, so unlike a `state` this one is a
 * check constraint in the database as well as an enum here. Two enforcers of
 * one vocabulary, the way `MAX_UPLOAD_BYTES` and the bucket's
 * `file_size_limit` are two enforcers of one size limit.
 */
export const LEDGER_ENTRY_KINDS = ['draw', 'repayment', 'interest', 'fee'] as const;

export const LedgerEntryKindSchema = z.enum(LEDGER_ENTRY_KINDS);
export type LedgerEntryKind = z.infer<typeof LedgerEntryKindSchema>;

export const LedgerEntrySchema = z.object({
  id: BigSerialIdSchema,
  loan_id: UuidSchema,
  kind: LedgerEntryKindSchema,
  /**
   * Signed: a draw, a fee and accrued interest raise the outstanding balance,
   * a repayment lowers it. Zero is refused because an entry that moves nothing
   * still appears on a timeline, which is how a reconciliation acquires a row
   * nobody can account for.
   */
  amount: MoneyFromNumericSchema.refine((amount) => amount !== 0, {
    message: 'a ledger entry must move money; use no entry rather than a zero one',
  }),
  effective: CalendarDateSchema,
  /**
   * Provenance. Not null for an entry the `disburse` effect posted, null for
   * one whose origin is the application itself -- the opening advance a loan
   * starts with -- or a fee the lender charged. The database carries a unique
   * constraint on this column, so one release can never disburse twice.
   */
  release_id: UuidSchema.nullable(),
  memo: z.string().nullable(),
  created_at: TimestampSchema,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const CreditReleaseSchema = z.object({
  id: UuidSchema,
  loan_id: UuidSchema,
  /**
   * Strictly positive. A release asks for money to be moved out; a request for
   * nothing is not a request, and a negative one is a repayment wearing the
   * wrong form.
   */
  amount: MoneyFromNumericSchema.refine((amount) => amount > 0, {
    message: 'a credit release must ask for a positive amount',
  }),
  purpose: NonEmptyTextSchema,
  /**
   * Text in the database with no check constraint, exactly as
   * `application.state` is: legality lives in `workflow_transition`, generated
   * from packages/workflow, and `assert_legal_transition` enforces it. The
   * narrowing here is a second line, not the first.
   */
  state: CreditReleaseStateSchema,
  /** Optimistic concurrency. `POST /api/transition` matches on it, which is
   * what makes two lender tabs approving one release serialise rather than
   * double-approve. */
  revision: z.number().int().nonnegative(),
  requested_by: UuidSchema,
  decided_by: UuidSchema.nullable(),
  /**
   * Lender-authored and SHARED with the borrower, which is why it is a column
   * here and `internal_note` is not. No client holds an UPDATE grant on it: a
   * borrower and a lender are the same database role, so a grant wide enough
   * to let a lender autosave this field is wide enough to let a borrower write
   * their own decline reason onto their own draft.
   */
  decline_reason: z.string().nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type CreditRelease = z.infer<typeof CreditReleaseSchema>;

/**
 * The borrower's projection is exactly the release row.
 *
 * Stated as an alias rather than as a second object, because that IS the
 * contract: `credit_release_borrower_v` withholds nothing, since there is
 * nothing on the base table to withhold. Everything lender-only is a row in
 * `credit_release_note`, which no borrower policy admits.
 */
export const CreditReleaseBorrowerViewSchema = CreditReleaseSchema;
export type CreditReleaseBorrowerView = CreditRelease;

/**
 * The lender's private half of a decision, one row per release.
 *
 * A table rather than two columns, for the reason `application_decision` is
 * one. The primary key is the foreign key: there is at most one note per
 * release, and it goes when the release goes.
 */
export const CreditReleaseNoteSchema = z.object({
  release_id: UuidSchema,
  internal_note: z.string().nullable(),
  /**
   * Not null. An audit entry with no author is worse than no entry, because it
   * is believed -- the same reason `application_decision.decided_by` is not
   * null.
   */
  recorded_by: UuidSchema,
  recorded_at: TimestampSchema,
});
export type CreditReleaseNote = z.infer<typeof CreditReleaseNoteSchema>;

/**
 * The lender's projection: the release, its note, and the two names.
 *
 * Every added column is nullable, and not out of caution. The view is
 * `security_invoker` and left-joins both the note and the deciding lender's
 * profile, so a caller whose policies do not admit those rows reads them as
 * null rather than getting a permission error. A borrower who reads this view
 * therefore sees their own release with the lender-only half empty -- which is
 * the same behaviour `application_lender_v` has, and it is why the projection
 * is not itself a gate.
 *
 * `decided_by` is present on BOTH projections. Omitting it from the borrower's
 * would be theatre: it is a column on the base table their own row policy
 * admits, so a view could not withhold it. What plan/06 means by "the lender
 * sees who decided" is the NAME, and that is protected properly -- by the
 * `profile` policies, which do not admit a lender's row to a borrower.
 */
export const CreditReleaseLenderViewSchema = CreditReleaseSchema.extend({
  /** Carried from the loan so the queue can group by borrower in one read. */
  borrower_id: UuidSchema,
  org_id: UuidSchema,
  internal_note: z.string().nullable(),
  note_recorded_by: UuidSchema.nullable(),
  note_recorded_at: TimestampSchema.nullable(),
  requested_by_name: z.string().nullable(),
  decided_by_name: z.string().nullable(),
});
export type CreditReleaseLenderView = z.infer<typeof CreditReleaseLenderViewSchema>;

/**
 * `loan_balance_v`, derived on every read.
 *
 * Three figures rather than one, because two audiences read this row and each
 * needs a different pair of them -- see `borrowerAvailableCredit` and
 * `lenderUndrawnLimit` below.
 */
export const LoanBalanceSchema = z.object({
  loan_id: UuidSchema,
  borrower_id: UuidSchema,
  org_id: UuidSchema,
  approved_limit: MoneyFromNumericSchema,
  /**
   * The signed sum of the ledger. Negative if the borrower has repaid past
   * zero, which is unusual and real; nothing here refuses it.
   */
  outstanding: MoneyFromNumericSchema,
  /** The sum of every release that holds credit but has not moved money yet. */
  pending: MoneyFromNumericSchema,
  /** `approved_limit - outstanding - pending`. Negative when over-drawn. */
  available: MoneyFromNumericSchema,
});
export type LoanBalance = z.infer<typeof LoanBalanceSchema>;

/**
 * The borrower's truth, and the submit guard's.
 *
 * It is net of pending because a borrower must not be able to spend the same
 * credit twice, and `amountWithinAvailable` compares against this exact
 * quantity. The function exists rather than a field access at each call site so
 * that "the number on the screen" and "the number in the guard" are one named
 * thing: if they ever differed, a borrower could submit a request the screen
 * had just told them was affordable, and that is the bug Option 3 exists to
 * avoid.
 */
export function borrowerAvailableCredit(balance: LoanBalance): Money {
  return balance.available;
}

/**
 * The lender's truth over the same row: headroom against the limit, ignoring
 * requests not yet disbursed.
 *
 * Both readings are legitimate and they differ by exactly `pending`, which the
 * lender's screen shows as its own at-risk column rather than folding away.
 * Naming both is what stops a template showing one audience the other's figure.
 */
export function lenderUndrawnLimit(balance: LoanBalance): Money {
  return subtractMoney(balance.approved_limit, balance.outstanding);
}

/**
 * The states in which a release holds credit that has not moved yet.
 *
 * `draft` is excluded because nobody has been asked. The terminal states are
 * excluded because the question is settled -- `funded` in particular, whose
 * money is on the ledger and would otherwise be counted twice.
 *
 * `approved` is the one worth stating aloud: the money is committed and not yet
 * disbursed, so it is spent from the borrower's point of view and absent from
 * the ledger. Leaving it out of this set is precisely how a borrower spends the
 * same credit twice.
 *
 * This set is the second definition of nothing: `loan_balance_v` filters on the
 * same three names, and the test in this package asserts that every member of
 * CREDIT_RELEASE_STATES lands in exactly one of draft, pending or terminal, so
 * a state added later cannot slip through unclassified.
 */
export const PENDING_CREDIT_RELEASE_STATES = [
  'submitted',
  'under_review',
  'approved',
] as const satisfies readonly CreditReleaseState[];

export const TERMINAL_CREDIT_RELEASE_STATES = [
  'funded',
  'declined',
  'cancelled',
] as const satisfies readonly CreditReleaseState[];

export function isPendingCreditReleaseState(state: CreditReleaseState): boolean {
  return (PENDING_CREDIT_RELEASE_STATES as readonly CreditReleaseState[]).includes(state);
}

export function isTerminalCreditReleaseState(state: CreditReleaseState): boolean {
  return (TERMINAL_CREDIT_RELEASE_STATES as readonly CreditReleaseState[]).includes(state);
}
