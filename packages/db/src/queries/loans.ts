/**
 * The facility, its derived balance, and the ledger underneath both.
 *
 * Reads are ordinary and go through row-level security; the policies in
 * `0007_servicing.sql` admit the application's own audience -- the borrower who
 * owns it, or a lender at the organisation it was sent to -- and nobody else.
 *
 * Writes are narrower than they look:
 *
 *   - `authenticated` holds SELECT and nothing else on either table, so both
 *     writing helpers below are reachable only with the service role, from
 *     `apps/api`.  A loan is opened by the funding effect; a ledger entry is
 *     posted by `disburse` in the same transaction as the state change that
 *     justifies it.
 *   - there is no helper that updates or deletes a ledger entry, because no
 *     grant exists for one -- not even for the service role.  A ledger that can
 *     be edited after the fact is not a ledger; a correction is a compensating
 *     entry.
 *
 * ## Money crosses this boundary as TEXT, and it does not do so by accident
 *
 * PostgREST renders a `numeric` column as a JSON **number**, not as a string.
 * By the time `JSON.parse` has finished, `128442.47` is already a binary
 * double, and the cent this codebase refuses to lose has been lost before any
 * TypeScript sees the value.  `@lj/domain`'s `moneyFromNumericString` exists to
 * parse the exact decimal, and it can only do that if the exact decimal
 * arrives.
 *
 * So every money column below is selected as `column::text`.  PostgREST applies
 * the cast in the SQL it issues, so the value is rendered by Postgres and
 * quoted on the wire, and `MoneyFromNumericSchema` parses precisely what it
 * documents.  That is also why the select lists here are written out rather
 * than `*`: a `*` cannot carry a cast, so a helper that used one would hand its
 * caller a float and look correct doing it.
 */

import type { DatabaseClient } from '../client.ts';
import type { Database } from '../database.types.ts';
import { unwrapList, unwrapMaybe } from '../errors.ts';

type LoanTable = Database['public']['Tables']['loan'];
type LedgerTable = Database['public']['Tables']['ledger_entry'];

/**
 * Money goes IN as text too, and for the same reason it comes out that way.
 *
 * The generated Insert types say `number`, because Postgres reports the column
 * as numeric and the generator has no way to know that a JavaScript number
 * cannot hold one.  PostgREST accepts a JSON string for a numeric column and
 * Postgres parses the decimal exactly, so `moneyToNumericString` in
 * `@lj/domain` renders the value and it arrives unrounded.  Passing the float
 * the generated type asks for would put the error back at the only boundary
 * that matters -- the write.
 */
export type LoanInsert = Omit<LoanTable['Insert'], 'approved_limit'> & {
  readonly approved_limit: string;
};

export type LedgerEntryInsert = Omit<LedgerTable['Insert'], 'amount'> & {
  readonly amount: string;
};

/**
 * A loan as these helpers return it: the generated row, with `approved_limit`
 * carried as the exact decimal text Postgres rendered rather than as the float
 * PostgREST would otherwise have produced.
 */
export type LoanRow = Omit<LoanTable['Row'], 'approved_limit'> & {
  readonly approved_limit: string;
};

export type LedgerEntryRow = Omit<LedgerTable['Row'], 'amount'> & {
  readonly amount: string;
};

/**
 * One row of `loan_balance_v`, every figure as exact decimal text.
 *
 * The generated view type makes each column nullable, because Postgres reports
 * no not-null constraint through a view.  None of them is ever null in
 * practice -- the view coalesces both sums -- but the nullability is left in
 * place rather than asserted away (CLAUDE.md section 11), so a caller has to
 * decide what an absent figure means instead of being handed a `!`.
 */
export interface LoanBalanceRow {
  readonly loan_id: string | null;
  readonly borrower_id: string | null;
  readonly org_id: string | null;
  readonly approved_limit: string | null;
  readonly outstanding: string | null;
  readonly pending: string | null;
  readonly available: string | null;
}

const LOAN_COLUMNS =
  'id, application_id, borrower_id, org_id, product_id, approved_limit::text, ' +
  'rate_bps, opened_at, status, created_at';

const LEDGER_COLUMNS = 'id, loan_id, kind, amount::text, effective, release_id, memo, created_at';

const BALANCE_COLUMNS =
  'loan_id, borrower_id, org_id, approved_limit::text, outstanding::text, ' +
  'pending::text, available::text';

/**
 * Every loan the caller may see, newest first.
 *
 * No borrower or organisation filter, deliberately: the policies already answer
 * "whose loans are these", and a filter here would be a second, weaker copy of
 * that answer -- one that a caller could forget to apply.  A borrower gets
 * their own; a lender gets their organisation's.
 */
export async function listLoans(client: DatabaseClient): Promise<readonly LoanRow[]> {
  return unwrapList(
    'loan.list',
    await client
      .from('loan')
      .select(LOAN_COLUMNS)
      .order('opened_at', { ascending: false })
      .order('id', { ascending: true })
      .returns<LoanRow[]>(),
  );
}

export async function getLoan(client: DatabaseClient, loanId: string): Promise<LoanRow | null> {
  return unwrapMaybe(
    'loan.get',
    await client
      .from('loan')
      .select(LOAN_COLUMNS)
      .eq('id', loanId)
      .maybeSingle()
      .returns<LoanRow>(),
  );
}

/** Open a facility against a funded application.  Service role only. */
export async function insertLoan(
  client: DatabaseClient,
  values: LoanInsert,
): Promise<LoanRow | null> {
  return unwrapMaybe(
    'loan.insert',
    await client
      .from('loan')
      // The cast is the money-as-text decision above, made visible: the
      // generated Insert type asks for a number and the wire wants the exact
      // decimal.  Postgres validates the payload either way, so what is
      // asserted away here is a type that is wrong rather than a check.
      .insert(values as unknown as LoanTable['Insert'])
      .select(LOAN_COLUMNS)
      .maybeSingle()
      .returns<LoanRow>(),
  );
}

/**
 * The derived balance for one loan.
 *
 * `null` covers both "no such loan" and "no policy admits it", which is one
 * answer from outside and is what `unwrapMaybe` exists to say.
 */
export async function getLoanBalance(
  client: DatabaseClient,
  loanId: string,
): Promise<LoanBalanceRow | null> {
  return unwrapMaybe(
    'loan_balance.get',
    await client
      .from('loan_balance_v')
      .select(BALANCE_COLUMNS)
      .eq('loan_id', loanId)
      .maybeSingle()
      .returns<LoanBalanceRow>(),
  );
}

/**
 * Every balance the caller may see, in one round trip.
 *
 * The borrower's dashboard lists loans with their figures, and reading the
 * balance once per card is the shape that turns three loans into four requests.
 */
export async function listLoanBalances(
  client: DatabaseClient,
): Promise<readonly LoanBalanceRow[]> {
  return unwrapList(
    'loan_balance.list',
    await client.from('loan_balance_v').select(BALANCE_COLUMNS).returns<LoanBalanceRow[]>(),
  );
}

/**
 * One loan's ledger, most recent effect first.
 *
 * Ordered by `effective` and then by `id` descending: two entries can share a
 * day -- the opening advance and its establishment fee do -- and without the
 * tiebreak the statement reshuffles between two reads, which is a statement
 * nobody can reconcile against a printout.
 */
export async function listLedgerEntries(
  client: DatabaseClient,
  loanId: string,
): Promise<readonly LedgerEntryRow[]> {
  return unwrapList(
    'ledger_entry.list',
    await client
      .from('ledger_entry')
      .select(LEDGER_COLUMNS)
      .eq('loan_id', loanId)
      .order('effective', { ascending: false })
      .order('id', { ascending: false })
      .returns<LedgerEntryRow[]>(),
  );
}

/**
 * Post an entry.  Service role only; there is no client grant.
 *
 * There is deliberately no update and no delete counterpart.  The unique
 * constraint on `release_id` is what makes a retried `disburse` safe: the second
 * insert is refused by the database rather than by the caller remembering to
 * look first, and a check-then-insert is a race whose failure is a balance
 * nobody can explain.
 */
export async function insertLedgerEntry(
  client: DatabaseClient,
  values: LedgerEntryInsert,
): Promise<LedgerEntryRow | null> {
  return unwrapMaybe(
    'ledger_entry.insert',
    await client
      .from('ledger_entry')
      // Cast for the same reason insertLoan casts: the amount is the exact
      // decimal text, not the float the generated type asks for.
      .insert(values as unknown as LedgerTable['Insert'])
      .select(LEDGER_COLUMNS)
      .maybeSingle()
      .returns<LedgerEntryRow>(),
  );
}
