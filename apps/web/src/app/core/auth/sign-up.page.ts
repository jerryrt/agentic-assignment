import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { LjAuthField } from './auth-field.ts';
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
  imports: [ReactiveFormsModule, RouterLink, LjAuthField],
  template: `
    <div class="lj-page" style="max-width: 420px">
      <h1>Create an account</h1>

      <!--
        Registration is open in code and closed in practice. The deployed project
        requires an email confirmation and has no mail service to send one, so a
        new account is created and can never sign in. Saying that here is cheaper
        than letting someone find out by being refused their own password.
      -->
      <p class="lj-notice lj-notice--warn" data-testid="registration-closed">
        Registration is not open in this demo. An account can be created, but the
        deployed project confirms addresses by email and has no mail service, so
        it could never sign in. Use a demo account on the
        <a routerLink="/signin">sign in</a> page instead.
      </p>

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

        <lj-auth-field
          [field]="form.controls.fullName"
          label="Full name"
          name="fullName"
          autocomplete="name"
          testId="full-name"
        />

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
          autocomplete="new-password"
          testId="password"
        />

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

  private readonly fields = viewChildren(LjAuthField);

  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly form = this.formBuilder.nonNullable.group({
    fullName: ['', [Validators.required]],
    email: ['', [Validators.required, Validators.email]],
    // The floor GoTrue itself enforces, checked here so the answer arrives
    // beside the field rather than as a server error after a round trip.
    // <lj-auth-field> is what puts it in front of anyone: before it, this
    // validator refused the submit and said nothing.
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.busy()) {
      this.reportProblems();
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

  /**
   * Show every unanswered field, and put the caret in the first of them.
   *
   * Marking the form touched is what makes the messages render; moving the
   * focus is what makes them findable. A keyboard user has no other way to
   * reach the control at fault.
   */
  private reportProblems(): void {
    this.form.markAllAsTouched();
    this.fields().find((field) => field.isAtFault())?.focus();
  }
}
