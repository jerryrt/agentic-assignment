import {
  clearDecisionSnapshot,
  readDecisionSnapshot,
  reconcileDecision,
  writeDecisionSnapshot,
  type DecisionSnapshot,
} from './decision-draft.ts';

const RELEASE = '00000000-0000-4000-8000-0000000000f3';

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

function snapshot(patch: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
  return {
    releaseId: RELEASE,
    internalNote: 'Called the borrower, waiting on the survey.',
    declineReason: 'The land title on file expired in June.',
    savedAt: '2026-09-01T12:00:00.000Z',
    ...patch,
  };
}

describe('the decision seatbelt', () => {
  /** plan/06's third refresh case, stated as a test: lenders lose work too. */
  it('gives a typed decline reason back after a reload', () => {
    const storage = new MemoryStorage();
    writeDecisionSnapshot(storage, snapshot());

    // A reload is a new store reading the same browser storage.
    const recovered = readDecisionSnapshot(storage, RELEASE);

    expect(recovered?.declineReason).toBe('The land title on file expired in June.');
    expect(recovered?.internalNote).toBe('Called the borrower, waiting on the survey.');
  });

  it('discards an entry belonging to another release', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'lj.decision.' + RELEASE,
      JSON.stringify(snapshot({ releaseId: '00000000-0000-4000-8000-0000000000f4' })),
    );

    expect(readDecisionSnapshot(storage, RELEASE)).toBeNull();
  });

  it('discards anything unreadable rather than repairing it', () => {
    const storage = new MemoryStorage();
    storage.setItem('lj.decision.' + RELEASE, '{ not json');

    expect(readDecisionSnapshot(storage, RELEASE)).toBeNull();
  });

  it('forgets the copy once the decision has been sent', () => {
    const storage = new MemoryStorage();
    writeDecisionSnapshot(storage, snapshot());
    clearDecisionSnapshot(storage, RELEASE);

    expect(readDecisionSnapshot(storage, RELEASE)).toBeNull();
  });

  it('survives storage being unavailable', () => {
    expect(() => writeDecisionSnapshot(null, snapshot())).not.toThrow();
    expect(readDecisionSnapshot(null, RELEASE)).toBeNull();
    expect(() => clearDecisionSnapshot(null, RELEASE)).not.toThrow();
  });
});

describe('reconciling a decision with the server', () => {
  it('opens with the saved note when nothing was left behind', () => {
    expect(reconcileDecision(null, { internalNote: 'Survey received.' })).toEqual({
      internalNote: 'Survey received.',
      declineReason: '',
      recovered: false,
    });
  });

  /**
   * The decline reason has no server copy at all -- no client may write that
   * column (issue #50) -- so the browser's is the only one there is.
   */
  it('always takes the decline reason from the browser', () => {
    const reconciled = reconcileDecision(snapshot({ internalNote: 'Survey received.' }), {
      internalNote: 'Survey received.',
    });

    expect(reconciled.declineReason).toBe('The land title on file expired in June.');
    expect(reconciled.recovered).toBe(true);
  });

  it('keeps a note the autosave never sent, and says so', () => {
    const reconciled = reconcileDecision(snapshot({ declineReason: '' }), {
      internalNote: 'Called the borrower',
    });

    expect(reconciled.internalNote).toBe('Called the borrower, waiting on the survey.');
    expect(reconciled.recovered).toBe(true);
  });

  it('has nothing to recover when the browser and the server agree', () => {
    const reconciled = reconcileDecision(
      snapshot({ declineReason: '', internalNote: 'Survey received.' }),
      { internalNote: 'Survey received.' },
    );

    expect(reconciled.recovered).toBe(false);
  });
});
