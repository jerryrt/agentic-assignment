import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Money } from '@lj/domain';
import { moneyFromMinorUnits } from '@lj/domain';

import { LjMoney } from './money.ts';

@Component({
  selector: 'lj-money-host',
  imports: [LjMoney],
  template: `
    <lj-money [amount]="amount()" [symbol]="symbol()" [signDisplay]="signDisplay()" />
  `,
})
class Host {
  readonly amount = signal<Money>(moneyFromMinorUnits(0));
  readonly symbol = signal('$');
  readonly signDisplay = signal<'auto' | 'always' | 'never'>('auto');
}

async function render(amount: number, options: { symbol?: string; sign?: 'auto' | 'always' | 'never' } = {}) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.amount.set(moneyFromMinorUnits(amount));
  if (options.symbol !== undefined) {
    fixture.componentInstance.symbol.set(options.symbol);
  }
  if (options.sign !== undefined) {
    fixture.componentInstance.signDisplay.set(options.sign);
  }
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return (root.querySelector('lj-money')?.textContent ?? '').trim();
}

describe('lj-money', () => {
  it('renders minor units at full scale, grouped', async () => {
    expect(await render(123_456_789)).toBe('$1,234,567.89');
  });

  it('keeps the cent a float multiplication would have lost', async () => {
    // 0.29 and 1.15 are the cases packages/domain/src/money.ts exists for.
    expect(await render(29)).toBe('$0.29');
    expect(await render(115)).toBe('$1.15');
  });

  it('puts the sign outside the symbol', async () => {
    expect(await render(-5000)).toBe('-$50.00');
  });

  it('can show a plus, for a ledger of draws and repayments', async () => {
    expect(await render(5000, { sign: 'always' })).toBe('+$50.00');
  });

  it('can render a magnitude for a column whose heading carries the direction', async () => {
    expect(await render(-5000, { sign: 'never' })).toBe('$50.00');
  });

  it('can render a bare figure', async () => {
    expect(await render(5000, { symbol: '' })).toBe('50.00');
  });

  it('follows the amount when it changes', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.amount.set(moneyFromMinorUnits(100));
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect((root.querySelector('lj-money')?.textContent ?? '').trim()).toBe('$1.00');

    fixture.componentInstance.amount.set(moneyFromMinorUnits(250));
    await fixture.whenStable();
    expect((root.querySelector('lj-money')?.textContent ?? '').trim()).toBe('$2.50');
  });
});
