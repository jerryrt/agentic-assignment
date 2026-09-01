import { describe, expect, it } from 'vitest';

import {
  APP_ROLES,
  AppRoleSchema,
  ApplicationBorrowerViewSchema,
  ApplicationLenderViewSchema,
  ApplicationSchema,
  ApplicationStateSchema,
  DOCUMENT_SLOT_STATES,
  LoanProductSchema,
  OrganisationSchema,
  ProfileSchema,
  TERMINAL_APPLICATION_STATES,
  WORKFLOW_MACHINES,
  WorkflowEventSchema,
  WorkflowTransitionSchema,
  isTerminalApplicationState,
} from '../src/index.js';

const ORG_ID = '2f1c8b8e-7d6a-4c1b-9f3e-5a2d0b7c4e11';
const BORROWER_ID = '0a9b8c7d-6e5f-4a3b-8c9d-1e2f3a4b5c6d';
const APPLICATION_ID = '9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const NOW = '2026-09-01T12:00:00+00:00';

describe('app_role', () => {
  it('is exactly the three roles the enum declares', () => {
    expect([...APP_ROLES]).toEqual(['borrower', 'lender', 'admin']);
    expect(AppRoleSchema.parse('lender')).toBe('lender');
    expect(AppRoleSchema.safeParse('underwriter').success).toBe(false);
    expect(AppRoleSchema.safeParse('Borrower').success).toBe(false);
  });
});

describe('the state unions', () => {
  it('names every state of the application machine in plan 03', () => {
    expect(ApplicationStateSchema.options).toEqual([
      'draft',
      'submitted',
      'docs_pending',
      'under_review',
      'needs_borrower_action',
      'approved',
      'declined',
      'funded',
      'withdrawn',
    ]);
  });

  it('knows which application states are terminal', () => {
    expect([...TERMINAL_APPLICATION_STATES]).toEqual(['funded', 'declined', 'withdrawn']);
    expect(isTerminalApplicationState('funded')).toBe(true);
    expect(isTerminalApplicationState('under_review')).toBe(false);
  });

  // Expiry is derived from valid_until and the clock, so it is deliberately
  // not a state: a machine whose state changes without an event is a machine
  // that lies. See plan 03.
  it('does not carry expired as a document slot state', () => {
    expect([...DOCUMENT_SLOT_STATES]).toEqual([
      'required',
      'uploaded',
      'extracted',
      'accepted',
      'rejected',
    ]);
  });

  it('names the three machines one event log serves', () => {
    expect([...WORKFLOW_MACHINES]).toEqual(['application', 'document_slot', 'credit_release']);
  });
});

describe('organisation', () => {
  it('parses a row', () => {
    expect(OrganisationSchema.parse({ id: ORG_ID, name: 'Prairie Ag Credit', created_at: NOW })).toEqual({
      id: ORG_ID,
      name: 'Prairie Ag Credit',
      created_at: NOW,
    });
  });

  it('rejects a malformed id and a blank name', () => {
    expect(OrganisationSchema.safeParse({ id: 'nope', name: 'X', created_at: NOW }).success).toBe(false);
    expect(OrganisationSchema.safeParse({ id: ORG_ID, name: '', created_at: NOW }).success).toBe(false);
  });
});

describe('profile', () => {
  const lender = { id: BORROWER_ID, role: 'lender', org_id: ORG_ID, full_name: 'A Lender', created_at: NOW };

  it('parses a lender and a borrower', () => {
    expect(ProfileSchema.parse(lender)).toEqual(lender);
    expect(ProfileSchema.parse({ ...lender, role: 'borrower', org_id: null, full_name: null }).org_id).toBeNull();
  });

  it('rejects a missing role rather than defaulting one', () => {
    const { role: _role, ...withoutRole } = lender;
    expect(ProfileSchema.safeParse(withoutRole).success).toBe(false);
  });
});

describe('loan product', () => {
  const product = {
    id: APPLICATION_ID,
    org_id: ORG_ID,
    name: 'Operating line',
    min_amount: '25000.00',
    max_amount: '500000.00',
    criteria: { rules: [{ id: 'dscr_floor', min_bps: 12500 }] },
    required_docs: [{ key: 'tax_return' }],
    active: true,
  };

  it('reads the amount band into minor units, never through a float', () => {
    const parsed = LoanProductSchema.parse(product);
    expect(parsed.min_amount).toBe(2_500_000);
    expect(parsed.max_amount).toBe(50_000_000);
  });

  it('allows an open-ended band', () => {
    const parsed = LoanProductSchema.parse({ ...product, min_amount: null, max_amount: null });
    expect(parsed.min_amount).toBeNull();
  });

  // criteria is a declarative rule set interpreted by packages/rules, which
  // sits above this package. Giving it a shape here would put a rule's schema
  // below the layer that owns the rule.
  it('carries criteria and required_docs as opaque JSON', () => {
    const parsed = LoanProductSchema.parse(product);
    expect(parsed.criteria).toEqual(product.criteria);
    expect(parsed.required_docs).toEqual(product.required_docs);
  });

  it('rejects a criteria value that is not JSON', () => {
    expect(LoanProductSchema.safeParse({ ...product, criteria: undefined }).success).toBe(false);
  });
});

describe('application and its two projections', () => {
  const borrowerRow = {
    id: APPLICATION_ID,
    borrower_id: BORROWER_ID,
    org_id: ORG_ID,
    state: 'under_review',
    revision: 3,
    data: { step1: { entity_type: 'corporation' } },
    furthest_step: 'financials',
    submitted_at: NOW,
    decided_at: null,
    created_at: NOW,
    updated_at: NOW,
  };

  it('parses the borrower projection', () => {
    expect(ApplicationBorrowerViewSchema.parse(borrowerRow)).toEqual(borrowerRow);
  });

  // The borrower view has no decision_note column at all; stripping the field
  // here is the second layer, so a view that regressed would not leak through
  // a schema that happened to be permissive.
  it('strips lender-only columns rather than passing them through', () => {
    const leaked = { ...borrowerRow, decision_note: 'thin margins', risk_grade: 'C' };
    const parsed = ApplicationBorrowerViewSchema.parse(leaked);
    expect(parsed).not.toHaveProperty('decision_note');
    expect(parsed).not.toHaveProperty('risk_grade');
  });

  it('parses the lender projection, which adds the decision fields and the queue counts', () => {
    const lenderRow = {
      ...borrowerRow,
      decision_note: 'thin margins',
      risk_grade: 'C',
      borrower_name: 'A Borrower',
      open_doc_count: 2,
    };
    expect(ApplicationLenderViewSchema.parse(lenderRow)).toEqual(lenderRow);
  });

  // open_doc_count counts document_slot rows, and that table arrives with the
  // Option 1 migration. Until then the view does not select the column, and the
  // honest reading of its absence is "not reported" -- not "no open documents",
  // which is a different and materially wrong thing to tell a loan officer.
  it('reads a missing open_doc_count as unreported rather than as zero', () => {
    const lenderRow = {
      ...borrowerRow,
      decision_note: null,
      risk_grade: null,
      borrower_name: 'A Borrower',
    };
    expect(ApplicationLenderViewSchema.parse(lenderRow).open_doc_count).toBeNull();
  });

  it('still rejects a negative open_doc_count when the view does report one', () => {
    const lenderRow = {
      ...borrowerRow,
      decision_note: null,
      risk_grade: null,
      borrower_name: 'A Borrower',
      open_doc_count: -1,
    };
    expect(ApplicationLenderViewSchema.safeParse(lenderRow).success).toBe(false);
  });

  it('rejects a state the machine does not have', () => {
    expect(ApplicationBorrowerViewSchema.safeParse({ ...borrowerRow, state: 'archived' }).success).toBe(false);
  });

  it('rejects a negative revision', () => {
    expect(ApplicationBorrowerViewSchema.safeParse({ ...borrowerRow, revision: -1 }).success).toBe(false);
  });

  it('parses the full server-side row', () => {
    const full = { ...borrowerRow, decision_note: null, risk_grade: null };
    expect(ApplicationSchema.parse(full)).toEqual(full);
  });
});

describe('workflow event', () => {
  const event = {
    id: 42,
    machine: 'application',
    subject_id: APPLICATION_ID,
    from_state: 'submitted',
    to_state: 'docs_pending',
    event: 'request_docs',
    actor_id: BORROWER_ID,
    actor_role: 'lender',
    payload: { note: 'need the tax return' },
    created_at: NOW,
  };

  it('parses a logged transition', () => {
    expect(WorkflowEventSchema.parse(event)).toEqual(event);
  });

  it('allows a null from_state, because the first event has no predecessor', () => {
    expect(WorkflowEventSchema.parse({ ...event, from_state: null }).from_state).toBeNull();
  });

  // One append-only log serves three machines, so the states are text here
  // rather than any one machine's union. The machine column is what narrows
  // them, and it is validated.
  it('does not constrain the state names to the application machine', () => {
    expect(
      WorkflowEventSchema.safeParse({ ...event, machine: 'document_slot', from_state: 'uploaded', to_state: 'extracted' })
        .success,
    ).toBe(true);
  });

  it('rejects a machine outside the three', () => {
    expect(WorkflowEventSchema.safeParse({ ...event, machine: 'loan' }).success).toBe(false);
  });
});

describe('workflow transition', () => {
  it('parses a generated legality row', () => {
    const row = {
      machine: 'application',
      from_state: 'under_review',
      event: 'approve',
      to_state: 'approved',
      actor_role: 'lender',
    };
    expect(WorkflowTransitionSchema.parse(row)).toEqual(row);
  });

  it('requires an actor role, because legality is per role', () => {
    expect(
      WorkflowTransitionSchema.safeParse({
        machine: 'application',
        from_state: 'under_review',
        event: 'approve',
        to_state: 'approved',
      }).success,
    ).toBe(false);
  });
});
