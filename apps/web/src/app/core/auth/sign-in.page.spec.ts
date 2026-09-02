import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import type { AppRole } from '@lj/domain';

import { SupabaseAuthService } from './auth.service.ts';
import { SignInPage } from './sign-in.page.ts';

/**
 * What the sign-in screen says when it refuses to submit.
 *
 * The screen used to say nothing at all: `submit()` called markAllAsTouched()
 * and returned, and neither the template nor the controls carried anything the
 * touched state could drive. A sighted user saw a button that appeared not to
 * work; a screen reader user was told nothing whatsoever. These tests are that
 * defect written down, so it cannot come back quietly.
 */
interface Rendered {
  element: HTMLElement;
  detect: () => Promise<void>;
  signIn: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

async function render(options: { configurationError?: string | null } = {}): Promise<Rendered> {
  const signIn = vi.fn().mockResolvedValue({ ok: true });
  const auth = {
    signIn,
    role: signal<AppRole | null>('borrower'),
    configurationError: options.configurationError ?? null,
  };

  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: SupabaseAuthService, useValue: auth },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: { get: () => null } } },
      },
    ],
  });

  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockImplementation(navigate);

  const fixture = TestBed.createComponent(SignInPage);
  fixture.detectChanges();
  const detect = async (): Promise<void> => {
    await Promise.resolve();
    fixture.detectChanges();
  };
  return { element: fixture.nativeElement as HTMLElement, detect, signIn, navigate };
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

function describedBy(element: HTMLElement, control: HTMLInputElement): string | null {
  const id = control.getAttribute('aria-describedby');
  return id === null ? null : (element.querySelector('#' + id)?.textContent?.trim() ?? null);
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('the sign-in form', () => {
  it('labels every control, so each has an accessible name', async () => {
    const { element } = await render();
    for (const testId of ['email', 'password']) {
      const control = input(element, testId);
      const label = element.querySelector('label[for="' + control.id + '"]');
      expect(label?.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  // A form nobody has filled in is not a form full of mistakes.
  it('says nothing about a field the applicant has not visited', async () => {
    const { element } = await render();
    expect(input(element, 'email').getAttribute('aria-invalid')).toBeNull();
    expect(element.querySelectorAll('[data-testid="field-problem"]').length).toBe(0);
  });

  // The defect this file exists for. Before the fix: no message, no
  // aria-invalid, no focus move, and no call -- a button that did nothing.
  it('says what is wrong when a submit cannot proceed', async () => {
    const { element, detect, signIn } = await render();
    type(input(element, 'email'), 'not-an-address');
    type(input(element, 'password'), 'a-password');
    await detect();

    element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await detect();

    const email = input(element, 'email');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(element, email)).toContain('email address');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('says a required field is missing rather than only refusing', async () => {
    const { element, detect } = await render();
    element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await detect();

    expect(describedBy(element, input(element, 'email'))).not.toBeNull();
    expect(describedBy(element, input(element, 'password'))).not.toBeNull();
  });

  // A keyboard user has no other way to find the control at fault, and a
  // screen reader announces the field it lands on.
  it('moves focus to the first field at fault', async () => {
    const { element, detect } = await render();
    type(input(element, 'password'), 'a-password');
    await detect();

    element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await detect();

    expect(document.activeElement).toBe(input(element, 'email'));
  });

  it('clears the message once the field is corrected', async () => {
    const { element, detect } = await render();
    element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await detect();
    expect(describedBy(element, input(element, 'email'))).not.toBeNull();

    type(input(element, 'email'), 'borrower@example.test');
    await detect();

    const email = input(element, 'email');
    expect(email.getAttribute('aria-invalid')).toBeNull();
    expect(describedBy(element, email)).toBeNull();
  });

  it('signs in and leaves when the form is answered', async () => {
    const { element, detect, signIn, navigate } = await render();
    type(input(element, 'email'), 'borrower@example.test');
    type(input(element, 'password'), 'demo-only-not-a-secret');
    await detect();

    element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await detect();
    await detect();

    expect(signIn).toHaveBeenCalledWith('borrower@example.test', 'demo-only-not-a-secret');
    expect(navigate).toHaveBeenCalled();
  });

  // The server's own refusal already worked and must keep working: it is a
  // different message, in a different place, and it is announced by role=alert
  // rather than by aria-describedby.
  it('still reports the refusal the server sent', async () => {
    const { element, detect, signIn } = await render();
    signIn.mockResolvedValue({ ok: false, message: 'Invalid login credentials' });
    type(input(element, 'email'), 'borrower@example.test');
    type(input(element, 'password'), 'wrong');
    await detect();

    element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await detect();
    await detect();

    const alert = element.querySelector('[data-testid="sign-in-error"]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('Invalid login credentials');
  });
});
