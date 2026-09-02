import { describe, expect, it } from 'vitest';

import {
  APP_ROLES,
  APPLICATION_STATES,
  CREDIT_RELEASE_STATES,
  DOCUMENT_SLOT_STATES,
  rulePassed,
} from '@lj/domain';
import type { AppRole } from '@lj/domain';

import { apply, can } from '../src/index.ts';
import {
  applicationMachine,
  creditReleaseMachine,
  documentSlotMachine,
} from '../src/index.ts';
import type {
  ApplicationGuardContext,
  CreditReleaseGuardContext,
  DocumentSlotGuardContext,
} from '../src/index.ts';

/**
 * The legal set, written out by hand from the state diagrams in
 * plan/03-workflow-engine.md.
 *
 * Deriving the expectation from the machine definition would make this file
 * agree with itself no matter what the definition said. The specification is
 * restated here on purpose, so that an edit to a machine has to be an edit to
 * the specification too.
 */
/** machine, from_state, event, actor_role, to_state. */
const EXPECTED: readonly (readonly [string, string, string, AppRole, string])[] = [
  // application
  ['application', 'draft', 'submit', 'borrower', 'submitted'],
  ['application', 'submitted', 'request_docs', 'lender', 'docs_pending'],
  ['application', 'docs_pending', 'begin_review', 'lender', 'under_review'],
  ['application', 'under_review', 'approve', 'lender', 'approved'],
  ['application', 'under_review', 'decline', 'lender', 'declined'],
  ['application', 'under_review', 'request_info', 'lender', 'needs_borrower_action'],
  ['application', 'needs_borrower_action', 'resubmit', 'borrower', 'under_review'],
  ['application', 'approved', 'fund', 'lender', 'funded'],
  ['application', 'draft', 'withdraw', 'borrower', 'withdrawn'],
  ['application', 'submitted', 'withdraw', 'borrower', 'withdrawn'],
  ['application', 'docs_pending', 'withdraw', 'borrower', 'withdrawn'],
  ['application', 'needs_borrower_action', 'withdraw', 'borrower', 'withdrawn'],
  // document_slot
  ['document_slot', 'required', 'upload', 'borrower', 'uploaded'],
  ['document_slot', 'uploaded', 'extract', 'admin', 'extracted'],
  ['document_slot', 'extracted', 'accept', 'lender', 'accepted'],
  ['document_slot', 'extracted', 'reject', 'lender', 'rejected'],
  ['document_slot', 'rejected', 'replace', 'borrower', 'uploaded'],
  ['document_slot', 'accepted', 'replace', 'borrower', 'uploaded'],
  // credit_release
  ['credit_release', 'draft', 'submit', 'borrower', 'submitted'],
  ['credit_release', 'submitted', 'begin_review', 'lender', 'under_review'],
  ['credit_release', 'under_review', 'approve', 'lender', 'approved'],
  ['credit_release', 'under_review', 'decline', 'lender', 'declined'],
  ['credit_release', 'approved', 'disburse', 'lender', 'funded'],
  ['credit_release', 'submitted', 'cancel', 'borrower', 'cancelled'],
  ['credit_release', 'under_review', 'cancel', 'borrower', 'cancelled'],
];

function satisfied(id: string): readonly ReturnType<typeof rulePassed>[] {
  return [rulePassed({ id, label: id, explain: 'satisfied' })];
}

/** Every guard bucket satisfied, so a refusal can only be about shape or role. */
const APPLICATION_CONTEXT: ApplicationGuardContext = {
  completeness: satisfied('steps_complete'),
  eligibility: satisfied('at_least_one_eligible_product'),
  documentPack: satisfied('document_pack_complete'),
};
const DOCUMENT_SLOT_CONTEXT: DocumentSlotGuardContext = {};
const CREDIT_RELEASE_CONTEXT: CreditReleaseGuardContext = {
  availableCredit: satisfied('within_available_credit'),
};

interface MachineUnderTest {
  readonly id: string;
  /** The state union the domain declares, which is what the columns hold. */
  readonly states: readonly string[];
  /** The state list the machine itself declares. */
  readonly declared: readonly string[];
  readonly can: (from: string, event: string, role: AppRole) => { readonly ok: boolean };
  readonly apply: (
    from: string,
    event: string,
    role: AppRole,
  ) => { readonly ok: boolean; readonly to?: string };
}

const MACHINES: readonly MachineUnderTest[] = [
  {
    id: 'application',
    states: APPLICATION_STATES,
    declared: applicationMachine.states,
    can: (from, event, role) =>
      can(applicationMachine, from as never, event as never, role, APPLICATION_CONTEXT),
    apply: (from, event, role) =>
      apply(applicationMachine, from as never, event as never, role, APPLICATION_CONTEXT),
  },
  {
    id: 'document_slot',
    states: DOCUMENT_SLOT_STATES,
    declared: documentSlotMachine.states,
    can: (from, event, role) =>
      can(documentSlotMachine, from as never, event as never, role, DOCUMENT_SLOT_CONTEXT),
    apply: (from, event, role) =>
      apply(documentSlotMachine, from as never, event as never, role, DOCUMENT_SLOT_CONTEXT),
  },
  {
    id: 'credit_release',
    states: CREDIT_RELEASE_STATES,
    declared: creditReleaseMachine.states,
    can: (from, event, role) =>
      can(creditReleaseMachine, from as never, event as never, role, CREDIT_RELEASE_CONTEXT),
    apply: (from, event, role) =>
      apply(creditReleaseMachine, from as never, event as never, role, CREDIT_RELEASE_CONTEXT),
  },
];

function key(machine: string, from: string, event: string, role: AppRole): string {
  return [machine, from, event, role].join('|');
}

const LEGAL = new Map(
  EXPECTED.map((row) => [key(row[0], row[1], row[2], row[3]), row[4]] as const),
);

describe.each(MACHINES)('$id', (machine) => {
  const events = [
    ...new Set(EXPECTED.filter((row) => row[0] === machine.id).map((row) => row[2])),
  ];

  /**
   * The state names are a column and a label-map key, so they live in
   * packages/domain; legality lives here. The two have to agree, and a machine
   * that quietly declares its own list is the drift this catches.
   */
  it('declares exactly the states the domain union declares', () => {
    expect(events.length).toBeGreaterThan(0);
    expect([...machine.declared].sort()).toEqual([...machine.states].sort());
  });

  /**
   * The whole cross product, not a sample: every state, every event of this
   * machine, every role. "Legal from its `from` states and rejected from all
   * others" is only a claim about the whole grid.
   */
  it('permits exactly the specified (state, event, role) triples and nothing else', () => {
    const permitted: string[] = [];

    for (const from of machine.states) {
      for (const event of events) {
        for (const role of APP_ROLES) {
          if (machine.can(from, event, role).ok) {
            permitted.push(key(machine.id, from, event, role));
          }
        }
      }
    }

    const expected = EXPECTED.filter((row) => row[0] === machine.id).map((row) =>
      key(row[0], row[1], row[2], row[3]),
    );

    expect(permitted.sort()).toEqual([...expected].sort());
  });

  it('lands each legal transition on the specified state', () => {
    for (const from of machine.states) {
      for (const event of events) {
        for (const role of APP_ROLES) {
          const to = LEGAL.get(key(machine.id, from, event, role));
          if (to === undefined) {
            continue;
          }
          const outcome = machine.apply(from, event, role);
          expect(outcome.ok, key(machine.id, from, event, role)).toBe(true);
          expect(outcome.to, key(machine.id, from, event, role)).toBe(to);
        }
      }
    }
  });
});

describe('declared effects', () => {
  /**
   * Effects are declarative so that the API can run them inside the same
   * transaction as the state change. Naming them here is what stops `fund`
   * quietly becoming a state change with no loan behind it.
   */
  it('creates a loan when an application is funded', () => {
    const outcome = apply(applicationMachine, 'approved', 'fund', 'lender', APPLICATION_CONTEXT);

    expect(outcome.ok === true && outcome.effects).toEqual([{ kind: 'create_loan' }]);
  });

  /**
   * The snapshot is what makes a decision reproducible: a lender reading an
   * application months later sees the criteria as they stood when the borrower
   * submitted, not as the product defines them now. Declaring it on the
   * transition rather than writing it inline in the handler is what lets the
   * browser say so before the round trip, from the same definition the server
   * runs.
   */
  it('writes an eligibility snapshot when an application is submitted', () => {
    const outcome = apply(applicationMachine, 'draft', 'submit', 'borrower', APPLICATION_CONTEXT);

    expect(outcome.ok === true && outcome.effects).toEqual([
      { kind: 'write_eligibility_snapshot' },
    ]);
  });

  it('posts a ledger entry when a release is disbursed', () => {
    const outcome = apply(
      creditReleaseMachine,
      'approved',
      'disburse',
      'lender',
      CREDIT_RELEASE_CONTEXT,
    );

    expect(outcome.ok === true && outcome.effects).toEqual([{ kind: 'post_ledger_entry' }]);
  });

  it('declares no effect on a transition that only moves state', () => {
    const outcome = apply(applicationMachine, 'under_review', 'approve', 'lender', APPLICATION_CONTEXT);

    expect(outcome.ok === true && outcome.effects).toEqual([]);
  });
});
