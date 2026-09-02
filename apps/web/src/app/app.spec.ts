import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AppRole, LabelAudience } from '@lj/domain';

import { App } from './app.ts';
import { routes } from './app.routes.ts';
import { SupabaseAuthService, type AuthStatus } from './core/auth/auth.service.ts';

/**
 * The shell renders no data of its own, so what is worth asserting is the
 * frame: does the outlet exist, does the menu follow the role, and is the
 * identity of whoever is signed in actually on screen.
 *
 * The role-dependent menu is the one with a real failure mode. Getting it
 * wrong offers a borrower a lender link that will bounce them, which reads as a
 * broken application rather than as a permission they do not have.
 */
describe('App', () => {
  function configure(options: {
    status: AuthStatus;
    role: AppRole | null;
    displayName?: string;
  }): { signOutCalls: number } {
    const status = signal<AuthStatus>(options.status);
    const role = signal<AppRole | null>(options.role);
    const calls = { signOutCalls: 0 };

    const stub = {
      status,
      role,
      isSignedIn: () => status() === 'signed-in',
      displayName: () => options.displayName ?? 'Someone',
      audience: (): LabelAudience => (role() === 'borrower' || role() === null ? 'borrower' : 'lender'),
      whenReady: () => Promise.resolve(),
      signOut: async () => {
        calls.signOutCalls += 1;
        status.set('signed-out');
        role.set(null);
        await Promise.resolve();
      },
    };

    TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), { provide: SupabaseAuthService, useValue: stub }],
    });

    return calls;
  }

  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  // The shell renders nothing of its own: every screen arrives through the
  // router. Asserting the outlet exists is what catches a bootstrap that
  // compiles but routes nowhere, which no typecheck would report.
  it('renders a router outlet for features to fill', async () => {
    configure({ status: 'signed-out', role: null });
    const compiled = await render();

    expect(compiled.querySelector('router-outlet')).not.toBeNull();
  });

  it('offers a way in when nobody is signed in, and no identity', async () => {
    configure({ status: 'signed-out', role: null });
    const compiled = await render();

    expect(compiled.querySelector('[data-testid="sign-in-link"]')).not.toBeNull();
    expect(compiled.querySelector('[data-testid="sign-out"]')).toBeNull();
    expect(compiled.querySelector('[data-testid="signed-in-as"]')).toBeNull();
  });

  it('shows who is signed in, and their role', async () => {
    configure({ status: 'signed-in', role: 'lender', displayName: 'Dale Hutchins' });
    const compiled = await render();

    expect(compiled.querySelector('[data-testid="signed-in-as"]')?.textContent).toContain(
      'Dale Hutchins',
    );
    expect(compiled.querySelector('[data-testid="signed-in-role"]')?.textContent).toContain(
      'lender',
    );
  });

  it('offers a borrower the borrower root and not the lending desk', async () => {
    configure({ status: 'signed-in', role: 'borrower' });
    const compiled = await render();

    const labels = navigationLabels(compiled);
    expect(labels).toContain('Dashboard');
    expect(labels).not.toContain('Lending desk');
  });

  it('offers a lender the lending desk', async () => {
    configure({ status: 'signed-in', role: 'lender' });
    const compiled = await render();

    expect(navigationLabels(compiled)).toContain('Lending desk');
  });

  // An admin reads the lender vocabulary (packages/domain, labels.ts), so it
  // gets the lender menu rather than a third one nobody maintains.
  it('gives an admin the lender side rather than a menu of its own', async () => {
    configure({ status: 'signed-in', role: 'admin' });
    const compiled = await render();

    expect(navigationLabels(compiled)).toEqual(['Lending desk']);
  });

  it('signs out through the service rather than clearing storage itself', async () => {
    const calls = configure({ status: 'signed-in', role: 'borrower' });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    const button = compiled.querySelector<HTMLButtonElement>('[data-testid="sign-out"]');
    button?.click();
    await fixture.whenStable();

    expect(calls.signOutCalls).toBe(1);
    expect(compiled.querySelector('[data-testid="sign-out"]')).toBeNull();
  });
});

function navigationLabels(compiled: HTMLElement): string[] {
  return Array.from(compiled.querySelectorAll('.shell-nav a')).map((link) =>
    (link.textContent ?? '').trim(),
  );
}
