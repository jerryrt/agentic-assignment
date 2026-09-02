import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { AppRole } from '@lj/domain';

import { SupabaseAuthService } from './auth.service.ts';
import { SignUpPage } from './sign-up.page.ts';

/**
 * The sign-up screen carries one validator the sign-in screen does not -- a
 * password length floor -- and a comment claiming it "keeps the message in
 * front of the user". It did not: nothing rendered it, so the submit was
 * refused in silence. That is what this file pins.
 */
async function render(): Promise<{
  element: HTMLElement;
  detect: () => Promise<void>;
  signUp: ReturnType<typeof vi.fn>;
}> {
  const signUp = vi.fn().mockResolvedValue({ ok: true });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: SupabaseAuthService,
        useValue: { signUp, role: signal<AppRole | null>('borrower'), configurationError: null },
      },
    ],
  });
  vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

  const fixture = TestBed.createComponent(SignUpPage);
  fixture.detectChanges();
  return {
    element: fixture.nativeElement as HTMLElement,
    detect: async () => {
      await Promise.resolve();
      fixture.detectChanges();
    },
    signUp,
  };
}

function input(element: HTMLElement, testId: string): HTMLInputElement {
  const found = element.querySelector<HTMLInputElement>('[data-testid="' + testId + '"]');
  if (found === null) {
    throw new Error('no control marked ' + testId);
  }
  return found;
}

function type(control: HTMLInputElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event('input'));
}

function problemFor(element: HTMLElement, control: HTMLInputElement): string | null {
  const id = control.getAttribute('aria-describedby');
  return id === null ? null : (element.querySelector('#' + id)?.textContent?.trim() ?? null);
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('the sign-up form', () => {
  it('states the password length floor instead of refusing in silence', async () => {
    const { element, detect, signUp } = await render();
    type(input(element, 'full-name'), 'Ada Fenwick');
    type(input(element, 'email'), 'ada@example.test');
    type(input(element, 'password'), 'short');
    await detect();

    element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await detect();

    const password = input(element, 'password');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(problemFor(element, password)).toBe('Use at least 6 characters.');
    expect(signUp).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(password);
  });

  it('names each unanswered field rather than only refusing', async () => {
    const { element, detect } = await render();
    element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await detect();

    expect(problemFor(element, input(element, 'full-name'))).toBe('Enter your full name.');
    expect(problemFor(element, input(element, 'email'))).toBe('Enter your email.');
    expect(document.activeElement).toBe(input(element, 'full-name'));
  });

  // The screen's own warning is the reason anyone reads it: registration works
  // and cannot then sign in, because the deployed project confirms addresses
  // and has no mail service.
  it('still warns that a new account could never sign in', async () => {
    const { element } = await render();
    expect(element.querySelector('[data-testid="registration-closed"]')?.textContent).toContain(
      'demo account',
    );
  });
});
