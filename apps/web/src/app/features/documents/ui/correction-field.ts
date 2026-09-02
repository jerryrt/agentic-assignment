import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { humaniseFieldName } from '@lj/rules';

/**
 * One field the extractor could not read, and the box to type it into.
 *
 * THIS IS THE THIRD COPY OF A FIELD COMPONENT IN THIS APPLICATION, and that is
 * a problem rather than a solution. `core/auth/auth-field.ts` and
 * `features/apply/ui/field.ts` are the other two, and CLAUDE.md section 9 says
 * plainly that the third occurrence is when one belongs in `packages/ui` with
 * all three callers moved onto it. `packages/ui` is the design-system scope's
 * (issue #12) and `features/apply` is another feature's, so neither is this
 * scope's to edit: the promotion is RAISED on #43 and #12 rather than done
 * here, and this file is the minimum needed in the meantime.
 *
 * "Minimum" still includes the accessibility floor, because that is the part
 * that is invisible when it is missing: a `<label for>` bound to a generated
 * id, a hint joined to the control through `aria-describedby`, and a submit
 * that is disabled rather than silently ignored while the box is empty.
 *
 * It holds the typed value locally and emits only on submit. A correction is a
 * write through the API (../intake.ts), so emitting per keystroke would put a
 * request behind every character.
 */

let sequence = 0;

@Component({
  selector: 'lj-correction-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="correction">
      <label class="correction__label" [attr.for]="controlId">
        {{ readableName() }}
      </label>
      <p class="correction__hint" [id]="hintId">
        Read it off the document and type it exactly as it appears.
      </p>
      <div class="correction__row">
        <input
          class="correction__control"
          type="text"
          [id]="controlId"
          [attr.aria-describedby]="hintId"
          [value]="typed()"
          (input)="onInput($event)"
          [attr.data-testid]="'correct-' + field()"
        />
        <button
          class="lj-button"
          type="button"
          [disabled]="typed().trim() === '' || busy()"
          (click)="submit()"
          [attr.data-testid]="'correct-save-' + field()"
        >
          Save it
        </button>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .correction {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .correction__label {
      font-size: 12.5px;
      line-height: 18px;
      font-weight: 600;
      color: var(--lj-text);
    }

    .correction__hint {
      margin: 0;
      font-size: 12.5px;
      line-height: 18px;
      color: var(--lj-muted);
    }

    .correction__row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .correction__control {
      flex: 1 1 auto;
      min-width: 0;
      padding: 8px;
      border: 1px solid var(--lj-border);
      border-radius: 6px;
      background: var(--lj-surface);
      color: var(--lj-text);
      font: inherit;
      /* Figures are read down a column; digits that do not line up cannot be
         scanned (design/00-foundations.md). */
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class LjCorrectionField {
  /** The extracted field's name, as the slot declares it. */
  readonly field = input.required<string>();

  /** True while a correction is in flight, so it cannot be sent twice. */
  readonly busy = input(false);

  readonly corrected = output<string>();

  protected readonly controlId = 'lj-correction-' + String((sequence += 1));
  protected readonly hintId = this.controlId + '-hint';

  protected readonly typed = signal('');

  /** 'net_farm_income' as a person reads it. @lj/rules owns the wording. */
  protected readableName(): string {
    return humaniseFieldName(this.field());
  }

  protected onInput(event: Event): void {
    const target = event.target;
    this.typed.set(target instanceof HTMLInputElement ? target.value : '');
  }

  protected submit(): void {
    const value = this.typed().trim();
    if (value === '') {
      return;
    }
    this.corrected.emit(value);
  }
}
