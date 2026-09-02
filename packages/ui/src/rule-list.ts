import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { RuleResult } from '@lj/domain';
import { blockingRuleResults, overallRuleStatus, unresolvedRuleResults } from '@lj/domain';

import type { RuleRow } from './rule-presentation.js';
import { overallRulePresentation, ruleRow } from './rule-presentation.js';

/**
 * "Here is where you stand, and why" -- the one surface for it.
 *
 * Option 2's eligibility panel, Option 1's document cross-checks and the
 * blockers behind any refused transition all reduce to RuleResult[], so they
 * all render through this component. That is not only reuse: a blocked
 * transition and an unmet criterion are the same thing to the applicant, and
 * one component is what guarantees they read the same way.
 *
 * Three things this component does not do, on purpose:
 *
 * - It does not decide. The status, the severity and the gap to passing all
 *   arrive decided from packages/rules or from a workflow guard, and the counts
 *   in the summary come from @lj/domain's own folds rather than being recounted
 *   here. A rule threshold restated in a template is a second copy of a policy
 *   (CLAUDE.md sections 8 and 9).
 * - It does not sort or filter. The caller decides what belongs on the screen;
 *   reordering a list while someone is reading it is the behaviour
 *   design/00-foundations.md forbids under Motion.
 * - It emits nothing. There is no interaction here to report, and an output
 *   nobody raises is a contract the three feature scopes would have to read.
 *
 * Accessibility, from design/00-foundations.md: the region is aria-live so a
 * screen reader hears results change while the applicant types, each pill
 * carries a glyph and a word as well as a colour, and the glyph is hidden from
 * assistive technology in favour of the spoken form beside it.
 */
@Component({
  selector: 'lj-rule-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'lj-rule-list' },
  template: `
    <section
      class="rules"
      [attr.aria-live]="ariaLive()"
      [attr.aria-label]="heading() ?? 'Criteria'"
    >
      @if (heading(); as text) {
        <h3 class="rules__heading">{{ text }}</h3>
      }

      <!-- No summary over an empty set. The domain folds it to 'pass' because
           nothing disqualifies, which is correct and would read here as "all
           criteria met" above a list with no criteria in it. -->
      @if (showSummary() && rows().length > 0) {
        <p class="rules__summary" [attr.data-tone]="summaryTone()" data-testid="summary">
          {{ summaryText() }}
        </p>
      }

      @if (rows().length === 0) {
        <p class="rules__empty" data-testid="empty">Nothing to check yet.</p>
      } @else {
        <ul class="rules__list">
          @for (row of rows(); track row.id) {
            <li class="rules__item" [attr.data-status]="row.presentation.tone" data-testid="rule">
              <span class="pill" [attr.data-tone]="row.presentation.tone">
                <span class="pill__glyph" aria-hidden="true">{{ row.presentation.glyph }}</span>
                <span class="pill__word">{{ row.presentation.word }}</span>
                <span class="sr-only">{{ row.presentation.spoken }}</span>
              </span>
              <span class="rules__body">
                <span class="rules__label">{{ row.label }}</span>
                <span class="rules__explain">{{ row.explain }}</span>
                @if (row.waitingOn; as fields) {
                  <span class="rules__aside" data-testid="waiting-on">Waiting on: {{ fields }}</span>
                }
                @if (row.delta; as gap) {
                  <span class="rules__aside rules__aside--figures" data-testid="delta">{{ gap }}</span>
                }
              </span>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    /* Colour comes only from design/tokens.json, through the variables
       packages/ui/tokens/_tokens.css emits. A hex here would be a second,
       undocumented theme (design/00-foundations.md). The sizes and spacings are
       the scales in that same document: 4px steps, and the type roles small,
       micro and body. */
    :host {
      display: block;
      color: var(--lj-text);
      font-size: 14px;
      line-height: 21px;
    }

    .rules {
      background: var(--lj-surface);
      border: 1px solid var(--lj-border);
      border-radius: 8px;
      padding: 16px;
    }

    .rules__heading {
      margin: 0 0 8px;
      font-size: 20px;
      line-height: 28px;
      font-weight: 600;
    }

    .rules__summary {
      margin: 0 0 12px;
      font-size: 12.5px;
      line-height: 18px;
      font-weight: 600;
    }

    .rules__list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .rules__item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .rules__body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .rules__label {
      font-weight: 600;
    }

    .rules__explain,
    .rules__aside {
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }

    /* All money and all ratios are tabular: a column of figures whose digits do
       not line up cannot be scanned (design/00-foundations.md). */
    .rules__aside--figures {
      font-variant-numeric: tabular-nums;
      color: var(--lj-text);
    }

    .rules__empty {
      margin: 0;
      color: var(--lj-muted);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex: none;
      border: 1px solid;
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      line-height: 14px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      /* A rule changing status animates its ground, never its position: a list
         that reflows while someone is typing is a list they cannot read. */
      transition: background-color 150ms ease-out, color 150ms ease-out;
    }

    .pill__glyph {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-weight: 700;
    }

    .pill[data-tone='ok'] {
      color: var(--lj-ok);
      background: var(--lj-ok-subtle);
      border-color: var(--lj-ok);
    }

    .pill[data-tone='warn'] {
      color: var(--lj-warn);
      background: var(--lj-warn-subtle);
      border-color: var(--lj-warn);
    }

    .pill[data-tone='err'] {
      color: var(--lj-err);
      background: var(--lj-err-subtle);
      border-color: var(--lj-err);
    }

    /* The dashed edge is the third non-colour cue that separates "not answered
       yet" from "refused", after the glyph and the word. It also reads as
       provisional, which is what the status means. */
    .pill[data-tone='unknown'] {
      color: var(--lj-unknown);
      background: var(--lj-unknown-subtle);
      border-color: var(--lj-border-strong);
      border-style: dashed;
    }

    .rules__summary[data-tone='ok'] {
      color: var(--lj-ok);
    }
    .rules__summary[data-tone='err'] {
      color: var(--lj-err);
    }
    .rules__summary[data-tone='unknown'] {
      color: var(--lj-unknown);
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

    @media (prefers-reduced-motion: reduce) {
      .pill {
        transition-duration: 0ms;
      }
    }
  `,
})
export class LjRuleList {
  /** Rendered in the order given. The caller owns what is on the screen. */
  readonly results = input.required<readonly RuleResult[]>();

  /** Optional section title. Doubles as the region's accessible name. */
  readonly heading = input<string | null>(null);

  /**
   * On by default because the panel's own reason to exist is that it changes
   * while the applicant types. A surface that renders a fixed set of blockers
   * -- a lender reading a refused transition -- turns it off so the reader is
   * not interrupted by a region that never changes.
   */
  readonly live = input(true);

  readonly showSummary = input(true);

  protected readonly rows = computed<readonly RuleRow[]>(() => this.results().map(ruleRow));

  protected readonly ariaLive = computed(() => (this.live() ? 'polite' : 'off'));

  private readonly overall = computed(() => overallRuleStatus(this.results()));

  protected readonly summaryTone = computed(() => overallRulePresentation(this.overall()).tone);

  protected readonly summaryText = computed(() => {
    const results = this.results();
    const blocking = blockingRuleResults(results).length;
    if (blocking > 0) {
      return blocking === 1 ? '1 criterion not met' : String(blocking) + ' criteria not met';
    }
    const unresolved = unresolvedRuleResults(results).length;
    if (unresolved > 0) {
      return unresolved === 1
        ? '1 criterion still needs an answer'
        : String(unresolved) + ' criteria still need an answer';
    }
    return 'All criteria met';
  });
}
