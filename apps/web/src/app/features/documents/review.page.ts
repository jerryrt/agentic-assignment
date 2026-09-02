import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { formatBasisPointsAsPercentage } from '@lj/domain';
import { LjRuleList, LjStateBadge } from '@lj/ui';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { DocumentPackStore, type DocumentSlotRow } from './document-pack.store.ts';
import { decisionFor, reviewedFields, type ReviewedField, type SlotDecision } from './review.ts';

/**
 * The lender's document review: one application's pack, what was read off each
 * document, and accept or reject.
 *
 * WHY THIS EXISTS IN PHASE 6 AT ALL, since plan/09 puts every lender screen in
 * phase 7. `accept` and `reject` are lender-only on the document slot machine.
 * Without somewhere to fire them no slot can ever reach `accepted`, no pack can
 * turn green, `begin_review` can never fire, and Option 1 cannot be shown end
 * to end -- the borrower would upload into a checklist that never completes.
 * So this is the minimum that makes the option demonstrable, deliberately.
 *
 * IT IS NOT THE LENDER QUEUE. There is no work list, no sorting by time
 * waiting, no filtering and no decision note: that screen is
 * `feature-servicing`'s in phase 7 (docs/03-agent-scopes.md), and it is what
 * will link here. Until it exists a lender reaches this URL directly.
 *
 * It reuses the borrower's store, and therefore the borrower's checklist:
 * two audiences reading one aggregate. A second store would be a second answer
 * to "is this pack complete", which is precisely the disagreement Option 3's
 * brief calls the interesting failure.
 */
@Component({
  selector: 'lj-document-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LjRuleList, LjStateBadge],
  template: `
    <div class="lj-page review">
      @if (store.isLoading() && store.value() === null) {
        <p role="status">Reading the document pack...</p>
      } @else if (store.value() === null && store.failure(); as failure) {
        <div class="lj-notice lj-notice--error" role="alert">
          <h1>This document pack could not be opened</h1>
          <p>{{ failure.message }}</p>
          <a class="lj-button" routerLink="/lender">Back to the lending desk</a>
        </div>
      } @else if (store.value(); as pack) {
        <header class="review__header">
          <div class="review__title">
            <h1>Documents to review</h1>
            <lj-state-badge
              [subject]="{ machine: 'application', state: pack.applicationState }"
              [audience]="auth.audience()"
            />
          </div>
          <p class="review__count" data-testid="review-progress">
            {{ store.progress().accepted }} of {{ store.progress().total }} required documents
            accepted ({{ percentage() }}).
          </p>
        </header>

        @if (store.failure(); as failure) {
          <p class="lj-notice lj-notice--error" role="alert" data-testid="review-failure">
            {{ failure.message }}
          </p>
        }

        <lj-rule-list
          [results]="store.completeness()"
          heading="The pack"
          [live]="false"
          data-testid="review-checklist"
        />

        <section class="review__slots" aria-labelledby="review-slots-heading">
          <h2 id="review-slots-heading">Each document</h2>
          <ul class="review__list">
            @for (row of store.rows(); track row.slot.id) {
              <li class="review__item" [attr.data-slot]="row.slot.code">
                <div class="review__item-head">
                  <span class="review__item-label">{{ row.slot.label }}</span>
                  @if (!row.slot.required) {
                    <span class="review__optional">optional</span>
                  }
                </div>
                <!--
                  Where the slot stands is the rule's own sentence, not a state
                  name. @lj/domain holds no label map for document_slot and
                  lj-state-badge has no variant for it -- both raised on #43 --
                  and a status string written into this template would be
                  exactly the hardcoded label CLAUDE.md section 9 forbids:
                  wrong for one of the two audiences, and silently missing the
                  next state anybody adds.
                -->
                <p class="review__standing">{{ row.result.explain }}</p>

                @if (fieldsOf(row); as fields) {
                  @if (fields.length > 0) {
                    <dl class="review__fields">
                      @for (field of fields; track field.field) {
                        <div class="review__field" [attr.data-outstanding]="field.outstanding ? '' : null">
                          <dt>{{ field.field }}</dt>
                          <dd>
                            <span class="review__value">{{ show(field.value) }}</span>
                            <span class="review__source">{{ provenance(field) }}</span>
                          </dd>
                        </div>
                      }
                    </dl>
                  } @else {
                    <p class="review__nothing">This document declares no fields to read.</p>
                  }
                }

                <div class="review__decide">
                  <button
                    class="lj-button"
                    type="button"
                    [disabled]="!decision(row).accept.ok || store.isSaving()"
                    (click)="accept(row)"
                    [attr.data-testid]="'accept-' + row.slot.code"
                  >
                    Accept
                  </button>
                  <button
                    class="lj-button lj-button--quiet"
                    type="button"
                    [disabled]="!decision(row).reject.ok || store.isSaving()"
                    (click)="reject(row)"
                    [attr.data-testid]="'reject-' + row.slot.code"
                  >
                    Refuse
                  </button>
                  <span class="review__why">{{ why(decision(row)) }}</span>
                </div>
              </li>
            }
          </ul>
        </section>

        <lj-rule-list
          [results]="store.crossChecks()"
          heading="Cross-checks"
          [live]="false"
          data-testid="review-cross-checks"
        />
      }
    </div>
  `,
  styles: `
    .review {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .review__header {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .review__title {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .review__title h1,
    .review__count {
      margin: 0;
    }

    .review__count {
      color: var(--lj-muted);
    }

    .review__slots {
      background: var(--lj-surface);
      border: 1px solid var(--lj-border);
      border-radius: 8px;
      padding: 16px;
    }

    .review__slots h2 {
      margin: 0 0 12px;
      font-size: 20px;
      line-height: 28px;
    }

    .review__list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .review__item {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 16px;
      border-top: 1px solid var(--lj-border);
    }

    .review__item:first-child {
      padding-top: 0;
      border-top: 0;
    }

    .review__item-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .review__item-label {
      font-weight: 600;
    }

    .review__optional,
    .review__standing,
    .review__source,
    .review__why,
    .review__nothing {
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    .review__nothing,
    .review__standing {
      margin: 0;
    }

    .review__fields {
      margin: 0;
      display: grid;
      grid-template-columns: minmax(0, 12rem) minmax(0, 1fr);
      gap: 4px 16px;
    }

    .review__field {
      display: contents;
    }

    .review__field dt {
      font-size: 12.5px;
      line-height: 18px;
      color: var(--lj-muted);
    }

    .review__field dd {
      margin: 0;
      display: flex;
      gap: 8px;
      align-items: baseline;
    }

    .review__value {
      /* Figures are read down a column. */
      font-variant-numeric: tabular-nums;
    }

    /* A field nobody could read is marked by the border as well as by the
       word beside it: colour is never the only cue. */
    .review__field[data-outstanding] dd {
      border-left: 2px solid var(--lj-err);
      padding-left: 8px;
    }

    .review__decide {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
  `,
})
export class DocumentReviewPage {
  /** Bound from `/apply/:id/documents/review`; see ./documents.routes.ts. */
  readonly id = input.required<string>();

  protected readonly store = inject(DocumentPackStore);
  protected readonly auth = inject(SupabaseAuthService);

  private readonly opened = signal<string | null>(null);

  protected readonly percentage = computed(() =>
    formatBasisPointsAsPercentage(this.store.progress().basisPoints),
  );

  constructor() {
    // I/O, which is what `effect` is reserved for (plan/07).
    effect(() => {
      const applicationId = this.id();
      if (this.opened() === applicationId) {
        return;
      }
      this.opened.set(applicationId);
      void this.store.open(applicationId);
    });
  }

  protected decision(row: DocumentSlotRow): SlotDecision {
    return decisionFor(row.slot.state, this.auth.role());
  }

  protected fieldsOf(row: DocumentSlotRow): readonly ReviewedField[] {
    return reviewedFields(row.view.extractRequired, row.view.extracted);
  }

  /** A value read off a document, as text. Never reformatted or rounded. */
  protected show(value: unknown): string {
    return value === null || value === undefined ? 'not read' : String(value);
  }

  /**
   * Where a figure came from, which is the difference between a reading and a
   * claim. A percentage is what a basis point means, and @lj/domain owns the
   * conversion.
   */
  protected provenance(field: ReviewedField): string {
    if (field.outstanding) {
      return 'the extractor found nothing here';
    }
    if (field.confirmedByHuman) {
      return 'typed in and confirmed';
    }
    return 'read by the extractor, ' + formatBasisPointsAsPercentage(field.confidenceBasisPoints) + ' confident';
  }

  /** Why the buttons are quiet, when they are. */
  protected why(decision: SlotDecision): string {
    if (decision.accept.ok || decision.reject.ok) {
      return '';
    }
    return decision.accept.reason;
  }

  protected async accept(row: DocumentSlotRow): Promise<void> {
    await this.store.accept(row.slot.id);
  }

  protected async reject(row: DocumentSlotRow): Promise<void> {
    await this.store.reject(row.slot.id);
  }
}
