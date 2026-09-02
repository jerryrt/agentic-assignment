import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppRole } from '@lj/domain';

import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { RealtimeChannelFactory } from '../../core/realtime/channel-factory.ts';
import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { TransitionService } from '../../core/workflow/transition.service.ts';
import { readDecisionSnapshot, writeDecisionSnapshot } from './decision-draft.ts';
import { decisionActions } from './decision.ts';
import {
  DECISION_STORAGE,
  NOTE_DELAY_MS,
  REASON_REQUIRED,
  ReviewStore,
} from './review.store.ts';

const {
  getCreditReleaseForLender,
  getCreditReleaseNote,
  getLoan,
  getLoanBalance,
  listWorkflowEvents,
  upsertCreditReleaseNote,
} = vi.hoisted(() => ({
  getCreditReleaseForLender: vi.fn(),
  getCreditReleaseNote: vi.fn(),
  getLoan: vi.fn(),
  getLoanBalance: vi.fn(),
  listWorkflowEvents: vi.fn(),
  upsertCreditReleaseNote: vi.fn(),
}));

vi.mock('@lj/db', async (importOriginal) =>
  Object.assign({}, await importOriginal<typeof import('@lj/db')>(), {
    getCreditReleaseForLender,
    getCreditReleaseNote,
    getLoan,
    getLoanBalance,
    listWorkflowEvents,
    upsertCreditReleaseNote,
  }),
);

const RELEASE = '00000000-0000-4000-8000-0000000000f3';
const LOAN = '00000000-0000-4000-8000-0000000000e1';
const BORROWER = '00000000-0000-4000-8000-0000000000c2';
const LENDER = '00000000-0000-4000-8000-0000000000c3';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const APPLICATION = '00000000-0000-4000-8000-0000000000d3';
const NOW = '2026-09-01T12:00:00.000+00:00';

function releaseRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RELEASE,
    loan_id: LOAN,
    amount: '30000.00',
    purpose: 'Spring inputs',
    state: 'under_review',
    revision: 4,
    requested_by: BORROWER,
    decided_by: null,
    decline_reason: null,
    created_at: NOW,
    updated_at: NOW,
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

class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

const INERT_REALTIME = {
  watch: (): { active: boolean; close(): void } => ({ active: false, close: () => undefined }),
};

function harness(storage: Storage = new MemoryStorage()): {
  store: ReviewStore;
  storage: Storage;
  fire: ReturnType<typeof vi.fn>;
} {
  const fire = vi.fn().mockResolvedValue({
    ok: true,
    machine: 'credit_release',
    subjectId: RELEASE,
    event: 'approve',
    from: 'under_review',
    to: 'approved',
    revision: 5,
    actorRole: 'lender',
    effects: [],
    events: [],
  });
  const auth = {
    role: signal<AppRole | null>('lender'),
    audience: signal('lender'),
    identity: signal({ userId: LENDER, email: null, accessToken: 't' }),
  };

  TestBed.configureTestingModule({
    providers: [
      ReviewStore,
      { provide: DATABASE_CLIENT, useValue: {} },
      { provide: DECISION_STORAGE, useValue: storage },
      { provide: RealtimeChannelFactory, useValue: INERT_REALTIME },
      { provide: SupabaseAuthService, useValue: auth },
      { provide: TransitionService, useValue: { fire } },
    ],
  });
  return { store: TestBed.inject(ReviewStore), storage, fire };
}

function decline(): ReturnType<typeof decisionActions>[number] {
  const action = decisionActions('under_review', 'lender').find(
    (candidate) => candidate.event === 'decline',
  );
  if (action === undefined) {
    throw new Error('decline is not offered from under_review');
  }
  return action;
}

function approve(): ReturnType<typeof decisionActions>[number] {
  const action = decisionActions('under_review', 'lender').find(
    (candidate) => candidate.event === 'approve',
  );
  if (action === undefined) {
    throw new Error('approve is not offered from under_review');
  }
  return action;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getCreditReleaseForLender.mockResolvedValue(releaseRow());
  getCreditReleaseNote.mockResolvedValue(null);
  getLoan.mockResolvedValue(loanRow());
  getLoanBalance.mockResolvedValue(balanceRow());
  listWorkflowEvents.mockResolvedValue([]);
  upsertCreditReleaseNote.mockImplementation((_client: unknown, values: unknown) =>
    Promise.resolve(values),
  );
});

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('opening a request for review', () => {
  it('reads the file, the exposure behind it and the way to the documents', async () => {
    const { store } = harness();
    await store.open(RELEASE);

    expect(store.release()?.purpose).toBe('Spring inputs');
    // The LENDER's reading: limit less drawn, with pending kept separate.
    expect(store.figures()?.undrawn).toBe(12155753);
    expect(store.figures()?.atRisk).toBe(3000000);
    expect(store.applicationId()).toBe(APPLICATION);
  });

  it('offers the moves the machine allows from this state', async () => {
    const { store } = harness();
    await store.open(RELEASE);

    expect(store.actions().map((action) => action.event)).toEqual(['approve', 'decline']);
  });

  it('opens a request whose loan it cannot read, with fewer figures', async () => {
    getLoan.mockResolvedValue(null);
    getLoanBalance.mockResolvedValue(null);
    const { store } = harness();
    await store.open(RELEASE);

    expect(store.release()).not.toBeNull();
    expect(store.figures()).toBeNull();
    expect(store.applicationId()).toBeNull();
  });

  it('does not write the note it has just loaded', async () => {
    getCreditReleaseNote.mockResolvedValue({
      release_id: RELEASE,
      internal_note: 'Survey received.',
      recorded_by: LENDER,
      recorded_at: NOW,
    });
    const { store } = harness();
    await store.open(RELEASE);
    await vi.advanceTimersByTimeAsync(NOTE_DELAY_MS * 3);

    expect(store.form.controls.internalNote.value).toBe('Survey received.');
    expect(upsertCreditReleaseNote).not.toHaveBeenCalled();
  });
});

describe('what the lender has typed and not sent', () => {
  /**
   * plan/06's third refresh case. A reload is a new store reading the same
   * browser storage, and the reason typed into the box has no server copy to
   * fall back on -- no client may write that column at all (issue #50).
   */
  it('gives a typed decline reason back after a reload', async () => {
    const storage = new MemoryStorage();
    const first = harness(storage);
    await first.store.open(RELEASE);

    first.store.form.markAsDirty();
    first.store.form.controls.declineReason.setValue('The land title expired in June.');
    await vi.advanceTimersByTimeAsync(1);

    TestBed.resetTestingModule();
    const second = harness(storage);
    await second.store.open(RELEASE);

    expect(second.store.form.controls.declineReason.value).toBe(
      'The land title expired in June.',
    );
    expect(second.store.recovered()).not.toBeNull();
  });

  it('autosaves the private note to its own table', async () => {
    const { store } = harness();
    await store.open(RELEASE);

    store.form.markAsDirty();
    store.form.controls.internalNote.setValue('Called the borrower.');
    await vi.advanceTimersByTimeAsync(NOTE_DELAY_MS + 1);

    expect(upsertCreditReleaseNote).toHaveBeenCalledWith(
      {},
      { release_id: RELEASE, internal_note: 'Called the borrower.', recorded_by: LENDER },
    );
  });

  /**
   * The decline reason is borrower-readable and no client holds a grant on it.
   * It must never be sent to the note table, which is the lender-only one.
   */
  it('never writes the decline reason to the private note', async () => {
    const { store } = harness();
    await store.open(RELEASE);

    store.form.markAsDirty();
    store.form.controls.declineReason.setValue('The land title expired in June.');
    await vi.advanceTimersByTimeAsync(NOTE_DELAY_MS + 1);

    expect(upsertCreditReleaseNote).toHaveBeenCalledWith(
      {},
      { release_id: RELEASE, internal_note: '', recorded_by: LENDER },
    );
  });
});

describe('deciding', () => {
  it('refuses to decline without a reason the borrower can act on', async () => {
    const { store, fire } = harness();
    await store.open(RELEASE);

    const outcome = await store.decide(decline());

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.failure.message).toBe(REASON_REQUIRED);
    expect(fire).not.toHaveBeenCalled();
  });

  it('sends the reason with the decision that writes it', async () => {
    const { store, fire } = harness();
    await store.open(RELEASE);

    store.form.markAsDirty();
    store.form.controls.declineReason.setValue('The land title expired in June.');
    getCreditReleaseForLender.mockResolvedValue(
      releaseRow({ state: 'declined', revision: 5, decline_reason: 'The land title expired in June.' }),
    );

    await store.decide(decline());

    expect(fire).toHaveBeenCalledWith({
      machine: 'credit_release',
      subjectId: RELEASE,
      event: 'decline',
      expectedRevision: 4,
      declineReason: 'The land title expired in June.',
    });
  });

  it('lets go of the browser copy once the reason is on the row', async () => {
    const { store, storage } = harness();
    await store.open(RELEASE);

    store.form.markAsDirty();
    store.form.controls.declineReason.setValue('The land title expired in June.');
    getCreditReleaseForLender.mockResolvedValue(
      releaseRow({ state: 'declined', revision: 5, decline_reason: 'The land title expired in June.' }),
    );

    await store.decide(decline());

    expect(readDecisionSnapshot(storage, RELEASE)).toBeNull();
    expect(store.declineReasonPending()).toBe(false);
  });

  /**
   * A reason dropped between the box and the borrower is the worst outcome
   * available: they read "Declined" with nothing to act on and nobody is told.
   * So the landing is checked rather than assumed.
   */
  it('keeps the reason, and says so, when it did not reach the row', async () => {
    const { store, storage } = harness();
    await store.open(RELEASE);

    store.form.markAsDirty();
    store.form.controls.declineReason.setValue('The land title expired in June.');
    getCreditReleaseForLender.mockResolvedValue(
      releaseRow({ state: 'declined', revision: 5, decline_reason: null }),
    );

    await store.decide(decline());

    expect(store.declineReasonPending()).toBe(true);
    expect(readDecisionSnapshot(storage, RELEASE)?.declineReason).toBe(
      'The land title expired in June.',
    );
  });

  it('sends no reason with a decision that has none to send', async () => {
    const { store, fire } = harness();
    await store.open(RELEASE);

    await store.decide(approve());

    expect(fire).toHaveBeenCalledWith({
      machine: 'credit_release',
      subjectId: RELEASE,
      event: 'approve',
      expectedRevision: 4,
    });
  });

  /**
   * TWO LENDER TABS, ONE REQUEST. The second holds a revision the server has
   * moved past: it must read what is there now rather than approve again.
   */
  it('refetches rather than approving twice', async () => {
    const { store, fire } = harness();
    await store.open(RELEASE);
    expect(getCreditReleaseForLender).toHaveBeenCalledTimes(1);

    fire.mockRejectedValue({ status: 409, code: 'revision_conflict', reason: 'it moved' });
    getCreditReleaseForLender.mockResolvedValue(releaseRow({ state: 'approved', revision: 5 }));

    const outcome = await store.decide(approve());

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.conflicted).toBe(true);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(getCreditReleaseForLender).toHaveBeenCalledTimes(2);
    expect(store.release()?.state).toBe('approved');
  });

  it('records the note before the decision it explains', async () => {
    const { store } = harness();
    await store.open(RELEASE);

    store.form.markAsDirty();
    store.form.controls.internalNote.setValue('Spoke to the agronomist.');

    await store.decide(approve());

    expect(upsertCreditReleaseNote).toHaveBeenCalledTimes(1);
  });
});

describe('recovering a note the autosave never sent', () => {
  it('prefers what the browser held and flags it', async () => {
    const storage = new MemoryStorage();
    writeDecisionSnapshot(storage, {
      releaseId: RELEASE,
      internalNote: 'Waiting on the survey.',
      declineReason: '',
      savedAt: NOW,
    });
    getCreditReleaseNote.mockResolvedValue({
      release_id: RELEASE,
      internal_note: 'Waiting on',
      recorded_by: LENDER,
      recorded_at: NOW,
    });

    const { store } = harness(storage);
    await store.open(RELEASE);

    expect(store.form.controls.internalNote.value).toBe('Waiting on the survey.');
    expect(store.recovered()).toBe(NOW);
  });
});
