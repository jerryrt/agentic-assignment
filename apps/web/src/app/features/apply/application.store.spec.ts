import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppRole } from '@lj/domain';

import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { TransitionService } from '../../core/workflow/transition.service.ts';
import { AUTOSAVE_DELAY_MS, ApplicationStore, DRAFT_STORAGE } from './application.store.ts';
import { readDraftSnapshot, writeDraftSnapshot } from './draft.ts';

const { getBorrowerApplication, listActiveLoanProducts, saveApplicationDraft } = vi.hoisted(() => ({
  getBorrowerApplication: vi.fn(),
  listActiveLoanProducts: vi.fn(),
  saveApplicationDraft: vi.fn(),
}));

// Object.assign rather than a spread: the factory is hoisted above esbuild's
// own helper definitions, so `...` compiles to a call to a function that does
// not exist yet.
vi.mock('@lj/db', async (importOriginal) =>
  Object.assign({}, await importOriginal<typeof import('@lj/db')>(), {
    getBorrowerApplication,
    listActiveLoanProducts,
    saveApplicationDraft,
  }),
);

const ID = '00000000-0000-4000-8000-0000000000d1';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const BORROWER = '00000000-0000-4000-8000-0000000000c2';
const NOW = '2026-09-01T12:00:00.000+00:00';

const SEEDED_PAYLOAD = {
  borrower: {
    entity_type: 'sole_trader',
    legal_name: 'Beau Marchand',
    years_farming: 2,
    province: 'AB',
    postal_code: 'T1J 4B4',
    contact_email: 'grower@example.test',
    contact_phone: '403-555-0119',
  },
  farm: {
    primary_commodity: 'mixed',
    irrigation: 'none',
    has_crop_insurance: true,
    parcels: [
      { legal_description: 'SW-08-09-22-W4', acres: 310, tenure: 'owned', commodity: 'mixed' },
    ],
  },
  financials: {
    statements_basis: 'accrual',
    gross_revenue_minor: 41000000,
    operating_expenses_minor: 29500000,
    existing_debt_service_minor: 7200000,
    current_assets_minor: 18000000,
    current_liabilities_minor: 9500000,
  },
  request: {
    product_id: '00000000-0000-4000-8000-0000000000b2',
    amount_requested_minor: 9500000,
    term_months: 60,
    purpose: 'Replace a 1998 combine ahead of harvest',
    collateral_value_minor: 12500000,
  },
};

const EQUIPMENT_PRODUCT = {
  id: '00000000-0000-4000-8000-0000000000b2',
  org_id: ORG,
  name: 'Equipment Term Loan',
  min_amount: 10000,
  max_amount: 250000,
  active: true,
  required_docs: {},
  criteria: {
    version: 1,
    rules: [
      { id: 'dscr_floor', label: 'Debt service coverage', kind: 'min', field: 'dscr', threshold: 11500 },
      { id: 'max_ltv', label: 'Loan to value', kind: 'max', field: 'ltv', threshold: 8000 },
      { id: 'years_farming', label: 'Years farming', kind: 'min', field: 'years_farming', threshold: 1 },
      { id: 'in_footprint', label: 'Operating region', kind: 'one_of', field: 'province', allowed: ['AB', 'SK', 'MB'] },
    ],
  },
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    borrower_id: BORROWER,
    org_id: ORG,
    state: 'draft',
    revision: 7,
    data: SEEDED_PAYLOAD,
    furthest_step: 'financials',
    submitted_at: null,
    decided_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, value),
  };
}

interface Harness {
  store: ApplicationStore;
  storage: Storage;
  fire: ReturnType<typeof vi.fn>;
}

function harness(options: { role?: AppRole } = {}): Harness {
  const storage = memoryStorage();
  const fire = vi.fn();
  const auth = { role: signal<AppRole | null>(options.role ?? 'borrower') };

  TestBed.configureTestingModule({
    providers: [
      ApplicationStore,
      { provide: DATABASE_CLIENT, useValue: {} },
      { provide: DRAFT_STORAGE, useValue: storage },
      { provide: SupabaseAuthService, useValue: auth },
      { provide: TransitionService, useValue: { fire } },
    ],
  });
  return { store: TestBed.inject(ApplicationStore), storage, fire };
}

beforeEach(() => {
  vi.useFakeTimers();
  getBorrowerApplication.mockReset().mockResolvedValue(row());
  listActiveLoanProducts.mockReset().mockResolvedValue([EQUIPMENT_PRODUCT]);
  saveApplicationDraft
    .mockReset()
    .mockImplementation((_client: unknown, patch: { expectedRevision: number }) =>
      Promise.resolve({
        id: ID,
        state: 'draft',
        revision: patch.expectedRevision + 1,
        updated_at: NOW,
      }),
    );
});

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('opening an application', () => {
  it('reads the row and puts its payload in the form', async () => {
    const { store } = harness();
    await store.open(ID);

    expect(store.data().borrower.legal_name).toBe('Beau Marchand');
    expect(store.form.controls.farm.controls.parcels.length).toBe(1);
    expect(store.furthestStep()).toBe('financials');
  });

  // THE BUG plan/05 SINGLES OUT. Loading the form fires a value change, and an
  // autosave that acted on it would write the form over the server's copy
  // before the applicant has typed a character.
  it('does not save the form it has just loaded', async () => {
    const { store } = harness();
    await store.open(ID);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);

    expect(saveApplicationDraft).not.toHaveBeenCalled();
    expect(store.form.pristine).toBe(true);
  });

  it('does not write a seatbelt for a form nobody has touched', async () => {
    const { store, storage } = harness();
    await store.open(ID);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);

    expect(readDraftSnapshot(storage, ID)).toBeNull();
  });

  // Re-opening happens on every step navigation, because the guard and the
  // shell both ask. A second read would drop unsaved typing on the floor.
  it('does not re-read an application it already holds', async () => {
    const { store } = harness();
    await store.open(ID);
    await store.open(ID);

    expect(getBorrowerApplication).toHaveBeenCalledTimes(1);
  });

  it('reports an application it cannot read rather than rendering an empty form', async () => {
    getBorrowerApplication.mockResolvedValue(null);
    const { store } = harness();
    await store.open(ID);

    expect(store.status()).toBe('error');
    expect(store.failure()?.message).toContain('does not exist');
  });
});

describe('autosaving a draft', () => {
  it('waits for the applicant to stop typing, then writes once', async () => {
    const { store } = harness();
    await store.open(ID);

    store.form.controls.request.controls.purpose.setValue('A');
    store.form.controls.request.controls.purpose.setValue('A new combine');
    store.form.markAsDirty();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(saveApplicationDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(saveApplicationDraft).toHaveBeenCalledTimes(1);
  });

  it('sends the revision it read, and adopts the one it is given back', async () => {
    const { store } = harness();
    await store.open(ID);
    expect(store.revision()).toBe(7);

    store.form.controls.request.controls.purpose.setValue('A new combine');
    store.form.markAsDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 1);

    expect(saveApplicationDraft.mock.calls[0]?.[1]).toMatchObject({
      applicationId: ID,
      expectedRevision: 7,
    });
    expect(store.revision()).toBe(8);
    expect(store.form.pristine).toBe(true);
  });

  // The seatbelt has to be there between keystrokes, not 800ms behind them:
  // the case it covers is the tab being killed, which gives no warning.
  it('writes the seatbelt immediately and clears it once the server has the payload', async () => {
    const { store, storage } = harness();
    await store.open(ID);

    store.form.controls.request.controls.purpose.setValue('A new combine');
    store.form.markAsDirty();
    store.form.controls.request.controls.purpose.setValue('A new combine, urgently');

    const held = readDraftSnapshot(storage, ID);
    expect(held?.revision).toBe(7);
    expect(held?.data.request.purpose).toBe('A new combine, urgently');

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 1);
    expect(readDraftSnapshot(storage, ID)).toBeNull();
  });

  it('refuses to autosave an application that is no longer a draft', async () => {
    getBorrowerApplication.mockResolvedValue(row({ state: 'under_review' }));
    const { store } = harness();
    await store.open(ID);

    store.form.controls.request.controls.purpose.setValue('Too late');
    store.form.markAsDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 1);

    expect(saveApplicationDraft).not.toHaveBeenCalled();
  });

  // A null acknowledgement is PostgREST saying the revision matched no row:
  // a second tab, or a lender acting while the borrower typed. The server is
  // right, so go and ask it rather than reasoning about it here.
  it('refetches when the revision moved under the write', async () => {
    const { store } = harness();
    await store.open(ID);
    saveApplicationDraft.mockResolvedValue(null);

    store.form.controls.request.controls.purpose.setValue('A new combine');
    store.form.markAsDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 1);

    expect(getBorrowerApplication).toHaveBeenCalledTimes(2);
  });
});

describe('recovering unsaved work', () => {
  it('restores edits the server never received, and marks them for saving', async () => {
    const { store, storage } = harness();
    writeDraftSnapshot(storage, {
      applicationId: ID,
      revision: 7,
      data: { ...store.data(), request: { ...store.data().request, purpose: 'Rescued text' } },
      furthestStep: 'request',
      savedAt: NOW,
    });

    await store.open(ID);

    expect(store.recoveredDraft()).not.toBeNull();
    expect(store.data().request.purpose).toBe('Rescued text');
    expect(store.form.dirty).toBe(true);
  });

  // A later revision on the server means somebody saved something this browser
  // never saw; restoring over it would delete their work.
  it('ignores a seatbelt the server has already moved past', async () => {
    const { store, storage } = harness();
    writeDraftSnapshot(storage, {
      applicationId: ID,
      revision: 6,
      data: { ...store.data(), request: { ...store.data().request, purpose: 'Stale text' } },
      furthestStep: 'request',
      savedAt: NOW,
    });

    await store.open(ID);

    expect(store.recoveredDraft()).toBeNull();
    expect(store.data().request.purpose).toBe('Replace a 1998 combine ahead of harvest');
  });

  it('goes back to the server copy when the recovery is discarded', async () => {
    const { store, storage } = harness();
    writeDraftSnapshot(storage, {
      applicationId: ID,
      revision: 7,
      data: { ...store.data(), request: { ...store.data().request, purpose: 'Rescued text' } },
      furthestStep: 'request',
      savedAt: NOW,
    });
    await store.open(ID);

    store.discardRecoveredDraft();

    expect(store.recoveredDraft()).toBeNull();
    expect(store.data().request.purpose).toBe('Replace a 1998 combine ahead of harvest');
    expect(readDraftSnapshot(storage, ID)).toBeNull();
  });

  // A refetch happens on every conflict and after every submit. Reloading the
  // form under someone mid-sentence would delete the words they are typing.
  it('does not overwrite a form that is being typed into', async () => {
    const { store } = harness();
    await store.open(ID);

    store.form.controls.request.controls.purpose.setValue('Half a sen');
    store.form.markAsDirty();
    getBorrowerApplication.mockResolvedValue(row({ revision: 9 }));
    await store.refresh();

    expect(store.data().request.purpose).toBe('Half a sen');
  });
});

describe('the resume hint', () => {
  it('records a step further on than the furthest reached', async () => {
    const { store } = harness();
    await store.open(ID);

    await store.noteStepReached('request');

    expect(saveApplicationDraft.mock.calls[0]?.[1]).toMatchObject({ furthestStep: 'request' });
    expect(store.furthestStep()).toBe('request');
  });

  // Walking back to step one must not move the hint backwards, or a reload
  // would strand the applicant behind where they had got to.
  it('never moves backwards', async () => {
    const { store } = harness();
    await store.open(ID);

    await store.noteStepReached('borrower');

    expect(saveApplicationDraft).not.toHaveBeenCalled();
    expect(store.furthestStep()).toBe('financials');
  });
});

describe('predicting the submit guard', () => {
  it('refuses while a step is unanswered, and says which criteria are waiting', async () => {
    getBorrowerApplication.mockResolvedValue(
      row({ data: { ...SEEDED_PAYLOAD, request: {} } }),
    );
    const { store } = harness();
    await store.open(ID);

    const guard = store.submitGuard();
    expect(guard.ok).toBe(false);
    expect(store.canSubmit()).toBe(false);
    expect(guard.ok === false && guard.blockers.map((blocker) => blocker.id)).toContain(
      'step_request',
    );
  });

  it('permits a complete application that matches a product', async () => {
    const { store } = harness();
    await store.open(ID);

    expect(store.eligibilityMatch().status).toBe('pass');
    expect(store.canSubmit()).toBe(true);
  });

  // A lender may not fire submit at all, and the refusal is structural rather
  // than about criteria, so it carries no blockers.
  it('refuses a role the machine does not give the transition to', async () => {
    const { store } = harness({ role: 'lender' });
    await store.open(ID);

    const guard = store.submitGuard();
    expect(guard.ok).toBe(false);
    expect(guard.ok === false && guard.blockers).toEqual([]);
  });
});

describe('submitting', () => {
  it('flushes the pending payload first and fires with the revision that flush produced', async () => {
    const { store, fire } = harness();
    fire.mockResolvedValue({ ok: true, revision: 9 });
    await store.open(ID);

    store.form.controls.request.controls.purpose.setValue('A new combine');
    store.form.markAsDirty();
    await store.submit();

    expect(saveApplicationDraft).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith({
      machine: 'application',
      subjectId: ID,
      event: 'submit',
      expectedRevision: 8,
    });
  });

  it('hands back the refusal so the blockers can be rendered', async () => {
    const { store, fire } = harness();
    const blocker = {
      id: 'step_request',
      label: 'What you are asking for',
      status: 'unknown',
      severity: 'error',
      explain: 'Still needed: Amount requested.',
      inputs: {},
      missing: ['request.amount_requested_minor'],
      delta: null,
    };
    fire.mockRejectedValue({
      ok: false,
      status: 422,
      code: 'guard_refused',
      reason: 'the application is not complete',
      blockers: [blocker],
      current: { state: 'draft', revision: 7 },
    });
    await store.open(ID);

    const outcome = await store.submit();

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.failure.code).toBe('guard_refused');
    // AggregateStore flattens a failure to a message and a code, so the
    // blockers have to be caught before that or the screen has nothing to
    // render but a sentence.
    expect(store.serverRefusal().map((result) => result.id)).toEqual(['step_request']);
  });
});
