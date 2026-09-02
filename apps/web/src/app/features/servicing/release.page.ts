import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ZERO_MONEY } from '@lj/domain';
import { LjMoney, LjRuleList, LjStateBadge, LjTimeline } from '@lj/ui';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { LoanStore } from './loan.store.ts';
import { ReleaseStore } from './release.store.ts';

/**
 * One credit request, at whichever stage it is: being written, waiting, or
 * decided.
 *
 * THE URL IS THE POSITION (plan/03 section 4). `/loans/:id/release/new` is the
 * compose screen, and the moment the row exists the address bar is replaced
 * with its id -- so a refresh from that point re-reads the row rather than
 * restoring anything, and there is no client-held progress left to lose. The
 * replacement is `replaceUrl`, so Back goes to the loan rather than to a
 * compose screen for a request that now exists.
 *
 * `new` is a route PARAMETER value rather than a route of its own, and that is
 * load-bearing: a separate path would re-create this component when the URL
 * changed and throw away the sentence being typed. One route means Angular
 * reuses the instance and the form survives the navigation.
 *
 * Nothing on this screen decides anything. The rule list is
 * `evaluateCreditRelease` over the loan's balance, the submit button is
 * `can(...)` from the machine the server runs, and the state's words come from
 * @lj/domain's audience-keyed map through `<lj-state-badge>`. What the server
 * refused with, when it disagrees with the prediction, is rendered instead --
 * because the server holds the state and is therefore right.
 *
 * NOT RENDER-TESTED: an `apps/web` unit test cannot instantiate an @lj/ui
 * component (issue #33). The behaviour is on ./release.store.ts and
 * ./compose-draft.ts, both under test; the rendering, and the refresh at each
 * of plan/06's three stages, belong to the browser suite.
 */

/** The parameter value that means "a request that does not exist yet". */
export const NEW_RELEASE = 'new';

@Component({
  selector: 'lj-release-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, LjMoney, LjRuleList, LjStateBadge, LjTimeline],
  template: `
    <div class="lj-page release">
      <nav class="release__back">
        <a [routerLink]="['/loans', id()]">Back to the loan</a>
      </nav>

      @if (store.failure(); as failure) {
        <p class="lj-notice lj-notice--error" role="alert" data-testid="release-problem">
          {{ failure.message }}
        </p>
      }

      @if (store.recovered(); as recovered) {
        <div class="lj-notice lj-notice--warn" role="status" data-testid="recovered">
          <p>
            This request was recovered from this browser -- it was typed but never
            reached your lender's system. Saved {{ recovered.savedAt }}.
          </p>
          <button class="lj-button lj-button--quiet" type="button" (click)="store.discardRecovered()">
            Discard the recovered copy
          </button>
        </div>
      }

      @if (store.isDraft()) {
        <h1>Request credit</h1>
        <p class="release__lead">
          You have <lj-money [amount]="available()" /> available. What you type is kept
          as you go, so you can leave this and come back.
        </p>

        <form class="lj-card release__form" [formGroup]="store.form" (ngSubmit)="submit()">
          <label class="release__field">
            <span class="release__label">Amount</span>
            <input
              type="text"
              inputmode="decimal"
              formControlName="amount"
              autocomplete="off"
              data-testid="release-amount"
            />
          </label>

          <label class="release__field">
            <span class="release__label">What it is for</span>
            <input
              type="text"
              formControlName="purpose"
              autocomplete="off"
              data-testid="release-purpose"
            />
          </label>

          <div class="release__actions">
            <button
              class="lj-button"
              type="submit"
              [disabled]="!store.canSubmit() || store.isSaving()"
              data-testid="submit-release"
            >
              Send to your lender
            </button>
            @if (store.releaseId(); as releaseId) {
              <button
                class="lj-button lj-button--quiet"
                type="button"
                (click)="discard()"
                data-testid="discard-release"
              >
                Discard this request
              </button>
            }
          </div>
        </form>

        <lj-rule-list [results]="blockers()" heading="Before this can be sent" />
      } @else if (store.release(); as release) {
        <header class="release__header">
          <h1>Your request</h1>
          <lj-state-badge
            [subject]="{ machine: 'credit_release', state: release.state }"
            [audience]="auth.audience()"
          />
        </header>

        <section class="lj-card release__summary" aria-label="Request">
          <p class="release__amount"><lj-money [amount]="release.amount" /></p>
          <p class="release__purpose">{{ release.purpose }}</p>
          @if (release.decline_reason; as reason) {
            <p class="release__reason" data-testid="decline-reason">
              <strong>Why it was declined:</strong> {{ reason }}
            </p>
          }
        </section>

        @if (canCancel()) {
          <button
            class="lj-button lj-button--quiet"
            type="button"
            (click)="cancel()"
            data-testid="cancel-release"
          >
            Withdraw this request
          </button>
        }

        <section aria-label="History">
          <h2>What has happened</h2>
          <lj-timeline [events]="store.events()" [audience]="auth.audience()" />
        </section>
      }
    </div>
  `,
  styles: `
    .release {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .release h1,
    .release h2 {
      margin: 0;
    }

    .release h2 {
      font-size: 20px;
      line-height: 28px;
      margin-bottom: 12px;
    }

    .release__lead,
    .release__purpose {
      margin: 0;
      color: var(--lj-muted);
    }

    .release__header {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .release__form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .release__field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .release__label {
      font-weight: 600;
    }

    .release__field input {
      padding: 9px 12px;
      border: 1px solid var(--lj-border-strong);
      border-radius: 6px;
      background: var(--lj-surface);
      color: var(--lj-text);
      font: inherit;
    }

    .release__actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .release__summary {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .release__amount {
      margin: 0;
      font-size: 28px;
      line-height: 34px;
    }

    .release__reason {
      margin: 0;
      color: var(--lj-err);
    }
  `,
})
export class ReleasePage {
  /** Bound from `/loans/:id/release/:rid` by `withComponentInputBinding()`. */
  readonly id = input.required<string>();
  readonly rid = input.required<string>();

  protected readonly store = inject(ReleaseStore);
  protected readonly loans = inject(LoanStore);
  protected readonly auth = inject(SupabaseAuthService);
  private readonly router = inject(Router);

  private readonly opened = signal<string | null>(null);

  /** The borrower's figure, from the loan file the store shares with this page. */
  protected readonly available = computed(
    () => this.loans.figures()?.available ?? ZERO_MONEY,
  );

  /**
   * What to put under the form: the server's refusal if there is one, the
   * client's prediction otherwise.
   *
   * The two should agree -- same machine, same rules, same payload -- and when
   * they do not the server is right, because it is the one holding the state.
   */
  protected readonly blockers = computed(() => {
    const refused = this.store.serverRefusal();
    return refused.length > 0 ? refused : this.store.rules();
  });

  protected readonly canCancel = computed(() => {
    const state = this.store.release()?.state;
    return state === 'submitted' || state === 'under_review';
  });

  constructor() {
    // I/O, which is what `effect` is reserved for (plan/07). The loan is opened
    // alongside the request because this screen is not rendered under the loan
    // screen: the figure the rules measure against has to be read here too, and
    // the store is the same instance either way -- it is provided on /loans/:id.
    effect(() => {
      const loanId = this.id();
      const releaseId = this.rid();
      const key = loanId + '/' + releaseId;
      if (this.opened() === key) {
        return;
      }
      this.opened.set(key);
      void this.loans.open(loanId);
      if (releaseId === NEW_RELEASE) {
        void this.store.compose(loanId);
        return;
      }
      void this.store.open(loanId, releaseId);
    });

    // The row now exists, so the address bar must name it: from here a refresh
    // re-reads rather than recovering. `opened` is set first so the effect above
    // treats the new URL as already open and does not re-read over the form.
    effect(() => {
      const created = this.store.releaseId();
      if (created === null || this.rid() !== NEW_RELEASE) {
        return;
      }
      this.opened.set(this.id() + '/' + created);
      void this.router.navigate(['/loans', this.id(), 'release', created], {
        replaceUrl: true,
      });
    });
  }

  protected async submit(): Promise<void> {
    await this.store.submit();
  }

  protected async cancel(): Promise<void> {
    await this.store.cancel();
  }

  protected async discard(): Promise<void> {
    if (await this.store.discard()) {
      await this.router.navigate(['/loans', this.id()]);
    }
  }
}
