import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, type ControlEvent, type FormControl } from '@angular/forms';
import { switchMap } from 'rxjs';

/**
 * One form field: its label, its control, its hint and its error, wired
 * together correctly once.
 *
 * The accessibility floor for this feature is structural rather than
 * per-field discipline, and this component is how. Every field gets a `<label
 * for>` bound to a generated id, an `aria-describedby` composed from whichever
 * of the hint and the error is actually present, and `aria-invalid` set from
 * the same condition that renders the message. Forty fields wired by hand is
 * forty chances to forget one, and the one that gets forgotten is never the
 * one anybody notices.
 *
 * The control is rendered here rather than projected through `<ng-content>`,
 * which is the decision that makes the above possible: a projected input is one
 * the wrapper cannot put an id or an `aria-describedby` on, so the caller would
 * have to do it, and we would be back to per-field discipline with extra steps.
 * The cost is a `@switch` over the kinds, which is a small closed set.
 *
 * **It never says a field is required for a reason of its own.** `[required]`
 * arrives from `APPLICATION_STEP_REQUIREMENTS` in @lj/domain, through the step
 * component, because required-ness is conditional on the entity type and is
 * what the completeness rules and the submit guard read. There is no
 * `Validators.required` behind it (see ../form.ts).
 *
 * The unanswered message waits for `touched`. Telling someone a field is
 * needed before they have had a chance to fill it in is the wall of red this
 * whole option is built to avoid, one field at a time.
 */

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export type FieldKind = 'text' | 'email' | 'tel' | 'integer' | 'money' | 'select' | 'textarea';

let sequence = 0;

@Component({
  selector: 'lj-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <div class="field" [attr.data-invalid]="problem() === null ? null : ''">
      <label class="field__label" [attr.for]="controlId">
        {{ label() }}
        @if (required()) {
          <span class="field__required" aria-hidden="true">*</span>
          <span class="sr-only">(required)</span>
        }
      </label>

      @if (hint(); as text) {
        <p class="field__hint" [id]="hintId">{{ text }}</p>
      }

      @switch (kind()) {
        @case ('select') {
          <select
            class="field__control"
            [id]="controlId"
            [formControl]="control()"
            [attr.aria-describedby]="describedBy()"
            [attr.aria-invalid]="problem() === null ? null : 'true'"
          >
            <option value="">{{ placeholder() }}</option>
            @for (option of options(); track option.value) {
              <option [value]="option.value">{{ option.label }}</option>
            }
          </select>
        }
        @case ('textarea') {
          <textarea
            class="field__control"
            rows="3"
            [id]="controlId"
            [formControl]="control()"
            [attr.aria-describedby]="describedBy()"
            [attr.aria-invalid]="problem() === null ? null : 'true'"
          ></textarea>
        }
        @default {
          <input
            class="field__control"
            [id]="controlId"
            [type]="inputType()"
            [attr.inputmode]="inputMode()"
            [attr.autocomplete]="autocomplete()"
            [formControl]="control()"
            [attr.aria-describedby]="describedBy()"
            [attr.aria-invalid]="problem() === null ? null : 'true'"
          />
        }
      }

      @if (problem(); as message) {
        <!-- role=alert rather than aria-live on a container that is usually
             absent: a live region only announces changes to a region that was
             already there, so an error appended to the DOM would be silent. -->
        <p class="field__problem" [id]="problemId" role="alert">{{ message }}</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .field__label {
      font-size: 12.5px;
      line-height: 18px;
      font-weight: 600;
      color: var(--lj-text);
    }

    .field__required {
      color: var(--lj-err);
      margin-left: 2px;
    }

    .field__hint,
    .field__problem {
      margin: 0;
      font-size: 12.5px;
      line-height: 18px;
    }

    .field__hint {
      color: var(--lj-muted);
    }

    .field__problem {
      color: var(--lj-err);
    }

    .field__control {
      width: 100%;
      padding: 8px;
      border: 1px solid var(--lj-border);
      border-radius: 6px;
      background: var(--lj-surface);
      color: var(--lj-text);
      font: inherit;
      /* Amounts and acreages are read down a column, and digits that do not
         line up cannot be scanned (design/00-foundations.md). */
      font-variant-numeric: tabular-nums;
    }

    /* The invalid state is carried by the border AND by the message below it.
       Colour is never the only cue. */
    .field[data-invalid] .field__control {
      border-color: var(--lj-err);
      border-width: 2px;
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
export class LjField {
  readonly control = input.required<FormControl<string>>();
  readonly label = input.required<string>();
  readonly kind = input<FieldKind>('text');
  readonly options = input<readonly FieldOption[]>([]);

  /** From APPLICATION_STEP_REQUIREMENTS, never decided here. */
  readonly required = input(false);
  readonly hint = input<string | null>(null);
  readonly autocomplete = input<string | null>(null);
  readonly placeholder = input('Choose one');

  /** What a failing `pattern` validator should tell the applicant. */
  readonly formatHint = input('Check the format of this value.');

  /**
   * The control's own state, as a signal.
   *
   * A reactive form control is not a signal: `touched`, `errors` and `status`
   * are plain properties, so a `computed()` that read them would establish no
   * dependency and would never recompute. With zoneless change detection that
   * is not a slow update, it is no update at all -- the error message would
   * simply never appear. `control.events` is the observable Angular emits
   * value, status, touched and pristine changes on, and reading this signal
   * inside the computeds below is what makes them recompute.
   */
  private readonly controlState = toSignal<ControlEvent | null>(
    toObservable(this.control).pipe(switchMap((control) => control.events)),
    { initialValue: null },
  );

  protected readonly controlId = 'lj-field-' + String((sequence += 1));
  protected readonly hintId = this.controlId + '-hint';
  protected readonly problemId = this.controlId + '-problem';

  protected readonly inputType = computed(() => {
    switch (this.kind()) {
      case 'email':
        return 'email';
      case 'tel':
        return 'tel';
      default:
        // Amounts and whole numbers are text inputs on purpose: type=number
        // reports three different states as the same empty value, and its
        // spinner turns a scroll over the field into an edit (../form-fields.ts).
        return 'text';
    }
  });

  protected readonly inputMode = computed(() => {
    switch (this.kind()) {
      case 'integer':
        return 'numeric';
      case 'money':
        return 'decimal';
      case 'tel':
        return 'tel';
      case 'email':
        return 'email';
      default:
        return null;
    }
  });

  /**
   * What is wrong, in one sentence, or null.
   *
   * Format problems come from the control's own validators; "you still have to
   * answer this" comes from `[required]`, which is the domain's. Both wait for
   * `touched`, because a message about a field nobody has visited is the wall
   * of red this option exists to avoid.
   */
  protected readonly problem = computed<string | null>(() => {
    // Establishes the dependency; the value itself is not needed, because the
    // control is then read directly for all four of its states at once.
    this.controlState();
    const control = this.control();
    if (!control.touched) {
      return null;
    }
    if (control.hasError('email')) {
      return 'Enter an email address, such as name@example.test.';
    }
    if (control.hasError('money')) {
      return 'Enter an amount, such as 25000.00.';
    }
    if (control.hasError('integer')) {
      return 'Enter a whole number.';
    }
    if (control.hasError('pattern')) {
      return this.formatHint();
    }
    if (this.required() && control.value.trim() === '') {
      return 'This is needed before the application can be submitted.';
    }
    return null;
  });

  protected readonly describedBy = computed(() => {
    const ids: string[] = [];
    if (this.hint() !== null) {
      ids.push(this.hintId);
    }
    if (this.problem() !== null) {
      ids.push(this.problemId);
    }
    return ids.length === 0 ? null : ids.join(' ');
  });
}
