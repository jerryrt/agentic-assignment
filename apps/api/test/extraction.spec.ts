// The stub extractor, tested as the pure function it is.
//
// Worth its own file and no database: what it reads out of a filename is a
// grammar, and a grammar is exactly the thing that is cheap to pin down and
// expensive to leave to an end-to-end case. The seam it sits behind is proved
// in transition.spec.ts, against the real bucket and the real column.

import { describe, expect, it } from 'vitest';

import { stubExtractor, type FileRef, type SlotDefinition } from '../lib/extraction.ts';

function file(filename: string): FileRef {
  return {
    filename,
    storagePath: 'application/slot/' + filename,
    mime: 'application/pdf',
    bytes: 4_096,
  };
}

function slot(code: string, extractRequired: string[]): SlotDefinition {
  return { code, label: code, extractRequired };
}

describe('the stub extractor', () => {
  /** The example plan/04 gives, so the documented behaviour is the tested one. */
  it('reads the acreage and the owner off a deed filename', async () => {
    const extraction = await stubExtractor.extract(
      file('deed_1240ac_smith-farms.pdf'),
      slot('land_title', ['total_acres', 'owner_name']),
    );

    expect(extraction.fields['total_acres']?.value).toBe(1240);
    expect(extraction.fields['owner_name']?.value).toBe('Smith Farms');
    expect(extraction.state).toBe('extracted');
  });

  // Everything it emits is a machine reading, in basis points, above the floor
  // packages/rules applies. A human correction is the other source, and it is
  // trusted whatever the machine thought of its own reading.
  it('emits ocr readings with a confidence in basis points', async () => {
    const extraction = await stubExtractor.extract(
      file('deed_1240ac_smith-farms.pdf'),
      slot('land_title', ['total_acres', 'owner_name']),
    );

    for (const field of Object.values(extraction.fields)) {
      expect(field.source).toBe('ocr');
      expect(Number.isInteger(field.confidence_basis_points)).toBe(true);
      expect(field.confidence_basis_points).toBeGreaterThanOrEqual(7_000);
      expect(field.confidence_basis_points).toBeLessThanOrEqual(10_000);
    }
  });

  /**
   * A partial read is not an error. The fields that were not read are simply
   * absent, and the slot still moves -- what they become is a completeness
   * failure with a next action, which is what the borrower can act on.
   */
  it('reports a partial read rather than failing', async () => {
    const extraction = await stubExtractor.extract(
      file('scan0001.pdf'),
      slot('tax_return_2024', ['net_farm_income', 'taxpayer_name']),
    );

    expect(extraction.state).toBe('partial');
    expect(extraction.fields['net_farm_income']).toBeUndefined();
    expect(extraction.validUntil).toBeNull();
  });

  it('reads an expiry off the name, whether or not the pack asked for one', async () => {
    const asked = await stubExtractor.extract(
      file('crop_insurance_2027-03-01.pdf'),
      slot('crop_insurance', ['valid_until']),
    );
    expect(asked.fields['valid_until']?.value).toBe('2027-03-01');
    expect(asked.validUntil).toBe('2027-03-01');
    expect(asked.state).toBe('extracted');

    // A certificate says when it runs out regardless of what the checklist
    // wanted from it, and that date is what makes the document go stale.
    const unasked = await stubExtractor.extract(
      file('crop_insurance_2027-03-01.pdf'),
      slot('crop_insurance', []),
    );
    expect(unasked.validUntil).toBe('2027-03-01');
    expect(unasked.state).toBe('extracted');
  });

  // Money is integer minor units in TypeScript, everywhere. A figure that
  // changed scale between the extractor and the rule comparing it would be
  // wrong by a factor of a hundred in a comparison nobody re-checks.
  it('records money in minor units', async () => {
    const extraction = await stubExtractor.extract(
      file('tax_return_184200usd_fenwick-grain.pdf'),
      slot('tax_return_2024', ['net_farm_income', 'taxpayer_name']),
    );

    expect(extraction.fields['net_farm_income']?.value).toBe(18_420_000);
    expect(extraction.fields['taxpayer_name']?.value).toBe('Fenwick Grain');
  });

  /**
   * The same file read twice must say the same thing, or a lender and a
   * borrower looking at one document on two days see two different documents.
   */
  it('is deterministic', async () => {
    const once = await stubExtractor.extract(
      file('deed_1240ac_smith-farms.pdf'),
      slot('land_title', ['total_acres', 'owner_name']),
    );
    const twice = await stubExtractor.extract(
      file('deed_1240ac_smith-farms.pdf'),
      slot('land_title', ['total_acres', 'owner_name']),
    );

    expect(once).toEqual(twice);
  });

  // The first token says what the document is, not what it says. Reading it as
  // a name would put "Deed" in front of a lender as the owner of the land.
  it('never reads the document kind as a name', async () => {
    const extraction = await stubExtractor.extract(
      file('deed.pdf'),
      slot('land_title', ['owner_name']),
    );

    expect(extraction.fields['owner_name']).toBeUndefined();
    expect(extraction.state).toBe('partial');
  });

  // Anchored patterns, so a near-miss contributes nothing rather than becoming
  // a figure somebody then relies on.
  it('ignores a token that only looks like a figure', async () => {
    const extraction = await stubExtractor.extract(
      file('deed_12ac40_smith-farms.pdf'),
      slot('land_title', ['total_acres']),
    );

    expect(extraction.fields['total_acres']).toBeUndefined();
  });
});
