import { TestBed } from '@angular/core/testing';

import { AggregateStore, type WriteOutcome } from './aggregate-store.ts';

/**
 * The base class is where a bug is copied four times, so it is tested as
 * behaviour rather than exercised through a feature (CLAUDE.md section 7).
 *
 * Everything below is about a single question: when two answers about the same
 * aggregate arrive, which one is allowed to win. The store's whole reason to
 * exist is that the server holds the truth and the client holds a prediction
 * (plan/03-workflow-engine.md section 4), and every test here is one way that
 * ordering can be violated.
 */

interface Parcel {
  readonly id: string;
  readonly revision: number;
  readonly label: string;
}

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;
  readonly promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** A store whose reads and writes the test drives by hand. */
class TestStore extends AggregateStore<Parcel> {
  readonly reads: Deferred<Parcel>[] = [];
  loadCalls = 0;

  protected override load(): Promise<Parcel> {
    this.loadCalls += 1;
    const pending = new Deferred<Parcel>();
    this.reads.push(pending);
    return pending.promise;
  }

  protected override revisionOf(value: Parcel): number {
    return value.revision;
  }

  /** Exposed so the test can drive the protected write path directly. */
  runWrite<R>(operation: () => Promise<R>): Promise<WriteOutcome<R>> {
    return this.write(operation);
  }

  adoptValue(value: Parcel): void {
    this.adopt(value);
  }

  /** Start a read and answer it, so a test can get to a known held value. */
  async seed(value: Parcel): Promise<void> {
    const settled = this.refresh();
    this.settleRead(this.reads.length - 1, value);
    await settled;
  }

  settleRead(index: number, value: Parcel): void {
    const pending = this.reads[index];
    if (pending === undefined) {
      throw new Error('no read at index ' + String(index));
    }
    pending.resolve(value);
  }

  failRead(index: number, reason: unknown): void {
    const pending = this.reads[index];
    if (pending === undefined) {
      throw new Error('no read at index ' + String(index));
    }
    pending.reject(reason);
  }
}

function parcel(revision: number, label: string): Parcel {
  return { id: 'p1', revision, label };
}

/** Wait for a read the store starts from a promise callback rather than inline. */
async function untilRead(store: TestStore, index: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && store.reads.length <= index; attempt += 1) {
    await Promise.resolve();
  }
}

describe('AggregateStore', () => {
  let store: TestStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.runInInjectionContext(() => new TestStore());
  });

  it('starts idle, holding nothing and claiming nothing', () => {
    expect(store.status()).toBe('idle');
    expect(store.value()).toBeNull();
    expect(store.failure()).toBeNull();
    expect(store.revision()).toBeNull();
  });

  it('exposes the loaded value and the revision that came with it', async () => {
    const settled = store.refresh();
    expect(store.status()).toBe('loading');
    expect(store.isLoading()).toBe(true);

    store.settleRead(0, parcel(3, 'north quarter'));
    await settled;

    expect(store.status()).toBe('ready');
    expect(store.value()).toEqual(parcel(3, 'north quarter'));
    expect(store.revision()).toBe(3);
    expect(store.failure()).toBeNull();
  });

  it('reports a failed read without pretending the aggregate is empty', async () => {
    await store.seed(parcel(1, 'first'));

    const settled = store.refresh();
    store.failRead(1, new Error('network is down'));
    await settled;

    expect(store.status()).toBe('error');
    expect(store.failure()?.message).toBe('network is down');
    // The previous value survives: blanking the screen on a transient failure
    // loses the user's context and tells them nothing they did not already see
    // from the error.
    expect(store.value()).toEqual(parcel(1, 'first'));
  });

  // The bug this kills is silent and intermittent: two reads in flight, the
  // older one answers last, and the screen goes backwards with nothing logged.
  it('discards a read that was superseded before it answered', async () => {
    const first = store.refresh();
    const second = store.refresh();

    store.settleRead(1, parcel(5, 'current'));
    store.settleRead(0, parcel(4, 'stale'));
    await Promise.all([first, second]);

    expect(store.value()).toEqual(parcel(5, 'current'));
    expect(store.status()).toBe('ready');
  });

  it('discards a superseded read even when it fails', async () => {
    const first = store.refresh();
    const second = store.refresh();

    store.settleRead(1, parcel(5, 'current'));
    store.failRead(0, new Error('stale request timed out'));
    await Promise.all([first, second]);

    expect(store.status()).toBe('ready');
    expect(store.failure()).toBeNull();
    expect(store.value()).toEqual(parcel(5, 'current'));
  });

  // Revision is the optimistic-concurrency token (plan/03 section 4). A value
  // carrying an older one is by definition a view of the past.
  it('refuses to adopt a value whose revision is behind the one held', async () => {
    await store.seed(parcel(7, 'current'));

    store.adoptValue(parcel(6, 'older'));

    expect(store.value()).toEqual(parcel(7, 'current'));
  });

  it('adopts a value whose revision has moved forward', async () => {
    await store.seed(parcel(7, 'current'));

    store.adoptValue(parcel(8, 'newer'));

    expect(store.value()).toEqual(parcel(8, 'newer'));
  });

  it('marks itself saving for the duration of a write and returns its result', async () => {
    await store.seed(parcel(1, 'first'));

    const pending = new Deferred<string>();
    const outcome = store.runWrite(() => pending.promise);
    expect(store.isSaving()).toBe(true);

    pending.resolve('saved');
    const result = await outcome;

    expect(store.isSaving()).toBe(false);
    expect(result).toEqual({ ok: true, result: 'saved' });
    expect(store.failure()).toBeNull();
  });

  // "The client holds a prediction; the server holds the truth. If they
  // disagree the server wins and the client refetches." A conflict is the one
  // failure the store answers by going back to the server rather than by
  // reporting and stopping.
  it('refetches after a conflict rather than keeping what it predicted', async () => {
    await store.seed(parcel(1, 'first'));
    expect(store.loadCalls).toBe(1);

    const outcome = store.runWrite(() => Promise.reject(conflict()));
    // The refetch is started from the rejection handler, so it does not exist
    // until the microtask queue has turned over.
    await untilRead(store, 1);
    store.settleRead(1, parcel(2, 'what the server actually holds'));
    const result = await outcome;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.conflicted).toBe(true);
    expect(store.loadCalls).toBe(2);
    expect(store.value()).toEqual(parcel(2, 'what the server actually holds'));
  });

  it('does not refetch after a failure that is not a conflict', async () => {
    await store.seed(parcel(1, 'first'));

    const result = await store.runWrite(() => Promise.reject(new Error('validation failed')));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.conflicted).toBe(false);
    expect(store.loadCalls).toBe(1);
    expect(store.failure()?.message).toBe('validation failed');
  });
});

/** The shape core/api reports a 409 as. Built by hand so this file needs no HTTP. */
function conflict(): unknown {
  return {
    ok: false,
    status: 409,
    code: 'revision_conflict',
    reason: 'the application moved under you',
    blockers: [],
    current: { state: 'submitted', revision: 2 },
  };
}
