import { describe, expect, it } from 'vitest';

import { parseRequiredDocs } from '../src/index.ts';

/**
 * `loan_product.required_docs`, parsed.
 *
 * The same trust boundary `parseEligibilityCriteria` guards, pointed at the
 * other opaque column, and with the same property: it FAILS CLOSED. A dropped
 * required document is worse than a rejected product, because the pack then
 * reports complete while a document is missing -- which is the one outcome
 * Option 1 exists to prevent.
 */

/** The operating line's pack, copied verbatim from 0004_demo_data.sql. */
const OPERATING_LINE: unknown = {
  version: 1,
  slots: [
    { code: 'tax_return_2024', label: '2024 tax return', required: true,
      extract_required: ['tax_year', 'net_income'] },
    { code: 'financial_statements', label: 'Year-end financial statements', required: true,
      extract_required: ['fiscal_year_end', 'total_assets'] },
    { code: 'crop_insurance', label: 'Crop insurance certificate', required: true,
      extract_required: ['valid_until', 'insured_acres'] },
    { code: 'land_title', label: 'Land title or lease', required: true,
      extract_required: ['legal_description'] },
    { code: 'id_verification', label: 'Photo identification', required: true,
      extract_required: ['full_name', 'valid_until'] },
  ],
};

/** The equipment loan's, which has an OPTIONAL slot -- the interesting difference. */
const EQUIPMENT_LOAN: unknown = {
  version: 1,
  slots: [
    { code: 'equipment_invoice', label: 'Equipment invoice or quote', required: true,
      extract_required: ['vendor', 'purchase_price'] },
    { code: 'lien_search', label: 'Personal property lien search', required: true,
      extract_required: ['search_date', 'registrations'] },
    { code: 'tax_return_2024', label: '2024 tax return', required: true,
      extract_required: ['tax_year', 'net_income'] },
    { code: 'financial_statements', label: 'Year-end financial statements', required: false,
      extract_required: [] },
    { code: 'id_verification', label: 'Photo identification', required: true,
      extract_required: ['full_name', 'valid_until'] },
  ],
};

function parsed(value: unknown) {
  const outcome = parseRequiredDocs(value);
  if (!outcome.ok) {
    throw new Error('expected it to parse: ' + outcome.problems.join('; '));
  }
  return outcome.slots;
}

describe('parseRequiredDocs', () => {
  it('parses both packs the demo migration seeds', () => {
    expect(parsed(OPERATING_LINE)).toHaveLength(5);
    expect(parsed(EQUIPMENT_LOAN)).toHaveLength(5);
  });

  it('keeps the slots in the order the product declares them', () => {
    expect(parsed(OPERATING_LINE).map((slot) => slot.code)).toEqual([
      'tax_return_2024',
      'financial_statements',
      'crop_insurance',
      'land_title',
      'id_verification',
    ]);
  });

  it('carries the label, the required flag and the fields each slot must yield', () => {
    const [first] = parsed(OPERATING_LINE);
    expect(first).toEqual({
      code: 'tax_return_2024',
      label: '2024 tax return',
      required: true,
      extractRequired: ['tax_year', 'net_income'],
    });
  });

  // The difference that makes the checklist feel like a lending product rather
  // than a fixed list: an equipment loan asks for an invoice and a lien search,
  // an operating line does not.
  it('keeps an optional slot, and keeps it optional', () => {
    const optional = parsed(EQUIPMENT_LOAN).find(
      (slot) => slot.code === 'financial_statements',
    );
    expect(optional?.required).toBe(false);
    expect(optional?.extractRequired).toEqual([]);
  });

  // Absent means required. A slot that does not say otherwise is one somebody
  // has to produce; the permissive reading would let a typo make a document
  // optional.
  it('treats a missing required flag as required', () => {
    const slots = parsed({ version: 1, slots: [{ code: 'deed', label: 'Deed' }] });
    expect(slots[0]?.required).toBe(true);
    expect(slots[0]?.extractRequired).toEqual([]);
  });

  it('reports a version it was not written for rather than guessing', () => {
    const outcome = parseRequiredDocs({ version: 2, slots: [] });
    expect(outcome.ok).toBe(false);
  });

  // Every one of these would otherwise become a slot silently absent from the
  // checklist, and a pack short a document reports complete.
  it('refuses a malformed pack rather than dropping the slot it cannot read', () => {
    const bad: readonly unknown[] = [
      null,
      'not an object',
      { version: 1 },
      { version: 1, slots: 'not an array' },
      { version: 1, slots: [{ label: 'No code' }] },
      { version: 1, slots: [{ code: 'deed' }] },
      { version: 1, slots: [{ code: 'deed', label: 'Deed', required: 'yes' }] },
      { version: 1, slots: [{ code: 'deed', label: 'Deed', extract_required: 'owner' }] },
      { version: 1, slots: [{ code: 'deed', label: 'Deed', extract_required: [''] }] },
    ];
    for (const value of bad) {
      expect(parseRequiredDocs(value).ok).toBe(false);
    }
  });

  // Two slots with one code would collide on unique (application_id, code) at
  // generation time. Refusing here names the product; refusing there names a
  // constraint.
  it('refuses a duplicated code', () => {
    const outcome = parseRequiredDocs({
      version: 1,
      slots: [
        { code: 'deed', label: 'Deed' },
        { code: 'deed', label: 'Deed again' },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.problems.join(' ')).toContain('twice');
  });

  // A product asking for nothing is a product whose pack is complete on
  // arrival, which is a policy nobody stated. It is refused rather than read as
  // "no documents needed".
  it('refuses an empty pack', () => {
    expect(parseRequiredDocs({ version: 1, slots: [] }).ok).toBe(false);
  });
});
