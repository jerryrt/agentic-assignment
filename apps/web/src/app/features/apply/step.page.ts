import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  APPLICATION_STEPS,
  applicationStepIndex,
  isApplicationStep,
  type ApplicationStep,
} from '@lj/domain';
import { LjRuleList } from '@lj/ui';

import { ApplicationStore } from './application.store.ts';
import { refusalToShow } from './refusal.ts';
import { BorrowerStep } from './steps/borrower-step.ts';
import { FarmStep } from './steps/farm-step.ts';
import { FinancialsStep } from './steps/financials-step.ts';
import { RequestStep } from './steps/request-step.ts';

/**
 * One step, and the navigation out of it.
 *
 * Which step is decided by the URL, bound straight to an input by
 * `withComponentInputBinding()`. Nothing here holds a step index: the address
 * bar is the position (plan/03-workflow-engine.md section 4), so a reload lands
 * where the applicant was without a line of state restoration.
 *
 * Continue does two things and they are in this order for a reason: it records
 * that the next step has been reached, and only then navigates. A navigation
 * that beat the write would leave a reload one step behind where the applicant
 * actually is -- which is the case the resume hint exists to cover, failing at
 * the one moment it matters.
 *
 * The submit button is greyed by a PREDICTION -- `can()` from @lj/workflow, run
 * over the same machine the server runs -- and the reasons underneath it are
 * the guard's own blockers, rendered by the same `<lj-rule-list>` that draws
 * the eligibility criteria. To the applicant a refused transition and an unmet
 * criterion are the same thing, so they read the same way.
 */
@Component({
  selector: 'lj-apply-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BorrowerStep, FarmStep, FinancialsStep, RequestStep, LjRuleList],
  template: `
    <section class="step-page">
      @switch (current()) {
        @case ('borrower') {
          <lj-borrower-step />
        }
        @case ('farm') {
          <lj-farm-step />
        }
        @case ('financials') {
          <lj-financials-step />
        }
        @case ('request') {
          <lj-request-step />
        }
      }

      @if (outstanding().length > 0) {
        <p class="step-page__outstanding" data-testid="outstanding">
          Still to answer on this step: {{ outstandingLabels() }}.
        </p>
      }

      @if (submitted()) {
        <div class="step-page__submitted" role="status" data-testid="submitted">
          <h3>Your application is with your lender</h3>
          <p>Nothing more is needed from you today. You can still read it here.</p>
        </div>
      }

      @if (refusal(); as blockers) {
        @if (blockers.length > 0) {
          <div class="step-page__refusal" data-testid="submit-blockers">
            <lj-rule-list [results]="blockers" [live]="false" heading="Before this can be submitted" />
          </div>
        }
      }

      @if (failure(); as message) {
        <p class="step-page__failure" role="alert" data-testid="submit-failure">{{ message }}</p>
      }

      <nav class="step-page__nav" aria-label="Step navigation">
        @if (previous(); as back) {
          <button class="lj-button lj-button--quiet" type="button" (click)="goTo(back)">
            Back
          </button>
        } @else {
          <span></span>
        }

        @if (next(); as forward) {
          <button
            class="lj-button"
            type="button"
            [disabled]="!stepAnswered()"
            (click)="advanceTo(forward)"
            data-testid="continue"
          >
            Continue
          </button>
        } @else {
          <button
            class="lj-button"
            type="button"
            [disabled]="!canSubmit() || store.isSaving()"
            (click)="submit()"
            data-testid="submit"
          >
            Submit this application
          </button>
        }
      </nav>
    </section>
  `,
  styles: `
    .step-page {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .step-page__nav {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--lj-border);
    }

    .step-page__outstanding {
      margin: 0;
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    .step-page__failure {
      margin: 0;
      color: var(--lj-err);
    }

    .step-page__submitted {
      padding: 16px;
      border: 1px solid var(--lj-ok);
      border-radius: 8px;
      background: var(--lj-ok-subtle);
    }

    .step-page__submitted h3,
    .step-page__submitted p {
      margin: 0;
    }
  `,
})
export class ApplyStepPage {
  /** Bound from `/apply/:id/:step`. The URL is the position. */
  readonly step = input.required<string>();

  protected readonly store = inject(ApplicationStore);
  private readonly router = inject(Router);

  private readonly submitFailure = signal<string | null>(null);

  protected readonly current = computed<ApplicationStep>(() => {
    const value = this.step();
    // The guard has already redirected anything else; this is the narrowing
    // that keeps the switch exhaustive rather than a second check.
    return isApplicationStep(value) ? value : 'borrower';
  });

  protected readonly previous = computed<ApplicationStep | null>(
    () => APPLICATION_STEPS[applicationStepIndex(this.current()) - 1] ?? null,
  );

  protected readonly next = computed<ApplicationStep | null>(
    () => APPLICATION_STEPS[applicationStepIndex(this.current()) + 1] ?? null,
  );

  protected readonly outstanding = computed(() => this.store.outstanding(this.current()));

  protected readonly outstandingLabels = computed(() =>
    this.outstanding()
      .map((requirement) => requirement.label)
      .join(', '),
  );

  protected readonly stepAnswered = computed(() => this.outstanding().length === 0);

  protected readonly canSubmit = computed(() => this.store.canSubmit() && this.store.isDraft());

  protected readonly submitted = computed(() => this.store.value()?.state === 'submitted');

  /**
   * What is standing in the way, whoever said so.
   *
   * The server's answer wins when there is one: it is the decision, and the
   * client's is a prediction of it. Before a submit has been tried, the
   * prediction is all there is, and showing it is what lets someone fix the
   * problem without a round trip.
   */
  protected readonly refusal = computed(() =>
    refusalToShow({
      fromServer: this.store.serverRefusal(),
      guard: this.store.submitGuard(),
      isLastStep: this.next() === null,
    }),
  );

  protected readonly failure = computed(() => this.submitFailure());

  protected async goTo(step: ApplicationStep): Promise<void> {
    await this.router.navigate(['/apply', this.store.applicationId(), step]);
  }

  /**
   * Move forward, recording that the next step has been reached BEFORE
   * navigating.
   *
   * The other order loses the resume hint exactly when it matters: the write
   * would still be in flight as the page changed, and a reload a second later
   * would land on the step before the one the applicant is looking at.
   */
  protected async advanceTo(step: ApplicationStep): Promise<void> {
    await this.store.noteStepReached(step);
    await this.goTo(step);
  }

  protected async submit(): Promise<void> {
    this.submitFailure.set(null);
    const outcome = await this.store.submit();
    if (!outcome.ok) {
      // A refusal with blockers renders as a rule list above; this line is for
      // the failures that have nothing to show -- a network drop, a role the
      // machine does not give the transition to, a revision that moved.
      this.submitFailure.set(
        this.store.serverRefusal().length > 0 ? null : outcome.failure.message,
      );
    }
  }
}
