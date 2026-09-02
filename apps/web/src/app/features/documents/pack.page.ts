import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ACCEPTED_UPLOAD_MIME_TYPES, formatBasisPointsAsPercentage } from '@lj/domain';
import { LjRuleList, LjStateBadge } from '@lj/ui';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { DocumentPackStore, type DocumentSlotRow } from './document-pack.store.ts';
import { isBorrowerAction } from './pack.ts';
import { LjCorrectionField } from './ui/correction-field.ts';

/**
 * The borrower's document pack: where they stand, and what to do next.
 *
 * plan/04's four honesty rules ARE this screen, and each of them is kept
 * somewhere it can be tested rather than in this template:
 *
 * 1. The bar is `store.progress()`, which is `documentPackProgress` over the
 *    same rule results the checklist renders. Nothing here counts slots, so
 *    the bar and the list cannot disagree, and a document that uploads and
 *    then fails never moved it forward to begin with.
 * 2. Missing, stale and unreadable stay three failures with three different
 *    next actions. The verdicts come from `evaluateCompleteness` and the
 *    controls from `nextActionFor` (./pack.ts), whose branch order mirrors it.
 * 3. Every button says what to do -- "Upload a current one" -- and never what
 *    is wrong. The wording lives in ./pack.ts, under test.
 * 4. The cross-checks render through `<lj-rule-list>`, which already draws a
 *    result's two figures, its gap and its tolerance. There is no second
 *    renderer here and no tolerance restated.
 *
 * WHY THE CONTROLS ARE NOT INSIDE `<lj-rule-list>`. That component renders
 * verdicts and, by its own header, "emits nothing ... an output nobody raises
 * is a contract the three feature scopes would have to read". Putting buttons
 * in it would either fork it or make every caller carry an action contract, so
 * the checklist is the rule list and the controls are a list beside it -- both
 * computed from the same `rows()`, so they cannot fall out of step. A second
 * copy of the rule renderer is the thing that was worth avoiding, and it was.
 *
 * NO REALTIME, deliberately. plan/04 wants a `document_slot` subscription so a
 * lender's acceptance reaches this screen without a refresh, and plan/07 puts
 * the channel factory in `core/realtime/` -- which does not exist. Building
 * one inside a feature is the most expensive failure docs/03-agent-scopes.md
 * names, so this ships without it and it is raised on #43 and #19 instead.
 *
 * NOT RENDER-TESTED, and not because it does not matter: an `apps/web` unit
 * test cannot instantiate an @lj/ui component (issue #33 -- the test builder
 * pre-bundles the package, so `[results]` arrives with no input metadata and
 * throws NG0950). Every decision behind this template is therefore a function
 * in ./pack.ts or a signal on ./document-pack.store.ts, both under test, and
 * the rendering itself belongs to the browser suite (#14).
 */
@Component({
  selector: 'lj-document-pack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LjRuleList, LjStateBadge, LjCorrectionField],
  template: `
    <div class="lj-page pack">
      @if (store.isLoading() && store.value() === null) {
        <p role="status">Reading your documents...</p>
      } @else if (store.value() === null && store.failure(); as failure) {
        <div class="lj-notice lj-notice--error" role="alert">
          <h1>These documents could not be opened</h1>
          <p>{{ failure.message }}</p>
          <a class="lj-button" routerLink="/apply">Back to your applications</a>
        </div>
      } @else if (store.value(); as pack) {
        <header class="pack__header">
          <div class="pack__title">
            <h1>Your documents</h1>
            <lj-state-badge
              [subject]="{ machine: 'application', state: pack.applicationState }"
              [audience]="auth.audience()"
            />
          </div>

          <div class="pack__progress">
            <p class="pack__count" data-testid="pack-progress">
              Your file is {{ store.progress().accepted }} of {{ store.progress().total }}
              complete
            </p>
            <progress
              class="pack__bar"
              [value]="store.progress().accepted"
              [max]="store.progress().total"
              [attr.aria-label]="'Documents accepted: ' + percentage()"
            ></progress>
            <span class="pack__percent">{{ percentage() }}</span>
          </div>

          <p class="pack__attention" data-testid="pack-attention">{{ attention() }}</p>
        </header>

        @if (store.refusal(); as refused) {
          <p class="lj-notice lj-notice--warn" role="alert" data-testid="pack-refusal">
            {{ refused }}
          </p>
        }

        @if (store.failure(); as failure) {
          <p class="lj-notice lj-notice--error" role="alert" data-testid="pack-failure">
            {{ failure.message }}
          </p>
        }

        <lj-rule-list
          [results]="store.completeness()"
          heading="What your lender asked for"
          data-testid="pack-checklist"
        />

        @if (outstanding().length > 0) {
          <section class="pack__todo" aria-labelledby="pack-todo-heading">
            <h2 id="pack-todo-heading">What to do next</h2>
            <ul class="pack__todo-list">
              @for (row of outstanding(); track row.slot.id) {
                <li class="pack__todo-item" [attr.data-slot]="row.slot.code">
                  <div class="pack__todo-head">
                    <span class="pack__todo-label">{{ row.slot.label }}</span>
                    <span class="pack__todo-explain">{{ row.result.explain }}</span>
                  </div>

                  <label class="pack__file">
                    <span class="pack__file-label">{{ row.action.label }}</span>
                    <input
                      type="file"
                      [accept]="accept"
                      [disabled]="store.isSaving()"
                      (change)="pick(row, $event)"
                      [attr.data-testid]="'upload-' + row.slot.code"
                    />
                  </label>

                  @if (row.action.kind === 'correct') {
                    <div class="pack__corrections">
                      <p class="pack__corrections-lead">
                        Or read the value off the document and type it in -- a value a person
                        confirms is taken as read.
                      </p>
                      @for (field of row.action.fields; track field) {
                        <lj-correction-field
                          [field]="field"
                          [busy]="store.isSaving()"
                          (corrected)="correct(row, field, $event)"
                        />
                      }
                    </div>
                  }
                </li>
              }
            </ul>
          </section>
        }

        <lj-rule-list
          [results]="store.crossChecks()"
          heading="Cross-checks"
          [live]="false"
          data-testid="pack-cross-checks"
        />
      }
    </div>
  `,
  styles: `
    .pack {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .pack__header,
    .pack__title,
    .pack__progress {
      display: flex;
      gap: 12px;
    }

    .pack__header {
      flex-direction: column;
      gap: 8px;
    }

    .pack__title {
      align-items: center;
    }

    .pack__title h1 {
      margin: 0;
    }

    .pack__progress {
      align-items: center;
    }

    .pack__count,
    .pack__attention,
    .pack__percent {
      margin: 0;
    }

    .pack__percent {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }

    .pack__attention {
      color: var(--lj-muted);
    }

    .pack__bar {
      flex: 0 1 240px;
      height: 8px;
    }

    .pack__todo {
      background: var(--lj-surface);
      border: 1px solid var(--lj-border);
      border-radius: 8px;
      padding: 16px;
    }

    .pack__todo h2 {
      margin: 0 0 12px;
      font-size: 20px;
      line-height: 28px;
    }

    .pack__todo-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .pack__todo-item {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 16px;
      border-top: 1px solid var(--lj-border);
    }

    .pack__todo-item:first-child {
      padding-top: 0;
      border-top: 0;
    }

    .pack__todo-head {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .pack__todo-label {
      font-weight: 600;
    }

    .pack__todo-explain,
    .pack__corrections-lead {
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
      margin: 0;
    }

    .pack__file {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .pack__file-label {
      font-size: 12.5px;
      line-height: 18px;
      font-weight: 600;
    }

    .pack__corrections {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-left: 12px;
      border-left: 2px solid var(--lj-border);
    }
  `,
})
export class DocumentPackPage {
  /**
   * Bound from `/apply/:id/documents` by `withComponentInputBinding()`. The
   * route above this one is component-less, so its parameters are inherited
   * here under Angular's default `emptyOnly` strategy.
   */
  readonly id = input.required<string>();

  protected readonly store = inject(DocumentPackStore);
  protected readonly auth = inject(SupabaseAuthService);

  /** What a file picker will offer. The list is @lj/domain's, not a second one. */
  protected readonly accept = ACCEPTED_UPLOAD_MIME_TYPES.join(',');

  /** Re-read whenever the address bar names a different application. */
  private readonly opened = signal<string | null>(null);

  protected readonly percentage = computed(() =>
    formatBasisPointsAsPercentage(this.store.progress().basisPoints),
  );

  /**
   * The rows the borrower can act on.
   *
   * A document sitting with the lender is deliberately not among them: it is
   * outstanding, and there is nothing they can do about it.
   */
  protected readonly outstanding = computed<readonly DocumentSlotRow[]>(() =>
    this.store.rows().filter((row) => isBorrowerAction(row.action)),
  );

  protected readonly attention = computed(() => {
    const count = this.outstanding().length;
    if (count === 0) {
      return this.store.isComplete()
        ? 'Nothing is outstanding. Your lender has everything they asked for.'
        : 'Nothing needs you right now -- your lender is reading what you sent.';
    }
    return count === 1
      ? '1 thing needs your attention'
      : String(count) + ' things need your attention';
  });

  constructor() {
    // I/O, which is what `effect` is reserved for (plan/07). The read is keyed
    // on the route parameter rather than run once, so following a link from
    // one application's pack to another's re-reads instead of showing the
    // previous one.
    effect(() => {
      const applicationId = this.id();
      if (this.opened() === applicationId) {
        return;
      }
      this.opened.set(applicationId);
      void this.store.open(applicationId);
    });
  }

  protected async pick(row: DocumentSlotRow, event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const file = input.files?.[0];
    // Cleared so that picking the same file again after a refusal still fires
    // a change event; a picker that silently ignores the second attempt is
    // indistinguishable from one that is broken.
    input.value = '';
    if (file === undefined) {
      return;
    }
    await this.store.upload(row.slot.id, file);
  }

  protected async correct(row: DocumentSlotRow, field: string, value: string): Promise<void> {
    await this.store.correct(row.slot.id, field, value);
  }
}
