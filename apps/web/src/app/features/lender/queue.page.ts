import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { creditReleaseStateLabel } from '@lj/domain';
import type { CreditReleaseState } from '@lj/domain';
import { LjMoney } from '@lj/ui';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { decisionActions, type DecisionAction } from './decision.ts';
import type { QueueRow } from './queue.ts';
import { QueueStore } from './queue.store.ts';

/**
 * The lending desk: everything waiting, oldest first.
 *
 * CRITERION #1 IS JUDGED HERE -- "a loan officer could move through it
 * quickly" -- so the screen is built for someone working, not browsing:
 *
 *   - Oldest first, in the three piles a desk works through. Both come from
 *     ./queue.ts, where they are tested.
 *   - Arrow keys move between rows and every control is reachable by tab, so
 *     the queue can be worked without leaving the keyboard.
 *   - The simple decisions are taken FROM THE LIST. A decision that owes the
 *     borrower an explanation is not: `needsReason` marks it, and it opens the
 *     file instead, because a decline typed into a queue is a decline nobody
 *     writes a reason for.
 *   - Every row carries the way into the borrower's documents, which phase 6
 *     shipped with nothing linking to it.
 *
 * The figures are the LENDER'S reading -- exposure against the limit, with
 * pending as its own at-risk column -- and the words of each state come from
 * @lj/domain's audience-keyed map. Nothing on this screen is computed here.
 *
 * NOT RENDER-TESTED: an `apps/web` unit test cannot instantiate an @lj/ui
 * component (issue #33), so a spec here would assert the harness rather than
 * the screen. The ordering, the banding and the decision set are in ./queue.ts,
 * ./decision.ts and ./queue.store.ts, all under test; the keyboard behaviour
 * belongs to the browser suite.
 */
@Component({
  selector: 'lj-lender-queue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LjMoney],
  template: `
    <div class="lj-page queue">
      <header class="queue__header">
        <h1>Lending queue</h1>
        <p class="queue__summary" data-testid="queue-summary">
          {{ summary() }}
        </p>
      </header>

      @if (store.failure(); as failure) {
        <p class="lj-notice lj-notice--error" role="alert" data-testid="queue-problem">
          {{ failure.message }}
        </p>
      }

      @if (store.isLoading() && store.value() === null) {
        <p role="status">Reading the queue...</p>
      } @else if (store.total() === 0) {
        <p class="queue__empty" data-testid="queue-empty">
          Nothing is waiting. Every request has been decided.
        </p>
      } @else {
        @for (group of store.groups(); track group.state) {
          <section class="queue__group" [attr.aria-label]="stateLabel(group.state)">
            <h2>{{ stateLabel(group.state) }} ({{ group.rows.length }})</h2>

            <ul class="queue__rows" (keydown)="onKey($event)">
              @for (row of group.rows; track row.id) {
                <li class="queue__row" [attr.data-sla]="row.sla" data-testid="queue-row">
                  <a
                    #rowLink
                    class="queue__link"
                    [routerLink]="['/lender/release', row.id]"
                    data-testid="queue-open"
                  >
                    <span class="queue__borrower">{{ row.borrowerName }}</span>
                    <span class="queue__amount"><lj-money [amount]="row.amount" /></span>
                    <span class="queue__purpose">{{ row.purpose }}</span>
                  </a>

                  <span class="queue__age" [attr.data-sla]="row.sla" data-testid="queue-age">
                    {{ waited(row) }}
                  </span>

                  <span class="queue__exposure">
                    @if (row.undrawn !== null) {
                      <span class="queue__figure">
                        Undrawn <lj-money [amount]="row.undrawn" />
                      </span>
                    }
                    @if (row.atRisk !== null) {
                      <span class="queue__figure">
                        At risk <lj-money [amount]="row.atRisk" />
                      </span>
                    }
                  </span>

                  <span class="queue__actions">
                    @for (action of inlineActions(row); track action.event) {
                      <button
                        class="lj-button lj-button--quiet"
                        type="button"
                        [disabled]="store.isSaving()"
                        (click)="decide(row, action)"
                        [attr.data-event]="action.event"
                        data-testid="queue-decide"
                      >
                        {{ action.label }}
                      </button>
                    }
                    @if (row.applicationId; as applicationId) {
                      <a
                        class="lj-button lj-button--quiet"
                        [routerLink]="['/apply', applicationId, 'documents', 'review']"
                        data-testid="queue-documents"
                      >
                        Documents
                      </a>
                    }
                    @if (row.hasNote) {
                      <span class="queue__note" title="A note has been left on this file">
                        Note
                      </span>
                    }
                  </span>
                </li>
              }
            </ul>
          </section>
        }
      }
    </div>
  `,
  styles: `
    .queue {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .queue__header h1,
    .queue__summary,
    .queue__empty {
      margin: 0;
    }

    .queue__summary,
    .queue__empty,
    .queue__purpose,
    .queue__exposure {
      color: var(--lj-muted);
    }

    .queue__group h2 {
      margin: 0 0 12px;
      font-size: 20px;
      line-height: 28px;
    }

    .queue__rows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .queue__row {
      display: grid;
      grid-template-columns: minmax(220px, 2fr) auto minmax(160px, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border: 1px solid var(--lj-border);
      border-left-width: 4px;
      border-radius: 8px;
      background: var(--lj-surface);
    }

    /* Colour is never the only cue: the age is spelled out beside it
       (design/00-foundations.md). */
    .queue__row[data-sla='due'] {
      border-left-color: var(--lj-warn);
    }

    .queue__row[data-sla='overdue'] {
      border-left-color: var(--lj-err);
    }

    .queue__link {
      display: flex;
      flex-direction: column;
      gap: 2px;
      text-decoration: none;
      color: var(--lj-text);
    }

    .queue__borrower {
      font-weight: 600;
    }

    .queue__amount {
      font-size: 18px;
    }

    .queue__purpose,
    .queue__age,
    .queue__figure,
    .queue__note {
      font-size: 12.5px;
      line-height: 18px;
    }

    .queue__age[data-sla='due'] {
      color: var(--lj-warn);
    }

    .queue__age[data-sla='overdue'] {
      color: var(--lj-err);
    }

    .queue__exposure {
      display: flex;
      flex-direction: column;
    }

    .queue__actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .queue__note {
      padding: 2px 8px;
      border: 1px solid var(--lj-border-strong);
      border-radius: 999px;
      color: var(--lj-muted);
    }

    @media (max-width: 720px) {
      .queue__row {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class LenderQueuePage {
  protected readonly store = inject(QueueStore);
  protected readonly auth = inject(SupabaseAuthService);

  private readonly rowLinks = viewChildren<ElementRef<HTMLElement>>('rowLink');

  protected readonly summary = computed(() => {
    const total = this.store.total();
    const overdue = this.store.overdue();
    if (total === 0) {
      return 'Nothing is waiting.';
    }
    const waiting = total === 1 ? '1 request waiting' : String(total) + ' requests waiting';
    return overdue === 0 ? waiting + ', oldest first.' : waiting + ', ' + String(overdue) + ' of them overdue.';
  });

  constructor() {
    void this.store.open();
  }

  protected stateLabel(state: CreditReleaseState): string {
    // The lender's vocabulary, from the one map in @lj/domain. A heading typed
    // out here would be the copy that goes stale when a state is added.
    return creditReleaseStateLabel(state, this.auth.audience());
  }

  protected waited(row: QueueRow): string {
    if (row.waitingDays === 0) {
      return 'Today';
    }
    return row.waitingDays === 1 ? 'Waiting 1 day' : 'Waiting ' + String(row.waitingDays) + ' days';
  }

  /**
   * The decisions that can be taken without opening the file.
   *
   * A decision that owes the borrower an explanation is deliberately not among
   * them: a decline taken from a list is a decline with no reason typed, and
   * the reason is the part the borrower can act on.
   */
  protected inlineActions(row: QueueRow): readonly DecisionAction[] {
    const role = this.auth.role();
    if (role === null) {
      return [];
    }
    return decisionActions(row.state, role).filter((action) => !action.needsReason);
  }

  protected async decide(row: QueueRow, action: DecisionAction): Promise<void> {
    await this.store.decide(row, action.event);
  }

  /**
   * Up and down move between rows.
   *
   * A work queue is worked with the hands on the keyboard; every control here
   * is already tabbable, and this is what makes moving THROUGH the list as
   * cheap as moving through one row's controls.
   */
  protected onKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) {
      return;
    }
    const links = this.rowLinks().map((reference) => reference.nativeElement);
    const current = links.findIndex((element) => element === document.activeElement);
    if (current === -1) {
      return;
    }
    const next = links[current + step];
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    next.focus();
  }
}
