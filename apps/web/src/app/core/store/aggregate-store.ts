import { computed, signal, type Signal } from '@angular/core';

/**
 * The base every aggregate store extends.
 *
 * `plan/07-frontend.md` puts state in three tiers and gives the middle one --
 * one store class per aggregate, provided at the *route* level rather than at
 * the root -- the job of holding server state and the writes against it.  This
 * class is that tier's shared half. A feature store extends it, says how to
 * read its aggregate, and adds the methods that write; it does not restate the
 * loading flag, the error surface, or the ordering rules below. Four features
 * restating them is four chances to get one of them subtly wrong, and the
 * wrong ones fail silently (CLAUDE.md section 9).
 *
 * What it deliberately does NOT do:
 *
 *   - It holds no derived state. Eligibility, completeness, available credit
 *     and which buttons are legal are `computed()` in the subclass, over what
 *     is held here. A value that can be derived is never stored.
 *   - It performs no I/O of its own. `load()` and the operation passed to
 *     `write()` are supplied by the subclass, which is what lets this class be
 *     tested without a network and what keeps the API client injectable.
 *   - It decides nothing about the domain. It is a holder with an ordering
 *     policy, not a rule.
 *
 * The ordering policy is the part worth reading, because it is the part that
 * is wrong in most hand-rolled stores:
 *
 *   1. **A superseded read never lands.** Two `refresh()` calls in flight and
 *      the older one answering last would otherwise move the screen backwards,
 *      intermittently, with nothing logged.
 *   2. **A value carrying an older `revision` never replaces a newer one.**
 *      `revision` is the optimistic-concurrency token of plan/03 section 4, so
 *      a lower one is by definition a view of the past.
 *   3. **A conflict is answered by refetching, not by reporting.** The client
 *      holds a prediction; the server holds the truth. When they disagree the
 *      server wins -- which means going and asking it, not keeping the local
 *      copy and showing a message beside it.
 */

/** Where a store is in its lifecycle. `error` still holds the last good value. */
export type StoreStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A failure, flattened to what a template can render.
 *
 * `code` is the API's machine-readable code (issue #13: every non-2xx has one
 * shape) when the failure came from there, and null when it came from the
 * browser -- an offline fetch, a parse error. Templates branch on `code`;
 * humans read `message`.
 */
export interface StoreFailure {
  readonly message: string;
  readonly code: string | null;
}

/**
 * The result of a write.
 *
 * A union rather than an exception, because every caller has to handle the
 * failure: a store's write is a user action, and an unhandled rejection in an
 * event handler is a button that silently does nothing. `conflicted` is
 * separated from the rest because it is the one failure the caller may want to
 * treat as "try again now" -- the store has already refetched by the time it
 * is returned.
 */
export type WriteOutcome<TResult> =
  | { readonly ok: true; readonly result: TResult }
  | { readonly ok: false; readonly failure: StoreFailure; readonly conflicted: boolean };

/**
 * The HTTP statuses and API codes that mean "you were looking at an older
 * version of this". Both spellings appear: 409 from `POST /api/transition`
 * (issue #13) and a zero-row update from a revision-matched PostgREST write
 * (`@lj/db`, issue #7).
 */
const CONFLICT_CODES: readonly string[] = ['revision_conflict', 'state_conflict'];

interface ApiFailureShape {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly reason?: unknown;
  readonly message?: unknown;
}

function asRecord(value: unknown): ApiFailureShape | null {
  return typeof value === 'object' && value !== null ? (value as ApiFailureShape) : null;
}

/**
 * True when a rejection says the caller's revision was stale.
 *
 * Written against the shape rather than against a class, so that a failure
 * reconstructed from JSON -- which is what crosses a fetch boundary -- is
 * recognised as readily as one thrown locally. Losing the class on the way
 * through JSON is exactly how a conflict silently becomes a generic error.
 */
export function isConflictFailure(reason: unknown): boolean {
  const failure = asRecord(reason);
  if (failure === null) {
    return false;
  }
  if (failure.status === 409) {
    return true;
  }
  return typeof failure.code === 'string' && CONFLICT_CODES.includes(failure.code);
}

/** Flatten anything a rejected promise can carry into something renderable. */
export function toStoreFailure(reason: unknown): StoreFailure {
  if (reason instanceof Error) {
    return { message: reason.message, code: null };
  }
  const failure = asRecord(reason);
  if (failure !== null) {
    const code = typeof failure.code === 'string' ? failure.code : null;
    const message =
      typeof failure.reason === 'string'
        ? failure.reason
        : typeof failure.message === 'string'
          ? failure.message
          : 'The request failed.';
    return { message, code };
  }
  return { message: 'The request failed.', code: null };
}

export abstract class AggregateStore<TValue> {
  private readonly currentValue = signal<TValue | null>(null);
  private readonly currentStatus = signal<StoreStatus>('idle');
  private readonly currentFailure = signal<StoreFailure | null>(null);
  private readonly writesInFlight = signal(0);

  /**
   * Which read is allowed to land. Incremented before every read; a read whose
   * token no longer matches has been superseded and is dropped, answer and
   * failure alike. A boolean "loading" flag cannot express this -- it says a
   * read is outstanding, not which one.
   */
  private readToken = 0;

  readonly value: Signal<TValue | null> = this.currentValue.asReadonly();
  readonly status: Signal<StoreStatus> = this.currentStatus.asReadonly();
  readonly failure: Signal<StoreFailure | null> = this.currentFailure.asReadonly();

  readonly isLoading: Signal<boolean> = computed(() => this.currentStatus() === 'loading');
  readonly isReady: Signal<boolean> = computed(() => this.currentStatus() === 'ready');
  readonly isSaving: Signal<boolean> = computed(() => this.writesInFlight() > 0);

  /**
   * The revision the held value carries, or null when the aggregate has none.
   * Every write that must not clobber a concurrent one sends this back.
   */
  readonly revision: Signal<number | null> = computed(() => {
    const held = this.currentValue();
    return held === null ? null : this.revisionOf(held);
  });

  /** How the subclass reads its aggregate. One call, no retries, no caching. */
  protected abstract load(): Promise<TValue>;

  /**
   * The optimistic-concurrency revision of a value.
   *
   * Defaults to null -- "this aggregate has no revision" -- rather than to 0,
   * because 0 is a revision and would make every unversioned value compare
   * equal and pass the monotonicity check by accident.
   */
  protected revisionOf(_value: TValue): number | null {
    return null;
  }

  /** Read the aggregate. Safe to call concurrently; the last call started wins. */
  async refresh(): Promise<void> {
    this.readToken += 1;
    const token = this.readToken;
    this.currentStatus.set('loading');
    this.currentFailure.set(null);

    try {
      const loaded = await this.load();
      if (token !== this.readToken) {
        return;
      }
      this.currentValue.set(loaded);
      this.currentStatus.set('ready');
    } catch (reason) {
      if (token !== this.readToken) {
        return;
      }
      this.currentFailure.set(toStoreFailure(reason));
      this.currentStatus.set('error');
    }
  }

  /**
   * Take a value the server has just confirmed -- a read, or the acknowledgement
   * of a write -- unless it is older than what is already held.
   *
   * Rejecting the older one silently is deliberate: it is not an error, it is
   * a race resolving correctly, and reporting it would train people to ignore
   * the error surface.
   */
  protected adopt(next: TValue): void {
    const held = this.currentValue();
    if (held !== null) {
      const heldRevision = this.revisionOf(held);
      const nextRevision = this.revisionOf(next);
      if (heldRevision !== null && nextRevision !== null && nextRevision < heldRevision) {
        return;
      }
    }
    this.currentValue.set(next);
    this.currentStatus.set('ready');
    this.currentFailure.set(null);
  }

  /**
   * Run a write, with the saving flag, the error surface and the conflict rule
   * applied around it.
   *
   * The operation is a callback rather than a request object because what a
   * write *is* differs per aggregate -- a PostgREST patch through `@lj/db`, a
   * `POST /api/transition` -- and the only thing common to all of them is this
   * envelope.
   */
  protected async write<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<WriteOutcome<TResult>> {
    this.writesInFlight.update((count) => count + 1);
    this.currentFailure.set(null);
    try {
      const result = await operation();
      return { ok: true, result };
    } catch (reason) {
      const failure = toStoreFailure(reason);
      this.currentFailure.set(failure);
      const conflicted = isConflictFailure(reason);
      if (conflicted) {
        // The server moved. Ask it what it holds rather than reasoning about
        // it here; `refresh()` clears the failure once it answers, so the
        // conflict does not linger on screen after it has been resolved.
        await this.refresh();
      }
      return { ok: false, failure, conflicted };
    } finally {
      this.writesInFlight.update((count) => count - 1);
    }
  }
}
