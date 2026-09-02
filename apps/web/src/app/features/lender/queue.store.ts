import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import {
  CreditReleaseLenderViewSchema,
  LoanBalanceSchema,
  LoanSchema,
  type CreditReleaseLenderView,
  type Loan,
  type LoanBalance,
} from '@lj/domain';
import { listCreditReleaseQueue, listLoanBalances, listLoans } from '@lj/db';

import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { RealtimeChannelFactory } from '../../core/realtime/channel-factory.ts';
import { AggregateStore, type WriteOutcome } from '../../core/store/aggregate-store.ts';
import { TransitionService, type TransitionAck } from '../../core/workflow/transition.service.ts';
import { queueGroups, queueRows, type QueueGroup, type QueueRow } from './queue.ts';
import type { CreditReleaseEvent } from '@lj/workflow';

/**
 * The lender's work queue: every request that still holds credit, and the
 * decisions that can be taken without opening one.
 *
 * Three reads, not one per row. `listCreditReleaseQueue` returns the pending
 * requests across the organisation, and the loans and balances arrive whole so
 * that a queue of forty rows is three round trips rather than eighty-one. The
 * rows themselves are built by ./queue.ts, which is where the ordering and the
 * banding are decided and tested.
 *
 * WHY A DECISION CAN BE TAKEN FROM THE LIST. Criterion #1 is whether a loan
 * officer can move through the queue quickly, and opening a file to click one
 * button is the thing that makes a queue slow. The safety is not lost by doing
 * it here: every decision carries the revision of the row AS READ, so two
 * lenders acting on one request serialise -- the second one's write matches
 * nothing, comes back 409, and `AggregateStore.write()` refetches instead of
 * approving twice.
 *
 * The subscription is unfiltered, because the queue is not about one row: any
 * insert or decision anywhere in the organisation changes what is on this
 * screen. Row-level security still decides which of those changes are
 * delivered, and the re-read is what enforces it -- the handler takes no
 * payload, so a row can never reach this screen without going back through
 * Postgres.
 */

/** What a store that cannot reach the database reports. */
export const NO_DATABASE: string =
  'This deployment cannot reach the database, so the queue cannot be read.';

/**
 * Now, as an ISO instant, injected.
 *
 * A row's age is what the queue is ordered and coloured by, so the clock is a
 * seam rather than a call to `Date.now()` in a computation -- the same reason
 * @lj/rules takes `today` in its context: a figure that cannot be reproduced
 * cannot be tested, and an SLA that disagrees with itself between two renders
 * is worse than none.
 */
export const QUEUE_NOW = new InjectionToken<() => string>('lj.queue-now', {
  providedIn: 'root',
  factory: () => (): string => new Date().toISOString(),
});

export interface QueueValue {
  readonly releases: readonly CreditReleaseLenderView[];
  readonly loans: readonly Loan[];
  readonly balances: readonly LoanBalance[];
}

@Injectable()
export class QueueStore extends AggregateStore<QueueValue> {
  private readonly client = inject(DATABASE_CLIENT);
  private readonly realtime = inject(RealtimeChannelFactory);
  private readonly transitions = inject(TransitionService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly now = inject(QUEUE_NOW);

  private watching = false;

  /** Bumped on every read, so the rows are rebuilt against a current clock. */
  private readonly readAt = signal<string>(this.now());

  readonly rows: Signal<readonly QueueRow[]> = computed(() => {
    const held = this.value();
    if (held === null) {
      return [];
    }
    return queueRows({
      releases: held.releases,
      loans: held.loans,
      balances: held.balances,
      now: this.readAt(),
    });
  });

  readonly groups: Signal<readonly QueueGroup[]> = computed(() => queueGroups(this.rows()));

  readonly total: Signal<number> = computed(() => this.rows().length);

  /** How many have waited past the point worth noticing. See ./queue.ts. */
  readonly overdue: Signal<number> = computed(
    () => this.rows().filter((row) => row.sla === 'overdue').length,
  );

  /** Read the queue, and start listening for anything that changes it. */
  async open(): Promise<void> {
    this.watch();
    await this.refresh();
  }

  /**
   * Take a decision on one row.
   *
   * The revision sent is the one that row was read with, which is what makes
   * this safe to offer from a list: a second lender who has the same row on
   * screen is holding a revision the server has moved past, and their write is
   * refused rather than applied on top.
   */
  async decide(row: QueueRow, event: CreditReleaseEvent): Promise<WriteOutcome<TransitionAck>> {
    const outcome = await this.write(() =>
      this.transitions.fire({
        machine: 'credit_release',
        subjectId: row.id,
        event,
        expectedRevision: row.revision,
      }),
    );
    if (outcome.ok) {
      // The row has moved to another pile, and the figures behind it with it.
      // Ask the database what the queue now is rather than moving the row here.
      await this.refresh();
    }
    return outcome;
  }

  private watch(): void {
    if (this.watching) {
      return;
    }
    this.watching = true;
    this.realtime.watch({ table: 'credit_release' }, () => this.refresh(), this.destroyRef);
  }

  protected async load(): Promise<QueueValue> {
    const client = this.client;
    if (client === null) {
      throw new Error(NO_DATABASE);
    }

    const [releaseRows, loanRows, balanceRows] = await Promise.all([
      listCreditReleaseQueue(client),
      listLoans(client),
      listLoanBalances(client),
    ]);
    this.readAt.set(this.now());

    // Parsed even though it came from our own database: a view reports no
    // not-null constraint, so every generated column type is nullable. A row
    // that will not parse is dropped rather than taking the queue down with it
    // -- one unreadable request must not hide the other thirty-nine.
    return {
      releases: parsed(releaseRows, (row) => CreditReleaseLenderViewSchema.parse(row)),
      loans: parsed(loanRows, (row) => LoanSchema.parse(row)),
      balances: parsed(balanceRows, (row) => LoanBalanceSchema.parse(row)),
    };
  }
}

function parsed<TRow, TValue>(
  rows: readonly TRow[],
  parse: (row: TRow) => TValue,
): readonly TValue[] {
  const values: TValue[] = [];
  for (const row of rows) {
    try {
      values.push(parse(row));
    } catch {
      continue;
    }
  }
  return values;
}
