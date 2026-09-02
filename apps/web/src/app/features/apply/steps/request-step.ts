import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { formatBasisPointsAsPercentage } from '@lj/domain';

import { ApplicationStore } from '../application.store.ts';
import { LjField } from '../ui/field.ts';
import type { FieldOption } from '../ui/field.ts';
import { requiredPaths } from './required.ts';

/**
 * Step four: what is being asked for.
 *
 * The step the eligibility panel reacts hardest to, because three criteria read
 * from it at once -- the amount band, the loan-to-value cap, and through those
 * whether any product matches at all. Changing the amount by a dollar can move
 * a product from eligible to not, which is exactly what the panel is for.
 *
 * The product list comes from the store, which read it from `loan_product`
 * under row-level security. It is the products this lender is offering, not a
 * list of the ones the applicant qualifies for: choosing one they do not
 * qualify for is allowed, and the panel says so. The submit guard requires at
 * least one eligible product, not that the chosen one is it (plan/03).
 */
@Component({
  selector: 'lj-request-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, LjField],
  template: `
    <div class="step" [formGroup]="group">
      <h2 class="step__heading">What you are asking for</h2>
      <p class="step__lead">
        The panel beside this form updates as you type, so you can see what a different
        amount would do.
      </p>

      <div class="step__grid">
        <lj-field
          [control]="group.controls.product_id"
          label="Product"
          kind="select"
          [options]="products()"
          placeholder="Choose a product"
          [required]="isRequired('request.product_id')"
        />
        <lj-field
          [control]="group.controls.amount_requested_minor"
          label="Amount requested"
          kind="money"
          [required]="isRequired('request.amount_requested_minor')"
        />
        <lj-field
          [control]="group.controls.term_months"
          label="Term, in months"
          kind="integer"
          [required]="isRequired('request.term_months')"
        />
        <lj-field
          [control]="group.controls.collateral_value_minor"
          label="Value of the security"
          kind="money"
          hint="What you are pledging against the loan."
          [required]="isRequired('request.collateral_value_minor')"
        />
        <lj-field
          [control]="group.controls.preferred_start_date"
          label="Preferred start date"
          hint="Optional. For example 2026-04-01."
        />
        <div class="step__wide">
          <lj-field
            [control]="group.controls.purpose"
            label="What the money is for"
            kind="textarea"
            hint="One or two sentences is plenty."
            [required]="isRequired('request.purpose')"
          />
        </div>
      </div>

      <p class="ltv" aria-live="polite" data-testid="request-ltv">
        @if (loanToValue(); as percentage) {
          At this amount and security, your loan to value is {{ percentage }}.
        } @else {
          Enter an amount and a security value to see your loan to value.
        }
      </p>
    </div>
  `,
  styleUrl: './step.scss',
  styles: `
    .ltv {
      margin: 0;
      padding: 12px 16px;
      border-radius: 8px;
      background: var(--lj-surface);
      border: 1px solid var(--lj-border);
      color: var(--lj-muted);
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class RequestStep {
  private readonly store = inject(ApplicationStore);

  protected readonly group = this.store.form.controls.request;

  protected readonly products = computed<readonly FieldOption[]>(() =>
    this.store.products().map((product) => ({ value: product.id, label: product.name })),
  );

  protected readonly loanToValue = computed(() => {
    const value = this.store.figures().loanToValue;
    return value === null ? null : formatBasisPointsAsPercentage(value);
  });

  private readonly required = requiredPaths('request', this.store.data);

  protected isRequired(path: string): boolean {
    return this.required().has(path);
  }
}
