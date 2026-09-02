import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { AppRole } from '@lj/domain';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { TransitionService } from '../../core/workflow/transition.service.ts';
import { ApplicationStore, DRAFT_STORAGE } from './application.store.ts';
import { ApplyStepPage } from './step.page.ts';

const { getBorrowerApplication, listActiveLoanProducts, saveApplicationDraft } = vi.hoisted(() => ({
  getBorrowerApplication: vi.fn(),
  listActiveLoanProducts: vi.fn(),
  saveApplicationDraft: vi.fn(),
}));

vi.mock('@lj/db', async (importOriginal) =>
  Object.assign({}, await importOriginal<typeof import('@lj/db')>(), {
    getBorrowerApplication,
    listActiveLoanProducts,
    saveApplicationDraft,
  }),
);

const ID = '00000000-0000-4000-8000-0000000000d1';
const NOW = '2026-09-01T12:00:00.000+00:00';

const COMPLETE_PAYLOAD = {
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

const PRODUCT = {
  id: '00000000-0000-4000-8000-0000000000b2',
  org_id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Equipment Term Loan',
  min_amount: 10000,
  max_amount: 250000,
  active: true,
  required_docs: {},
  criteria: {
    version: 1,
    rules: [
      { id: 'max_ltv', label: 'Loan to value', kind: 'max', field: 'ltv', threshold: 8000 },
      { id: 'in_footprint', label: 'Operating region', kind: 'one_of', field: 'province', allowed: ['AB'] },
    ],
  },
};

function row(data: unknown, furthestStep: string): Record<string, unknown> {
  return {
    id: ID,
    borrower_id: '00000000-0000-4000-8000-0000000000c2',
    org_id: '00000000-0000-4000-8000-0000000000a1',
    state: 'draft',
    revision: 7,
    data,
    furthest_step: furthestStep,
    submitted_at: null,
    decided_at: null,
    created_at: NOW,
    updated_at: NOW,
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

interface Rendered {
  element: HTMLElement;
  store: ApplicationStore;
  fire: ReturnType<typeof vi.fn>;
  detect: () => void;
}

async function render(step: string): Promise<Rendered> {
  const fire = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      ApplicationStore,
      { provide: DATABASE_CLIENT, useValue: {} },
      { provide: DRAFT_STORAGE, useValue: memoryStorage() },
      { provide: SupabaseAuthService, useValue: { role: signal<AppRole | null>('borrower') } },
      { provide: TransitionService, useValue: { fire } },
    ],
  });

  const store = TestBed.inject(ApplicationStore);
  await store.open(ID);

  const fixture = TestBed.createComponent(ApplyStepPage);
  fixture.componentRef.setInput('step', step);
  fixture.detectChanges();
  return {
    element: fixture.nativeElement as HTMLElement,
    store,
    fire,
    detect: () => fixture.detectChanges(),
  };
}

/** Let every queued microtask and the timer queue drain before asserting. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function button(element: HTMLElement, testId: string): HTMLButtonElement | null {
  return element.querySelector('[data-testid="' + testId + '"]');
}

beforeEach(() => {
  getBorrowerApplication.mockReset().mockResolvedValue(row(COMPLETE_PAYLOAD, 'request'));
  listActiveLoanProducts.mockReset().mockResolvedValue([PRODUCT]);
  saveApplicationDraft.mockReset().mockResolvedValue({
    id: ID,
    state: 'draft',
    revision: 8,
    updated_at: NOW,
  });
});

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('the step page', () => {
  it('holds the applicant on a step that is not answered yet', async () => {
    getBorrowerApplication.mockResolvedValue(row({}, 'request'));
    const { element } = await render('borrower');

    expect(button(element, 'continue')?.disabled).toBe(true);
    expect(element.querySelector('[data-testid="outstanding"]')?.textContent).toContain(
      'Legal name',
    );
  });

  it('lets them continue once the step is answered', async () => {
    const { element } = await render('borrower');
    expect(button(element, 'continue')?.disabled).toBe(false);
  });

  // The resume hint has to be written BEFORE the navigation, or a reload a
  // second later lands one step behind where the applicant is looking.
  it('records the step reached before navigating to it', async () => {
    getBorrowerApplication.mockResolvedValue(row(COMPLETE_PAYLOAD, 'farm'));
    const { element, detect } = await render('farm');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    button(element, 'continue')?.click();
    await settle();
    detect();

    expect(saveApplicationDraft.mock.calls[0]?.[1]).toMatchObject({ furthestStep: 'financials' });
    expect(navigate).toHaveBeenCalledWith(['/apply', ID, 'financials']);
    expect(saveApplicationDraft.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('offers submit on the last step, and only there', async () => {
    const last = await render('request');
    expect(button(last.element, 'submit')).not.toBeNull();
    expect(button(last.element, 'continue')).toBeNull();

    TestBed.resetTestingModule();
    const first = await render('borrower');
    expect(button(first.element, 'submit')).toBeNull();
  });

  /**
   * The two cases that would put blockers on the screen -- a refused
   * prediction and a refused request -- are NOT rendered here, and not because
   * they do not matter.
   *
   * `apps/web`'s unit-test builder pre-bundles `@lj/ui` as a dependency rather
   * than compiling it as part of this program, so its components arrive without
   * their compiled input metadata and every `[input]` binding into one is
   * silently dropped -- `<lj-rule-list [results]>` then throws NG0950 at
   * render. `packages/ui/angular.json` names this exact failure mode in a
   * comment ("a JIT runner would silently drop every [input] binding"). The
   * production build does NOT have it: the built bundle carries
   * `inputs:{results:[1,'results'],...}` and binds it, which was checked
   * against `dist/` rather than assumed.
   *
   * So the decision behind those two cases is tested where it lives instead:
   * `refusalToShow` in ./refusal.spec.ts owns the precedence, and the store
   * spec owns the capture of the server's blockers. What is untested is the
   * one line of template that hands one to the other, and the browser suite
   * (issue #14) is where that belongs anyway; see issue #33 -- it renders the real bundle.
   */
});
