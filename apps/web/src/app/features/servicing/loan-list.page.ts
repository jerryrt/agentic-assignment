import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LoanBalanceSchema, LoanSchema, type LoanStatus, type Money } from '@lj/domain';
import { listLoanBalances, listLoans } from '@lj/db';
import { LjMoney } from '@lj/ui';

import { DATABASE_CLIENT } from '../../core/data/database-client.ts';
import { availableFromBalance } from './balance.ts';

/**
 * The borrower's facilities, one card each.
 *
 * It reads straight from Supabase under row-level security, as
 * `features/apply`'s list does and for the same reason: `loan_read_own` returns
 * this borrower's rows and nobody else's, so the list is filtered by the
 * database rather than by a `where` clause anyone could edit. There is no API
 * call here and there should not be.
 *
 * Both balances arrive in ONE round trip. `listLoanBalances` exists for exactly
 * this screen (`packages/db/src/queries/loans.ts`): reading a balance per card
 * is the shape that turns three loans into four requests.
 *
 * The figure on the card is the BORROWER'S -- net of pending requests. A lender
 * looking at the same rows reads undrawn limit instead, which is larger by
 * exactly what is pending; both come out of `loan_balance_v` and neither is
 * computed in this template (./balance.ts).
 *
 * NOT RENDER-TESTED, and not because it does not matter: an `apps/web` unit
 * test cannot instantiate an @lj/ui component (issue #33 -- the test builder
 * pre-bundles the package, so a signal input arrives with no compiled metadata
 * and throws NG0950). The decision behind the figure is `availableFromBalance`
 * in ./balance.ts, under test; the rendering belongs to the browser suite.
 */

interface LoanCard {
  readonly id: string;
  readonly openedAt: string;
  readonly status: LoanStatus;
  readonly limit: Money;
  readonly outstanding: Money;
  readonly available: Money;
  readonly ratePercent: string;
}

/** Hundredths of a percent to a percentage, which is what a card shows. */
function ratePercent(rateBps: number): string {
  return (rateBps / 100).toFixed(2) + '%';
}

@Component({
  selector: 'lj-loan-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LjMoney],
  template: `
    <div class="lj-page loans">
      <header>
        <h1>Your land loans</h1>
        <p class="loans__lead">
          What you have available is your limit less what is drawn and less anything
          already with your lender.
        </p>
      </header>

      @if (problem(); as message) {
        <p class="lj-notice lj-notice--error" role="alert" data-testid="loans-problem">
          {{ message }}
        </p>
      }

      @if (loading()) {
        <p role="status">Reading your loans...</p>
      } @else if (cards().length === 0) {
        <p class="loans__empty" data-testid="no-loans">
          You have no loans yet. A loan is opened when an application is funded.
        </p>
      } @else {
        <ul class="loans__list">
          @for (card of cards(); track card.id) {
            <li class="lj-card loans__card">
              <a class="loans__link" [routerLink]="['/loans', card.id]" data-testid="loan-link">
                Loan opened {{ card.openedAt }}
              </a>
              <dl class="loans__figures">
                <div>
                  <dt>Available to draw</dt>
                  <dd><lj-money [amount]="card.available" /></dd>
                </div>
                <div>
                  <dt>Drawn</dt>
                  <dd><lj-money [amount]="card.outstanding" /></dd>
                </div>
                <div>
                  <dt>Approved limit</dt>
                  <dd><lj-money [amount]="card.limit" /></dd>
                </div>
                <div>
                  <dt>Rate</dt>
                  <dd>{{ card.ratePercent }}</dd>
                </div>
              </dl>
              <p class="loans__status" data-testid="loan-status">{{ card.status }}</p>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    .loans {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .loans h1,
    .loans__lead {
      margin: 0;
    }

    .loans__lead,
    .loans__empty,
    .loans__status {
      color: var(--lj-muted);
    }

    .loans__list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .loans__card {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .loans__link {
      font-weight: 600;
    }

    .loans__figures {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin: 0;
    }

    .loans__figures dt {
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    .loans__figures dd {
      margin: 0;
      font-size: 18px;
    }

    .loans__status {
      margin: 0;
      font-size: 12.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
  `,
})
export class LoanListPage {
  private readonly client = inject(DATABASE_CLIENT);

  private readonly rows = signal<readonly LoanCard[]>([]);
  private readonly isLoading = signal(true);
  private readonly failure = signal<string | null>(null);

  protected readonly cards = this.rows.asReadonly();
  protected readonly loading = this.isLoading.asReadonly();
  protected readonly problem = computed(() => this.failure());

  constructor() {
    void this.read();
  }

  private async read(): Promise<void> {
    const client = this.client;
    if (client === null) {
      this.failure.set('This deployment cannot reach the database.');
      this.isLoading.set(false);
      return;
    }
    try {
      const [loans, balances] = await Promise.all([
        listLoans(client),
        listLoanBalances(client),
      ]);
      const byLoan = new Map(
        balances
          .map((row) => LoanBalanceSchema.safeParse(row))
          .filter((parsed) => parsed.success)
          .map((parsed) => [parsed.data.loan_id, parsed.data]),
      );

      const cards: LoanCard[] = [];
      for (const row of loans) {
        const loan = LoanSchema.safeParse(row);
        const balance = loan.success ? byLoan.get(loan.data.id) : undefined;
        // A loan whose balance did not arrive is left off rather than shown
        // with a figure invented here: an "available" nothing derived is the
        // one number on this screen that must not be guessed.
        if (!loan.success || balance === undefined) {
          continue;
        }
        cards.push({
          id: loan.data.id,
          openedAt: loan.data.opened_at,
          status: loan.data.status,
          limit: balance.approved_limit,
          outstanding: balance.outstanding,
          available: availableFromBalance(balance),
          ratePercent: ratePercent(loan.data.rate_bps),
        });
      }
      this.rows.set(cards);
    } catch {
      this.failure.set('Your loans could not be read.');
    } finally {
      this.isLoading.set(false);
    }
  }
}
