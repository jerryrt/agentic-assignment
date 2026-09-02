import { decisionActions, decisionIsReady } from './decision.ts';

function events(state: Parameters<typeof decisionActions>[0], role: Parameters<typeof decisionActions>[1]): readonly string[] {
  return decisionActions(state, role).map((action) => action.event);
}

describe('what a lender may do with a request', () => {
  it('offers triage on a new request', () => {
    expect(events('submitted', 'lender')).toEqual(['begin_review']);
  });

  it('offers the decision once it is in review', () => {
    expect(events('under_review', 'lender')).toEqual(['approve', 'decline']);
  });

  it('offers the money once it is approved', () => {
    expect(events('approved', 'lender')).toEqual(['disburse']);
  });

  it('offers nothing on a settled request', () => {
    expect(events('funded', 'lender')).toEqual([]);
    expect(events('declined', 'lender')).toEqual([]);
    expect(events('cancelled', 'lender')).toEqual([]);
  });

  /**
   * The set is read off the machine rather than listed, so the actor split is
   * the machine's too: withdrawing is the borrower's move on their own request,
   * and it is not offered to the lender looking at the same row.
   */
  it('reads the actor split off the machine, not off a list here', () => {
    expect(events('submitted', 'borrower')).toEqual(['cancel']);
    expect(events('submitted', 'lender')).not.toContain('cancel');
  });

  /**
   * `submit` is the only guarded transition, and an empty rule set makes the
   * guard refuse -- so the borrower's move is never offered by this screen,
   * which is a refusal by the machine rather than an omission here.
   */
  it('never offers the guarded transition from an unevaluated context', () => {
    expect(events('draft', 'borrower')).toEqual([]);
    expect(events('draft', 'lender')).toEqual([]);
  });

  it('says which decision owes the borrower an explanation', () => {
    const [approve, decline] = decisionActions('under_review', 'lender');

    expect(approve?.needsReason).toBe(false);
    expect(decline?.needsReason).toBe(true);
    expect(decline?.emphasis).toBe('danger');
  });
});

describe('when a decision may be sent', () => {
  it('holds a decline back until there is a reason', () => {
    const [, decline] = decisionActions('under_review', 'lender');
    if (decline === undefined) {
      throw new Error('decline is not offered from under_review');
    }

    expect(decisionIsReady(decline, '')).toBe(false);
    expect(decisionIsReady(decline, '   ')).toBe(false);
    expect(decisionIsReady(decline, 'The land title is out of date.')).toBe(true);
  });

  it('never holds back a decision that owes no explanation', () => {
    const [approve] = decisionActions('under_review', 'lender');
    if (approve === undefined) {
      throw new Error('approve is not offered from under_review');
    }

    expect(decisionIsReady(approve, '')).toBe(true);
  });
});
