import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';

import { ApplicationStore } from '../application.store.ts';
import { LjField } from '../ui/field.ts';
import { ENTITY_TYPE_OPTIONS, PROVINCE_OPTIONS } from '../ui/vocabulary.ts';
import { requiredPaths } from './required.ts';

/**
 * Step one: who is borrowing.
 *
 * The conditional fields are the subject here. A corporation is asked for its
 * operating name and the year it was incorporated; a sole trader is not, and
 * withholding them cannot make their step incomplete. Both the rendering and
 * the required marker come from `requirementsForStep`, so the question set and
 * the completeness rule cannot drift apart -- there is no second list in this
 * file saying which fields a corporation has.
 */
@Component({
  selector: 'lj-borrower-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, LjField],
  template: `
    <div class="step" [formGroup]="group">
      <h2 class="step__heading">About your business</h2>
      <p class="step__lead">
        How the business is held decides what else we have to ask, so it comes first.
      </p>

      <div class="step__grid">
        <lj-field
          [control]="group.controls.entity_type"
          label="How the business is held"
          kind="select"
          [options]="entityTypes"
          [required]="isRequired('borrower.entity_type')"
          placeholder="Choose one"
        />
        <lj-field
          [control]="group.controls.legal_name"
          label="Legal name"
          hint="Exactly as it appears on your filings."
          autocomplete="organization"
          [required]="isRequired('borrower.legal_name')"
        />

        @if (isRequired('borrower.trade_name')) {
          <lj-field
            [control]="group.controls.trade_name"
            label="Operating name"
            hint="The name you farm under, if it differs from the legal one."
            [required]="true"
          />
        }
        @if (isRequired('borrower.incorporation_year')) {
          <lj-field
            [control]="group.controls.incorporation_year"
            label="Year of incorporation"
            kind="integer"
            [required]="true"
          />
        }

        <lj-field
          [control]="group.controls.years_farming"
          label="Years farming"
          kind="integer"
          hint="Counted from when you started operating, not from incorporation."
          [required]="isRequired('borrower.years_farming')"
        />
        <lj-field
          [control]="group.controls.province"
          label="Province"
          kind="select"
          [options]="provinces"
          [required]="isRequired('borrower.province')"
          placeholder="Choose one"
        />
        <lj-field
          [control]="group.controls.postal_code"
          label="Postal code"
          autocomplete="postal-code"
          formatHint="Use the form A1A 1A1."
          [required]="isRequired('borrower.postal_code')"
        />
        <lj-field
          [control]="group.controls.contact_email"
          label="Contact email"
          kind="email"
          autocomplete="email"
          [required]="isRequired('borrower.contact_email')"
        />
        <lj-field
          [control]="group.controls.contact_phone"
          label="Contact phone"
          kind="tel"
          autocomplete="tel"
          [required]="isRequired('borrower.contact_phone')"
        />
      </div>
    </div>
  `,
  styleUrl: './step.scss',
})
export class BorrowerStep {
  private readonly store = inject(ApplicationStore);

  protected readonly group = this.store.form.controls.borrower;
  protected readonly entityTypes = ENTITY_TYPE_OPTIONS;
  protected readonly provinces = PROVINCE_OPTIONS;

  private readonly required = requiredPaths('borrower', this.store.data);

  protected isRequired(path: string): boolean {
    return this.required().has(path);
  }
}
