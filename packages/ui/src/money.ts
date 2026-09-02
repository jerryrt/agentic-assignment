import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Money } from '@lj/domain';
import { formatMoney } from '@lj/domain';

/**
 * An amount, formatted once and aligned.
 *
 * The formatting is @lj/domain's, not this component's. formatMoney lives down
 * there because the API renders amounts into rule explanations too, and two
 * formatters would eventually disagree about a negative sign
 * (packages/domain/src/money.ts). It deliberately does not use
 * Intl.NumberFormat: Intl takes a float, which is the one thing the money type
 * exists to avoid, and its output varies with the environment's locale.
 *
 * What this component adds is the part that is presentation: tabular figures.
 * A ledger column whose digits do not line up cannot be scanned, and this
 * application is mostly figures (design/00-foundations.md).
 */
@Component({
  selector: 'lj-money',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'lj-money' },
  template: `{{ text() }}`,
  styles: `
    :host {
      font-variant-numeric: tabular-nums;
      font-weight: 500;
      white-space: nowrap;
    }
  `,
})
export class LjMoney {
  /** Integer minor units, branded. A raw number will not compile. */
  readonly amount = input.required<Money>();

  /** Pass '' for a bare figure in a column whose heading carries the unit. */
  readonly symbol = input('$');

  /**
   * 'always' is what a ledger of draws and repayments needs; 'never' is for a
   * column whose heading already states the direction.
   */
  readonly signDisplay = input<'auto' | 'always' | 'never'>('auto');

  protected readonly text = computed(() =>
    formatMoney(this.amount(), { symbol: this.symbol(), signDisplay: this.signDisplay() }),
  );
}
