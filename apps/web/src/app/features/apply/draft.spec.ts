import { ApplicationDataSchema, type ApplicationData } from '@lj/domain';

import {
  clearDraftSnapshot,
  readDraftSnapshot,
  reconcileDraft,
  writeDraftSnapshot,
  type DraftSnapshot,
} from './draft.ts';

const ID = '00000000-0000-4000-8000-0000000000d1';

function parsed(value: unknown): ApplicationData {
  return ApplicationDataSchema.parse(value);
}

/** localStorage without a browser, and one that refuses, which is a real case. */
function fakeStorage(options: { refuse?: boolean } = {}): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => {
      if (options.refuse === true) {
        throw new DOMException('denied');
      }
      return entries.get(key) ?? null;
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (options.refuse === true) {
        throw new DOMException('quota');
      }
      entries.set(key, value);
    },
  };
}

function snapshotOf(revision: number, data: ApplicationData): DraftSnapshot {
  return {
    applicationId: ID,
    revision,
    data,
    furthestStep: 'financials',
    savedAt: '2026-09-01T12:00:00.000Z',
  };
}

describe('the draft seatbelt', () => {
  it('round-trips a snapshot', () => {
    const storage = fakeStorage();
    const snapshot = snapshotOf(7, parsed({ borrower: { legal_name: 'Fenwick Grain Co.' } }));

    writeDraftSnapshot(storage, snapshot);
    expect(readDraftSnapshot(storage, ID)).toEqual(snapshot);

    clearDraftSnapshot(storage, ID);
    expect(readDraftSnapshot(storage, ID)).toBeNull();
  });

  it('keeps one snapshot per application', () => {
    const storage = fakeStorage();
    writeDraftSnapshot(storage, snapshotOf(7, parsed({})));
    expect(readDraftSnapshot(storage, 'another-application')).toBeNull();
  });

  // Losing the seatbelt is a degradation. Taking the screen down over it, in a
  // private window or over quota, would be the bug.
  it('survives storage that refuses to answer', () => {
    const storage = fakeStorage({ refuse: true });
    expect(() => writeDraftSnapshot(storage, snapshotOf(7, parsed({})))).not.toThrow();
    expect(readDraftSnapshot(storage, ID)).toBeNull();
  });

  it('survives having no storage at all', () => {
    expect(readDraftSnapshot(null, ID)).toBeNull();
    expect(() => writeDraftSnapshot(null, snapshotOf(1, parsed({})))).not.toThrow();
    expect(() => clearDraftSnapshot(null, ID)).not.toThrow();
  });

  // A cache is discarded when it cannot be read, never repaired: a half-parsed
  // payload restored over a good one is worse than no seatbelt.
  it('discards a snapshot it cannot read rather than repairing it', () => {
    const storage = fakeStorage();
    storage.setItem('lj.draft.' + ID, 'not json');
    expect(readDraftSnapshot(storage, ID)).toBeNull();

    storage.setItem('lj.draft.' + ID, JSON.stringify({ applicationId: ID, revision: 'seven' }));
    expect(readDraftSnapshot(storage, ID)).toBeNull();

    storage.setItem(
      'lj.draft.' + ID,
      JSON.stringify({ ...snapshotOf(7, parsed({})), furthestStep: 'business' }),
    );
    expect(readDraftSnapshot(storage, ID)).toBeNull();
  });
});

describe('reconcileDraft', () => {
  const server = { revision: 7, data: parsed({ borrower: { legal_name: 'Fenwick Grain Co.' } }) };

  it('opens the server copy when there is no seatbelt', () => {
    expect(reconcileDraft(null, server)).toEqual({ source: 'server' });
  });

  // A later revision on the server means somebody saved something this browser
  // never saw. Restoring over it would delete their work.
  it('discards a seatbelt the server has already moved past', () => {
    expect(reconcileDraft(snapshotOf(6, parsed({})), server)).toEqual({ source: 'server' });
  });

  it('opens the server copy when the last save landed', () => {
    expect(reconcileDraft(snapshotOf(7, server.data), server)).toEqual({ source: 'server' });
  });

  // The case the seatbelt exists for: the tab was killed, or the last save was
  // in flight when the page went away.
  it('recovers edits the server never received', () => {
    const unsaved = snapshotOf(7, parsed({ borrower: { legal_name: 'Fenwick Grain Company' } }));
    expect(reconcileDraft(unsaved, server)).toEqual({ source: 'local', snapshot: unsaved });
  });

  // A save landed but this read did not see it. The local copy is the later of
  // the two.
  it('prefers a seatbelt that is ahead of the read', () => {
    const ahead = snapshotOf(8, parsed({ borrower: { legal_name: 'Fenwick Grain Company' } }));
    expect(reconcileDraft(ahead, server)).toEqual({ source: 'local', snapshot: ahead });
  });
});
