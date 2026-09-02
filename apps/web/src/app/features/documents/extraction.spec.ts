import { readExtractedFields } from './extraction.ts';

/**
 * The reader for `document_upload.extracted`.
 *
 * Every case here is about the direction it fails in. A field this reader
 * drops or downgrades becomes "could not read that -- upload a clearer scan,
 * or type the value in", which is a recoverable instruction. A field it
 * accepts on bad evidence becomes a document the borrower is told is finished
 * and a lender is shown a figure nobody read. So the whole file is one
 * assertion made several ways: when in doubt, trust less.
 */
describe('reading what was extracted', () => {
  it('carries a value, its confidence and its source through unchanged', () => {
    const fields = readExtractedFields({
      net_income: { value: 184200, confidence_basis_points: 9100, source: 'ocr' },
    });

    expect(fields['net_income']).toEqual({
      value: 184200,
      confidenceBasisPoints: 9100,
      source: 'ocr',
    });
  });

  /**
   * The distinction plan/04 calls load-bearing: extraction proposes, a person
   * confirms. `isReadable` in @lj/rules trusts a human-sourced field whatever
   * the machine thought of its own reading, so dropping `source` on the way
   * through here would quietly re-impose the confidence floor on a value
   * somebody typed in by hand.
   */
  it('keeps a human correction marked as one', () => {
    const fields = readExtractedFields({
      net_income: { value: 184200, confidence_basis_points: 0, source: 'human' },
    });

    expect(fields['net_income']?.source).toBe('human');
  });

  it('treats any source it does not recognise as the machine', () => {
    const fields = readExtractedFields({
      a: { value: 1, confidence_basis_points: 9000, source: 'verified' },
      b: { value: 1, confidence_basis_points: 9000 },
      c: { value: 1, confidence_basis_points: 9000, source: 7 },
    });

    expect(fields['a']?.source).toBe('ocr');
    expect(fields['b']?.source).toBe('ocr');
    expect(fields['c']?.source).toBe('ocr');
  });

  it('reads an unusable confidence as no confidence at all', () => {
    const fields = readExtractedFields({
      a: { value: 1, confidence_basis_points: 'high', source: 'ocr' },
      b: { value: 1, confidence_basis_points: 12000, source: 'ocr' },
      c: { value: 1, confidence_basis_points: -1, source: 'ocr' },
      d: { value: 1, confidence_basis_points: 91.5, source: 'ocr' },
    });

    expect(fields['a']?.confidenceBasisPoints).toBe(0);
    expect(fields['b']?.confidenceBasisPoints).toBe(0);
    expect(fields['c']?.confidenceBasisPoints).toBe(0);
    expect(fields['d']?.confidenceBasisPoints).toBe(0);
  });

  /**
   * A field with no value is not a field. Emitting one with `value: null`
   * would make `isReadable` answer false anyway, so this is not about the
   * verdict -- it is about the cross-checks, which read `extracted[field]`
   * directly and would otherwise compare against a hole.
   */
  it('drops a field that has no value', () => {
    const fields = readExtractedFields({
      a: { value: null, confidence_basis_points: 9900, source: 'human' },
      b: { confidence_basis_points: 9900, source: 'human' },
      c: 'not an object',
    });

    expect(Object.keys(fields)).toEqual([]);
  });

  it('reads anything that is not an object of fields as nothing extracted', () => {
    expect(readExtractedFields(null)).toEqual({});
    expect(readExtractedFields(undefined)).toEqual({});
    expect(readExtractedFields('{}')).toEqual({});
    expect(readExtractedFields([{ value: 1 }])).toEqual({});
    expect(readExtractedFields(42)).toEqual({});
  });

  it('keeps the fields it can read when a sibling is unusable', () => {
    const fields = readExtractedFields({
      total_acres: { value: 1240, confidence_basis_points: 8800, source: 'ocr' },
      owner_name: { value: null, confidence_basis_points: 8800, source: 'ocr' },
    });

    expect(Object.keys(fields)).toEqual(['total_acres']);
    expect(fields['total_acres']?.value).toBe(1240);
  });
});
