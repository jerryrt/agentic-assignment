import {
  amountToMoney,
  clearComposeSnapshot,
  composeSnapshotsFor,
  reconcileCompose,
  readComposeSnapshot,
  storableCompose,
  writeComposeSnapshot,
  type ComposeSnapshot,
} from './compose-draft.ts';

const LOAN = '00000000-0000-4000-8000-0000000000e1';
const RELEASE = '00000000-0000-4000-8000-0000000000f5';

class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

function snapshot(patch: Partial<ComposeSnapshot> = {}): ComposeSnapshot {
  return {
    loanId: LOAN,
    releaseId: RELEASE,
    revision: 2,
    amountText: '12,000',
    purpose: 'Seed and fertiliser',
    savedAt: '2026-09-01T12:00:00.000Z',
    ...patch,
  };
}

describe('the compose seatbelt', () => {
  it('reads back what it wrote', () => {
    const storage = new MemoryStorage();
    writeComposeSnapshot(storage, snapshot());

    expect(readComposeSnapshot(storage, LOAN, RELEASE)).toEqual(snapshot());
  });

  /**
   * The row is created as soon as what has been typed can be stored, so there
   * is a window -- from the first keystroke until there is an amount and a
   * purpose, and longer if the insert fails -- in which there is typing and no
   * release to key it to. It is kept under the loan instead, and moved when the
   * row arrives.
   */
  it('keeps typing that has no release row yet', () => {
    const storage = new MemoryStorage();
    const unsent = snapshot({ releaseId: null, revision: 0 });
    writeComposeSnapshot(storage, unsent);

    expect(readComposeSnapshot(storage, LOAN, null)).toEqual(unsent);
    expect(readComposeSnapshot(storage, LOAN, RELEASE)).toBeNull();
  });

  it('forgets a copy the server now holds', () => {
    const storage = new MemoryStorage();
    writeComposeSnapshot(storage, snapshot());
    clearComposeSnapshot(storage, LOAN, RELEASE);

    expect(readComposeSnapshot(storage, LOAN, RELEASE)).toBeNull();
  });

  it('discards an entry belonging to another release', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'lj.release.' + LOAN + '.' + RELEASE,
      JSON.stringify(snapshot({ releaseId: '00000000-0000-4000-8000-0000000000f6' })),
    );

    expect(readComposeSnapshot(storage, LOAN, RELEASE)).toBeNull();
  });

  it('discards anything unreadable rather than repairing it', () => {
    const storage = new MemoryStorage();
    storage.setItem('lj.release.' + LOAN + '.' + RELEASE, '{ not json');

    expect(readComposeSnapshot(storage, LOAN, RELEASE)).toBeNull();
  });

  it('survives storage being unavailable', () => {
    expect(() => writeComposeSnapshot(null, snapshot())).not.toThrow();
    expect(readComposeSnapshot(null, LOAN, RELEASE)).toBeNull();
    expect(() => clearComposeSnapshot(null, LOAN, RELEASE)).not.toThrow();
  });

  it('lists both keys so the unsent one can be moved onto the new row', () => {
    expect(composeSnapshotsFor(LOAN, RELEASE)).toEqual([
      'lj.release.' + LOAN + '.new',
      'lj.release.' + LOAN + '.' + RELEASE,
    ]);
  });
});

describe('reconciling the seatbelt with the server', () => {
  it('prefers the server when the browser is behind it', () => {
    expect(
      reconcileCompose(snapshot({ revision: 1 }), {
        revision: 4,
        amountText: '12000.00',
        purpose: 'Seed and fertiliser',
      }),
    ).toEqual({ source: 'server' });
  });

  it('prefers the browser when it holds edits the server never saw', () => {
    const held = snapshot();
    expect(
      reconcileCompose(held, {
        revision: 2,
        amountText: '9000.00',
        purpose: 'Seed and fertiliser',
      }),
    ).toEqual({ source: 'local', snapshot: held });
  });

  it('prefers the browser when a save landed that this read has not seen', () => {
    const held = snapshot({ revision: 5 });
    expect(
      reconcileCompose(held, { revision: 4, amountText: '12,000', purpose: 'Seed and fertiliser' }),
    ).toEqual({ source: 'local', snapshot: held });
  });

  /**
   * The amount is compared as an AMOUNT, not as text: '12,000' and '12000.00'
   * are one value typed two ways, and offering to recover the difference would
   * be offering to recover nothing.
   */
  it('treats two spellings of one amount as the same payload', () => {
    expect(
      reconcileCompose(snapshot(), {
        revision: 2,
        amountText: '12000.00',
        purpose: 'Seed and fertiliser',
      }),
    ).toEqual({ source: 'server' });
  });

  it('has nothing to recover when there is no snapshot', () => {
    expect(
      reconcileCompose(null, { revision: 0, amountText: '', purpose: '' }),
    ).toEqual({ source: 'server' });
  });
});

describe('what can be stored', () => {
  it('is nothing until there is a positive amount and a purpose', () => {
    expect(storableCompose('', '')).toBeNull();
    expect(storableCompose('12000', '')).toBeNull();
    expect(storableCompose('12000', '   ')).toBeNull();
    expect(storableCompose('', 'Seed and fertiliser')).toBeNull();
    expect(storableCompose('half typed', 'Seed and fertiliser')).toBeNull();
  });

  /** `credit_release` carries `check (amount > 0)`; zero is not a request. */
  it('refuses a request for nothing', () => {
    expect(storableCompose('0', 'Seed and fertiliser')).toBeNull();
    expect(storableCompose('0.00', 'Seed and fertiliser')).toBeNull();
  });

  it('trims the purpose it will store, because a space is not a purpose', () => {
    expect(storableCompose('12,000', '  Seed and fertiliser ')).toEqual({
      amount: 1_200_000,
      purpose: 'Seed and fertiliser',
    });
  });
});

describe('reading a typed amount', () => {
  it('accepts the separators a person types', () => {
    expect(amountToMoney('12,000')).toBe(1_200_000);
    expect(amountToMoney('12 000.50')).toBe(1_200_050);
  });

  it('reports a half-typed or malformed amount as absent rather than throwing', () => {
    expect(amountToMoney('')).toBeNull();
    expect(amountToMoney('   ')).toBeNull();
    expect(amountToMoney('$12000')).toBeNull();
    expect(amountToMoney('12.0.0')).toBeNull();
  });
});
