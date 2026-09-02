import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { RuleResult } from '@lj/domain';
import { basisPointsDelta, ruleFailed, rulePassed, ruleUnknown } from '@lj/domain';

import { LjRuleList } from './rule-list.js';

@Component({
  selector: 'lj-rule-list-host',
  imports: [LjRuleList],
  template: `
    <lj-rule-list [results]="results()" [live]="live()" [showSummary]="showSummary()" />
  `,
})
class Host {
  readonly results = signal<readonly RuleResult[]>([]);
  readonly live = signal(true);
  readonly showSummary = signal(true);
}

const passing = rulePassed({
  id: 'acreage',
  label: 'Acreage',
  explain: '120 acres, at least 40 needed.',
});

const advisory = ruleFailed({
  id: 'address-match',
  label: 'Address consistency',
  explain: 'The address on the tax bill differs from the one entered.',
  severity: 'warning',
});

const refused = ruleFailed({
  id: 'ltv',
  label: 'Loan to value',
  explain: 'The loan is larger than this land supports.',
  delta: basisPointsDelta({ actual: 8800, required: 8000 }),
});

const awaiting = ruleUnknown({
  id: 'dscr',
  label: 'Debt service coverage',
  explain: 'Enter your operating income to see this.',
  missing: ['net_operating_income'],
});

async function render(results: readonly RuleResult[]) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.results.set(results);
  await fixture.whenStable();
  return fixture;
}

function rows(fixture: { nativeElement: unknown }): HTMLElement[] {
  const root = fixture.nativeElement as HTMLElement;
  return [...root.querySelectorAll<HTMLElement>('[data-testid="rule"]')];
}

function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').trim();
}

describe('lj-rule-list', () => {
  it('renders one row per result, in the order given', async () => {
    const fixture = await render([passing, awaiting, refused]);
    const labels = rows(fixture).map((row) => textOf(row.querySelector('.rules__label')));
    expect(labels).toEqual(['Acreage', 'Debt service coverage', 'Loan to value']);
  });

  it('renders the empty case as calm rather than as a pass', async () => {
    const fixture = await render([]);
    const root = fixture.nativeElement as HTMLElement;
    expect(textOf(root.querySelector('[data-testid="empty"]'))).toBe('Nothing to check yet.');
    expect(root.querySelector('[data-testid="summary"]')).toBeNull();
  });

  const appearances: ReadonlyArray<{
    readonly name: string;
    readonly result: RuleResult;
    readonly tone: string;
    readonly glyph: string;
    readonly word: string;
  }> = [
    { name: 'a pass', result: passing, tone: 'ok', glyph: '+', word: 'Met' },
    { name: 'a blocking failure', result: refused, tone: 'err', glyph: 'x', word: 'Not met' },
    { name: 'an advisory', result: advisory, tone: 'warn', glyph: '!', word: 'Advisory' },
    { name: 'an unknown', result: awaiting, tone: 'unknown', glyph: '?', word: 'Not answered' },
  ];

  for (const appearance of appearances) {
    it('renders ' + appearance.name + ' with its own tone, glyph and word', async () => {
      const fixture = await render([appearance.result]);
      const [row] = rows(fixture);
      const pill = row?.querySelector('.pill');
      expect(pill?.getAttribute('data-tone')).toBe(appearance.tone);
      expect(textOf(pill?.querySelector('.pill__glyph'))).toBe(appearance.glyph);
      expect(textOf(pill?.querySelector('.pill__word'))).toBe(appearance.word);
    });
  }

  // The failure this component exists to prevent, asserted on the rendered DOM
  // rather than only on the map behind it: a borrower must not be able to read
  // "you have not told us yet" as "you have been refused", and the browser
  // suite's greyscale check will strip the colour that currently separates
  // them.
  it('separates an unknown from a refusal without relying on colour', async () => {
    const fixture = await render([awaiting, refused]);
    const [unknownRow, failedRow] = rows(fixture);
    const unknownPill = unknownRow?.querySelector('.pill');
    const failedPill = failedRow?.querySelector('.pill');

    expect(textOf(unknownPill?.querySelector('.pill__glyph'))).not.toBe(
      textOf(failedPill?.querySelector('.pill__glyph')),
    );
    expect(textOf(unknownPill?.querySelector('.pill__word'))).not.toBe(
      textOf(failedPill?.querySelector('.pill__word')),
    );
    expect(unknownPill?.getAttribute('data-tone')).not.toBe(failedPill?.getAttribute('data-tone'));
    // And the bodies say different things: one names what is still needed, the
    // other states the gap to passing.
    expect(unknownRow?.querySelector('[data-testid="waiting-on"]')).not.toBeNull();
    expect(unknownRow?.querySelector('[data-testid="delta"]')).toBeNull();
    expect(failedRow?.querySelector('[data-testid="waiting-on"]')).toBeNull();
    expect(failedRow?.querySelector('[data-testid="delta"]')).not.toBeNull();
  });

  it('names the inputs an unknown is waiting for', async () => {
    const fixture = await render([awaiting]);
    const [row] = rows(fixture);
    expect(textOf(row?.querySelector('[data-testid="waiting-on"]'))).toBe(
      'Waiting on: net operating income',
    );
  });

  it('renders a failure gap to passing', async () => {
    const fixture = await render([refused]);
    const [row] = rows(fixture);
    expect(textOf(row?.querySelector('[data-testid="delta"]'))).toBe(
      'Now 88%, needs 80% -- down by 8%',
    );
  });

  it('hides the glyph from assistive technology and speaks the status instead', async () => {
    const fixture = await render([awaiting]);
    const [row] = rows(fixture);
    expect(row?.querySelector('.pill__glyph')?.getAttribute('aria-hidden')).toBe('true');
    expect(textOf(row?.querySelector('.sr-only'))).toBe('Not answered yet');
  });

  describe('the summary', () => {
    it('counts blocking failures, and reports them ahead of anything unresolved', async () => {
      const fixture = await render([passing, awaiting, refused, advisory]);
      const root = fixture.nativeElement as HTMLElement;
      const summary = root.querySelector('[data-testid="summary"]');
      expect(textOf(summary)).toBe('1 criterion not met');
      expect(summary?.getAttribute('data-tone')).toBe('err');
    });

    it('reports what is still unanswered when nothing has failed', async () => {
      const fixture = await render([passing, awaiting]);
      const root = fixture.nativeElement as HTMLElement;
      const summary = root.querySelector('[data-testid="summary"]');
      expect(textOf(summary)).toBe('1 criterion still needs an answer');
      expect(summary?.getAttribute('data-tone')).toBe('unknown');
    });

    // An advisory explains; only an error blocks.
    it('reads as met when the only failure is advisory', async () => {
      const fixture = await render([passing, advisory]);
      const root = fixture.nativeElement as HTMLElement;
      const summary = root.querySelector('[data-testid="summary"]');
      expect(textOf(summary)).toBe('All criteria met');
      expect(summary?.getAttribute('data-tone')).toBe('ok');
    });

    it('can be turned off', async () => {
      const fixture = await render([passing]);
      fixture.componentInstance.showSummary.set(false);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('[data-testid="summary"]')).toBeNull();
    });
  });

  describe('the live region', () => {
    it('announces changes politely by default, because it changes while typing', async () => {
      const fixture = await render([awaiting]);
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('.rules')?.getAttribute('aria-live')).toBe('polite');
    });

    it('can be silenced for a surface that never changes under the reader', async () => {
      const fixture = await render([refused]);
      fixture.componentInstance.live.set(false);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('.rules')?.getAttribute('aria-live')).toBe('off');
    });
  });

  it('re-renders when a result changes status, which is the whole point', async () => {
    const fixture = await render([awaiting]);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.pill')?.getAttribute('data-tone')).toBe('unknown');

    fixture.componentInstance.results.set([
      rulePassed({ id: 'dscr', label: 'Debt service coverage', explain: 'Covered 1.4 times.' }),
    ]);
    await fixture.whenStable();
    expect(root.querySelector('.pill')?.getAttribute('data-tone')).toBe('ok');
  });
});
