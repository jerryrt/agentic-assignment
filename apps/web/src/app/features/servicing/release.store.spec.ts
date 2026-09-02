import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppRole } from '@lj/domain';

import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { RealtimeChannelFactory } from '../../core/realtime/channel-factory.ts';
import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { TransitionService } from '../../core/workflow/transition.service.ts';
import { readComposeSnapshot, writeComposeSnapshot } from './compose-draft.ts';
import { LoanStore } from './loan.store.ts';
import { COMPOSE_DELAY_MS, RELEASE_STORAGE, ReleaseStore } from './release.store.ts';

const {
  getLoan,
  getLoanBalance,
  listLedgerEntries,
  listCreditReleasesForBorrower,
  getCreditReleaseForBorrower,
  insertCreditRelease,
  updateCreditRelease,
  deleteCreditReleaseDraft,
  listWorkflowEvents,
} = vi.hoisted(() => ({
  getLoan: vi.fn(),
  getLoanBalance: vi.fn(),
  listLedgerEntries: vi.fn(),
  listCreditReleasesForBorrower: vi.fn(),
  getCreditReleaseForBorrower: vi.fn(),
  insertCreditRelease: vi.fn(),
  updateCreditRelease: vi.fn(),
  deleteCreditReleaseDraft: vi.fn(),
  listWorkflowEvents: vi.fn(),
}));

// Object.assign rather than a spread: the factory is hoisted above esbuild's
// own helper definitions, so `...` compiles to a call that does not exist yet.
vi.mock('@lj/db', async (importOriginal) =>
  Object.assign({}, await importOriginal<typeof import('@lj/db')>(), {
    getLoan,
    getLoanBalance,
    listLedgerEntries,
    listCreditReleasesForBorrower,
    getCreditReleaseForBorrower,
    insertCreditRelease,
    updateCreditRelease,
    deleteCreditReleaseDraft,
    listWorkflowEvents,
  }),
);

const LOAN = '00000000-0000-4000-8000-0000000000e1';
const BORROWER = '00000000-0000-4000-8000-0000000000c2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const RELEASE = '00000000-0000-4000-8000-0000000000f7';
const NOW = '2026-09-01T12:00:00.000+00:00';

function loanRow(): Record<string, unknown> {
  return {
    id: LOAN,
    application_id: '00000000-0000-4000-8000-0000000000d3',
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
    pending: '0.00',
    available: '121557.53',
  };
}

function draftRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RELEASE,
    loan_id: LOAN,
    amount: '12000.00',
    purpose: 'Seed and fertiliser',
    state: 'draft',
    revision: 3,
    requested_by: BORROWER,
    decided_by: null,
    decline_reason: null,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
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

interface Harness {
  readonly store: ReleaseStore;
  readonly loans: LoanStore;
  readonly storage: Storage;
  readonly fire: ReturnType<typeof vi.fn>;
}

function harness(role: AppRole = 'borrower'): Harness {
  const storage = new MemoryStorage();
  const fire = vi.fn().mockResolvedValue({
    ok: true,
    machine: 'credit_release',
    subjectId: RELEASE,
    event: 'submit',
    from: 'draft',
    to: 'submitted',
    revision: 4,
    actorRole: role,
    effects: [],
    events: [],
  });
  const auth = {
    role: signal<AppRole | null>(role),
    audience: signal(role === 'borrower' ? 'borrower' : 'lender'),
    identity: signal({ userId: BORROWER, email: null, accessToken: 't' }),
  };

  TestBed.configureTestingModule({
    providers: [
      LoanStore,
      ReleaseStore,
      { provide: DATABASE_CLIENT, useValue: {} },
      { provide: RELEASE_STORAGE, useValue: storage },
      { provide: RealtimeChannelFactory, useValue: INERT_REALTIME },
      { provide: SupabaseAuthService, useValue: auth },
      { provide: TransitionService, useValue: { fire } },
    ],
  });
  return {
    store: TestBed.inject(ReleaseStore),
    loans: TestBed.inject(LoanStore),
    storage,
    fire,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getLoan.mockResolvedValue(loanRow());
  getLoanBalance.mockResolvedValue(balanceRow());
  listLedgerEntries.mockResolvedValue([]);
  listCreditReleasesForBorrower.mockResolvedValue([]);
  getCreditReleaseForBorrower.mockResolvedValue(draftRow());
  listWorkflowEvents.mockResolvedValue([]);
  insertCreditRelease.mockResolvedValue({
    id: RELEASE,
    loan_id: LOAN,
    state: 'draft',
    revision: 0,
  });
  updateCreditRelease.mockImplementation(
    (_client: unknown, request: { expectedRevision: number }) =>
      Promise.resolve({
        id: RELEASE,
        loan_id: LOAN,
        state: 'draft',
        revision: request.expectedRevision + 1,
      }),
  );
  deleteCreditReleaseDraft.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('composing a request', () => {
  /**
   * The URL is the position (plan/03 section 4), so the row has to exist before
   * the borrower has finished: it is created as soon as what has been typed can
   * be stored, and from that moment a refresh re-reads it rather than restoring
   * anything.
   */
  it('creates the draft as soon as the request can be stored', async () => {
    const { store, loans } = harness();
    await loans.open(LOAN);
    await store.compose(LOAN);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.amount.setValue('12,000');
    store.form.controls.purpose.setValue('Seed and fertiliser');
    await vi.advanceTimersByTimeAsync(1);

    expect(insertCreditRelease).toHaveBeenCalledTimes(1);
    expect(insertCreditRelease.mock.calls[0]?.[1]).toEqual({
      loan_id: LOAN,
      // Text, not a float: PostgREST accepts the exact decimal and the cent
      // survives the wire (packages/db/src/queries/loans.ts).
      amount: '12000.00',
      purpose: 'Seed and fertiliser',
      requested_by: BORROWER,
    });
    expect(store.releaseId()).toBe(RELEASE);
  });

  it('creates exactly one row however much more is typed', async () => {
    const { store, loans } = harness();
    await loans.open(LOAN);
    await store.compose(LOAN);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.amount.setValue('12000');
    store.form.controls.purpose.setValue('Seed');
    await vi.advanceTimersByTimeAsync(1);
    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.purpose.setValue('Seed and fertiliser');
    await vi.advanceTimersByTimeAsync(COMPOSE_DELAY_MS + 1);

    expect(insertCreditRelease).toHaveBeenCalledTimes(1);
    expect(updateCreditRelease).toHaveBeenCalledTimes(1);
  });

  /**
   * `credit_release` carries `check (amount > 0)` and a purpose that is not
   * null, so a row cannot be created from the literal first keystroke -- there
   * is nothing storable to create it with, and inventing an amount would be
   * fabricating the borrower's request. The browser holds that typing instead,
   * under the loan, and a refresh gets it back.
   */
  it('keeps typing that cannot be stored yet in the browser', async () => {
    const { store, loans, storage } = harness();
    await loans.open(LOAN);
    await store.compose(LOAN);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.purpose.setValue('Seed and fer');
    await vi.advanceTimersByTimeAsync(1);

    expect(insertCreditRelease).not.toHaveBeenCalled();
    expect(readComposeSnapshot(storage, LOAN, null)?.purpose).toBe('Seed and fer');
  });

  it('moves the unsent copy onto the row once it exists', async () => {
    const { store, loans, storage } = harness();
    await loans.open(LOAN);
    await store.compose(LOAN);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.purpose.setValue('Seed and fertiliser');
    store.form.controls.amount.setValue('12000');
    await vi.advanceTimersByTimeAsync(1);

    expect(readComposeSnapshot(storage, LOAN, null)).toBeNull();
  });

  it('autosaves the revision it read, and adopts the one it is given back', async () => {
    const { store, loans } = harness();
    await loans.open(LOAN);
    await store.open(LOAN, RELEASE);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.purpose.setValue('Seed, fertiliser and fuel');
    await vi.advanceTimersByTimeAsync(COMPOSE_DELAY_MS + 1);

    expect(updateCreditRelease.mock.calls[0]?.[1]).toMatchObject({
      releaseId: RELEASE,
      expectedRevision: 3,
    });
    expect(store.revision()).toBe(4);
  });

  /**
   * THE PRISTINE GATE. Opening a draft puts the server's payload in the form,
   * which fires a value change; an autosave that acted on it would write the
   * form back over the row before the borrower has typed anything.
   */
  it('does not save the form it has just loaded', async () => {
    const { store, loans, storage } = harness();
    await loans.open(LOAN);
    await store.open(LOAN, RELEASE);
    await vi.advanceTimersByTimeAsync(COMPOSE_DELAY_MS * 3);

    expect(updateCreditRelease).not.toHaveBeenCalled();
    expect(store.form.pristine).toBe(true);
    expect(readComposeSnapshot(storage, LOAN, RELEASE)).toBeNull();
  });

  it('re-reads when the revision moved under an autosave', async () => {
    updateCreditRelease.mockResolvedValue(null);
    const { store, loans } = harness();
    await loans.open(LOAN);
    await store.open(LOAN, RELEASE);
    expect(getCreditReleaseForBorrower).toHaveBeenCalledTimes(1);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.purpose.setValue('Something else');
    await vi.advanceTimersByTimeAsync(COMPOSE_DELAY_MS + 1);

    expect(getCreditReleaseForBorrower).toHaveBeenCalledTimes(2);
  });

  it('offers back edits the server never received', async () => {
    const { store, loans, storage } = harness();
    writeComposeSnapshot(storage, {
      loanId: LOAN,
      releaseId: RELEASE,
      revision: 3,
      amountText: '15000',
      purpose: 'Seed and fertiliser',
      savedAt: NOW,
    });

    await loans.open(LOAN);
    await store.open(LOAN, RELEASE);

    expect(store.recovered()?.amountText).toBe('15000');
    expect(store.form.controls.amount.value).toBe('15000');
    expect(store.form.dirty).toBe(true);
  });
});

describe('what the borrower is told before they submit', () => {
  it('measures the request against the figure the loan screen shows', async () => {
    const { store, loans } = harness();
    await loans.open(LOAN);
    await store.compose(LOAN);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.amount.setValue('121557.53');
    store.form.controls.purpose.setValue('Everything');
    await vi.advanceTimersByTimeAsync(1);

    expect(
      store.rules().find((result) => result.id === 'release_within_available')?.status,
    ).toBe('pass');

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.amount.setValue('121557.54');
    expect(
      store.rules().find((result) => result.id === 'release_within_available')?.status,
    ).toBe('fail');
    expect(store.canSubmit()).toBe(false);
  });
});

describe('submitting', () => {
  it('fires the transition with the revision it read and drops the seatbelt', async () => {
    const { store, loans, storage, fire } = harness();
    await loans.open(LOAN);
    await store.open(LOAN, RELEASE);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.purpose.setValue('Seed, fertiliser and fuel');
    await vi.advanceTimersByTimeAsync(COMPOSE_DELAY_MS + 1);

    getCreditReleaseForBorrower.mockResolvedValue(draftRow({ state: 'submitted', revision: 5 }));
    const outcome = await store.submit();

    expect(outcome.ok).toBe(true);
    expect(fire).toHaveBeenCalledWith({
      machine: 'credit_release',
      subjectId: RELEASE,
      event: 'submit',
      // The autosave moved it from 3 to 4, and the submit must send what the
      // row now holds rather than what it held when the screen opened.
      expectedRevision: 4,
    });
    expect(readComposeSnapshot(storage, LOAN, RELEASE)).toBeNull();
  });

  /**
   * Two tabs, one request. The second one is holding a revision the server has
   * moved past, and the answer is to go and read what it now holds -- not to
   * report a conflict beside a screen that is already wrong.
   */
  it('refetches rather than insisting, when the revision has moved', async () => {
    const { store, loans, fire } = harness();
    await loans.open(LOAN);
    await store.open(LOAN, RELEASE);
    expect(getCreditReleaseForBorrower).toHaveBeenCalledTimes(1);

    fire.mockRejectedValue({ status: 409, code: 'revision_conflict', reason: 'it moved' });
    getCreditReleaseForBorrower.mockResolvedValue(draftRow({ state: 'submitted', revision: 4 }));

    const outcome = await store.submit();

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.conflicted).toBe(true);
    expect(getCreditReleaseForBorrower).toHaveBeenCalledTimes(2);
    expect(store.value()?.release?.state).toBe('submitted');
  });

  it('shows the blockers the server refused with, not only the prediction', async () => {
    const { store, loans, fire } = harness();
    await loans.open(LOAN);
    await store.open(LOAN, RELEASE);

    fire.mockRejectedValue({
      ok: false,
      status: 422,
      code: 'transition_refused',
      reason: 'the request exceeds available credit',
      blockers: [
        {
          id: 'release_within_available',
          label: 'Within your available credit',
          status: 'fail',
          severity: 'error',
          explain: 'The request is more than is available.',
          inputs: {},
          delta: null,
          waitingOn: [],
        },
      ],
    });

    await store.submit();

    expect(store.serverRefusal()).toHaveLength(1);
    expect(store.serverRefusal()[0]?.id).toBe('release_within_available');
  });
});

describe('abandoning a draft', () => {
  it('deletes the row and forgets the browser copy', async () => {
    const { store, loans, storage } = harness();
    await loans.open(LOAN);
    await store.open(LOAN, RELEASE);

    // Typing marks the form dirty in a browser; setValue does not.
    store.form.markAsDirty();
    store.form.controls.purpose.setValue('Changed my mind');
    await vi.advanceTimersByTimeAsync(1);

    expect(await store.discard()).toBe(true);
    expect(deleteCreditReleaseDraft).toHaveBeenCalledWith({}, RELEASE);
    expect(readComposeSnapshot(storage, LOAN, RELEASE)).toBeNull();
  });
});
