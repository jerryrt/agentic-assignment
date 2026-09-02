import { DestroyRef, inject, Injectable } from '@angular/core';

import { DATABASE_CLIENT } from '../data/database-client.ts';

/**
 * Postgres changes, delivered to a feature that never has to remember to
 * unsubscribe.
 *
 * `plan/07-frontend.md` puts a channel factory here and says it "cleans up on
 * destroy". This is that, and the reason it is one shared thing rather than a
 * few lines inside each feature is that the few lines are the same few lines
 * every time and each copy is a chance to forget the teardown (CLAUDE.md
 * section 9).
 *
 * Four properties, and each one is the answer to a specific failure:
 *
 *   1. **It closes itself.** The subscription is bound to the caller's
 *      `DestroyRef`, the way `core/auth/auth.service.ts` binds the auth state
 *      subscription. A feature that had to call `close()` would eventually not,
 *      and a leaked Supabase channel keeps a websocket open per navigation --
 *      a leak with no error, no log, and no failing test.
 *
 *   2. **A change means "read it again", never "here is the new row".** The
 *      handler takes no payload, deliberately: realtime is a courtesy on top of
 *      a correct read, and a row patched in from a websocket frame is a second
 *      source of truth. So the intended call is
 *      `() => this.store.refresh()` -- and it is also the only call the
 *      signature permits, which is the point. A dropped connection then costs
 *      a delay, not a wrong screen.
 *
 *   3. **Realtime is subject to row-level security, and that is not what is
 *      relied on.** Supabase delivers a change only to a subscriber allowed to
 *      read the row, which is correct and worth having -- but it is the re-read
 *      in (2) that actually enforces the policy, because that read goes back
 *      through Postgres. Treat the notification as an untrusted "something may
 *      have moved" and nothing more; then a change to the publication, or a
 *      future Supabase release, cannot turn into a data leak here.
 *
 *   4. **An unconfigured build still renders.** `DATABASE_CLIENT` is null when
 *      no Supabase configuration reached the build (`../data/database-client.ts`).
 *      A factory that threw there would take down every screen that watches a
 *      table, so a watch without a client is inert: it opens nothing, closes
 *      cleanly, and reports `active === false`.
 *
 * It knows no table names and no feature vocabulary. The caller says what it
 * wants to watch, in Postgres terms, because the caller is the only code that
 * knows.
 */

/** Which changes to receive. `'*'` is every insert, update and delete. */
export type RealtimeChangeEvent = '*' | 'INSERT' | 'UPDATE' | 'DELETE';

/** What a feature wants to hear about. */
export interface RealtimeWatchRequest {
  /** The table to watch, unqualified: 'credit_release', 'document_slot'. */
  readonly table: string;

  /**
   * Which rows, as a PostgREST filter expression -- `loan_id=eq.<uuid>`.
   *
   * Omitted means every row of the table that the subscriber may read. Prefer
   * naming the rows: it is fewer frames on the socket and fewer wasted reads,
   * though it is not a security control -- see property 3 above.
   */
  readonly filter?: string;

  /** Defaults to every change. */
  readonly event?: RealtimeChangeEvent;

  /** Defaults to 'public'. Present for completeness, not expected to be used. */
  readonly schema?: string;
}

/**
 * What the caller runs when something changed.
 *
 * No arguments, on purpose: see property 2. A promise may be returned -- a
 * store's `refresh()` is async -- and its rejection is swallowed here, because
 * the store records its own read failures and an unhandled rejection raised
 * from a websocket callback has no call site left to report to.
 */
export type RealtimeChangeHandler = () => void | Promise<void>;

/**
 * A live watch.
 *
 * Returned so a caller that genuinely needs to stop early -- a filter that
 * changed, a row that is no longer on screen -- can, not because anyone has to
 * remember to. `close()` is idempotent, so closing early and then being
 * destroyed is one close, and a double close is not an error.
 */
export interface RealtimeWatchHandle {
  /** False once closed, and false from the start when there is no client. */
  readonly active: boolean;
  close(): void;
}

/** The binding sent to Supabase. Built here rather than by the caller. */
interface PostgresChangesBinding {
  event: RealtimeChangeEvent;
  schema: string;
  table: string;
  filter?: string;
}

class OpenWatch implements RealtimeWatchHandle {
  private stopped = false;

  constructor(private readonly stop: () => void) {}

  get active(): boolean {
    return !this.stopped;
  }

  close(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.stop();
  }
}

/**
 * What an unconfigured build gets. One shared instance: it holds no state, and
 * a caller can only ask whether it is active -- which it never is -- or close
 * it, which does nothing.
 */
const INERT_WATCH: RealtimeWatchHandle = {
  active: false,
  close: (): void => {
    // Nothing was opened, so there is nothing to close.
  },
};

/**
 * Run the caller's handler, keeping a rejected promise out of the socket
 * callback. See RealtimeChangeHandler.
 */
function notify(onChange: RealtimeChangeHandler): void {
  const outcome: unknown = onChange();
  if (outcome instanceof Promise) {
    void outcome.catch(() => undefined);
  }
}

@Injectable({ providedIn: 'root' })
export class RealtimeChannelFactory {
  /** Null when the build carried no Supabase configuration. Property 4. */
  private readonly client = inject(DATABASE_CLIENT);

  /**
   * Supabase keys a channel by its topic, so two watches must never share one:
   * they would become two bindings on a single channel, and closing either
   * would close both. A counter is enough -- the topic is an identifier, not a
   * description, and nothing reads it back.
   */
  private opened = 0;

  /**
   * Watch a table, until the injection context that asked for it is destroyed.
   *
   *     private readonly realtime = inject(RealtimeChannelFactory);
   *     private readonly store = inject(CreditReleaseStore);
   *     ...
   *     this.realtime.watch(
   *       { table: 'credit_release', filter: 'loan_id=eq.' + loanId },
   *       () => this.store.refresh(),
   *     );
   *
   * Call it from a field initialiser or a constructor -- an injection context
   * -- and the `DestroyRef` is found for you. A caller outside one (an
   * `ngOnInit`, a callback) passes its own `DestroyRef` instead; that is the
   * same contract `takeUntilDestroyed` uses, and it exists so that such a
   * caller stays on the automatic teardown path rather than being pushed onto
   * a manual `close()` it will forget.
   */
  watch(
    request: RealtimeWatchRequest,
    onChange: RealtimeChangeHandler,
    destroyRef?: DestroyRef,
  ): RealtimeWatchHandle {
    const client = this.client;
    if (client === null) {
      // Before the DestroyRef is resolved, so that an unconfigured build cannot
      // fail on the injection context either. Property 4 is about the screen
      // rendering, and half of it would be no use.
      return INERT_WATCH;
    }

    const teardown = destroyRef ?? inject(DestroyRef);

    this.opened += 1;
    const topic = 'lj:' + request.table + ':' + String(this.opened);

    const binding: PostgresChangesBinding = {
      event: request.event ?? '*',
      schema: request.schema ?? 'public',
      table: request.table,
    };
    if (request.filter !== undefined) {
      binding.filter = request.filter;
    }

    const channel = client
      .channel(topic)
      .on('postgres_changes', binding, () => {
        notify(onChange);
      })
      .subscribe();

    const handle = new OpenWatch(() => {
      // removeChannel rather than channel.unsubscribe(): it also drops the
      // channel from the client's registry, which is what lets the socket
      // itself close once the last channel is gone. Unsubscribing alone leaves
      // the connection open, which is the leak this whole file is about.
      void Promise.resolve(client.removeChannel(channel)).catch(() => undefined);
    });

    teardown.onDestroy(() => {
      handle.close();
    });

    return handle;
  }
}
