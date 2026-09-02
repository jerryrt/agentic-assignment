import { DestroyRef, Injectable, computed, inject, signal, type Signal } from '@angular/core';
import {
  CreditReleaseBorrowerViewSchema,
  LedgerEntrySchema,
  LoanBalanceSchema,
  LoanSchema,
  type CreditRelease,
  type LedgerEntry,
  type Loan,
  type LoanBalance,
  type Money,
} from '@lj/domain';
import {
  getLoan,
  getLoanBalance,
  listCreditReleasesForBorrower,
  listLedgerEntries,
} from '@lj/db';

import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { RealtimeChannelFactory } from '../../core/realtime/channel-factory.ts';
import { AggregateStore } from '../../core/store/aggregate-store.ts';
import {
  borrowerFigures,
  type BorrowerFigures,
  type LoanFacts,
} from './balance.ts';

/**
 * One loan as the borrower reads it: the facility, its derived balance, the
 * ledger under it and every request against it.
 *
 * Provided at the `/loans/:id` route rather than at the root (plan/07), so the
 * release screen underneath shares this instance -- the figure the compose
 * screen checks against is then the figure the loan screen showed, by
 * construction rather than by two reads agreeing -- and so it dies when the
 * borrower leaves the loan.
 *
 * THE BALANCE IS NOT SUMMED HERE. `loan_balance_v` derives it on every read
 * (plan/06), and re-summing the ledger in the browser would be a second
 * derivation that drifts the day an entry kind is added. Everything below
 * `value` is a `computed()` over what was read; ./balance.ts turns it into the
 * two audiences' figures and @lj/rules decides what may be requested.
 *
 * REALTIME MEANS "READ IT AGAIN". The watch is on `credit_release` filtered to
 * this loan, and its handler is `() => this.refresh()` -- the only thing #51's
 * factory lets a caller express, deliberately: a row patched in from a
 * websocket frame is a second source of truth that has never been through
 * row-level security. It is also why the balance can be live at all without
 * `loan` or `ledger_entry` being published: the view is derived, so it is
 * current the moment it is read, and a decided request is a change to
 * `credit_release` (the #50 handoff, point 7).
 *
 * The current state is read once when the loan is opened, and the subscription
 * updates it from there. A screen that subscribed and then waited would look
 * correct and show nothing -- a subscriber sees changes, never the rows that
 * were already there, and #50 found that the first payload after SUBSCRIBED is
 * not guaranteed either.
 */

/** What a store that cannot reach the database reports. */
export const NO_DATABASE: string =
  'This deployment cannot reach the database, so a loan cannot be opened.';

export const NO_SUCH_LOAN: string = 'That loan does not exist, or is not yours to read.';

/**
 * A loan with no row in `loan_balance_v` is a database that has lost its view,
 * not a loan with nothing drawn: reading it as zero would put a confident
 * $0.00 on the screen and let the borrower request against a limit nobody
 * confirmed.
 */
export const NO_BALANCE: string = 'That loan has no balance, so its figures cannot be shown.';

export interface LoanFileValue {
  readonly loan: Loan;
  readonly balance: LoanBalance;
  /** Newest effect first, as `@lj/db` orders it. */
  readonly ledger: readonly LedgerEntry[];
  /** Every release on the loan, newest first, whatever its state. */
  readonly releases: readonly CreditRelease[];
}

@Injectable()
export class LoanStore extends AggregateStore<LoanFileValue> {
  private readonly client = inject(DATABASE_CLIENT);
  private readonly realtime = inject(RealtimeChannelFactory);
  private readonly destroyRef = inject(DestroyRef);

  private readonly currentId = signal<string | null>(null);
  private watching: string | null = null;

  readonly loanId: Signal<string | null> = this.currentId.asReadonly();

  /** What ./balance.ts and @lj/rules read. Assembled once, used by both. */
  readonly facts: Signal<LoanFacts | null> = computed(() => {
    const held = this.value();
    return held === null
      ? null
      : { status: held.loan.status, balance: held.balance, releases: held.releases };
  });

  /**
   * The borrower's figures, net of pending -- and `available` is the submit
   * guard's cap, not a second computation of it. See ./balance.ts.
   */
  readonly figures: Signal<BorrowerFigures | null> = computed(() => {
    const facts = this.facts();
    return facts === null ? null : borrowerFigures(facts);
  });

  readonly availableCredit: Signal<Money | null> = computed(
    () => this.figures()?.available ?? null,
  );

  readonly releases: Signal<readonly CreditRelease[]> = computed(
    () => this.value()?.releases ?? [],
  );

  readonly ledger: Signal<readonly LedgerEntry[]> = computed(() => this.value()?.ledger ?? []);

  /**
   * Read a loan, and start listening for changes to its requests.
   *
   * Safe to call again with the same id -- the loan screen and the release
   * screen underneath both do -- and it re-reads, because a borrower coming
   * back from a submitted request needs the balance as it now stands. Only the
   * subscription is kept, since a second channel on the same rows is a second
   * websocket doing the same work.
   */
  async open(loanId: string): Promise<void> {
    this.currentId.set(loanId);
    this.watch(loanId);
    await this.refresh();
  }

  private watch(loanId: string): void {
    if (this.watching === loanId) {
      return;
    }
    this.watching = loanId;
    // The DestroyRef is passed explicitly: this is called from a method rather
    // than from a constructor, so there is no injection context to resolve one
    // from. Same contract as takeUntilDestroyed (core/realtime/channel-factory.ts).
    this.realtime.watch(
      { table: 'credit_release', filter: 'loan_id=eq.' + loanId },
      () => this.refresh(),
      this.destroyRef,
    );
  }

  protected async load(): Promise<LoanFileValue> {
    const client = this.client;
    const loanId = this.currentId();
    if (client === null) {
      throw new Error(NO_DATABASE);
    }
    if (loanId === null) {
      throw new Error('No loan has been opened.');
    }

    const [loanRow, balanceRow, ledgerRows, releaseRows] = await Promise.all([
      getLoan(client, loanId),
      getLoanBalance(client, loanId),
      listLedgerEntries(client, loanId),
      listCreditReleasesForBorrower(client, loanId),
    ]);
    if (loanRow === null) {
      throw new Error(NO_SUCH_LOAN);
    }
    if (balanceRow === null) {
      throw new Error(NO_BALANCE);
    }

    // Parsed even though it came from our own database: a view reports no
    // not-null constraint, so every generated column type is nullable, and a
    // `state` no machine knows must not reach the rules as a string that
    // happens to typecheck.
    return {
      loan: LoanSchema.parse(loanRow),
      balance: LoanBalanceSchema.parse(balanceRow),
      ledger: ledgerRows.map((row) => LedgerEntrySchema.parse(row)),
      releases: releaseRows.map((row) => CreditReleaseBorrowerViewSchema.parse(row)),
    };
  }
}
