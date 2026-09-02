import { MAX_UPLOAD_BYTES } from '@lj/domain';

import { CORRECTION_NOT_WIRED, INTAKE_NOT_WIRED, UnwiredDocumentIntake, fileRefusal } from './intake.ts';

describe('refusing a file before it is sent', () => {
  it('lets a PDF within the limit through', () => {
    expect(fileRefusal({ size: 2_000_000, type: 'application/pdf' })).toBeNull();
  });

  it('lets a photograph through, because that is what a scan usually is', () => {
    expect(fileRefusal({ size: 400_000, type: 'image/jpeg' })).toBeNull();
    expect(fileRefusal({ size: 400_000, type: 'image/heic' })).toBeNull();
  });

  it('refuses a file over the limit and says what to do instead', () => {
    const refusal = fileRefusal({ size: MAX_UPLOAD_BYTES + 1, type: 'application/pdf' });
    expect(refusal).toContain('10 MB');
    expect(refusal).toContain('smaller');
  });

  it('accepts a file exactly at the limit, because the limit is inclusive', () => {
    expect(fileRefusal({ size: MAX_UPLOAD_BYTES, type: 'application/pdf' })).toBeNull();
  });

  it('refuses a kind of file the bucket does not hold', () => {
    expect(fileRefusal({ size: 1_000, type: 'application/zip' })).toContain('PDF');
    expect(fileRefusal({ size: 1_000, type: 'text/csv' })).toContain('PDF');
  });

  /**
   * A browser reports an empty string for a type it cannot name, and
   * `document_upload` has `check (bytes > 0)`. Both are refused here rather
   * than sent and bounced.
   */
  it('refuses a file the browser could not name', () => {
    expect(fileRefusal({ size: 1_000, type: '' })).not.toBeNull();
  });

  it('refuses an empty file', () => {
    expect(fileRefusal({ size: 0, type: 'application/pdf' })).toContain('empty');
  });
});

/**
 * The default binding refuses instead of pretending. A stub that resolved
 * would put an "uploaded" on the checklist that the next refresh deletes, and
 * a screen that lies about where the borrower stands is the one thing plan/04
 * exists to avoid.
 */
describe('the seam with nothing behind it', () => {
  it('refuses an upload, in a sentence a person can read', async () => {
    await expect(
      new UnwiredDocumentIntake().upload({
        applicationId: 'a',
        slotId: 'b',
        slotCode: 'land_title',
        file: new File(['x'], 'title.pdf', { type: 'application/pdf' }),
      }),
    ).rejects.toThrow(INTAKE_NOT_WIRED);
  });

  it('refuses a correction the same way', async () => {
    await expect(
      new UnwiredDocumentIntake().correct({
        applicationId: 'a',
        slotId: 'b',
        field: 'net_income',
        value: '184200',
      }),
    ).rejects.toThrow(CORRECTION_NOT_WIRED);
  });
});
