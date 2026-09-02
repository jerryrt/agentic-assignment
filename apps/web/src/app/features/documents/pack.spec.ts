import { ApplicationDataSchema, type DocumentSlot, type DocumentUpload } from '@lj/domain';
import { documentPackProgress, evaluateCompleteness } from '@lj/rules';

import {
  applicationFactsOf,
  applySlotAck,
  isBorrowerAction,
  latestUploadFor,
  nextActionFor,
  slotViewsOf,
  type DocumentPackValue,
} from './pack.ts';

const APPLICATION = '00000000-0000-4000-8000-0000000000d1';
const TODAY = '2026-09-02';

let sequence = 0;

function slot(patch: Partial<DocumentSlot> = {}): DocumentSlot {
  sequence += 1;
  return {
    id: '00000000-0000-4000-8000-00000000e' + String(sequence).padStart(3, '0'),
    application_id: APPLICATION,
    code: 'land_title',
    label: 'Land title or lease',
    required: true,
    state: 'required',
    revision: 0,
    extract_required: [],
    valid_until: null,
    created_at: '2026-09-01T09:00:00.000+00:00',
    updated_at: '2026-09-01T09:00:00.000+00:00',
    ...patch,
  };
}

function upload(patch: Partial<DocumentUpload> = {}): DocumentUpload {
  sequence += 1;
  return {
    id: '00000000-0000-4000-8000-00000000f' + String(sequence).padStart(3, '0'),
    slot_id: '00000000-0000-4000-8000-00000000e001',
    storage_path: APPLICATION + '/land_title/a.pdf',
    filename: 'a.pdf',
    bytes: 1024,
    mime: 'application/pdf',
    extracted: null,
    extraction_state: 'done',
    uploaded_at: '2026-09-01T10:00:00.000+00:00',
    ...patch,
  };
}

const DATA = ApplicationDataSchema.parse({
  borrower: { legal_name: 'Fenwick Grain Co.' },
  farm: {
    parcels: [
      { legal_description: 'NW-14-35-05-W3', acres: 1240, tenure: 'owned', commodity: 'grain' },
    ],
  },
});

function pack(
  slots: readonly DocumentSlot[],
  uploads: readonly DocumentUpload[] = [],
): DocumentPackValue {
  return {
    applicationId: APPLICATION,
    applicationState: 'docs_pending',
    applicationRevision: 3,
    data: DATA,
    slots,
    uploads,
  };
}

/** One entry of `document_upload.extracted`, in the shape 0006 writes it. */
type ExtractedEntry = NonNullable<DocumentUpload['extracted']>[string];

function ocr(value: number, confidenceBasisPoints: number): ExtractedEntry {
  return { value, confidence_basis_points: confidenceBasisPoints, source: 'ocr' };
}

describe('the newest file against a slot', () => {
  /**
   * @lj/db returns uploads newest first, but a helper that relies on the
   * caller's ordering is a helper that reads the wrong extraction the day
   * somebody adds a second query. The order is re-established here.
   */
  it('is the most recently uploaded one, whatever order the rows arrive in', () => {
    const target = '00000000-0000-4000-8000-00000000e001';
    const older = upload({ slot_id: target, uploaded_at: '2026-08-01T10:00:00.000+00:00' });
    const newer = upload({ slot_id: target, uploaded_at: '2026-09-01T10:00:00.000+00:00' });

    expect(latestUploadFor([older, newer], target)?.id).toBe(newer.id);
    expect(latestUploadFor([newer, older], target)?.id).toBe(newer.id);
  });

  it('is nothing at all when the slot has never been filled', () => {
    expect(latestUploadFor([], '00000000-0000-4000-8000-00000000e001')).toBeNull();
  });
});

describe('the slot views the rules read', () => {
  it('carries the terms the slot was generated under, not the product`s', () => {
    const only = slot({
      code: 'crop_insurance',
      label: 'Crop insurance certificate',
      required: false,
      state: 'accepted',
      valid_until: '2027-03-12',
      extract_required: ['insured_acres'],
    });

    const [view] = slotViewsOf(pack([only]));

    expect(view).toMatchObject({
      code: 'crop_insurance',
      label: 'Crop insurance certificate',
      required: false,
      state: 'accepted',
      validUntil: '2027-03-12',
      extractRequired: ['insured_acres'],
    });
  });

  /**
   * A replacement is a new row (the table is append-only), so the extraction
   * that counts is the newest one. Reading an earlier one would show a
   * borrower the figures from the document they just replaced.
   */
  it('reads the extraction from the newest file, not an earlier one', () => {
    const only = slot({ state: 'accepted', extract_required: ['total_acres'] });
    const stale = upload({
      slot_id: only.id,
      uploaded_at: '2026-08-01T10:00:00.000+00:00',
      extracted: { total_acres: ocr(900, 9000) },
    });
    const current = upload({
      slot_id: only.id,
      uploaded_at: '2026-09-01T10:00:00.000+00:00',
      extracted: { total_acres: ocr(1240, 9000) },
    });

    const [view] = slotViewsOf(pack([only], [stale, current]));

    expect(view?.extracted['total_acres']?.value).toBe(1240);
  });

  it('has nothing extracted for a slot with no file', () => {
    const [view] = slotViewsOf(pack([slot()]));
    expect(view?.extracted).toEqual({});
  });
});

describe('the next action on a slot', () => {
  /**
   * THE ASSESSMENT, in one test. plan/04 keeps missing, stale and unreadable
   * apart because the borrower's next action differs in each case, and the
   * lazy version collapses them into one red dot. Three kinds, three verbs.
   */
  it('is a different one for missing, stale and unreadable', () => {
    const missing = nextActionFor(slotViewsOf(pack([slot()]))[0]!, TODAY);
    const stale = nextActionFor(
      slotViewsOf(pack([slot({ state: 'accepted', valid_until: '2026-03-12' })]))[0]!,
      TODAY,
    );
    const unreadableSlot = slot({ state: 'accepted', extract_required: ['net_income'] });
    const unreadable = nextActionFor(
      slotViewsOf(
        pack([unreadableSlot], [upload({ slot_id: unreadableSlot.id, extracted: { net_income: ocr(1, 1000) } })]),
      )[0]!,
      TODAY,
    );

    expect(missing.kind).toBe('upload');
    expect(stale.kind).toBe('renew');
    expect(unreadable.kind).toBe('correct');
    expect(new Set([missing.label, stale.label, unreadable.label]).size).toBe(3);
  });

  it('names what to do, never what is wrong', () => {
    const missing = nextActionFor(slotViewsOf(pack([slot()]))[0]!, TODAY);
    const stale = nextActionFor(
      slotViewsOf(pack([slot({ state: 'accepted', valid_until: '2026-03-12' })]))[0]!,
      TODAY,
    );

    expect(missing.label).toBe('Upload it');
    expect(stale.label).toBe('Upload a current one');
    expect(stale.label.toLowerCase()).not.toContain('expired');
  });

  it('asks for a replacement when the lender refused the last one', () => {
    const action = nextActionFor(slotViewsOf(pack([slot({ state: 'rejected' })]))[0]!, TODAY);
    expect(action).toMatchObject({ kind: 'replace', label: 'Upload a replacement' });
  });

  it('asks the borrower for nothing while the lender still has it', () => {
    for (const state of ['uploaded', 'extracted'] as const) {
      const action = nextActionFor(slotViewsOf(pack([slot({ state })]))[0]!, TODAY);
      expect(action.kind).toBe('wait');
    }
  });

  it('names the fields a correction would fill in', () => {
    const only = slot({ state: 'accepted', extract_required: ['net_income', 'tax_year'] });
    const filed = upload({
      slot_id: only.id,
      extracted: { net_income: ocr(184200, 1000), tax_year: ocr(2024, 9900) },
    });

    const action = nextActionFor(slotViewsOf(pack([only], [filed]))[0]!, TODAY);

    expect(action.kind).toBe('correct');
    expect(action.fields).toEqual(['net_income']);
  });

  /**
   * The branch order mirrors `documentSlotRule` in @lj/rules exactly. If it
   * did not, a row would say one thing and the button beside it would offer
   * another -- the two disagreeing is worse than either being wrong.
   */
  it('offers a current document before it offers a correction, as the rule does', () => {
    const only = slot({
      state: 'accepted',
      valid_until: '2026-03-12',
      extract_required: ['net_income'],
    });
    const filed = upload({ slot_id: only.id, extracted: { net_income: ocr(1, 1000) } });

    expect(nextActionFor(slotViewsOf(pack([only], [filed]))[0]!, TODAY).kind).toBe('renew');
  });

  it('asks for nothing once a slot is accepted, current and readable', () => {
    const only = slot({ state: 'accepted', valid_until: '2027-01-01' });
    expect(nextActionFor(slotViewsOf(pack([only]))[0]!, TODAY).kind).toBe('done');
  });

  /**
   * plan/04: extraction proposes, a human confirms, and confidence drops out
   * of the rule once a field is human-verified. The action has to agree with
   * that or a corrected slot keeps asking to be corrected.
   */
  it('stops asking once somebody has typed the value in', () => {
    const only = slot({ state: 'accepted', extract_required: ['net_income'] });
    const filed = upload({
      slot_id: only.id,
      extracted: { net_income: { value: 184200, confidence_basis_points: 0, source: 'human' } },
    });

    expect(nextActionFor(slotViewsOf(pack([only], [filed]))[0]!, TODAY).kind).toBe('done');
  });
});

/**
 * plan/04's first honesty rule, asserted against the same figure the screen
 * renders. `documentPackProgress` is @lj/rules' and is not re-implemented
 * here; what these tests protect is that this feature feeds it the results of
 * the completeness rules rather than counting slots for itself.
 */
describe('the bar', () => {
  function progressOf(value: DocumentPackValue): { accepted: number; total: number } {
    const results = evaluateCompleteness({ today: TODAY, slots: slotViewsOf(value) });
    const { accepted, total } = documentPackProgress(results);
    return { accepted, total };
  }

  it('does not move forward when a file is uploaded, only when it is accepted', () => {
    const before = pack([slot({ code: 'a' }), slot({ code: 'b', state: 'accepted' })]);
    const uploaded = pack([slot({ code: 'a', state: 'uploaded' }), slot({ code: 'b', state: 'accepted' })]);

    expect(progressOf(before)).toEqual({ accepted: 1, total: 2 });
    expect(progressOf(uploaded)).toEqual({ accepted: 1, total: 2 });
  });

  /**
   * The dishonest version moves the bar to 2 of 2 on upload and back to 1 of 2
   * on the refusal. It never moved here, so there is nothing to move back.
   */
  it('has nothing to give back when the lender refuses that file', () => {
    const rejected = pack([slot({ code: 'a', state: 'rejected' }), slot({ code: 'b', state: 'accepted' })]);
    expect(progressOf(rejected)).toEqual({ accepted: 1, total: 2 });
  });

  it('does not count a document that has expired', () => {
    const stale = pack([
      slot({ code: 'a', state: 'accepted', valid_until: '2026-03-12' }),
      slot({ code: 'b', state: 'accepted' }),
    ]);
    expect(progressOf(stale)).toEqual({ accepted: 1, total: 2 });
  });

  it('does not count a document whose required field nobody could read', () => {
    const unreadable = slot({ code: 'a', state: 'accepted', extract_required: ['net_income'] });
    const value = pack(
      [unreadable, slot({ code: 'b', state: 'accepted' })],
      [upload({ slot_id: unreadable.id, extracted: { net_income: ocr(1, 1000) } })],
    );
    expect(progressOf(value)).toEqual({ accepted: 1, total: 2 });
  });

  it('leaves an optional document out of the count entirely', () => {
    const value = pack([
      slot({ code: 'a', state: 'accepted' }),
      slot({ code: 'b', required: false }),
    ]);
    expect(progressOf(value)).toEqual({ accepted: 1, total: 1 });
  });
});

describe('what "needs your attention" counts', () => {
  it('counts the things the borrower can act on', () => {
    for (const state of ['required', 'rejected'] as const) {
      const only = slotViewsOf(pack([slot({ state })]))[0]!;
      expect(isBorrowerAction(nextActionFor(only, TODAY))).toBe(true);
    }
  });

  /**
   * A document sitting with the lender is outstanding, and it is still not the
   * borrower's to do anything about. Counting it would send them looking for
   * work that is not theirs.
   */
  it('does not count a document the lender is still reading', () => {
    const only = slotViewsOf(pack([slot({ state: 'uploaded' })]))[0]!;
    expect(isBorrowerAction(nextActionFor(only, TODAY))).toBe(false);
  });

  it('does not count one that is finished', () => {
    const only = slotViewsOf(pack([slot({ state: 'accepted' })]))[0]!;
    expect(isBorrowerAction(nextActionFor(only, TODAY))).toBe(false);
  });
});

describe('taking the answer to a slot transition', () => {
  it('moves the slot the server moved, and its revision with it', () => {
    const only = slot({ state: 'extracted', revision: 3 });
    const next = applySlotAck(pack([only]), {
      subjectId: only.id,
      to: 'accepted',
      revision: 4,
    });

    expect(next.slots[0]).toMatchObject({ state: 'accepted', revision: 4 });
  });

  /**
   * The ordering policy `AggregateStore` states, applied where a pack can
   * actually apply it. A pack has no single revision -- it has one per slot --
   * so the base class's monotonicity check has nothing to compare and this is
   * where the older answer is dropped instead.
   */
  it('drops an answer that is not newer than what is already held', () => {
    const only = slot({ state: 'accepted', revision: 5 });
    const value = pack([only]);

    expect(applySlotAck(value, { subjectId: only.id, to: 'rejected', revision: 4 })).toBe(value);
    expect(applySlotAck(value, { subjectId: only.id, to: 'rejected', revision: 5 })).toBe(value);
  });

  it('drops an answer about a slot this pack does not hold', () => {
    const value = pack([slot()]);
    const unchanged = applySlotAck(value, {
      subjectId: '00000000-0000-4000-8000-0000000000ff',
      to: 'accepted',
      revision: 9,
    });

    expect(unchanged).toBe(value);
  });

  /**
   * The acknowledgement crosses a fetch boundary as JSON, so `to` is a string
   * that happens to typecheck. A state the machine does not have must not
   * reach the rules, which switch on it.
   */
  it('drops an answer naming a state the slot machine does not have', () => {
    const only = slot({ revision: 1 });
    const value = pack([only]);

    expect(applySlotAck(value, { subjectId: only.id, to: 'archived', revision: 2 })).toBe(value);
  });
});

describe('the facts the cross-checks compare against', () => {
  it('are the derived acreage and the legal name, not raw form fields', () => {
    const facts = applicationFactsOf(pack([]).data);
    expect(facts).toEqual({ totalAcres: 1240, legalName: 'Fenwick Grain Co.' });
  });
});
