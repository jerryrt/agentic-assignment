import { describe, expect, it } from 'vitest';

import {
  APPLICATION_STATES,
  APPLICATION_STATE_LABELS,
  APP_ROLES,
  CREDIT_RELEASE_STATES,
  CREDIT_RELEASE_STATE_LABELS,
  LABEL_AUDIENCES,
  applicationStateLabel,
  audienceForRole,
  creditReleaseStateLabel,
} from '../src/index.ts';

describe('audiences', () => {
  it('has one vocabulary per side of the file', () => {
    expect([...LABEL_AUDIENCES]).toEqual(['borrower', 'lender']);
  });

  // An admin is on the lending side of the file: they need the operational
  // reading ("awaiting your decision"), not the reassuring one.
  it('maps every role to an audience, admins reading as lenders', () => {
    expect(audienceForRole('borrower')).toBe('borrower');
    expect(audienceForRole('lender')).toBe('lender');
    expect(audienceForRole('admin')).toBe('lender');
    for (const role of APP_ROLES) {
      expect(LABEL_AUDIENCES).toContain(audienceForRole(role));
    }
  });
});

describe('application state labels', () => {
  it('covers every state of the application machine, for every audience', () => {
    for (const state of APPLICATION_STATES) {
      for (const audience of LABEL_AUDIENCES) {
        const label = applicationStateLabel(state, audience);
        expect(label.length, state + '/' + audience).toBeGreaterThan(0);
        expect(label.trim(), state + '/' + audience).toBe(label);
      }
    }
  });

  it('adds no state the machine does not have', () => {
    expect(Object.keys(APPLICATION_STATE_LABELS).sort()).toEqual([...APPLICATION_STATES].sort());
  });

  it('says what plan 02 says it says', () => {
    expect(applicationStateLabel('under_review', 'borrower')).toBe('With your lender');
    expect(applicationStateLabel('under_review', 'lender')).toBe('Awaiting your decision');
    expect(applicationStateLabel('needs_borrower_action', 'borrower')).toBe('Action needed from you');
    expect(applicationStateLabel('needs_borrower_action', 'lender')).toBe('Waiting on borrower');
    expect(applicationStateLabel('approved', 'borrower')).toBe('Approved');
    expect(applicationStateLabel('approved', 'lender')).toBe('Approved -- awaiting funding');
  });

  it('reads differently for the two audiences wherever the reading differs', () => {
    const divergent = APPLICATION_STATES.filter(
      (state) => APPLICATION_STATE_LABELS[state].borrower !== APPLICATION_STATE_LABELS[state].lender,
    );
    expect(divergent).toContain('under_review');
    expect(divergent).toContain('needs_borrower_action');
    expect(divergent).toContain('submitted');
  });
});

describe('credit release state labels', () => {
  it('covers every state of the credit release machine, for every audience', () => {
    for (const state of CREDIT_RELEASE_STATES) {
      for (const audience of LABEL_AUDIENCES) {
        expect(creditReleaseStateLabel(state, audience).length).toBeGreaterThan(0);
      }
    }
  });

  it('adds no state the machine does not have', () => {
    expect(Object.keys(CREDIT_RELEASE_STATE_LABELS).sort()).toEqual([...CREDIT_RELEASE_STATES].sort());
  });

  it('says what plan 06 says it says', () => {
    expect(creditReleaseStateLabel('submitted', 'borrower')).toBe('Submitted -- with your lender');
    expect(creditReleaseStateLabel('submitted', 'lender')).toBe('New request -- awaiting triage');
  });
});
