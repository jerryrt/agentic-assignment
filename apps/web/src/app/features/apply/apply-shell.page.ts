import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { APPLICATION_STEPS, applicationStepIndex, type ApplicationStep } from '@lj/domain';
import { LjStateBadge } from '@lj/ui';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { ApplicationStore } from './application.store.ts';
import { LjEligibilityPanel } from './ui/eligibility-panel.ts';

/**
 * The frame the four steps render inside: the stepper, the panel, and the
 * three things that are true of the whole application rather than of one step.
 *
 * `ApplicationStore` is provided on the route rather than here, so it is one
 * instance shared with the step components and with the route guard, and it
 * dies when the applicant leaves this application (plan/07).
 *
 * The recovery banner is the visible half of the seatbelt (./draft.ts). It
 * appears only when the browser held edits the server never received, and it
 * offers both directions: keeping them is the default because they are the
 * applicant's most recent work, and discarding is one click because the other
 * case -- a stale tab restored over a good copy -- is the one that would cost
 * them something.
 */
@Component({
  selector: 'lj-apply-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LjStateBadge, LjEligibilityPanel],
  template: `
    <div class="lj-page apply">
      @if (store.isLoading() && store.value() === null) {
        <p class="apply__notice" role="status">Reading your application...</p>
      } @else if (store.failure(); as failure) {
        <div class="apply__notice apply__notice--error" role="alert">
          <h1>This application could not be opened</h1>
          <p>{{ failure.message }}</p>
          <a class="lj-button" routerLink="/apply">Back to your applications</a>
        </div>
      } @else if (store.value(); as application) {
        <header class="apply__header">
          <div class="apply__title">
            <h1>Your application</h1>
            <lj-state-badge
              [subject]="{ machine: 'application', state: application.state }"
              [audience]="auth.audience()"
            />
            <span class="apply__saved" data-testid="save-state">{{ savedState() }}</span>
          </div>

          <nav class="stepper" aria-label="Application steps">
            <ol class="stepper__list">
              @for (step of steps; track step.step; let index = $index) {
                <li class="stepper__item">
                  @if (step.reachable()) {
                    <a
                      [routerLink]="['/apply', application.id, step.step]"
                      routerLinkActive="is-current"
                      [attr.data-answered]="step.answered() ? '' : null"
                    >
                      <span class="stepper__index" aria-hidden="true">{{ index + 1 }}</span>
                      {{ step.label }}
                      @if (step.answered()) {
                        <span class="sr-only">(answered)</span>
                      }
                    </a>
                  } @else {
                    <span class="stepper__locked">
                      <span class="stepper__index" aria-hidden="true">{{ index + 1 }}</span>
                      {{ step.label }}
                      <span class="sr-only">(not reached yet)</span>
                    </span>
                  }
                </li>
              }
            </ol>
          </nav>
        </header>

        @if (store.recoveredDraft(); as recovered) {
          <div class="apply__notice apply__notice--recovered" role="alert" data-testid="recovered">
            <p>
              This browser had changes that never reached the server, last kept at
              {{ recovered.savedAt }}. They have been put back into the form and will be
              saved as you continue.
            </p>
            <button
              class="lj-button lj-button--quiet"
              type="button"
              (click)="store.discardRecoveredDraft()"
              data-testid="discard-recovered"
            >
              Discard them and use the saved copy
            </button>
          </div>
        }

        <div class="apply__body">
          <div class="apply__form">
            <router-outlet />
          </div>
          <lj-eligibility-panel class="apply__panel" />
        </div>
      }
    </div>
  `,
  styles: `
    .apply {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .apply__header {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .apply__title {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .apply__title h1 {
      margin: 0;
    }

    .apply__saved {
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    .apply__notice {
      margin: 0;
      padding: 16px;
      border: 1px solid var(--lj-border);
      border-radius: 8px;
      background: var(--lj-surface);
    }

    .apply__notice--error {
      border-color: var(--lj-err);
    }

    .apply__notice--recovered {
      border-color: var(--lj-warn);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .apply__notice p {
      margin: 0;
    }

    /* The panel sits beside the form on a wide screen and above it on a narrow
       one, where sticky positioning would cover the fields it is about. */
    .apply__body {
      display: grid;
      gap: 24px;
      grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
      align-items: start;
    }

    @media (max-width: 900px) {
      .apply__body {
        grid-template-columns: 1fr;
      }

      .apply__panel {
        order: -1;
      }
    }

    .stepper__list {
      display: flex;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
      flex-wrap: wrap;
    }

    .stepper__item a,
    .stepper__locked {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid var(--lj-border);
      border-radius: 999px;
      text-decoration: none;
      color: var(--lj-text);
    }

    .stepper__locked {
      color: var(--lj-muted);
      border-style: dashed;
    }

    .stepper__item a.is-current {
      border-color: var(--lj-primary);
      border-width: 2px;
      font-weight: 600;
    }

    /* An answered step is marked by its number turning into a tick as well as
       by the tint, because colour is never the only cue. */
    .stepper__item a[data-answered] .stepper__index {
      background: var(--lj-ok-subtle);
      color: var(--lj-ok);
    }

    .stepper__index {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      background: var(--lj-bg);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
  `,
})
export class ApplyShellPage {
  /** Bound from `/apply/:id` by withComponentInputBinding(). */
  readonly id = input.required<string>();

  protected readonly store = inject(ApplicationStore);
  protected readonly auth = inject(SupabaseAuthService);

  protected readonly steps = APPLICATION_STEPS.map((step) => ({
    step,
    label: STEP_LABELS[step],
    answered: computed(() => this.store.stepIsAnswered(step)),
    reachable: computed(
      () => applicationStepIndex(step) <= applicationStepIndex(this.store.furthestStep()),
    ),
  }));

  protected readonly savedState = computed(() => {
    if (this.store.isSaving()) {
      return 'Saving...';
    }
    return this.store.form.dirty ? 'Unsaved changes' : 'Saved';
  });

  constructor() {
    // The one effect in this feature, and it is I/O: opening an application
    // when the route says which one. The route guard opens it too, and `open`
    // is written to be safe to call twice for exactly that reason -- but a
    // component that relied on a guard having run would break the moment the
    // guard was reordered.
    effect(() => {
      void this.store.open(this.id());
    });
  }
}

const STEP_LABELS: { readonly [K in ApplicationStep]: string } = {
  borrower: 'Business',
  farm: 'Farm',
  financials: 'Financials',
  request: 'Request',
};
