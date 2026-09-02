import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import type { AppRole } from '@lj/domain';

import { authGuard, roleGuard, signedOutOnlyGuard } from './auth.guards.ts';
import { SupabaseAuthService, type AuthStatus } from './auth.service.ts';

/**
 * Guards shape navigation; they do not enforce anything (see the header of
 * auth.guards.ts). What is being tested here is therefore navigation: where
 * someone lands, and whether the destination they asked for survives the
 * detour. Getting the second one wrong is how a deep link silently becomes a
 * dashboard after login.
 */

interface FakeAuth {
  status: ReturnType<typeof signal<AuthStatus>>;
  role: ReturnType<typeof signal<AppRole | null>>;
  readyCalls: number;
}

function routeAt(url: string): { route: ActivatedRouteSnapshot; state: RouterStateSnapshot } {
  return {
    route: {} as unknown as ActivatedRouteSnapshot,
    state: { url } as unknown as RouterStateSnapshot,
  };
}

describe('the navigation guards', () => {
  let fake: FakeAuth;

  beforeEach(() => {
    const status = signal<AuthStatus>('signed-out');
    const role = signal<AppRole | null>(null);
    fake = { status, role, readyCalls: 0 };

    const stub = {
      status,
      role,
      isSignedIn: () => status() === 'signed-in',
      whenReady: () => {
        fake.readyCalls += 1;
        return Promise.resolve();
      },
    };

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SupabaseAuthService, useValue: stub },
      ],
    });
  });

  // `CanActivateFn` is declared over the whole GuardResult union, so a call
  // site sees a type far wider than these guards ever return. Narrowing here
  // keeps the assertions readable without weakening the guards' own signatures.
  function urlOf(result: unknown): string {
    if (!(result instanceof UrlTree)) {
      throw new Error('expected a redirect, got ' + String(result));
    }
    return TestBed.inject(Router).serializeUrl(result);
  }

  describe('authGuard', () => {
    it('waits for the session to be restored before deciding', async () => {
      fake.status.set('signed-in');
      const { route, state } = routeAt('/');

      await TestBed.runInInjectionContext(() => authGuard(route, state));

      // Without this the guard decides against a session that has not been read
      // yet, and a reload flashes the login page before correcting itself.
      expect(fake.readyCalls).toBe(1);
    });

    it('admits a signed-in visitor', async () => {
      fake.status.set('signed-in');
      const { route, state } = routeAt('/');

      const result = await TestBed.runInInjectionContext(() => authGuard(route, state));

      expect(result).toBe(true);
    });

    it('sends a signed-out visitor to sign in, remembering where they were going', async () => {
      const { route, state } = routeAt('/lender/queue');

      const result = await TestBed.runInInjectionContext(() => authGuard(route, state));

      expect(urlOf(result)).toBe('/signin?next=%2Flender%2Fqueue');
    });
  });

  describe('roleGuard', () => {
    it('admits the role it names', async () => {
      fake.status.set('signed-in');
      fake.role.set('lender');
      const { route, state } = routeAt('/lender/queue');

      const result = await TestBed.runInInjectionContext(() => roleGuard('lender')(route, state));

      expect(result).toBe(true);
    });

    // A borrower who reaches a lender URL is not an attacker, they are lost.
    // Sending them home is the useful answer; row-level security is what makes
    // it safe to be this forgiving.
    it('sends a signed-in visitor with the wrong role to their own root', async () => {
      fake.status.set('signed-in');
      fake.role.set('borrower');
      const { route, state } = routeAt('/lender/queue');

      const result = await TestBed.runInInjectionContext(() => roleGuard('lender')(route, state));

      expect(urlOf(result)).toBe('/');
    });

    it('refuses when the role is not known yet rather than assuming one', async () => {
      fake.status.set('signed-in');
      fake.role.set(null);
      const { route, state } = routeAt('/lender/queue');

      const result = await TestBed.runInInjectionContext(() => roleGuard('lender')(route, state));

      expect(urlOf(result)).toBe('/');
    });

    it('sends a signed-out visitor to sign in, not to a role they do not have', async () => {
      const { route, state } = routeAt('/lender/queue');

      const result = await TestBed.runInInjectionContext(() => roleGuard('lender')(route, state));

      expect(urlOf(result)).toBe('/signin?next=%2Flender%2Fqueue');
    });

    it('admits any of several named roles', async () => {
      fake.status.set('signed-in');
      fake.role.set('admin');
      const { route, state } = routeAt('/lender/queue');

      const result = await TestBed.runInInjectionContext(() =>
        roleGuard('lender', 'admin')(route, state),
      );

      expect(result).toBe(true);
    });
  });

  describe('signedOutOnlyGuard', () => {
    it('admits a signed-out visitor to the sign-in screen', async () => {
      const { route, state } = routeAt('/signin');

      const result = await TestBed.runInInjectionContext(() => signedOutOnlyGuard(route, state));

      expect(result).toBe(true);
    });

    it('bounces a signed-in visitor away from it', async () => {
      fake.status.set('signed-in');
      const { route, state } = routeAt('/signin');

      const result = await TestBed.runInInjectionContext(() => signedOutOnlyGuard(route, state));

      expect(urlOf(result)).toBe('/');
    });
  });
});
