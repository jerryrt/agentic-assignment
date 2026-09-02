import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppRole } from '@lj/domain';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { TransitionService } from '../../core/workflow/transition.service.ts';
import { DOCUMENT_TODAY, DocumentPackStore, NO_DATABASE } from './document-pack.store.ts';
import { DOCUMENT_INTAKE, INTAKE_NOT_WIRED, UnwiredDocumentIntake } from './intake.ts';

const { getApplicationForAudience, listDocumentSlots, listDocumentUploadsForApplication } =
  vi.hoisted(() => ({
    getApplicationForAudience: vi.fn(),
    listDocumentSlots: vi.fn(),
    listDocumentUploadsForApplication: vi.fn(),
  }));

vi.mock('@lj/db', async (importOriginal) =>
  Object.assign({}, await importOriginal<typeof import('@lj/db')>(), {
    getApplicationForAudience,
    listDocumentSlots,
    listDocumentUploadsForApplication,
  }),
);

const APPLICATION = '00000000-0000-4000-8000-0000000000d1';
const TODAY = '2026-09-02';
const NOW = '2026-09-01T12:00:00.000+00:00';

const SLOT_A = '00000000-0000-4000-8000-0000000000e1';
const SLOT_B = '00000000-0000-4000-8000-0000000000e2';

function application(): Record<string, unknown> {
  return {
    id: APPLICATION,
    borrower_id: '00000000-0000-4000-8000-0000000000c2',
    org_id: '00000000-0000-4000-8000-0000000000a1',
    state: 'docs_pending',
    revision: 4,
    data: {
      borrower: { legal_name: 'Fenwick Grain Co.' },
      farm: {
        parcels: [
          { legal_description: 'NW-14-35-05-W3', acres: 1240, tenure: 'owned', commodity: 'grain' },
        ],
      },
    },
    furthest_step: 'request',
    submitted_at: NOW,
    decided_at: null,
    created_at: NOW,
    updated_at: NOW,
    // `application_lender_v` left-joins the decision, so every column below is
    // null on an application nobody has decided -- which is every row a lender
    // is reading documents for. The borrower's schema strips them.
    decision_note: null,
    risk_grade: null,
    decided_by: null,
    recorded_at: null,
    borrower_name: 'Fenwick Grain Co.',
    open_doc_count: 1,
  };
}

function slot(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SLOT_A,
    application_id: APPLICATION,
    code: 'land_title',
    label: 'Land title or lease',
    required: true,
    state: 'required',
    revision: 0,
    extract_required: [],
    valid_until: null,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

function upload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    slot_id: SLOT_A,
    storage_path: APPLICATION + '/land_title/a.pdf',
    filename: 'a.pdf',
    bytes: 2048,
    mime: 'application/pdf',
    extracted: null,
    extraction_state: 'done',
    uploaded_at: NOW,
    ...patch,
  };
}

interface Harness {
  store: DocumentPackStore;
  fire: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  correct: ReturnType<typeof vi.fn>;
}

function build(options: { role?: AppRole; intakeWorks?: boolean } = {}): Harness {
  const fire = vi.fn();
  const uploadFn = vi.fn().mockResolvedValue(undefined);
  const correctFn = vi.fn().mockResolvedValue(undefined);
  const role = options.role ?? 'borrower';

  TestBed.configureTestingModule({
    providers: [
      DocumentPackStore,
      { provide: DATABASE_CLIENT, useValue: {} },
      {
        provide: SupabaseAuthService,
        useValue: {
          role: signal<AppRole | null>(role),
          audience: signal(role === 'borrower' ? 'borrower' : 'lender'),
        },
      },
      { provide: TransitionService, useValue: { fire } },
      { provide: DOCUMENT_TODAY, useValue: () => TODAY },
      {
        provide: DOCUMENT_INTAKE,
        useValue:
          options.intakeWorks === true
            ? { upload: uploadFn, correct: correctFn }
            : new UnwiredDocumentIntake(),
      },
    ],
  });

  return {
    store: TestBed.inject(DocumentPackStore),
    fire,
    upload: uploadFn,
    correct: correctFn,
  };
}

function pdf(bytes = 1024): File {
  return new File([new Uint8Array(bytes)], 'title.pdf', { type: 'application/pdf' });
}

beforeEach(() => {
  getApplicationForAudience.mockReset().mockResolvedValue(application());
  listDocumentSlots.mockReset().mockResolvedValue([slot()]);
  listDocumentUploadsForApplication.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('opening a pack', () => {
  it('reads the application, its slots and every file against them', async () => {
    const { store } = build();
    await store.open(APPLICATION);

    expect(store.isReady()).toBe(true);
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]?.slot.code).toBe('land_title');
    expect(listDocumentUploadsForApplication).toHaveBeenCalledWith({}, APPLICATION);
  });

  /**
   * A lender reading `application_borrower_v` is filtered out by row-level
   * security and would see an application that does not exist, so the
   * projection follows the audience rather than being fixed.
   */
  it('asks for the projection the reader is entitled to', async () => {
    const borrower = build();
    await borrower.store.open(APPLICATION);
    expect(getApplicationForAudience).toHaveBeenCalledWith({}, 'borrower', APPLICATION);

    TestBed.resetTestingModule();
    const lender = build({ role: 'lender' });
    await lender.store.open(APPLICATION);
    expect(getApplicationForAudience).toHaveBeenLastCalledWith({}, 'lender', APPLICATION);
  });

  it('says so plainly when the build cannot reach the database', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        DocumentPackStore,
        { provide: DATABASE_CLIENT, useValue: null },
        {
          provide: SupabaseAuthService,
          useValue: { role: signal<AppRole | null>('borrower'), audience: signal('borrower') },
        },
        { provide: TransitionService, useValue: { fire: vi.fn() } },
      ],
    });

    const store = TestBed.inject(DocumentPackStore);
    await store.open(APPLICATION);

    expect(store.failure()?.message).toBe(NO_DATABASE);
  });
});

/**
 * plan/04's first honesty rule, through the store rather than through the pure
 * function: what the screen binds to is what these tests read.
 */
describe('the bar the borrower sees', () => {
  it('counts accepted-and-valid, not uploaded', async () => {
    listDocumentSlots.mockResolvedValue([
      slot({ id: SLOT_A, code: 'land_title', state: 'uploaded' }),
      slot({ id: SLOT_B, code: 'tax_return_2024', state: 'accepted' }),
    ]);

    const { store } = build();
    await store.open(APPLICATION);

    expect(store.progress()).toMatchObject({ accepted: 1, total: 2 });
    expect(store.isComplete()).toBe(false);
  });

  it('is full only when every required slot is accepted, current and readable', async () => {
    listDocumentSlots.mockResolvedValue([
      slot({ id: SLOT_A, code: 'land_title', state: 'accepted' }),
      slot({ id: SLOT_B, code: 'tax_return_2024', state: 'accepted', valid_until: '2027-01-01' }),
    ]);

    const { store } = build();
    await store.open(APPLICATION);

    expect(store.isComplete()).toBe(true);
  });

  /**
   * The distinction plan/04 calls load-bearing. Same field, same confidence,
   * one of them typed in by a person: the machine's opinion of its own reading
   * stops being the question, and the slot recomputes to accepted.
   */
  it('accepts a field a person typed in, whatever the extractor thought of it', async () => {
    listDocumentSlots.mockResolvedValue([
      slot({ state: 'accepted', extract_required: ['net_income'] }),
    ]);
    listDocumentUploadsForApplication.mockResolvedValue([
      upload({ extracted: { net_income: { value: 184200, confidence_basis_points: 1000, source: 'ocr' } } }),
    ]);

    const machineRead = build();
    await machineRead.store.open(APPLICATION);
    expect(machineRead.store.progress()).toMatchObject({ accepted: 0, total: 1 });
    expect(machineRead.store.rows()[0]?.action.kind).toBe('correct');

    TestBed.resetTestingModule();
    listDocumentUploadsForApplication.mockResolvedValue([
      upload({ extracted: { net_income: { value: 184200, confidence_basis_points: 1000, source: 'human' } } }),
    ]);

    const corrected = build();
    await corrected.store.open(APPLICATION);
    expect(corrected.store.progress()).toMatchObject({ accepted: 1, total: 1 });
    expect(corrected.store.rows()[0]?.action.kind).toBe('done');
  });
});

describe('the cross-checks', () => {
  it('compare a document against the application and show the gap', async () => {
    listDocumentSlots.mockResolvedValue([
      slot({ code: 'land_title', state: 'accepted', extract_required: [] }),
    ]);
    listDocumentUploadsForApplication.mockResolvedValue([
      upload({
        extracted: { total_acres: { value: 1600, confidence_basis_points: 9000, source: 'ocr' } },
      }),
    ]);

    const { store } = build();
    await store.open(APPLICATION);

    const acreage = store.crossChecks().find((result) => result.id === 'acreage_matches_application');
    expect(acreage?.status).toBe('fail');
    // Both figures and the tolerance, which is what plan/04 requires the panel
    // to show. The renderer is @lj/ui's; this asserts the inputs reach it.
    expect(acreage?.inputs).toMatchObject({
      'The land title': 1600,
      'your application': 1240,
      tolerance: { kind: 'percent', basisPoints: 200 },
    });
    expect(acreage?.delta).not.toBeNull();
  });
});

describe('the lender deciding on a document', () => {
  beforeEach(() => {
    listDocumentSlots.mockResolvedValue([slot({ state: 'extracted', revision: 2 })]);
  });

  it('accepts through the one place a transition is fired, with the revision it read', async () => {
    const { store, fire } = build({ role: 'lender' });
    fire.mockResolvedValue({
      ok: true,
      machine: 'document_slot',
      subjectId: SLOT_A,
      event: 'accept',
      from: 'extracted',
      to: 'accepted',
      revision: 3,
      actorRole: 'lender',
      effects: [],
      events: [],
    });

    await store.open(APPLICATION);
    await store.accept(SLOT_A);

    expect(fire).toHaveBeenCalledWith({
      machine: 'document_slot',
      subjectId: SLOT_A,
      event: 'accept',
      expectedRevision: 2,
    });
  });

  it('rejects with the same revision and the reject event', async () => {
    const { store, fire } = build({ role: 'lender' });
    fire.mockResolvedValue({
      ok: true,
      machine: 'document_slot',
      subjectId: SLOT_A,
      event: 'reject',
      from: 'extracted',
      to: 'rejected',
      revision: 3,
      actorRole: 'lender',
      effects: [],
      events: [],
    });

    await store.open(APPLICATION);
    await store.reject(SLOT_A);

    expect(fire).toHaveBeenCalledWith({
      machine: 'document_slot',
      subjectId: SLOT_A,
      event: 'reject',
      expectedRevision: 2,
    });
  });

  /**
   * The answer moves the screen without a second read: the bar and the row are
   * computed from the slot, so taking the acknowledgement in is enough. It is
   * also what makes the next decision send the revision the server now holds.
   */
  it('takes the answer into the pack, so the bar and the next revision are right', async () => {
    const { store, fire } = build({ role: 'lender' });
    fire.mockResolvedValue({
      ok: true,
      machine: 'document_slot',
      subjectId: SLOT_A,
      event: 'accept',
      from: 'extracted',
      to: 'accepted',
      revision: 3,
      actorRole: 'lender',
      effects: [],
      events: [],
    });

    await store.open(APPLICATION);
    expect(store.progress()).toMatchObject({ accepted: 0, total: 1 });

    await store.accept(SLOT_A);

    expect(store.progress()).toMatchObject({ accepted: 1, total: 1 });
    expect(store.rows()[0]?.slot.revision).toBe(3);
  });

  it('reports a refusal rather than moving anything', async () => {
    const { store, fire } = build({ role: 'lender' });
    fire.mockRejectedValue({ status: 403, code: 'forbidden_role', reason: 'a borrower may not accept' });

    await store.open(APPLICATION);
    const outcome = await store.accept(SLOT_A);

    expect(outcome.ok).toBe(false);
    expect(store.failure()?.message).toBe('a borrower may not accept');
    expect(store.rows()[0]?.slot.state).toBe('extracted');
  });

  it('will not decide on a slot this pack does not hold', async () => {
    const { store, fire } = build({ role: 'lender' });
    await store.open(APPLICATION);

    const outcome = await store.accept('00000000-0000-4000-8000-0000000000ff');

    expect(outcome.ok).toBe(false);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe('sending a file', () => {
  it('never reaches the seam when the browser can already refuse it', async () => {
    const { store, upload: sent } = build({ intakeWorks: true });
    await store.open(APPLICATION);

    await store.upload(SLOT_A, new File(['x'], 'notes.txt', { type: 'text/plain' }));

    expect(sent).not.toHaveBeenCalled();
    expect(store.refusal()).toContain('PDF');
    expect(store.progress()).toMatchObject({ accepted: 0, total: 1 });
  });

  it('hands the seam the application, the slot and the slot`s code', async () => {
    const { store, upload: sent } = build({ intakeWorks: true });
    await store.open(APPLICATION);

    const file = pdf();
    await store.upload(SLOT_A, file);

    expect(sent).toHaveBeenCalledWith({
      applicationId: APPLICATION,
      slotId: SLOT_A,
      slotCode: 'land_title',
      file,
    });
  });

  it('re-reads the pack afterwards rather than predicting what the server did', async () => {
    const { store } = build({ intakeWorks: true });
    await store.open(APPLICATION);
    listDocumentSlots.mockResolvedValue([slot({ state: 'extracted' })]);

    await store.upload(SLOT_A, pdf());

    expect(store.rows()[0]?.slot.state).toBe('extracted');
  });

  /**
   * The seam has nothing behind it in this build (issue #42), and the refusal
   * is put on the screen rather than swallowed -- and nothing on the checklist
   * moves, which is the half that matters.
   */
  it('says plainly that nothing was sent when the seam is not wired', async () => {
    const { store } = build();
    await store.open(APPLICATION);

    await store.upload(SLOT_A, pdf());

    expect(store.failure()?.message).toBe(INTAKE_NOT_WIRED);
    expect(store.rows()[0]?.slot.state).toBe('required');
    expect(store.progress()).toMatchObject({ accepted: 0, total: 1 });
  });
});

describe('typing a value in', () => {
  beforeEach(() => {
    listDocumentSlots.mockResolvedValue([
      slot({ state: 'accepted', extract_required: ['net_income'] }),
    ]);
    listDocumentUploadsForApplication.mockResolvedValue([
      upload({ extracted: { net_income: { value: 1, confidence_basis_points: 1000, source: 'ocr' } } }),
    ]);
  });

  it('goes through the seam with the field it is correcting', async () => {
    const { store, correct } = build({ intakeWorks: true });
    await store.open(APPLICATION);

    await store.correct(SLOT_A, 'net_income', '184200');

    expect(correct).toHaveBeenCalledWith({
      applicationId: APPLICATION,
      slotId: SLOT_A,
      field: 'net_income',
      value: '184200',
    });
  });

  /**
   * The correction is recorded and the pack re-read, so the field the slot now
   * carries is the server's. A local patch to `source: 'human'` would move the
   * bar on the client's word alone.
   */
  it('re-reads, and the slot recomputes once the server records the correction', async () => {
    const { store } = build({ intakeWorks: true });
    await store.open(APPLICATION);
    expect(store.progress()).toMatchObject({ accepted: 0, total: 1 });

    listDocumentUploadsForApplication.mockResolvedValue([
      upload({
        extracted: { net_income: { value: 184200, confidence_basis_points: 1000, source: 'human' } },
      }),
    ]);
    await store.correct(SLOT_A, 'net_income', '184200');

    expect(store.progress()).toMatchObject({ accepted: 1, total: 1 });
    expect(store.rows()[0]?.action.kind).toBe('done');
  });

  it('leaves the slot alone when the seam refuses', async () => {
    const { store } = build();
    await store.open(APPLICATION);

    await store.correct(SLOT_A, 'net_income', '184200');

    expect(store.failure()).not.toBeNull();
    expect(store.progress()).toMatchObject({ accepted: 0, total: 1 });
  });
});
