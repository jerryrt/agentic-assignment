import { TestBed } from '@angular/core/testing';
import { moneyFromNumericString } from '@lj/domain';
import { evaluateCreditRelease } from '@lj/rules';

import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import {
  RealtimeChannelFactory,
  type RealtimeChangeHandler,
  type RealtimeWatchRequest,
} from '../../core/realtime/channel-factory.ts';
import { creditReleaseContextFor } from './balance.ts';
import { LoanStore, NO_BALANCE, NO_DATABASE, NO_SUCH_LOAN } from './loan.store.ts';

const { getLoan, getLoanBalance, listLedgerEntries, listCreditReleasesForBorrower } = vi.hoisted(
  () => ({
    getLoan: vi.fn(),
    getLoanBalance: vi.fn(),
    listLedgerEntries: vi.fn(),
    listCreditReleasesForBorrower: vi.fn(),
  }),
);

vi.mock('@lj/db', async (importOriginal) =>
  Object.assign({}, await importOriginal<typeof import('@lj/db')>(), {
    getLoan,
    getLoanBalance,
    listLedgerEntries,
    listCreditReleasesForBorrower,
  }),
);

const LOAN = '00000000-0000-4000-8000-0000000000e1';
const BORROWER = '00000000-0000-4000-8000-0000000000c2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const APPLICATION = '00000000-0000-4000-8000-0000000000d3';
const PRODUCT = '00000000-0000-4000-8000-0000000000b1';
const RELEASE = '00000000-0000-4000-8000-0000000000f3';
const NOW = '2026-09-01T12:00:00.000+00:00';

function loanRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LOAN,
    application_id: APPLICATION,
    borrower_id: BORROWER,
    org_id: ORG,
    product_id: PRODUCT,
    approved_limit: '250000.00',
    rate_bps: 875,
    opened_at: '2026-08-23',
    status: 'active',
    created_at: NOW,
    ...patch,
  };
}

function balanceRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    loan_id: LOAN,
    borrower_id: BORROWER,
    org_id: ORG,
    approved_limit: '250000.00',
    outstanding: '128442.47',
    pending: '30000.00',
    available: '91557.53',
    ...patch,
  };
}

function releaseRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RELEASE,
    loan_id: LOAN,
    amount: '30000.00',
    purpose: 'Spring inputs',
    state: 'under_review',
    revision: 1,
    requested_by: BORROWER,
    decided_by: null,
    decline_reason: null,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

function ledgerRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    loan_id: LOAN,
    kind: 'draw',
    amount: '85000.00',
    effective: '2026-08-25',
    release_id: null,
    memo: 'Opening advance',
    created_at: NOW,
    ...patch,
  };
}

/** Records what was watched, and hands the test the handler to fire. */
class FakeRealtime {
  readonly requests: RealtimeWatchRequest[] = [];
  private handler: RealtimeChangeHandler | null = null;

  watch(request: RealtimeWatchRequest, onChange: RealtimeChangeHandler): { active: boolean; close(): void } {
    this.requests.push(request);
    this.handler = onChange;
    return { active: true, close: (): void => undefined };
  }

  async deliver(): Promise<void> {
    await this.handler?.();
  }
}

function make(client: unknown = {}): { store: LoanStore; realtime: FakeRealtime } {
  const realtime = new FakeRealtime();
  TestBed.configureTestingModule({
    providers: [
      LoanStore,
      { provide: DATABASE_CLIENT, useValue: client },
      { provide: RealtimeChannelFactory, useValue: realtime },
    ],
  });
  return { store: TestBed.inject(LoanStore), realtime };
}

beforeEach(() => {
  TestBed.resetTestingModule();
  vi.clearAllMocks();
  getLoan.mockResolvedValue(loanRow());
  getLoanBalance.mockResolvedValue(balanceRow());
  listLedgerEntries.mockResolvedValue([ledgerRow()]);
  listCreditReleasesForBorrower.mockResolvedValue([releaseRow()]);
});

describe('reading a loan file', () => {
  it('shows the borrower the figure their submit guard compares against', async () => {
    const { store } = make();
    await store.open(LOAN);

    const available = store.availableCredit();
    expect(available).toBe(moneyFromNumericString('91557.53'));

    // The same quantity, put through the rule that guards the transition.
    const facts = store.facts();
    if (facts === null) {
      throw new Error('the loan was not read');
    }
    const results = evaluateCreditRelease(
      creditReleaseContextFor(facts, { requestedAmount: available }),
    );
    expect(results.find((result) => result.id === 'release_within_available')?.status).toBe('pass');
  });

  it('keeps the ledger and the requests it read', async () => {
    const { store } = make();
    await store.open(LOAN);

    expect(store.ledger()).toHaveLength(1);
    expect(store.releases()[0]?.state).toBe('under_review');
  });

  it('reports a loan it may not read rather than rendering an empty one', async () => {
    getLoan.mockResolvedValue(null);
    const { store } = make();
    await store.open(LOAN);

    expect(store.status()).toBe('error');
    expect(store.failure()?.message).toBe(NO_SUCH_LOAN);
  });

  it('refuses to read a missing balance as zero', async () => {
    getLoanBalance.mockResolvedValue(null);
    const { store } = make();
    await store.open(LOAN);

    expect(store.failure()?.message).toBe(NO_BALANCE);
  });

  it('says so when the build cannot reach the database', async () => {
    const { store } = make(null);
    await store.open(LOAN);

    expect(store.failure()?.message).toBe(NO_DATABASE);
  });
});

describe('staying live', () => {
  it('watches this loan credit releases, and nothing wider', async () => {
    const { store, realtime } = make();
    await store.open(LOAN);

    expect(realtime.requests).toEqual([
      { table: 'credit_release', filter: 'loan_id=eq.' + LOAN },
    ]);
  });

  /**
   * The handler takes no payload, so re-reading is the only thing it can do --
   * which is the property that keeps a row that never went through row-level
   * security off the screen.
   */
  it('re-reads the file when a request changes', async () => {
    const { store, realtime } = make();
    await store.open(LOAN);
    expect(getLoanBalance).toHaveBeenCalledTimes(1);

    // What a decision actually looks like from here: the request leaves the
    // pending set and the view's figures move with it.
    getLoanBalance.mockResolvedValue(balanceRow({ pending: '0.00', available: '121557.53' }));
    listCreditReleasesForBorrower.mockResolvedValue([releaseRow({ state: 'cancelled' })]);
    await realtime.deliver();

    expect(getLoanBalance).toHaveBeenCalledTimes(2);
    expect(store.availableCredit()).toBe(moneyFromNumericString('121557.53'));
  });

  it('does not open a second channel when the same loan is opened again', async () => {
    const { store, realtime } = make();
    await store.open(LOAN);
    await store.open(LOAN);

    expect(realtime.requests).toHaveLength(1);
    expect(getLoan).toHaveBeenCalledTimes(2);
  });
});
