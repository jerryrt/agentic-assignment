import { describe, expect, it } from 'vitest';

import { RuleResultSchema, type DocumentSlotState } from '@lj/domain';

import {
  EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS,
  documentPackComplete,
  documentPackProgress,
  evaluateCompleteness,
  type DocumentContext,
  type DocumentSlotView,
  type ExtractedField,
} from '../src/index.js';

const TODAY = '2026-09-01';

function extracted(
  confidenceBasisPoints: number,
  source: 'ocr' | 'human' = 'ocr',
  value: unknown = 184_200_00,
): ExtractedField {
  return { value, confidenceBasisPoints, source };
}

function slot(overrides: Partial<DocumentSlotView> = {}): DocumentSlotView {
  return {
    code: 'tax_return_2024',
    label: '2024 tax return',
    required: true,
    state: 'accepted',
    validUntil: null,
    extractRequired: [],
    extracted: {},
    ...overrides,
  };
}

function contextOf(...slots: readonly DocumentSlotView[]): DocumentContext {
  return { today: TODAY, slots };
}

function only(context: DocumentContext) {
  const results = evaluateCompleteness(context);
  const first = results[0];
  if (first === undefined) {
    throw new Error('expected one result');
  }
  expect(RuleResultSchema.safeParse(first).success).toBe(true);
  return first;
}

describe('a slot the borrower has not acted on', () => {
  it('is unknown, naming the document, not a failure', () => {
    const result = only(contextOf(slot({ state: 'required' })));
    expect(result.id).toBe('document_slot.tax_return_2024');
    expect(result.status).toBe('unknown');
    expect(result.missing).toEqual(['tax_return_2024']);
    expect(result.explain).toBe('Not uploaded yet -- upload the 2024 tax return.');
  });
});

describe('a slot waiting on the lender', () => {
  it.each<DocumentSlotState>(['uploaded', 'extracted'])(
    'is unknown while it is %s, because the decision is not the borrower to make',
    (state) => {
      const result = only(contextOf(slot({ state })));
      expect(result.status).toBe('unknown');
      expect(result.missing).toEqual(['tax_return_2024.accepted']);
      expect(result.explain).toBe('Uploaded -- waiting for your lender to accept it.');
    },
  );
});

describe('the three ways a slot can be wrong', () => {
  it('missing: a rejected document names the next action', () => {
    const result = only(contextOf(slot({ state: 'rejected' })));
    expect(result.status).toBe('fail');
    expect(result.explain).toBe('Rejected by your lender -- upload a replacement.');
  });

  it('stale: an accepted document past its valid_until is not complete', () => {
    const result = only(contextOf(slot({ state: 'accepted', validUntil: '2026-08-31' })));
    expect(result.status).toBe('fail');
    expect(result.explain).toBe('Expired 2026-08-31 -- upload a current one.');
  });

  it('unreadable: an accepted document whose required field could not be read', () => {
    const result = only(
      contextOf(
        slot({
          extractRequired: ['net_income'],
          extracted: { net_income: extracted(4_000) },
        }),
      ),
    );
    expect(result.status).toBe('fail');
    expect(result.explain).toBe(
      'Could not read net income -- upload a clearer scan, or type the value in.',
    );
  });

  it('names every field it could not read', () => {
    const result = only(
      contextOf(
        slot({
          extractRequired: ['tax_year', 'net_income'],
          extracted: { net_income: extracted(4_000) },
        }),
      ),
    );
    expect(result.explain).toBe(
      'Could not read tax year and net income -- upload a clearer scan, or type the value in.',
    );
  });
});

describe('expiry, derived from valid_until and the clock in the context', () => {
  // valid_until is inclusive: a certificate valid until today is valid today.
  it('is valid on its last day', () => {
    expect(only(contextOf(slot({ validUntil: TODAY }))).status).toBe('pass');
  });

  it('is expired the day after', () => {
    expect(only(contextOf({ ...slot({ validUntil: TODAY }) })).status).toBe('pass');
    const context: DocumentContext = { today: '2026-09-02', slots: [slot({ validUntil: TODAY })] };
    expect(evaluateCompleteness(context)[0]?.status).toBe('fail');
  });

  it('is valid forever when the document carries no expiry', () => {
    expect(only(contextOf(slot({ validUntil: null }))).status).toBe('pass');
  });

  // A silently mis-parsed date would compare wrong and expire a valid document,
  // or accept an expired one. Neither may happen quietly.
  it('refuses a date that is not a plain ISO calendar date', () => {
    expect(() => evaluateCompleteness(contextOf(slot({ validUntil: '31/08/2026' })))).toThrow(
      RangeError,
    );
    expect(() =>
      evaluateCompleteness({ today: 'today', slots: [slot()] }),
    ).toThrow(RangeError);
  });
});

describe('the extraction confidence floor', () => {
  it('sits at 70 percent, once', () => {
    expect(EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS).toBe(7_000);
  });

  it('accepts a field read exactly at the floor', () => {
    const result = only(
      contextOf(
        slot({ extractRequired: ['net_income'], extracted: { net_income: extracted(7_000) } }),
      ),
    );
    expect(result.status).toBe('pass');
  });

  it('rejects a field one basis point below it', () => {
    const result = only(
      contextOf(
        slot({ extractRequired: ['net_income'], extracted: { net_income: extracted(6_999) } }),
      ),
    );
    expect(result.status).toBe('fail');
  });

  // Extraction proposes, a human confirms. Once a person has typed the value in,
  // the machine's confidence in its own reading is no longer the question.
  it('ignores the floor for a value a person confirmed', () => {
    const result = only(
      contextOf(
        slot({
          extractRequired: ['net_income'],
          extracted: { net_income: extracted(0, 'human') },
        }),
      ),
    );
    expect(result.status).toBe('pass');
  });
});

describe('an optional slot', () => {
  it('is advisory, so it explains without blocking the pack', () => {
    const context = contextOf(
      slot(),
      slot({ code: 'financial_statements', label: 'Year-end financial statements', required: false, state: 'required' }),
    );
    const optional = evaluateCompleteness(context)[1];
    expect(optional?.severity).toBe('warning');
    expect(documentPackComplete(context).ok).toBe(true);
  });
});

describe('documentPackComplete', () => {
  it('allows the review to begin when every required slot is accepted and valid', () => {
    const context = contextOf(slot(), slot({ code: 'land_title', label: 'Land title or lease' }));
    expect(documentPackComplete(context).ok).toBe(true);
  });

  it('refuses while a required slot is still outstanding', () => {
    const decision = documentPackComplete(contextOf(slot({ state: 'required' })));
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.blockers.map((result) => result.id)).toEqual(['document_slot.tax_return_2024']);
  });
});

describe('documentPackProgress', () => {
  const pack = (...slots: readonly DocumentSlotView[]) =>
    documentPackProgress(evaluateCompleteness(contextOf(...slots)));

  it('counts accepted-and-valid slots out of the required ones', () => {
    const progress = pack(
      slot(),
      slot({ code: 'land_title', label: 'Land title or lease' }),
      slot({ code: 'crop_insurance', label: 'Crop insurance certificate', state: 'required' }),
    );
    expect(progress).toEqual({ accepted: 2, total: 3, basisPoints: 6_667 });
  });

  // Uploading a document that then fails must not move the bar forward and then
  // back. The bar counts what is finished, never what is in flight.
  it('does not count a document that is merely uploaded', () => {
    expect(pack(slot({ state: 'uploaded' })).accepted).toBe(0);
  });

  it('does not count an accepted document that has expired', () => {
    expect(pack(slot({ validUntil: '2020-01-01' })).accepted).toBe(0);
  });

  it('does not count an optional slot in the denominator', () => {
    const progress = pack(slot(), slot({ code: 'lien_search', label: 'Lien search', required: false, state: 'required' }));
    expect(progress).toEqual({ accepted: 1, total: 1, basisPoints: 10_000 });
  });

  it('reports an empty pack as complete rather than dividing by zero', () => {
    expect(pack()).toEqual({ accepted: 0, total: 0, basisPoints: 10_000 });
  });
});
