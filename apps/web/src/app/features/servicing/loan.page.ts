import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LjMoney, LjStateBadge } from '@lj/ui';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { LoanStore } from './loan.store.ts';

/**
 * One loan: what is available, what has moved, and every request made against
 * it.
 *
 * The four figures are the store's, which are ./balance.ts's, which are
 * `loan_balance_v`'s -- nothing here adds or subtracts. "Available to draw" is
 * the borrower's reading, net of pending requests, and it is the same quantity
 * the submit guard compares a new request against; a lender looking at the same
 * loan reads undrawn limit instead, which is larger by exactly what is pending.
 * Showing one audience the other's number is the failure Option 3 exists to
 * avoid, and the way it is avoided is that neither number is computed in a
 * template.
 *
 * The state of each request is rendered by `<lj-state-badge>`, which resolves
 * the label through @lj/domain's audience-keyed map -- so a borrower reads
 * "Submitted -- with your lender" where a lender reads "New request -- awaiting
 * triage", from one map. There is no status string in this file.
 *
 * NOT RENDER-TESTED: an `apps/web` unit test cannot instantiate an @lj/ui
 * component (issue #33). Every decision behind this template is a signal on
 * ./loan.store.ts or a function in ./balance.ts, both under test; the rendering
 * belongs to the browser suite.
 */
@Component({
  selector: 'lj-loan-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LjMoney, LjStateBadge],
  template: `
    <div class="lj-page loan">
      @if (store.isLoading() && store.value() === null) {
        <p role="status">Reading your loan...</p>
      } @else if (store.failure(); as failure) {
        <p class="lj-notice lj-notice--error" role="alert" data-testid="loan-problem">
          {{ failure.message }}
        </p>
      }

      @if (store.figures(); as figures) {
        <header class="loan__header">
          <h1>Your loan</h1>
          <a
            class="lj-button"
            [routerLink]="['/loans', id(), 'release', 'new']"
            data-testid="request-credit"
          >
            Request credit
          </a>
        </header>

        <section class="lj-card loan__figures" aria-label="Balance">
          <div class="loan__figure loan__figure--lead">
            <span class="loan__label">Available to draw</span>
            <span class="loan__value" data-testid="available">
              <lj-money [amount]="figures.available" />
            </span>
            <span class="loan__note">
              Your limit, less what is drawn, less anything already with your lender.
            </span>
          </div>
          <div class="loan__figure">
            <span class="loan__label">Drawn</span>
            <span class="loan__value"><lj-money [amount]="figures.outstanding" /></span>
          </div>
          <div class="loan__figure">
            <span class="loan__label">With your lender</span>
            <span class="loan__value" data-testid="pending"><lj-money [amount]="figures.pending" /></span>
          </div>
          <div class="loan__figure">
            <span class="loan__label">Approved limit</span>
            <span class="loan__value"><lj-money [amount]="figures.limit" /></span>
          </div>
        </section>

        <section aria-label="Requests">
          <h2>Credit requests</h2>
          @if (store.releases().length === 0) {
            <p class="loan__empty" data-testid="no-releases">
              You have not requested a draw against this loan yet.
            </p>
          } @else {
            <ul class="loan__releases">
              @for (release of store.releases(); track release.id) {
                <li class="lj-card loan__release">
                  <a
                    class="loan__release-link"
                    [routerLink]="['/loans', id(), 'release', release.id]"
                    data-testid="release-link"
                  >
                    <lj-money [amount]="release.amount" />
                    <span class="loan__purpose">{{ release.purpose }}</span>
                  </a>
                  <lj-state-badge
                    [subject]="{ machine: 'credit_release', state: release.state }"
                    [audience]="auth.audience()"
                  />
                  @if (release.decline_reason; as reason) {
                    <p class="loan__reason" data-testid="decline-reason">{{ reason }}</p>
                  }
                </li>
              }
            </ul>
          }
        </section>

        <section aria-label="Statement">
          <h2>Statement</h2>
          @if (store.ledger().length === 0) {
            <p class="loan__empty">Nothing has moved on this loan yet.</p>
          } @else {
            <table class="loan__ledger">
              <caption class="sr-only">Every entry on this loan, most recent first</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Entry</th>
                  <th scope="col">Detail</th>
                  <th scope="col" class="loan__amount-column">Amount</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of store.ledger(); track entry.id) {
                  <tr>
                    <td>{{ entry.effective }}</td>
                    <td>{{ entry.kind }}</td>
                    <td>{{ entry.memo }}</td>
                    <td class="loan__amount-column">
                      <!-- Signed always: draws raise the balance and repayments
                           lower it, and a column of bare magnitudes cannot be
                           reconciled against a statement. -->
                      <lj-money [amount]="entry.amount" signDisplay="always" />
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
      }
    </div>
  `,
  styles: `
    .loan {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .loan__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .loan__header h1,
    .loan h2 {
      margin: 0;
    }

    .loan h2 {
      font-size: 20px;
      line-height: 28px;
      margin-bottom: 12px;
    }

    .loan__figures {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 20px;
    }

    .loan__figure {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .loan__figure--lead .loan__value {
      font-size: 28px;
      line-height: 34px;
    }

    .loan__label {
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    .loan__value {
      font-size: 20px;
      line-height: 28px;
    }

    .loan__note,
    .loan__empty,
    .loan__purpose {
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    .loan__releases {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .loan__release {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 16px;
    }

    .loan__release-link {
      display: flex;
      align-items: baseline;
      gap: 10px;
      text-decoration: none;
      color: var(--lj-text);
      font-weight: 600;
    }

    .loan__reason {
      flex-basis: 100%;
      margin: 0;
      color: var(--lj-err);
      font-size: 13px;
    }

    .loan__ledger {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    .loan__ledger th,
    .loan__ledger td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--lj-border);
    }

    .loan__ledger th {
      color: var(--lj-muted);
      font-weight: 600;
    }

    .loan__amount-column {
      text-align: right;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  `,
})
export class LoanPage {
  /** Bound from `/loans/:id` by `withComponentInputBinding()`. */
  readonly id = input.required<string>();

  protected readonly store = inject(LoanStore);
  protected readonly auth = inject(SupabaseAuthService);

  private readonly opened = signal<string | null>(null);

  protected readonly hasFile = computed(() => this.store.value() !== null);

  constructor() {
    // I/O, which is what `effect` is reserved for (plan/07). Keyed on the route
    // parameter rather than run once, so following a link from one loan to
    // another re-reads rather than showing the previous one.
    effect(() => {
      const loanId = this.id();
      if (this.opened() === loanId) {
        return;
      }
      this.opened.set(loanId);
      void this.store.open(loanId);
    });
  }
}
