import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  viewChild,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, type ControlEvent, type FormControl } from '@angular/forms';
import { switchMap } from 'rxjs';

/**
 * One field on the sign-in and sign-up screens: its label, its control, and
 * what is wrong with it.
 *
 * The screens used to say nothing when they refused to submit. `submit()`
 * called `markAllAsTouched()` and returned, and nothing rendered the touched
 * state, so a sighted user saw a button that appeared not to work and a screen
 * reader user was told nothing whatsoever (issue #36). Three fields across two
 * screens is three places to wire a message, an `aria-describedby` and an
 * `aria-invalid` consistently, and the one that gets forgotten is never the one
 * anybody notices -- so they are wired here, once.
 *
 * The label becomes an explicit `for`/`id` pair rather than staying the
 * wrapping `<label>` it was. The wrapping form was correct and the accessible
 * names were right, so this is not a fix; it is a consequence. The message has
 * to sit outside the label, because text inside one becomes part of the
 * control's accessible NAME -- the field would announce itself as "Email Enter
 * an email address, such as name@example.test" instead of announcing "Email"
 * and then describing the problem.
 *
 * A message waits for `touched`. Telling someone a field is needed before they
 * have had a chance to fill it in is a wall of red on an empty form.
 *
 * NOT the same component as `features/apply/ui/field.ts`, and deliberately not
 * shared with it. That one renders seven control kinds and takes its
 * required-ness from `APPLICATION_STEP_REQUIREMENTS`, none of which these three
 * fields want, and `core/` may not import from `features/` in any case. This is
 * the second occurrence of the pattern and CLAUDE.md section 9 says not to
 * abstract on the second; the third belongs in `packages/ui`, with both callers
 * moved onto it.
 */

let sequence = 0;

@Component({
  selector: 'lj-auth-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <div class="auth-field">
      <label class="auth-field__label" [attr.for]="controlId">{{ label() }}</label>
      <input
        #control
        class="auth-field__control"
        [id]="controlId"
        [type]="type()"
        [attr.name]="name()"
        [attr.autocomplete]="autocomplete()"
        [attr.data-testid]="testId()"
        [formControl]="field()"
        [attr.aria-describedby]="problem() === null ? null : problemId"
        [attr.aria-invalid]="problem() === null ? null : 'true'"
      />
      @if (problem(); as message) {
        <p class="auth-field__problem" [id]="problemId" data-testid="field-problem">
          {{ message }}
        </p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin-bottom: 16px;
    }

    .auth-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .auth-field__label {
      font-size: 13px;
      font-weight: 600;
      color: var(--lj-muted);
    }

    .auth-field__control {
      width: 100%;
      padding: 9px 11px;
      border: 1px solid var(--lj-border-strong);
      border-radius: 6px;
      background: var(--lj-bg);
      color: var(--lj-text);
      font: inherit;
    }

    /* The border is the second cue and the sentence below is the third, so the
       state is never carried by colour alone (design/00-foundations.md). */
    .auth-field__control[aria-invalid] {
      border-color: var(--lj-err);
      border-width: 2px;
    }

    .auth-field__problem {
      margin: 0;
      font-size: 13px;
      color: var(--lj-err);
    }
  `,
})
export class LjAuthField {
  readonly field = input.required<FormControl<string>>();
  readonly label = input.required<string>();
  readonly type = input<'text' | 'email' | 'password'>('text');
  readonly name = input<string | null>(null);
  readonly autocomplete = input<string | null>(null);
  readonly testId = input<string | null>(null);

  private readonly element = viewChild.required<ElementRef<HTMLInputElement>>('control');

  protected readonly controlId = 'lj-auth-field-' + String((sequence += 1));
  protected readonly problemId = this.controlId + '-problem';

  /**
   * The control's state, as a signal.
   *
   * `touched`, `errors` and `status` are plain properties on a reactive form
   * control, so a `computed()` that read them would establish no dependency and
   * never recompute. Under zoneless change detection that is not a late update
   * but no update at all -- the message would simply never appear.
   */
  private readonly state = toSignal<ControlEvent | null>(
    toObservable(this.field).pipe(switchMap((control) => control.events)),
    { initialValue: null },
  );

  /** True once the control has been visited and is not acceptable. */
  readonly isAtFault = computed(() => this.problem() !== null);

  /**
   * What is wrong, in one sentence, or null.
   *
   * The three messages cover the three validators these screens use. A fourth
   * validator with no message here would render as a silent refusal again, so
   * the fallback names the field rather than saying nothing.
   */
  protected readonly problem = computed<string | null>(() => {
    this.state();
    const control = this.field();
    if (!control.touched || control.valid) {
      return null;
    }
    if (control.hasError('required')) {
      return 'Enter your ' + this.label().toLowerCase() + '.';
    }
    if (control.hasError('email')) {
      return 'Enter an email address, such as name@example.test.';
    }
    const minimum: unknown = control.getError('minlength');
    if (typeof minimum === 'object' && minimum !== null) {
      const required = (minimum as { requiredLength?: unknown }).requiredLength;
      if (typeof required === 'number') {
        return 'Use at least ' + String(required) + ' characters.';
      }
    }
    return 'Check your ' + this.label().toLowerCase() + '.';
  });

  /** Put the caret here. The page calls this on the first field at fault. */
  focus(): void {
    this.element().nativeElement.focus();
  }
}
