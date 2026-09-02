import { computed, DestroyRef, inject, Injectable, signal, type Signal } from '@angular/core';
import type { AppRole, LabelAudience } from '@lj/domain';
import { audienceForRole } from '@lj/domain';
import type { DatabaseClient, Profile } from '@lj/db';
import { createAnonClient, getProfile } from '@lj/db';

import { SUPABASE_CONFIG, type SupabaseConfigResult } from '../config/supabase-config.ts';

/**
 * Supabase Auth, for real: signup and login against GoTrue, a session that
 * survives a reload, and sign out. The brief fixes this and says "not stubbed"
 * (plan/07-frontend.md), and the local stack runs it offline in a container --
 * so there is no version of this that needs a cloud account to work.
 *
 * Three properties this service is responsible for, and each is a bug class if
 * it is got wrong:
 *
 *   1. **The session is restored before the first guarded render.** `whenReady`
 *      resolves once the client has read whatever the browser had; guards await
 *      it. Without that, a signed-in reload flashes the login page and then
 *      redirects, which reads to the user as having been logged out.
 *   2. **The role comes from `profile`, not from the token.** The signup
 *      trigger in supabase/migrations/0001_init.sql refuses a role supplied in
 *      the client's metadata, so the profile row is the only statement of it
 *      the user did not write. Reading it back under RLS is what makes it
 *      trustworthy enough to shape a menu -- and no more than that.
 *   3. **Nothing here logs a token.** Not on failure, not at debug level. An
 *      access token in a console is an access token in a screen recording.
 *
 * What it is NOT: an authorisation boundary. Row-level security is (CLAUDE.md
 * section 10), and `POST /api/transition` re-checks the actor's role against the
 * machine definition on every write. Everything this service exposes is for
 * drawing the right screen, never for deciding what may happen on it.
 */

/** Where the session is in its lifecycle, from the point of view of a render. */
export type AuthStatus = 'restoring' | 'signed-in' | 'signed-out' | 'unconfigured';

/** The half of a Supabase session this application uses. */
export interface AuthIdentity {
  readonly userId: string;
  readonly email: string | null;
  readonly accessToken: string;
}

/**
 * The result of an auth attempt.
 *
 * A union rather than a throw, because the failure is ordinary -- a wrong
 * password is not exceptional -- and because every call site has to render it.
 * `message` is GoTrue's, which is already written for an end user.
 */
export type AuthOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

interface AuthLikeError {
  readonly message?: unknown;
}

function messageOf(error: unknown, fallback: string): string {
  const candidate = (error ?? {}) as AuthLikeError;
  return typeof candidate.message === 'string' && candidate.message.length > 0
    ? candidate.message
    : fallback;
}

function unconfiguredMessage(result: SupabaseConfigResult): string {
  return result.ok
    ? ''
    : 'This deployment is not configured to reach Supabase: ' +
      result.missingVariable +
      ' was not set when the application was built. Nothing can sign in until it is.';
}

@Injectable({ providedIn: 'root' })
export class SupabaseAuthService {
  private readonly configResult = inject(SUPABASE_CONFIG);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Null when the build carried no configuration. The alternative -- throwing
   * from the constructor -- takes the whole application down and reports the
   * cause to a console rather than to the person looking at the blank page.
   */
  private readonly client: DatabaseClient | null;

  private readonly currentIdentity = signal<AuthIdentity | null>(null);
  private readonly currentProfile = signal<Profile | null>(null);
  private readonly currentStatus = signal<AuthStatus>('restoring');

  /** Resolves once the first session read has completed, successfully or not. */
  private readonly restored: Promise<void>;

  readonly identity: Signal<AuthIdentity | null> = this.currentIdentity.asReadonly();
  readonly profile: Signal<Profile | null> = this.currentProfile.asReadonly();
  readonly status: Signal<AuthStatus> = this.currentStatus.asReadonly();

  readonly isSignedIn: Signal<boolean> = computed(() => this.currentStatus() === 'signed-in');

  /**
   * The signed-in user's role, or null while it is unknown.
   *
   * Null and 'borrower' are deliberately different answers: defaulting an
   * unknown role to the least-privileged one would hide the difference between
   * "we have not read the profile yet" and "this person is a borrower", and the
   * role guard has to be able to tell them apart.
   */
  readonly role: Signal<AppRole | null> = computed(() => this.currentProfile()?.role ?? null);

  /** Which of the two state vocabularies this user reads (plan/02-domain-model.md). */
  readonly audience: Signal<LabelAudience> = computed(() => {
    const role = this.role();
    return role === null ? 'borrower' : audienceForRole(role);
  });

  readonly displayName: Signal<string> = computed(
    () => this.currentProfile()?.full_name ?? this.currentIdentity()?.email ?? 'Signed in',
  );

  /** Set when the build was not configured; rendered by the sign-in screen. */
  readonly configurationError: string | null;

  constructor() {
    this.configurationError = this.configResult.ok ? null : unconfiguredMessage(this.configResult);
    this.client = this.configResult.ok ? createAnonClient(this.configResult.config) : null;

    if (this.client === null) {
      this.currentStatus.set('unconfigured');
      this.restored = Promise.resolve();
      return;
    }

    // The client persists and refreshes the session itself (see @lj/db's
    // client.ts), so restoring is a read of what it already loaded rather than
    // a second implementation of session storage.
    this.restored = this.adoptSession();

    const subscription = this.client.auth.onAuthStateChange(() => {
      void this.adoptSession();
    });
    this.destroyRef.onDestroy(() => {
      subscription.data.subscription.unsubscribe();
    });
  }

  /**
   * Await the first session read.
   *
   * Guards call this before deciding, which is what removes the login flash on
   * a reload: the router waits a few milliseconds rather than rendering the
   * signed-out branch and correcting itself.
   */
  whenReady(): Promise<void> {
    return this.restored;
  }

  async signIn(email: string, password: string): Promise<AuthOutcome> {
    const client = this.client;
    if (client === null) {
      return { ok: false, message: this.configurationError ?? 'Authentication is unavailable.' };
    }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error !== null) {
      return { ok: false, message: messageOf(error, 'Could not sign in.') };
    }
    await this.adoptSession();
    return { ok: true };
  }

  /**
   * Create an account.
   *
   * `full_name` travels in the user metadata because that is the only channel a
   * signup has, and the trigger copies it into `profile`. `role` deliberately
   * does not: the trigger ignores a client-supplied role and writes 'borrower',
   * so sending one would be a request the database is right to refuse and a
   * misleading line of code here.
   */
  async signUp(email: string, password: string, fullName: string): Promise<AuthOutcome> {
    const client = this.client;
    if (client === null) {
      return { ok: false, message: this.configurationError ?? 'Authentication is unavailable.' };
    }
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error !== null) {
      return { ok: false, message: messageOf(error, 'Could not create the account.') };
    }
    // A project with email confirmation enabled answers a successful signup with
    // a user and no session: the account exists but cannot sign in until the
    // address is confirmed. Reporting that as success is what made the deployed
    // site accept a registration and then refuse the very credentials it had
    // just been given, with nothing said in between.
    if (data.session === null) {
      return {
        ok: false,
        message:
          'The account was created but needs its email address confirmed before it can sign in, ' +
          'and this demo has no mail service to confirm through. Use one of the demo accounts instead.',
      };
    }
    await this.adoptSession();
    return { ok: true };
  }

  async signOut(): Promise<void> {
    const client = this.client;
    if (client === null) {
      return;
    }
    await client.auth.signOut();
    await this.adoptSession();
  }

  /**
   * The access token for a call to `/api`, or null when there is none.
   *
   * Returned rather than stored anywhere of ours: the client refreshes it, so a
   * copy held in a field is a token that expires without telling anyone.
   */
  accessToken(): string | null {
    return this.currentIdentity()?.accessToken ?? null;
  }

  private async adoptSession(): Promise<void> {
    const client = this.client;
    if (client === null) {
      return;
    }
    const { data } = await client.auth.getSession();
    const session = data.session;

    if (session === null) {
      this.currentIdentity.set(null);
      this.currentProfile.set(null);
      this.currentStatus.set('signed-out');
      return;
    }

    this.currentIdentity.set({
      userId: session.user.id,
      email: session.user.email ?? null,
      accessToken: session.access_token,
    });
    this.currentStatus.set('signed-in');
    await this.loadProfile(client, session.user.id);
  }

  /**
   * Read the profile row under row-level security.
   *
   * A failure here is not a failure to sign in: the session is real either way,
   * and treating an unreadable profile as a signed-out user would log someone
   * out because of a transient network error. The role stays null, which the
   * role guard treats as "not this role" -- refusing rather than assuming.
   */
  private async loadProfile(client: DatabaseClient, userId: string): Promise<void> {
    try {
      this.currentProfile.set(await getProfile(client, userId));
    } catch {
      this.currentProfile.set(null);
    }
  }
}
