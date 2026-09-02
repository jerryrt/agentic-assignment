import {
  createEnvironmentInjector,
  DestroyRef,
  EnvironmentInjector,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DatabaseClient } from '@lj/db';

import { DATABASE_CLIENT } from '../data/database-client.ts';
import { RealtimeChannelFactory } from './channel-factory.ts';

/**
 * The factory is behaviour, not layout, so it is on the TDD list (CLAUDE.md
 * section 7). What is tested here is the four properties the thing exists for,
 * because each of them fails silently if it is got wrong:
 *
 *   1. The channel is closed when the injection context is destroyed. A leaked
 *      channel holds a websocket open per navigation and nothing reports it.
 *   2. The handler is given no row payload, so a caller cannot patch a screen
 *      from data that has not been through row-level security a second time.
 *   3. An unconfigured build gets an inert watch rather than a throw.
 *   4. Closing twice is harmless, because a caller that closes early is then
 *      also destroyed.
 *
 * No websocket is opened. The client is a fake that records what it was asked
 * for and delivers changes on demand, which is the only way to assert "exactly
 * once" at all: a real channel decides when to call back.
 */

/** The subset of the postgres_changes binding this factory sends. */
interface RecordedBinding {
  readonly event: string;
  readonly schema: string;
  readonly table?: string;
  readonly filter?: string;
}

class FakeChannel {
  readonly bindings: RecordedBinding[] = [];
  private readonly handlers: ((payload: unknown) => void)[] = [];
  subscribeCalls = 0;

  constructor(readonly topic: string) {}

  on(_type: string, binding: RecordedBinding, handler: (payload: unknown) => void): FakeChannel {
    this.bindings.push(binding);
    this.handlers.push(handler);
    return this;
  }

  subscribe(): FakeChannel {
    this.subscribeCalls += 1;
    return this;
  }

  /** Deliver one change, the way the server would, payload and all. */
  emit(): void {
    for (const handler of this.handlers) {
      handler({ eventType: 'UPDATE', new: { id: 'row-1', state: 'approved' }, old: {} });
    }
  }
}

class FakeClient {
  readonly opened: FakeChannel[] = [];
  readonly removed: FakeChannel[] = [];

  channel(topic: string): FakeChannel {
    const channel = new FakeChannel(topic);
    this.opened.push(channel);
    return channel;
  }

  removeChannel(channel: FakeChannel): Promise<string> {
    this.removed.push(channel);
    return Promise.resolve('ok');
  }

  /** The one channel this test opened, so an assertion does not index blindly. */
  onlyChannel(): FakeChannel {
    expect(this.opened).toHaveLength(1);
    return this.opened[0]!;
  }
}

/**
 * The cast is the price of a fake: DATABASE_CLIENT carries a full Supabase
 * client, and constructing one here would be constructing a websocket. The
 * factory touches exactly the three methods FakeClient and FakeChannel
 * implement, so what the cast hides is what is deliberately not exercised.
 */
function factoryFor(client: FakeClient | null): RealtimeChannelFactory {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DATABASE_CLIENT, useValue: client as unknown as DatabaseClient | null },
    ],
  });
  return TestBed.inject(RealtimeChannelFactory);
}

/** A destroyable injection context, standing in for a route-provided store. */
function childContext(): EnvironmentInjector {
  return createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
}

describe('the realtime channel factory', () => {
  it('opens one subscribed channel for the table and rows asked for', () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();

    runInInjectionContext(context, () => {
      factory.watch({ table: 'parcel', filter: 'loan_id=eq.7' }, () => undefined);
    });

    const channel = client.onlyChannel();
    expect(channel.subscribeCalls).toBe(1);
    expect(channel.bindings).toEqual([
      { event: '*', schema: 'public', table: 'parcel', filter: 'loan_id=eq.7' },
    ]);
  });

  it('watches every row of the table when no filter is given', () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();

    runInInjectionContext(context, () => {
      factory.watch({ table: 'parcel', event: 'INSERT' }, () => undefined);
    });

    expect(client.onlyChannel().bindings).toEqual([
      { event: 'INSERT', schema: 'public', table: 'parcel' },
    ]);
  });

  it('closes the channel when the injection context is destroyed', () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();

    const watch = runInInjectionContext(context, () =>
      factory.watch({ table: 'parcel' }, () => undefined),
    );

    expect(client.removed).toHaveLength(0);
    context.destroy();

    expect(client.removed).toEqual([client.onlyChannel()]);
    expect(watch.active).toBe(false);
  });

  it('calls the handler once per change, and not on subscribe', () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();
    let calls = 0;

    runInInjectionContext(context, () => {
      factory.watch({ table: 'parcel' }, () => {
        calls += 1;
      });
    });

    expect(calls).toBe(0);
    client.onlyChannel().emit();
    expect(calls).toBe(1);
    client.onlyChannel().emit();
    expect(calls).toBe(2);
  });

  // The point of the whole design: an event says "go and read it again", never
  // "here is the new row". A payload reaching the caller would be a second
  // source of truth that no policy has been applied to.
  it('hands the caller no row payload to patch from', () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();
    const seen: unknown[][] = [];

    runInInjectionContext(context, () => {
      factory.watch({ table: 'parcel' }, (...args: unknown[]) => {
        seen.push(args);
      });
    });
    client.onlyChannel().emit();

    expect(seen).toEqual([[]]);
  });

  // A handler that returns a promise is the normal case, because a store's
  // refresh() is async. Its rejection must not escape into a websocket
  // callback, where there is no call site left to report it.
  it('does not let a rejected handler escape', async () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();

    runInInjectionContext(context, () => {
      factory.watch({ table: 'parcel' }, () => Promise.reject(new Error('read failed')));
    });

    expect(() => client.onlyChannel().emit()).not.toThrow();
    await Promise.resolve();
  });

  it('is harmless to close twice, and to close before the context dies', () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();

    const watch = runInInjectionContext(context, () =>
      factory.watch({ table: 'parcel' }, () => undefined),
    );

    watch.close();
    watch.close();
    context.destroy();

    expect(client.removed).toHaveLength(1);
    expect(watch.active).toBe(false);
  });

  // Supabase keys a channel by its topic, so two watches sharing one would be
  // two subscriptions on one channel -- and closing either would close both.
  it('gives each watch its own topic', () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();

    runInInjectionContext(context, () => {
      factory.watch({ table: 'parcel' }, () => undefined);
      factory.watch({ table: 'parcel' }, () => undefined);
    });

    expect(client.opened).toHaveLength(2);
    expect(client.opened[0]!.topic).not.toBe(client.opened[1]!.topic);
    expect(client.opened[0]!.topic).toContain('parcel');
  });

  // An unconfigured build has no client (core/data/database-client.ts). Every
  // screen still has to render, so a watch there is inert rather than fatal.
  it('is inert rather than fatal when the build carried no configuration', () => {
    const factory = factoryFor(null);
    const context = childContext();

    const watch = runInInjectionContext(context, () =>
      factory.watch({ table: 'parcel' }, () => undefined),
    );

    expect(watch.active).toBe(false);
    expect(() => {
      watch.close();
      watch.close();
      context.destroy();
    }).not.toThrow();
  });

  // The store that owns the subscription may not be constructed in an
  // injection context. Taking the DestroyRef explicitly keeps that caller on
  // the same teardown path rather than pushing it to an unsubscribe it will
  // forget (the contract takeUntilDestroyed uses).
  it('accepts a DestroyRef from a caller outside an injection context', () => {
    const client = new FakeClient();
    const factory = factoryFor(client);
    const context = childContext();
    const destroyRef: DestroyRef = context.get(DestroyRef);

    // Deliberately not inside runInInjectionContext: this is the call an
    // ngOnInit makes, and it must reach the same teardown.
    factory.watch({ table: 'parcel' }, () => undefined, destroyRef);

    expect(client.opened).toHaveLength(1);
    context.destroy();
    expect(client.removed).toEqual([client.onlyChannel()]);
  });
});
