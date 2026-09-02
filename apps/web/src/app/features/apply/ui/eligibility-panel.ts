import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LjRuleList } from '@lj/ui';

import { ApplicationStore } from '../application.store.ts';

/**
 * "Here is where you stand, and why", updating as the applicant types.
 *
 * The panel is the half of Option 2 that the brief's "rules that change what
 * the user sees as they go" is actually about, and almost none of it is in this
 * file. Every row is a `RuleResult` decided by packages/rules and drawn by
 * `<lj-rule-list>` from @lj/ui; this component chooses what belongs on the
 * screen and in what order, and nothing else. It compares no threshold, counts
 * nothing, and formats no figure.
 *
 * Two sections, and the split is deliberate. Progress answers "have I finished"
 * and eligibility answers "do I qualify", and running them together is how a
 * form ends up telling someone they do not qualify when the truth is that they
 * have not finished. `<lj-rule-list>` already separates 'unknown' from 'fail'
 * four ways over; keeping the two lists apart is the same distinction one level
 * up.
 *
 * Only the eligibility list is a live region. Two `aria-live` regions on one
 * screen both announcing on every keystroke is a screen reader nobody can use;
 * the progress list is read on demand, which is how it is used.
 */
@Component({
  selector: 'lj-eligibility-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LjRuleList],
  template: `
    <aside class="panel" aria-labelledby="eligibility-heading">
      <h2 class="panel__heading" id="eligibility-heading">Where you stand</h2>

      <lj-rule-list
        [results]="match()"
        [live]="true"
        [showSummary]="false"
        heading="Do you qualify?"
      />

      @for (product of store.eligibility(); track product.productId) {
        <lj-rule-list [results]="product.results" [live]="false" [heading]="product.productName" />
      }

      @if (store.products().length === 0) {
        <p class="panel__note">
          No products could be read for this lender, so nothing can be matched yet.
        </p>
      }

      <lj-rule-list
        [results]="store.completeness()"
        [live]="false"
        heading="Your progress"
      />
    </aside>
  `,
  styles: `
    :host {
      display: block;
    }

    .panel {
      display: flex;
      flex-direction: column;
      gap: 16px;
      /* Sticky, because the whole point is that it is visible while the form
         beside it is being filled in. */
      position: sticky;
      top: 16px;
    }

    .panel__heading {
      margin: 0;
      font-size: 20px;
      line-height: 28px;
    }

    .panel__note {
      margin: 0;
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
    }
  `,
})
export class LjEligibilityPanel {
  protected readonly store = inject(ApplicationStore);

  /** One row, because <lj-rule-list> renders a list and this is the headline. */
  protected readonly match = computed(() => [this.store.eligibilityMatch()]);
}
