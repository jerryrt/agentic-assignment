import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_UPLOAD_MIME_TYPES,
  DocumentSlotSchema,
  DocumentUploadSchema,
  MAX_UPLOAD_BYTES,
  isAcceptedUploadMimeType,
} from '../src/index.ts';

const NOW = '2026-09-02T12:00:00.000+00:00';

const SLOT = {
  id: '00000000-0000-4000-8000-0000000000e1',
  application_id: '00000000-0000-4000-8000-0000000000d1',
  code: 'crop_insurance',
  label: 'Crop insurance certificate',
  required: true,
  state: 'accepted',
  revision: 3,
  extract_required: ['valid_until', 'insured_acres'],
  valid_until: '2027-03-12',
  created_at: NOW,
  updated_at: NOW,
};

const UPLOAD = {
  id: '00000000-0000-4000-8000-0000000000f1',
  slot_id: SLOT.id,
  storage_path: SLOT.application_id + '/crop_insurance/0f1e2d3c.pdf',
  filename: 'crop-insurance-2026.pdf',
  bytes: 182_000,
  mime: 'application/pdf',
  extracted: { insured_acres: { value: 2400, confidence_basis_points: 9100, source: 'ocr' } },
  extraction_state: 'complete',
  uploaded_at: NOW,
};

describe('DocumentSlotSchema', () => {
  it('parses a row as the database renders it', () => {
    expect(DocumentSlotSchema.parse(SLOT)).toEqual(SLOT);
  });

  it('accepts a slot that does not expire', () => {
    expect(DocumentSlotSchema.parse({ ...SLOT, valid_until: null }).valid_until).toBeNull();
  });

  // The narrowing is a second line behind the transition trigger, not the
  // first, but a state the machine does not know must not reach a guard as a
  // string that happens to typecheck.
  it('refuses a state no machine declares', () => {
    expect(DocumentSlotSchema.safeParse({ ...SLOT, state: 'shredded' }).success).toBe(false);
  });

  // A `date` and not a `timestamptz`: a certificate expires on a calendar day
  // where it was issued, and an instant would make the answer depend on the
  // reader's time zone.
  it('refuses a valid_until that is an instant rather than a calendar day', () => {
    expect(DocumentSlotSchema.safeParse({ ...SLOT, valid_until: NOW }).success).toBe(false);
    expect(DocumentSlotSchema.safeParse({ ...SLOT, valid_until: '12 Mar 2027' }).success).toBe(
      false,
    );
  });

  it('refuses a slot with no code, because the unique constraint is keyed on it', () => {
    expect(DocumentSlotSchema.safeParse({ ...SLOT, code: '' }).success).toBe(false);
  });
});

describe('DocumentUploadSchema', () => {
  it('parses a row as the database renders it', () => {
    expect(DocumentUploadSchema.parse(UPLOAD)).toEqual(UPLOAD);
  });

  it('accepts an upload nothing has read yet', () => {
    expect(DocumentUploadSchema.parse({ ...UPLOAD, extracted: null }).extracted).toBeNull();
  });

  // The extraction stays opaque here. packages/rules owns the confidence floor
  // and the ocr-versus-human distinction, so it owns what a field means.
  it('does not interpret what was extracted', () => {
    const odd = { ...UPLOAD, extracted: { anything: { at: 'all' } } };
    expect(DocumentUploadSchema.safeParse(odd).success).toBe(true);
  });

  it('refuses an empty file', () => {
    expect(DocumentUploadSchema.safeParse({ ...UPLOAD, bytes: 0 }).success).toBe(false);
  });
});

describe('what an upload may carry', () => {
  it('states the size limit once, for the browser and the server to share', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts a PDF and the image types, and nothing else', () => {
    expect(isAcceptedUploadMimeType('application/pdf')).toBe(true);
    expect(isAcceptedUploadMimeType('image/png')).toBe(true);
    expect(isAcceptedUploadMimeType('application/zip')).toBe(false);
    expect(isAcceptedUploadMimeType('text/html')).toBe(false);
    expect(ACCEPTED_UPLOAD_MIME_TYPES).toContain('application/pdf');
  });
});
