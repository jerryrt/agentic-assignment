import { decisionFor, reviewedFields } from './review.ts';

/**
 * The lender's half of the slot machine, predicted in the browser from the
 * same definition the server adjudicates with. These tests assert the
 * prediction; the server's re-check is asserted in apps/api's suite, and it is
 * the one that decides.
 */
describe('what a reviewer may do with a document', () => {
  it('lets a lender accept or refuse one that has been read', () => {
    const decision = decisionFor('extracted', 'lender');

    expect(decision.accept.ok).toBe(true);
    expect(decision.reject.ok).toBe(true);
  });

  /**
   * `accept` and `reject` are lender-only on the machine. The button is greyed
   * here as a courtesy; POST /api/transition refuses it whatever the browser
   * chose to render.
   */
  it('offers a borrower neither, whatever the screen would let them click', () => {
    const decision = decisionFor('extracted', 'borrower');

    expect(decision.accept.ok).toBe(false);
    expect(decision.reject.ok).toBe(false);
  });

  it('offers an admin the same two, because the machine names them too', () => {
    // The machine gives 'accept' and 'reject' to lenders alone, so an admin is
    // refused as well -- asserted rather than assumed, because it is the kind
    // of thing an added actor would change silently.
    expect(decisionFor('extracted', 'admin').accept.ok).toBe(false);
  });

  it('offers nothing on a document nobody has read yet', () => {
    const decision = decisionFor('uploaded', 'lender');

    expect(decision.accept.ok).toBe(false);
    expect(decision.accept.ok ? '' : decision.accept.reason).toContain('no transition');
    expect(decision.reject.ok).toBe(false);
  });

  it('offers nothing on a slot that has never been filled', () => {
    expect(decisionFor('required', 'lender').accept.ok).toBe(false);
  });

  /**
   * Nothing is terminal on this machine -- a borrower may replace an accepted
   * document -- but a second acceptance is not a move it has, so the buttons
   * go quiet once a decision is made.
   */
  it('offers nothing once the document has been decided', () => {
    expect(decisionFor('accepted', 'lender').accept.ok).toBe(false);
    expect(decisionFor('rejected', 'lender').reject.ok).toBe(false);
  });

  it('offers nothing before the reviewer is known', () => {
    expect(decisionFor('extracted', null).accept.ok).toBe(false);
  });
});

describe('what the reviewer is shown', () => {
  it('lists the fields the slot asks for, in the order it asks for them', () => {
    const fields = reviewedFields(['tax_year', 'net_income'], {
      net_income: { value: 184200, confidenceBasisPoints: 9100, source: 'ocr' },
      tax_year: { value: 2024, confidenceBasisPoints: 9900, source: 'ocr' },
    });

    expect(fields.map((field) => field.field)).toEqual(['tax_year', 'net_income']);
  });

  /**
   * The missing field is the reason the lender is looking at this slot, so it
   * keeps its place in the list rather than being dropped for having no value.
   */
  it('keeps a required field that was never read, and marks it outstanding', () => {
    const fields = reviewedFields(['net_income'], {});

    expect(fields).toEqual([
      {
        field: 'net_income',
        value: null,
        confidenceBasisPoints: 0,
        confirmedByHuman: false,
        outstanding: true,
      },
    ]);
  });

  it('shows what the extractor found beyond what was asked for, in name order', () => {
    const fields = reviewedFields(['tax_year'], {
      tax_year: { value: 2024, confidenceBasisPoints: 9900, source: 'ocr' },
      taxpayer_name: { value: 'Fenwick', confidenceBasisPoints: 8000, source: 'ocr' },
      net_income: { value: 1, confidenceBasisPoints: 8000, source: 'ocr' },
    });

    expect(fields.map((field) => field.field)).toEqual(['tax_year', 'net_income', 'taxpayer_name']);
  });

  /**
   * A lender deciding on a document needs to know which figures a person put
   * there, because that is the difference between a reading and a claim.
   */
  it('says which values a person confirmed rather than the extractor', () => {
    const fields = reviewedFields(['net_income'], {
      net_income: { value: 184200, confidenceBasisPoints: 0, source: 'human' },
    });

    expect(fields[0]).toMatchObject({ confirmedByHuman: true, outstanding: false });
  });
});
