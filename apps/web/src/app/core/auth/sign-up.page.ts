import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { roleHomePath } from './auth.guards.ts';
import { SupabaseAuthService } from './auth.service.ts';

/**
 * Create an account.
 *
 * Real signup against GoTrue, which the brief requires (plan/07-frontend.md).
 * The new user is a borrower and this form does not offer a choice: the trigger
 * in supabase/migrations/0001_init.sql writes `role = 'borrower'` and ignores
 * anything the client puts in its metadata, so a role selector here would be a
 * control whose value the database discards -- worse than no control, because
 * it implies otherwise. A lender account is provisioned, not self-served.
 *
 * The local stack has email confirmation off (supabase/config.toml), so signup
 * returns a session and this screen navigates straight on. Against a project
 * with confirmations on, `signUp` returns no session, `isSignedIn()` stays
 * false, and the guard on the destination sends the visitor back to sign in --
 * correct, if terse. A confirmation-pending screen is worth having the day that
 * configuration changes.
 */
@Component({
  selector: 'lj-sign-up-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="lj-page" style="max-width: 420px">
      <h1>Create an account</h1>

      @if (auth.configurationError; as configurationError) {
        <p class="lj-notice lj-notice--warn" data-testid="configuration-error">
          {{ configurationError }}
        </p>
      }

      <form class="lj-card" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        @if (failure(); as message) {
          <p class="lj-notice lj-notice--error" role="alert" data-testid="sign-up-error">
            {{ message }}
          </p>
        }

        <label class="lj-field">
          <span>Full name</span>
          <input
            type="text"
            name="fullName"
            autocomplete="name"
            formControlName="fullName"
            data-testid="full-name"
          />
        </label>

        <label class="lj-field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autocomplete="email"
            formControlName="email"
            data-testid="email"
          />
        </label>

        <label class="lj-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autocomplete="new-password"
            formControlName="password"
            data-testid="password"
          />
        </label>

        <button class="lj-button" type="submit" [disabled]="busy()" data-testid="submit">
          {{ busy() ? 'Creating...' : 'Create account' }}
        </button>
      </form>

      <p>Already have an account? <a routerLink="/signin">Sign in</a>.</p>
    </div>
  `,
})
export class SignUpPage {
  protected readonly auth = inject(SupabaseAuthService);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly form = this.formBuilder.nonNullable.group({
    fullName: ['', [Validators.required]],
    email: ['', [Validators.required, Validators.email]],
    // The floor GoTrue itself enforces. Stating it once here keeps the message
    // in front of the user instead of arriving as a server error after submit.
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.busy()) {
      this.form.markAllAsTouched();
      return;
    }

    this.busy.set(true);
    this.failure.set(null);
    try {
      const { fullName, email, password } = this.form.getRawValue();
      const outcome = await this.auth.signUp(email, password, fullName);
      if (!outcome.ok) {
        this.failure.set(outcome.message);
        return;
      }
      await this.router.navigateByUrl(roleHomePath(this.auth.role()));
    } finally {
      this.busy.set(false);
    }
  }
}
