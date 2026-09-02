import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { RouterLink } from '@angular/router';

import { LjAuthField } from './auth-field.ts';
import { roleHomePath, RETURN_TO_PARAM } from './auth.guards.ts';
import { SupabaseAuthService } from './auth.service.ts';

/**
 * Sign in.
 *
 * The component renders and dispatches; it decides nothing (CLAUDE.md section
 * 8). Whether the credentials are good is GoTrue's answer, where the session
 * goes afterwards is `roleHomePath`'s, and both arrive here already decided.
 *
 * The `next` query parameter is honoured so a deep link survives the detour
 * through this screen. It is deliberately treated as a path and handed to the
 * router, which will refuse anything that is not one -- an absolute URL in that
 * parameter is an open redirect, and this is where one would be introduced.
 *
 * A submit that cannot proceed says why, per field, and moves the caret to the
 * first field at fault (issue #36). It used to do neither: the form marked
 * itself touched and returned, which to a sighted user was a button that did
 * nothing and to a screen reader user was silence.
 */
@Component({
  selector: 'lj-sign-in-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, LjAuthField],
  template: `
    <div class="lj-page" style="max-width: 420px">
      <h1>Sign in</h1>

      @if (auth.configurationError; as configurationError) {
        <p class="lj-notice lj-notice--warn" data-testid="configuration-error">
          {{ configurationError }}
        </p>
      }

      <form class="lj-card" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        @if (failure(); as message) {
          <p class="lj-notice lj-notice--error" role="alert" data-testid="sign-in-error">
            {{ message }}
          </p>
        }

        <lj-auth-field
          [field]="form.controls.email"
          label="Email"
          type="email"
          name="email"
          autocomplete="email"
          testId="email"
        />

        <lj-auth-field
          [field]="form.controls.password"
          label="Password"
          type="password"
          name="password"
          autocomplete="current-password"
          testId="password"
        />

        <button class="lj-button" type="submit" [disabled]="busy()" data-testid="submit">
          {{ busy() ? 'Signing in...' : 'Sign in' }}
        </button>
      </form>

      <p>No account yet? <a routerLink="/signup">Create one</a>.</p>
    </div>
  `,
})
export class SignInPage {
  protected readonly auth = inject(SupabaseAuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);

  private readonly fields = viewChildren(LjAuthField);

  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly form = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.busy()) {
      this.reportProblems();
      return;
    }

    this.busy.set(true);
    this.failure.set(null);
    try {
      const { email, password } = this.form.getRawValue();
      const outcome = await this.auth.signIn(email, password);
      if (!outcome.ok) {
        this.failure.set(outcome.message);
        return;
      }
      await this.router.navigateByUrl(this.destination());
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Show every unanswered field, and put the caret in the first of them.
   *
   * Marking the form touched is what makes the messages render; moving the
   * focus is what makes them findable. A keyboard user has no other way to
   * reach the control at fault, and a screen reader announces the field it
   * lands on -- so the two together are the difference between a form that
   * refuses and one that says why.
   */
  private reportProblems(): void {
    this.form.markAllAsTouched();
    // After markAllAsTouched, so the fields have recomputed by the time the
    // first one at fault is looked for.
    this.fields().find((field) => field.isAtFault())?.focus();
  }

  /**
   * Where to land after signing in.
   *
   * A `next` that is not a same-origin path is discarded rather than repaired:
   * `navigateByUrl` on an absolute URL is how an open redirect gets built, and
   * the safe fallback (the role's own root) is never wrong, only less specific.
   */
  private destination(): string {
    const requested = this.route.snapshot.queryParamMap.get(RETURN_TO_PARAM);
    if (requested !== null && requested.startsWith('/') && !requested.startsWith('//')) {
      return requested;
    }
    return roleHomePath(this.auth.role());
  }
}
