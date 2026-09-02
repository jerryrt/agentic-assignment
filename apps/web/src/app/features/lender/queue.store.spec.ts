import { TestBed } from '@angular/core/testing';

import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import {
  RealtimeChannelFactory,
  type RealtimeChangeHandler,
  type RealtimeWatchRequest,
} from '../../core/realtime/channel-factory.ts';
import { TransitionService } from '../../core/workflow/transition.service.ts';
import { NO_DATABASE, QUEUE_NOW, QueueStore } from './queue.store.ts';

const { listCreditReleaseQueue, listLoans, listLoanBalances } = vi.hoisted(() => ({
  listCreditReleaseQueue: vi.fn(),
  listLoans: vi.fn(),
  listLoanBalances: vi.fn(),
}));

vi.mock('@lj/db', async (importOriginal) =>
  Object.assign({}, await importOriginal<typeof import('@lj/db')>(), {
    listCreditReleaseQueue,
    listLoans,
    listLoanBalances,
  }),
);

const LOAN = '00000000-0000-4000-8000-0000000000e1';
const BORROWER = '00000000-0000-4000-8000-0000000000c2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const APPLICATION = '00000000-0000-4000-8000-0000000000d3';
const OLD = '00000000-0000-4000-8000-000000000001';
const NEW = '00000000-0000-4000-8000-000000000002';
const NOW = '2026-09-10T12:00:00.000+00:00';

function loanRow(): Record<string, unknown> {
  return {
    id: LOAN,
    application_id: APPLICATION,
    borrower_id: BORROWER,
    org_id: ORG,
    product_id: '00000000-0000-4000-8000-0000000000b1',
    approved_limit: '250000.00',
    rate_bps: 875,
    opened_at: '2026-08-23',
    status: 'active',
    created_at: NOW,
  };
}

function balanceRow(): Record<string, unknown> {
  return {
    loan_id: LOAN,
    borrower_id: BORROWER,
    org_id: ORG,
    approved_limit: '250000.00',
    outstanding: '128442.47',
    pending: '30000.00',
    available: '91557.53',
  };
}

function releaseRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OLD,
    loan_id: LOAN,
    amount: '30000.00',
    purpose: 'Spring inputs',
    state: 'submitted',
    revision: 2,
    requested_by: BORROWER,
    decided_by: null,
    decline_reason: null,
    created_at: '2026-09-01T12:00:00.000+00:00',
    updated_at: '2026-09-01T12:00:00.000+00:00',
    borrower_id: BORROWER,
    org_id: ORG,
    internal_note: null,
    note_recorded_by: null,
    note_recorded_at: null,
    requested_by_name: 'Fenwick Grain Co.',
    decided_by_name: null,
    ...patch,
  };
}

class FakeRealtime {
  readonly requests: RealtimeWatchRequest[] = [];
  private handler: RealtimeChangeHandler | null = null;

  watch(
    request: RealtimeWatchRequest,
    onChange: RealtimeChangeHandler,
  ): { active: boolean; close(): void } {
    this.requests.push(request);
    this.handler = onChange;
    return { active: true, close: (): void => undefined };
  }

  async deliver(): Promise<void> {
    await this.handler?.();
  }
}

function harness(client: unknown = {}): {
  store: QueueStore;
  realtime: FakeRealtime;
  fire: ReturnType<typeof vi.fn>;
} {
  const realtime = new FakeRealtime();
  const fire = vi.fn().mockResolvedValue({
    ok: true,
    machine: 'credit_release',
    subjectId: OLD,
    event: 'begin_review',
    from: 'submitted',
    to: 'under_review',
    revision: 3,
    actorRole: 'lender',
    effects: [],
    events: [],
  });

  TestBed.configureTestingModule({
    providers: [
      QueueStore,
      { provide: DATABASE_CLIENT, useValue: client },
      { provide: RealtimeChannelFactory, useValue: realtime },
      { provide: TransitionService, useValue: { fire } },
      { provide: QUEUE_NOW, useValue: (): string => NOW },
    ],
  });
  return { store: TestBed.inject(QueueStore), realtime, fire };
}

beforeEach(() => {
  TestBed.resetTestingModule();
  vi.clearAllMocks();
  listCreditReleaseQueue.mockResolvedValue([releaseRow()]);
  listLoans.mockResolvedValue([loanRow()]);
  listLoanBalances.mockResolvedValue([balanceRow()]);
});

describe('reading the queue', () => {
  it('builds rows the desk can work, oldest first', async () => {
    listCreditReleaseQueue.mockResolvedValue([
      releaseRow({ id: NEW, created_at: '2026-09-09T12:00:00.000+00:00' }),
      releaseRow(),
    ]);
    const { store } = harness();
    await store.open();

    expect(store.rows().map((row) => row.id)).toEqual([OLD, NEW]);
    expect(store.total()).toBe(2);
    // Nine days on the older one, against thresholds ./queue.ts states once.
    expect(store.overdue()).toBe(1);
  });

  it('reads the loans and the balances once, not once per row', async () => {
    listCreditReleaseQueue.mockResolvedValue([releaseRow(), releaseRow({ id: NEW })]);
    const { store } = harness();
    await store.open();

    expect(listLoans).toHaveBeenCalledTimes(1);
    expect(listLoanBalances).toHaveBeenCalledTimes(1);
  });

  /**
   * One unreadable request must not hide the other thirty-nine: the queue is
   * somebody's work list, and an empty screen reads as "nothing to do".
   */
  it('drops a row it cannot parse rather than the whole queue', async () => {
    listCreditReleaseQueue.mockResolvedValue([releaseRow(), releaseRow({ id: NEW, state: 'no_such_state' })]);
    const { store } = harness();
    await store.open();

    expect(store.rows().map((row) => row.id)).toEqual([OLD]);
    expect(store.status()).toBe('ready');
  });

  it('says when the build cannot reach the database', async () => {
    const { store } = harness(null);
    await store.open();

    expect(store.failure()?.message).toBe(NO_DATABASE);
  });
});

describe('staying live', () => {
  /**
   * Unfiltered on purpose: any request anywhere in the organisation changes
   * what is on this screen. Row-level security decides what is delivered, and
   * the re-read is what enforces it -- the handler takes no payload, so nothing
   * reaches the screen without going back through Postgres.
   */
  it('watches every credit release the lender may see', async () => {
    const { store, realtime } = harness();
    await store.open();

    expect(realtime.requests).toEqual([{ table: 'credit_release' }]);
  });

  it('re-reads the queue when anything changes', async () => {
    const { store, realtime } = harness();
    await store.open();
    expect(listCreditReleaseQueue).toHaveBeenCalledTimes(1);

    listCreditReleaseQueue.mockResolvedValue([]);
    await realtime.deliver();

    expect(store.rows()).toEqual([]);
  });
});

describe('deciding from the list', () => {
  it('sends the revision the row was read with', async () => {
    const { store, fire } = harness();
    await store.open();
    const row = store.rows()[0];
    if (row === undefined) {
      throw new Error('the queue was empty');
    }

    await store.decide(row, 'begin_review');

    expect(fire).toHaveBeenCalledWith({
      machine: 'credit_release',
      subjectId: OLD,
      event: 'begin_review',
      expectedRevision: 2,
    });
  });

  /**
   * TWO LENDERS, ONE REQUEST. The second one is holding a revision the server
   * has moved past; the answer is to go and read what it now holds rather than
   * to approve a second time.
   */
  it('refetches rather than approving twice', async () => {
    const { store, fire } = harness();
    await store.open();
    const row = store.rows()[0];
    if (row === undefined) {
      throw new Error('the queue was empty');
    }

    fire.mockRejectedValue({ status: 409, code: 'revision_conflict', reason: 'it moved' });
    listCreditReleaseQueue.mockResolvedValue([releaseRow({ state: 'under_review', revision: 3 })]);

    const outcome = await store.decide(row, 'approve');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.conflicted).toBe(true);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(listCreditReleaseQueue).toHaveBeenCalledTimes(2);
    expect(store.rows()[0]?.state).toBe('under_review');
  });
});
