import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { formatBasisPointsAsPercentage, formatBasisPointsAsRatio } from '@lj/domain';
import { LjMoney } from '@lj/ui';

import { ApplicationStore } from '../application.store.ts';
import { LjField } from '../ui/field.ts';
import { STATEMENT_BASIS_OPTIONS } from '../ui/vocabulary.ts';
import { requiredPaths } from './required.ts';

/**
 * Step three: the figures, and the three that are computed from them.
 *
 * Net operating income, debt service coverage and the current ratio are
 * read-only and derived by `deriveApplicationFigures` in @lj/domain -- the same
 * function `eligibilityContextFromApplication` feeds, and therefore the same
 * numbers the criteria are compared against and the same numbers the server
 * re-derives inside the submit guard. A ratio computed in this template would
 * be a second answer, and the one the applicant reads would be the one nobody
 * checked.
 *
 * Amounts are typed as decimal strings and converted exactly (../form-fields.ts).
 * There is no `parseFloat` here, and there must not be: money.ts shows the cent
 * that goes missing when there is.
 */
@Component({
  selector: 'lj-financials-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, LjField, LjMoney],
  template: `
    <div class="step" [formGroup]="group">
      <h2 class="step__heading">Your financial position</h2>
      <p class="step__lead">
        Amounts in dollars, from your most recent year end. The three figures below the
        form are worked out from what you enter.
      </p>

      <div class="step__grid">
        <lj-field
          [control]="group.controls.statements_basis"
          label="Statement basis"
          kind="select"
          [options]="bases"
          [required]="isRequired('financials.statements_basis')"
        />
        <lj-field
          [control]="group.controls.fiscal_year_end"
          label="Fiscal year end"
          hint="Optional. For example 2025-12-31."
        />
        <lj-field
          [control]="group.controls.gross_revenue_minor"
          label="Gross revenue"
          kind="money"
          [required]="isRequired('financials.gross_revenue_minor')"
        />
        <lj-field
          [control]="group.controls.operating_expenses_minor"
          label="Operating expenses"
          kind="money"
          hint="Before debt service."
          [required]="isRequired('financials.operating_expenses_minor')"
        />
        <lj-field
          [control]="group.controls.existing_debt_service_minor"
          label="Existing annual debt service"
          kind="money"
          [required]="isRequired('financials.existing_debt_service_minor')"
        />
        <lj-field
          [control]="group.controls.current_assets_minor"
          label="Current assets"
          kind="money"
          [required]="isRequired('financials.current_assets_minor')"
        />
        <lj-field
          [control]="group.controls.current_liabilities_minor"
          label="Current liabilities"
          kind="money"
          [required]="isRequired('financials.current_liabilities_minor')"
        />
        <lj-field
          [control]="group.controls.inventory_value_minor"
          label="Inventory on hand"
          kind="money"
          hint="Optional."
        />
        <lj-field
          [control]="group.controls.land_value_minor"
          label="Land value"
          kind="money"
          hint="Optional."
        />
        <lj-field
          [control]="group.controls.off_farm_income_minor"
          label="Off-farm income"
          kind="money"
          hint="Optional."
        />
      </div>

      <!-- aria-live, because these change while the applicant types in the
           fields above and a screen reader would otherwise never hear them. -->
      <dl class="derived" aria-live="polite" data-testid="derived-figures">
        <div class="derived__item">
          <dt>Net operating income</dt>
          <dd>
            @if (figures().netOperatingIncome; as income) {
              <lj-money [amount]="income" />
            } @else {
              <span class="derived__pending">Needs revenue and expenses</span>
            }
          </dd>
        </div>
        <div class="derived__item">
          <dt>Debt service coverage</dt>
          <dd>
            @if (coverage(); as ratio) {
              {{ ratio }}
            } @else {
              <span class="derived__pending">Needs income and debt service</span>
            }
          </dd>
        </div>
        <div class="derived__item">
          <dt>Current ratio</dt>
          <dd>
            @if (currentRatio(); as ratio) {
              {{ ratio }}
            } @else {
              <span class="derived__pending">Needs current assets and liabilities</span>
            }
          </dd>
        </div>
        <div class="derived__item">
          <dt>Loan to value</dt>
          <dd>
            @if (loanToValue(); as percentage) {
              {{ percentage }}
            } @else {
              <span class="derived__pending">Set on the last step</span>
            }
          </dd>
        </div>
      </dl>
    </div>
  `,
  styleUrl: './step.scss',
  styles: `
    .derived {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin: 0;
      padding: 16px;
      border: 1px solid var(--lj-border);
      border-radius: 8px;
      background: var(--lj-surface);
    }

    .derived__item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .derived dt {
      font-size: 12.5px;
      line-height: 18px;
      color: var(--lj-muted);
    }

    .derived dd {
      margin: 0;
      font-size: 20px;
      line-height: 28px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }

    .derived__pending {
      font-size: 12.5px;
      line-height: 18px;
      font-weight: 400;
      color: var(--lj-muted);
    }
  `,
})
export class FinancialsStep {
  private readonly store = inject(ApplicationStore);

  protected readonly group = this.store.form.controls.financials;
  protected readonly bases = STATEMENT_BASIS_OPTIONS;
  protected readonly figures = this.store.figures;

  // Formatted through @lj/domain's formatters, which are the single
  // implementation for both (CLAUDE.md section 9). A ratio reads as "1.25" and
  // a loan-to-value as "76%", because that is how a credit memo states each.
  protected readonly coverage = computed(() => {
    const value = this.figures().debtServiceCoverage;
    return value === null ? null : formatBasisPointsAsRatio(value);
  });

  protected readonly currentRatio = computed(() => {
    const value = this.figures().currentRatio;
    return value === null ? null : formatBasisPointsAsRatio(value);
  });

  protected readonly loanToValue = computed(() => {
    const value = this.figures().loanToValue;
    return value === null ? null : formatBasisPointsAsPercentage(value);
  });

  private readonly required = requiredPaths('financials', this.store.data);

  protected isRequired(path: string): boolean {
    return this.required().has(path);
  }
}
