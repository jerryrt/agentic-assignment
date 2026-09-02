import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';

import { ApplicationStore } from '../application.store.ts';
import { newParcelGroup } from '../form.ts';
import { LjField } from '../ui/field.ts';
import {
  COMMODITY_OPTIONS,
  IRRIGATION_OPTIONS,
  LAND_TENURE_OPTIONS,
  YES_NO_OPTIONS,
} from '../ui/vocabulary.ts';
import { requiredPaths } from './required.ts';

/**
 * Step two: the land, as a repeating group.
 *
 * The parcels `FormArray` is the reason this step exists. Acreage is not a
 * field anybody types -- it is the sum of the rows, derived by
 * `deriveApplicationFigures` in @lj/domain -- so adding a parcel moves the
 * minimum-acreage criterion in the panel on the spot, and removing one moves it
 * back. A stored total beside the rows would be a second answer to the same
 * question the first time somebody edited a row and not the total.
 *
 * Removing a row is the operation that goes wrong in hand-rolled repeating
 * groups: `removeAt` shifts every index above it, so anything keyed by index --
 * a stored error, a focus target, a `track` expression -- moves to a different
 * row. `@for` tracks the control instance, which is stable across a removal.
 */
@Component({
  selector: 'lj-farm-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, LjField],
  template: `
    <div class="step" [formGroup]="group">
      <h2 class="step__heading">About your farm</h2>
      <p class="step__lead">
        Total acreage is added up from the parcels below, so describe each one.
      </p>

      <div class="step__grid">
        <lj-field
          [control]="group.controls.primary_commodity"
          label="Main commodity"
          kind="select"
          [options]="commodities"
          [required]="isRequired('farm.primary_commodity')"
        />
        <lj-field
          [control]="group.controls.secondary_commodity"
          label="Second commodity"
          kind="select"
          [options]="commodities"
          hint="Optional."
          placeholder="None"
        />
        <lj-field
          [control]="group.controls.irrigation"
          label="Irrigation"
          kind="select"
          [options]="irrigation"
          [required]="isRequired('farm.irrigation')"
        />
        <lj-field
          [control]="group.controls.has_crop_insurance"
          label="Crop insurance"
          kind="select"
          [options]="yesNo"
          placeholder="Not answered"
          [required]="isRequired('farm.has_crop_insurance')"
        />
        <lj-field
          [control]="group.controls.storage_capacity_tonnes"
          label="On-farm storage (tonnes)"
          kind="integer"
          hint="Optional."
        />
      </div>

      <fieldset class="step__section parcels">
        <legend class="step__section-heading">
          Parcels
          @if (isRequired('farm.parcels')) {
            <span class="parcels__required" aria-hidden="true">*</span>
            <span class="sr-only">(at least one, fully described, is required)</span>
          }
        </legend>

        @if (parcels.length === 0) {
          <p class="parcels__empty">
            No parcels yet. Add the first one to start the acreage adding up.
          </p>
        }

        <ol class="parcels__list">
          @for (parcel of parcels.controls; track parcel; let index = $index) {
            <li class="parcels__row" [formGroup]="parcel">
              <div class="step__grid">
                <lj-field
                  [control]="parcel.controls.legal_description"
                  label="Legal land description"
                  hint="For example NW-14-35-05-W3."
                  [required]="true"
                />
                <lj-field
                  [control]="parcel.controls.acres"
                  label="Acres"
                  kind="integer"
                  [required]="true"
                />
                <lj-field
                  [control]="parcel.controls.tenure"
                  label="Tenure"
                  kind="select"
                  [options]="tenures"
                  [required]="true"
                />
                <lj-field
                  [control]="parcel.controls.commodity"
                  label="Commodity"
                  kind="select"
                  [options]="commodities"
                  [required]="true"
                />
              </div>
              <button
                class="lj-button lj-button--quiet"
                type="button"
                (click)="removeParcel(index)"
                [attr.aria-label]="'Remove parcel ' + (index + 1)"
                data-testid="remove-parcel"
              >
                Remove
              </button>
            </li>
          }
        </ol>

        <div class="parcels__footer">
          <button
            class="lj-button"
            type="button"
            (click)="addParcel()"
            data-testid="add-parcel"
          >
            Add a parcel
          </button>
          <p class="parcels__total" data-testid="total-acres" aria-live="polite">
            @if (totalAcres(); as acres) {
              Total: {{ acres }} acres
            } @else {
              Total acreage will appear once every parcel has its acres.
            }
          </p>
        </div>
      </fieldset>
    </div>
  `,
  styleUrl: './step.scss',
  styles: `
    .parcels__list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .parcels__row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
      padding: 16px;
      border: 1px solid var(--lj-border);
      border-radius: 8px;
      background: var(--lj-surface);
    }

    .parcels__footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-top: 16px;
      flex-wrap: wrap;
    }

    .parcels__total {
      margin: 0;
      font-variant-numeric: tabular-nums;
      color: var(--lj-muted);
    }

    .parcels__empty {
      margin: 0 0 8px;
      color: var(--lj-muted);
    }

    .parcels__required {
      color: var(--lj-err);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
  `,
})
export class FarmStep {
  private readonly store = inject(ApplicationStore);

  protected readonly group = this.store.form.controls.farm;
  protected readonly parcels = this.group.controls.parcels;

  protected readonly commodities = COMMODITY_OPTIONS;
  protected readonly tenures = LAND_TENURE_OPTIONS;
  protected readonly irrigation = IRRIGATION_OPTIONS;
  protected readonly yesNo = YES_NO_OPTIONS;

  /** Derived in @lj/domain, never added up here. */
  protected readonly totalAcres = computed(() => this.store.figures().totalAcres);

  private readonly required = requiredPaths('farm', this.store.data);

  protected isRequired(path: string): boolean {
    return this.required().has(path);
  }

  protected addParcel(): void {
    this.parcels.push(newParcelGroup());
    // push() emits, which is what dirties the form -- but only markAsDirty
    // makes the autosave act on it, and an added empty row IS a change the
    // applicant made.
    this.parcels.markAsDirty();
  }

  protected removeParcel(index: number): void {
    this.parcels.removeAt(index);
    this.parcels.markAsDirty();
  }
}
