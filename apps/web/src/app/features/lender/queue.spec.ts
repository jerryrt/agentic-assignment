import {
  CreditReleaseLenderViewSchema,
  LoanBalanceSchema,
  LoanSchema,
  moneyFromNumericString,
  type CreditReleaseLenderView,
  type Loan,
  type LoanBalance,
} from '@lj/domain';

import {
  QUEUE_SLA_DUE_DAYS,
  QUEUE_SLA_OVERDUE_DAYS,
  queueGroups,
  queueRows,
  slaBandFor,
  waitingDays,
} from './queue.ts';

const LOAN = '00000000-0000-4000-8000-0000000000e1';
const OTHER_LOAN = '00000000-0000-4000-8000-0000000000e2';
const APPLICATION = '00000000-0000-4000-8000-0000000000d3';
const BORROWER = '00000000-0000-4000-8000-0000000000c2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const NOW = '2026-09-10T12:00:00.000+00:00';

function loan(patch: Record<string, unknown> = {}): Loan {
  return LoanSchema.parse({
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
    ...patch,
  });
}

function balance(patch: Record<string, unknown> = {}): LoanBalance {
  return LoanBalanceSchema.parse({
    loan_id: LOAN,
    borrower_id: BORROWER,
    org_id: ORG,
    approved_limit: '250000.00',
    outstanding: '128442.47',
    pending: '30000.00',
    available: '91557.53',
    ...patch,
  });
}

function release(patch: Record<string, unknown> = {}): CreditReleaseLenderView {
  return CreditReleaseLenderViewSchema.parse({
    id: '00000000-0000-4000-8000-0000000000f1',
    loan_id: LOAN,
    amount: '30000.00',
    purpose: 'Spring inputs',
    state: 'submitted',
    revision: 0,
    requested_by: BORROWER,
    decided_by: null,
    decline_reason: null,
    created_at: '2026-09-09T12:00:00.000+00:00',
    updated_at: '2026-09-09T12:00:00.000+00:00',
    borrower_id: BORROWER,
    org_id: ORG,
    internal_note: null,
    note_recorded_by: null,
    note_recorded_at: null,
    requested_by_name: 'Fenwick Grain Co.',
    decided_by_name: null,
    ...patch,
  });
}

function source(releases: readonly CreditReleaseLenderView[]) {
  return { releases, loans: [loan()], balances: [balance()], now: NOW };
}

describe('the order of the queue', () => {
  /**
   * Oldest first is the queue's whole premise (plan/06): the request that has
   * waited longest is the one that costs the most to leave.
   */
  it('puts what has waited longest at the top, whatever state it is in', () => {
    const rows = queueRows(
      source([
        release({ id: '00000000-0000-4000-8000-000000000001', created_at: '2026-09-09T12:00:00.000+00:00' }),
        release({
          id: '00000000-0000-4000-8000-000000000002',
          state: 'under_review',
          created_at: '2026-09-02T12:00:00.000+00:00',
        }),
        release({
          id: '00000000-0000-4000-8000-000000000003',
          state: 'approved',
          created_at: '2026-09-06T12:00:00.000+00:00',
        }),
      ]),
    );

    expect(rows.map((row) => row.id.slice(-1))).toEqual(['2', '3', '1']);
  });

  /**
   * Two requests can share an instant. Without the tiebreak the queue
   * reshuffles between two reads, and the row somebody was about to click
   * moves.
   */
  it('breaks a tie on id, so the order does not move between reads', () => {
    const at = '2026-09-05T12:00:00.000+00:00';
    const rows = queueRows(
      source([
        release({ id: '00000000-0000-4000-8000-00000000000b', created_at: at }),
        release({ id: '00000000-0000-4000-8000-00000000000a', created_at: at }),
      ]),
    );

    expect(rows.map((row) => row.id.slice(-1))).toEqual(['a', 'b']);
  });

  it('works the three piles in the order a desk works them', () => {
    const groups = queueGroups(
      queueRows(
        source([
          release({ id: '00000000-0000-4000-8000-000000000001', state: 'approved' }),
          release({ id: '00000000-0000-4000-8000-000000000002', state: 'submitted' }),
          release({ id: '00000000-0000-4000-8000-000000000003', state: 'under_review' }),
        ]),
      ),
    );

    expect(groups.map((group) => group.state)).toEqual([
      'submitted',
      'under_review',
      'approved',
    ]);
  });

  it('leaves out a pile with nothing in it', () => {
    const groups = queueGroups(queueRows(source([release()])));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.state).toBe('submitted');
  });
});

describe('how long a request has waited', () => {
  it('counts whole days, and never counts backwards', () => {
    expect(waitingDays('2026-09-08T12:00:00.000+00:00', NOW)).toBe(2);
    expect(waitingDays('2026-09-10T11:00:00.000+00:00', NOW)).toBe(0);
    expect(waitingDays('2026-09-11T12:00:00.000+00:00', NOW)).toBe(0);
  });

  it('bands on the two thresholds, at the boundary', () => {
    expect(slaBandFor(QUEUE_SLA_DUE_DAYS - 1)).toBe('fresh');
    expect(slaBandFor(QUEUE_SLA_DUE_DAYS)).toBe('due');
    expect(slaBandFor(QUEUE_SLA_OVERDUE_DAYS - 1)).toBe('due');
    expect(slaBandFor(QUEUE_SLA_OVERDUE_DAYS)).toBe('overdue');
  });
});

describe('what a row carries', () => {
  it('shows the lender their own figures rather than the borrower reading', () => {
    const row = queueRows(source([release()]))[0];

    // Limit less what is drawn -- larger than the borrower's available credit by
    // exactly what is pending, which is its own column.
    expect(row?.undrawn).toBe(moneyFromNumericString('121557.53'));
    expect(row?.atRisk).toBe(moneyFromNumericString('30000.00'));
  });

  it('carries the application, so the row can reach the document review', () => {
    expect(queueRows(source([release()]))[0]?.applicationId).toBe(APPLICATION);
  });

  /**
   * A loan the lender cannot read costs the row its link, not its place in the
   * queue: the request is real, and dropping it would hide work.
   */
  it('keeps a row whose loan did not arrive', () => {
    const rows = queueRows({
      releases: [release({ loan_id: OTHER_LOAN })],
      loans: [loan()],
      balances: [balance()],
      now: NOW,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.applicationId).toBeNull();
    expect(rows[0]?.undrawn).toBeNull();
  });

  it('says when somebody has already left a note on the file', () => {
    expect(queueRows(source([release()]))[0]?.hasNote).toBe(false);
    expect(
      queueRows(source([release({ internal_note: 'Called the borrower.' })]))[0]?.hasNote,
    ).toBe(true);
  });

  it('names the borrower, and says something honest when the name is not readable', () => {
    expect(queueRows(source([release()]))[0]?.borrowerName).toBe('Fenwick Grain Co.');
    expect(queueRows(source([release({ requested_by_name: null })]))[0]?.borrowerName).toBe(
      'This borrower',
    );
  });
});
