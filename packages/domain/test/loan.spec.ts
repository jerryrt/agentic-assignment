import { describe, expect, it } from 'vitest';

import {
  CREDIT_RELEASE_STATES,
  CreditReleaseLenderViewSchema,
  CreditReleaseNoteSchema,
  CreditReleaseSchema,
  LEDGER_ENTRY_KINDS,
  LOAN_STATUSES,
  LedgerEntrySchema,
  LoanBalanceSchema,
  LoanSchema,
  PENDING_CREDIT_RELEASE_STATES,
  TERMINAL_CREDIT_RELEASE_STATES,
  borrowerAvailableCredit,
  isPendingCreditReleaseState,
  lenderUndrawnLimit,
  moneyFromMinorUnits,
} from '../src/index.ts';
import type { CreditReleaseState } from '../src/index.ts';

const NOW = '2026-09-02T12:00:00.000+00:00';

const LOAN = {
  id: '00000000-0000-4000-8000-0000000000e1',
  application_id: '00000000-0000-4000-8000-0000000000d3',
  borrower_id: '00000000-0000-4000-8000-0000000000c2',
  org_id: '00000000-0000-4000-8000-0000000000a1',
  product_id: '00000000-0000-4000-8000-0000000000b1',
  approved_limit: '250000.00',
  rate_bps: 875,
  opened_at: '2026-08-24',
  status: 'active',
  created_at: NOW,
};

const LEDGER_ENTRY = {
  id: 41,
  loan_id: LOAN.id,
  kind: 'draw',
  amount: '85000.00',
  effective: '2026-08-27',
  release_id: '00000000-0000-4000-8000-0000000000f1',
  memo: 'Fuel and custom spraying',
  created_at: NOW,
};

const RELEASE = {
  id: '00000000-0000-4000-8000-0000000000f2',
  loan_id: LOAN.id,
  amount: '40000.00',
  purpose: 'Additional nitrogen ahead of the second pass',
  state: 'declined',
  revision: 4,
  requested_by: LOAN.borrower_id,
  decided_by: '00000000-0000-4000-8000-0000000000c1',
  decline_reason: 'The line is already drawn to 71 per cent nine days in.',
  created_at: NOW,
  updated_at: NOW,
};

const NOTE = {
  release_id: RELEASE.id,
  internal_note: 'Second request in a week. Ask for the marketing plan.',
  recorded_by: '00000000-0000-4000-8000-0000000000c1',
  recorded_at: NOW,
};

const BALANCE = {
  loan_id: LOAN.id,
  borrower_id: LOAN.borrower_id,
  org_id: LOAN.org_id,
  approved_limit: '250000.00',
  outstanding: '128442.47',
  pending: '30000.00',
  available: '91557.53',
};

describe('LoanSchema', () => {
  it('parses a row as the database renders it', () => {
    const loan = LoanSchema.parse(LOAN);
    expect(loan.id).toBe(LOAN.id);
    expect(loan.status).toBe('active');
  });

  // The whole reason money crosses this boundary as text: 250000.00 has to
  // arrive as exactly 25,000,000 minor units, not as whatever a binary float
  // lands on.
  it('carries the approved limit as integer minor units', () => {
    expect(LoanSchema.parse(LOAN).approved_limit).toBe(25_000_000);
  });

  it('refuses a limit with more precision than numeric(14,2) can hold', () => {
    expect(LoanSchema.safeParse({ ...LOAN, approved_limit: '250000.005' }).success).toBe(false);
  });

  // Written first as "refuses a limit that arrives as a JSON number", on the
  // strength of money.ts claiming PostgREST renders numeric as text. It does
  // not -- a plain select sends a number, and only `column::text` sends a
  // string (#57). A limit arriving as a number is the ordinary case, not the
  // suspicious one, and it is exact: 250000.00 is six significant digits and a
  // double round-trips fifteen.
  it('reads a limit in either spelling PostgREST sends', () => {
    expect(LoanSchema.parse({ ...LOAN, approved_limit: 250_000 }).approved_limit).toBe(
      25_000_000,
    );
    expect(LoanSchema.parse({ ...LOAN, approved_limit: '250000.00' }).approved_limit).toBe(
      25_000_000,
    );
  });

  it('refuses a status no lending system declares', () => {
    expect(LoanSchema.safeParse({ ...LOAN, status: 'forgiven' }).success).toBe(false);
    expect([...LOAN_STATUSES]).toEqual(['active', 'closed', 'delinquent']);
  });

  // `opened_at` is a `date`, for the reason document_slot.valid_until is: a
  // loan opens on a calendar day where it was written, and an instant would
  // make the answer depend on the reader's time zone.
  it('refuses an opened_at that is an instant rather than a calendar day', () => {
    expect(LoanSchema.safeParse({ ...LOAN, opened_at: NOW }).success).toBe(false);
  });

  it('refuses a negative rate', () => {
    expect(LoanSchema.safeParse({ ...LOAN, rate_bps: -1 }).success).toBe(false);
  });
});

describe('LedgerEntrySchema', () => {
  it('parses a row as the database renders it', () => {
    expect(LedgerEntrySchema.parse(LEDGER_ENTRY).amount).toBe(8_500_000);
  });

  // The sign is the design: draws positive, repayments negative, so the balance
  // is a sum rather than a case expression. A schema that refused a negative
  // amount would make a repayment unrepresentable.
  it('carries a repayment as a negative amount', () => {
    const repayment = LedgerEntrySchema.parse({
      ...LEDGER_ENTRY,
      kind: 'repayment',
      amount: '-25000.00',
      release_id: null,
    });
    expect(repayment.amount).toBe(-2_500_000);
    expect(repayment.release_id).toBeNull();
  });

  // Zero moves no money and still appears on a timeline, which is how a
  // reconciliation acquires a row nobody can explain.
  it('refuses an entry that moves nothing', () => {
    expect(LedgerEntrySchema.safeParse({ ...LEDGER_ENTRY, amount: '0.00' }).success).toBe(false);
  });

  it('refuses a kind outside the four the ledger recognises', () => {
    expect(LedgerEntrySchema.safeParse({ ...LEDGER_ENTRY, kind: 'adjustment' }).success).toBe(
      false,
    );
    expect([...LEDGER_ENTRY_KINDS]).toEqual(['draw', 'repayment', 'interest', 'fee']);
  });

  it('accepts an entry with no memo', () => {
    expect(LedgerEntrySchema.parse({ ...LEDGER_ENTRY, memo: null }).memo).toBeNull();
  });
});

describe('CreditReleaseSchema', () => {
  it('parses a row as the database renders it', () => {
    const release = CreditReleaseSchema.parse(RELEASE);
    expect(release.amount).toBe(4_000_000);
    expect(release.decline_reason).toBe(RELEASE.decline_reason);
  });

  it('accepts a draft nobody has decided', () => {
    const draft = CreditReleaseSchema.parse({
      ...RELEASE,
      state: 'draft',
      revision: 0,
      decided_by: null,
      decline_reason: null,
    });
    expect(draft.decided_by).toBeNull();
  });

  // Nothing is asked for by requesting nothing, and a negative request is a
  // repayment wearing the wrong form.
  it('refuses an amount that is zero or negative', () => {
    expect(CreditReleaseSchema.safeParse({ ...RELEASE, amount: '0.00' }).success).toBe(false);
    expect(CreditReleaseSchema.safeParse({ ...RELEASE, amount: '-100.00' }).success).toBe(false);
  });

  it('refuses a state the machine does not declare', () => {
    expect(CreditReleaseSchema.safeParse({ ...RELEASE, state: 'settled' }).success).toBe(false);
  });

  // `internal_note` is not a column on this row, and that is the point: RLS
  // filters rows and never columns, so a lender-only field a view merely omits
  // is still readable off the base table by anyone the row policy admits.
  it('has no internal_note to omit', () => {
    const parsed: Record<string, unknown> = CreditReleaseSchema.parse({
      ...RELEASE,
      internal_note: 'leaked',
    });
    expect(parsed['internal_note']).toBeUndefined();
  });
});

describe('CreditReleaseNoteSchema', () => {
  it('parses a row as the database renders it', () => {
    expect(CreditReleaseNoteSchema.parse(NOTE).internal_note).toBe(NOTE.internal_note);
  });

  // An audit entry with no author is worse than no entry, because it is
  // believed. The column is not null in the schema for the same reason
  // application_decision.decided_by is.
  it('refuses a note with no author', () => {
    expect(CreditReleaseNoteSchema.safeParse({ ...NOTE, recorded_by: null }).success).toBe(false);
  });
});

describe('CreditReleaseLenderViewSchema', () => {
  it('carries the lender-only note and the names the borrower cannot resolve', () => {
    const row = CreditReleaseLenderViewSchema.parse({
      ...RELEASE,
      borrower_id: LOAN.borrower_id,
      org_id: LOAN.org_id,
      internal_note: NOTE.internal_note,
      note_recorded_by: NOTE.recorded_by,
      note_recorded_at: NOTE.recorded_at,
      requested_by_name: 'Ada Fenwick',
      decided_by_name: 'Rowan Ellis',
    });
    expect(row.internal_note).toBe(NOTE.internal_note);
    expect(row.decided_by_name).toBe('Rowan Ellis');
  });

  // The view is security_invoker and left-joins both the note and the deciding
  // lender's profile, so a caller no policy admits reads the row with those
  // columns null rather than getting a permission error. The schema has to
  // accept that shape or the projection is unusable by the audience it exists
  // to serve.
  it('accepts a row read by a caller who may see none of the lender-only half', () => {
    const row = CreditReleaseLenderViewSchema.parse({
      ...RELEASE,
      borrower_id: LOAN.borrower_id,
      org_id: LOAN.org_id,
      internal_note: null,
      note_recorded_by: null,
      note_recorded_at: null,
      requested_by_name: null,
      decided_by_name: null,
    });
    expect(row.internal_note).toBeNull();
  });
});

describe('LoanBalanceSchema', () => {
  it('parses the derived row as the view renders it', () => {
    const balance = LoanBalanceSchema.parse(BALANCE);
    expect(balance.approved_limit).toBe(25_000_000);
    expect(balance.outstanding).toBe(12_844_247);
    expect(balance.pending).toBe(3_000_000);
    expect(balance.available).toBe(9_155_753);
  });

  // The identity the view computes. Asserted here as well, because these are
  // the numbers two screens show side by side and an arithmetic slip in the
  // view would otherwise be found by a reviewer rather than by a test.
  it('holds available = limit - outstanding - pending', () => {
    const balance = LoanBalanceSchema.parse(BALANCE);
    expect(balance.available).toBe(balance.approved_limit - balance.outstanding - balance.pending);
  });

  // A borrower who has drawn past the limit, or repaid past zero, is a real
  // state of a real loan. A schema that refused it would refuse to display the
  // one balance a lender most needs to see.
  it('accepts an over-drawn loan, whose available credit is negative', () => {
    const balance = LoanBalanceSchema.parse({
      ...BALANCE,
      outstanding: '260000.00',
      pending: '0.00',
      available: '-10000.00',
    });
    expect(balance.available).toBe(-1_000_000);
  });
});

describe('the two truths over one balance row', () => {
  const balance = LoanBalanceSchema.parse(BALANCE);

  // This is the invariant Option 3 exists to demonstrate. The borrower's
  // figure is net of pending because the submit guard compares against that
  // same number; if the two differed a borrower could submit a request the
  // screen had just told them was affordable.
  it('gives the borrower the figure the submit guard uses, net of pending', () => {
    expect(borrowerAvailableCredit(balance)).toBe(balance.available);
    expect(borrowerAvailableCredit(balance)).toBe(9_155_753);
  });

  it('gives the lender undrawn limit, with pending carried separately', () => {
    expect(lenderUndrawnLimit(balance)).toBe(12_155_753);
    expect(lenderUndrawnLimit(balance)).toBe(
      borrowerAvailableCredit(balance) + balance.pending,
    );
  });

  it('collapses the two truths to one when nothing is pending', () => {
    const settled = LoanBalanceSchema.parse({
      ...BALANCE,
      pending: '0.00',
      available: '121557.53',
    });
    expect(borrowerAvailableCredit(settled)).toBe(lenderUndrawnLimit(settled));
  });

  it('returns branded money, not a bare number', () => {
    expect(lenderUndrawnLimit(balance)).toBe(moneyFromMinorUnits(12_155_753));
  });
});

describe('which release states hold credit', () => {
  it('counts submitted, under_review and approved as pending', () => {
    expect([...PENDING_CREDIT_RELEASE_STATES]).toEqual([
      'submitted',
      'under_review',
      'approved',
    ]);
  });

  // `approved` is the one worth stating: the money is committed and not yet
  // moved, so it is spent from the borrower's point of view and not yet on the
  // ledger. Leaving it out is how a borrower spends the same credit twice.
  it('counts an approved release as pending, because the money is committed', () => {
    expect(isPendingCreditReleaseState('approved')).toBe(true);
  });

  it('counts a draft as holding nothing, because nobody has been asked yet', () => {
    expect(isPendingCreditReleaseState('draft')).toBe(false);
  });

  it('counts every terminal state as holding nothing', () => {
    for (const state of TERMINAL_CREDIT_RELEASE_STATES) {
      expect(isPendingCreditReleaseState(state)).toBe(false);
    }
  });

  // The completeness check. A state added to CREDIT_RELEASE_STATES later must
  // land in exactly one of the three buckets, or this fails -- which is what
  // stops the balance view and the machine drifting apart silently.
  it('classifies every credit release state exactly once', () => {
    const classified = new Set<CreditReleaseState>([
      'draft',
      ...PENDING_CREDIT_RELEASE_STATES,
      ...TERMINAL_CREDIT_RELEASE_STATES,
    ]);
    expect(classified.size).toBe(CREDIT_RELEASE_STATES.length);
    for (const state of CREDIT_RELEASE_STATES) {
      expect(classified.has(state)).toBe(true);
    }
  });
});
