import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LjMoney, LjStateBadge, LjTimeline } from '@lj/ui';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { decisionIsReady, type DecisionAction } from './decision.ts';
import { ReviewStore } from './review.store.ts';

/**
 * One request, with everything needed to decide it.
 *
 * The lender's half of "two roles, two truths": the same row the borrower
 * reads, shown as exposure -- undrawn limit against the approved limit, with
 * what is committed and not yet disbursed in its own at-risk column. The
 * borrower's screen shows available credit, which is smaller by exactly that
 * column. Neither figure is computed in a template; both come from
 * ../servicing/balance.ts.
 *
 * The two boxes are not the same kind of field, and the screen says so: the
 * note is private to the lending side and saves as it is typed, while the
 * decline reason goes to the borrower and is written by the decision itself.
 * Both survive a reload (./decision-draft.ts) -- plan/06's third refresh case,
 * because lenders lose work too.
 *
 * The buttons are read off the machine (./decision.ts), so this screen cannot
 * offer a move the server will refuse, and a decline is held back until there
 * is a reason: a decision the borrower cannot act on wastes the next round trip
 * and the phone call after it.
 *
 * NOT RENDER-TESTED: an `apps/web` unit test cannot instantiate an @lj/ui
 * component (issue #33). The behaviour is on ./review.store.ts and
 * ./decision.ts, both under test; the screen belongs to the browser suite.
 */
@Component({
  selector: 'lj-lender-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, LjMoney, LjStateBadge, LjTimeline],
  template: `
    <div class="lj-page review">
      <nav class="review__back">
        <a routerLink="/lender/queue">Back to the queue</a>
      </nav>

      @if (store.failure(); as failure) {
        <p class="lj-notice lj-notice--error" role="alert" data-testid="review-problem">
          {{ failure.message }}
        </p>
      }

      @if (store.declineReasonPending()) {
        <p class="lj-notice lj-notice--warn" role="alert" data-testid="reason-pending">
          The decision was recorded, but the reason has not reached the borrower. It is
          still in this browser -- send it again, or tell them another way.
        </p>
      }

      @if (store.recovered(); as savedAt) {
        <p class="lj-notice lj-notice--warn" role="status" data-testid="review-recovered">
          What you had typed here was recovered from this browser. Saved {{ savedAt }}.
        </p>
      }

      @if (store.release(); as release) {
        <header class="review__header">
          <div>
            <h1>{{ release.requested_by_name ?? 'Credit request' }}</h1>
            <p class="review__purpose">{{ release.purpose }}</p>
          </div>
          <lj-state-badge
            [subject]="{ machine: 'credit_release', state: release.state }"
            [audience]="auth.audience()"
          />
        </header>

        <section class="lj-card review__figures" aria-label="Exposure">
          <div class="review__figure review__figure--lead">
            <span class="review__label">Requested</span>
            <span class="review__value" data-testid="requested">
              <lj-money [amount]="release.amount" />
            </span>
          </div>
          @if (store.figures(); as figures) {
            <div class="review__figure">
              <span class="review__label">Undrawn limit</span>
              <span class="review__value" data-testid="undrawn">
                <lj-money [amount]="figures.undrawn" />
              </span>
            </div>
            <div class="review__figure">
              <span class="review__label">At risk</span>
              <span class="review__value" data-testid="at-risk">
                <lj-money [amount]="figures.atRisk" />
              </span>
              <span class="review__note">Approved or awaiting a decision, not yet disbursed.</span>
            </div>
            <div class="review__figure">
              <span class="review__label">Drawn</span>
              <span class="review__value"><lj-money [amount]="figures.outstanding" /></span>
            </div>
          } @else {
            <p class="review__note" data-testid="no-figures">
              This loan's balance could not be read, so the exposure is not shown.
            </p>
          }
        </section>

        @if (store.applicationId(); as applicationId) {
          <a
            class="lj-button lj-button--quiet review__documents"
            [routerLink]="['/apply', applicationId, 'documents', 'review']"
            data-testid="review-documents"
          >
            Open the borrower's documents
          </a>
        }

        <form class="lj-card review__form" [formGroup]="store.form">
          <label class="review__field">
            <span class="review__label">Your note</span>
            <textarea
              formControlName="internalNote"
              rows="3"
              data-testid="internal-note"
            ></textarea>
            <span class="review__note">
              Private to the lending side, and saved as you type.
            </span>
          </label>

          <label class="review__field">
            <span class="review__label">Reason, if you decline</span>
            <textarea
              formControlName="declineReason"
              rows="3"
              data-testid="decline-reason"
            ></textarea>
            <span class="review__note">
              The borrower reads this. It is sent with the decision, not before it.
            </span>
          </label>

          <div class="review__actions">
            @for (action of store.actions(); track action.event) {
              <button
                class="lj-button"
                [class.lj-button--quiet]="action.emphasis !== 'primary'"
                type="button"
                [disabled]="!ready(action) || store.isSaving()"
                (click)="decide(action)"
                [attr.data-event]="action.event"
                data-testid="review-decide"
              >
                {{ action.label }}
              </button>
            }
            @if (store.actions().length === 0) {
              <p class="review__note" data-testid="no-actions">
                Nothing is open on this request.
              </p>
            }
          </div>
        </form>

        @if (release.decline_reason; as reason) {
          <section class="lj-card" aria-label="Decision">
            <h2>What the borrower was told</h2>
            <p data-testid="recorded-reason">{{ reason }}</p>
          </section>
        }

        <section aria-label="History">
          <h2>What has happened</h2>
          <lj-timeline [events]="store.events()" [audience]="auth.audience()" />
        </section>
      }
    </div>
  `,
  styles: `
    .review {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .review h1,
    .review h2 {
      margin: 0;
    }

    .review h2 {
      font-size: 20px;
      line-height: 28px;
      margin-bottom: 8px;
    }

    .review__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .review__purpose,
    .review__note {
      margin: 0;
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    .review__figures {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 20px;
    }

    .review__figure {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .review__figure--lead .review__value {
      font-size: 28px;
      line-height: 34px;
    }

    .review__label {
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    .review__value {
      font-size: 20px;
      line-height: 28px;
    }

    .review__documents {
      align-self: flex-start;
    }

    .review__form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .review__field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .review__field textarea {
      padding: 9px 12px;
      border: 1px solid var(--lj-border-strong);
      border-radius: 6px;
      background: var(--lj-surface);
      color: var(--lj-text);
      font: inherit;
      resize: vertical;
    }

    .review__actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
  `,
})
export class LenderReviewPage {
  /** Bound from `/lender/release/:rid` by `withComponentInputBinding()`. */
  readonly rid = input.required<string>();

  protected readonly store = inject(ReviewStore);
  protected readonly auth = inject(SupabaseAuthService);

  private readonly opened = signal<string | null>(null);

  constructor() {
    // I/O, which is what `effect` is reserved for (plan/07). Keyed on the route
    // parameter, so following one request to another re-reads rather than
    // showing the previous one.
    effect(() => {
      const releaseId = this.rid();
      if (this.opened() === releaseId) {
        return;
      }
      this.opened.set(releaseId);
      void this.store.open(releaseId);
    });
  }

  /** A decline waits for its reason; nothing else does. See ./decision.ts. */
  protected ready(action: DecisionAction): boolean {
    return decisionIsReady(action, this.store.declineReason());
  }

  protected async decide(action: DecisionAction): Promise<void> {
    await this.store.decide(action);
  }
}
