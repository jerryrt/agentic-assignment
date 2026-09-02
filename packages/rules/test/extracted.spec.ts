import { describe, expect, it } from 'vitest';

import { EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS, isReadable, parseExtractedFields } from '../src/index.ts';

/**
 * One reader for a shape that was previously parsed twice, by the process that
 * writes it and the screen that reads it. What is asserted here is the
 * direction every branch fails in: towards distrust.
 */
describe('parseExtractedFields', () => {
  it('reads the shape the column comment states', () => {
    expect(
      parseExtractedFields({
        total_acres: { value: 1240, confidence_basis_points: 9100, source: 'ocr' },
        owner_name: { value: 'Smith Farms', confidence_basis_points: 10000, source: 'human' },
      }),
    ).toEqual({
      total_acres: { value: 1240, confidenceBasisPoints: 9100, source: 'ocr' },
      owner_name: { value: 'Smith Farms', confidenceBasisPoints: 10000, source: 'human' },
    });
  });

  it('reads anything that is not a field map as nothing extracted', () => {
    for (const value of [null, undefined, 'text', 42, [], [{ value: 1 }]]) {
      expect(parseExtractedFields(value)).toEqual({});
    }
  });

  it('drops a field that carries no value, because that is not a bad reading but no reading', () => {
    const fields = parseExtractedFields({
      net_income: { value: null, confidence_basis_points: 9900, source: 'ocr' },
      tax_year: { confidence_basis_points: 9900, source: 'ocr' },
    });
    expect(fields).toEqual({});
  });

  // The point the two previous copies disagreed on. Keeping the field lets the
  // correction panel offer it; dropping it would not. Both block the pack --
  // which the next test proves rather than assumes.
  it('keeps a field whose confidence it cannot read, at zero confidence', () => {
    const fields = parseExtractedFields({
      net_income: { value: 184200, confidence_basis_points: 'high', source: 'ocr' },
      total_assets: { value: 12, confidence_basis_points: 12.5, source: 'ocr' },
      insured_acres: { value: 900, confidence_basis_points: 20000, source: 'ocr' },
      valid_until: { value: '2027-01-01', confidence_basis_points: -1, source: 'ocr' },
    });
    expect(Object.keys(fields).sort()).toEqual([
      'insured_acres',
      'net_income',
      'total_assets',
      'valid_until',
    ]);
    expect(Object.values(fields).every((field) => field.confidenceBasisPoints === 0)).toBe(true);
  });

  it('leaves a field it could not read unreadable, so the pack still blocks', () => {
    const fields = parseExtractedFields({
      net_income: { value: 184200, confidence_basis_points: 'high', source: 'ocr' },
    });
    expect(isReadable(fields['net_income'])).toBe(false);
  });

  // Handing the trust that belongs to a person's confirmation to whatever wrote
  // the row is the one mistake with no recovery: a human-sourced field is
  // trusted regardless of confidence.
  it('reads any source but the exact string human as the machine', () => {
    for (const source of ['HUMAN', 'person', '', null, undefined, 1, true]) {
      const fields = parseExtractedFields({
        f: { value: 1, confidence_basis_points: 100, source },
      });
      expect(fields['f']?.source).toBe('ocr');
      expect(isReadable(fields['f'])).toBe(false);
    }
  });

  it('trusts a human correction whatever the machine thought of it', () => {
    const fields = parseExtractedFields({
      f: { value: 1, confidence_basis_points: 0, source: 'human' },
    });
    expect(fields['f']?.confidenceBasisPoints).toBeLessThan(
      EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS,
    );
    expect(isReadable(fields['f'])).toBe(true);
  });
});
