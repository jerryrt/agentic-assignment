import type { RuleDelta, RuleSeverity, RuleStatus } from '@lj/domain';
import {
  acresDelta,
  basisPointsDelta,
  countDelta,
  moneyDelta,
  moneyFromMinorUnits,
  ruleFailed,
  rulePassed,
  ruleUnknown,
  yearsDelta,
} from '@lj/domain';

import {
  formatMissingInputs,
  formatRuleDelta,
  overallRulePresentation,
  ruleRow,
  rulePresentation,
} from './rule-presentation.ts';

describe('rulePresentation', () => {
  // The whole point of the table is that it is exhaustive: every combination
  // the domain can produce has exactly one appearance, and adding a status
  // without adding a row here fails rather than rendering a blank pill.
  const cases: ReadonlyArray<{
    readonly status: RuleStatus;
    readonly severity: RuleSeverity;
    readonly tone: string;
    readonly glyph: string;
    readonly blocking: boolean;
  }> = [
    { status: 'pass', severity: 'error', tone: 'ok', glyph: '+', blocking: false },
    { status: 'pass', severity: 'warning', tone: 'ok', glyph: '+', blocking: false },
    { status: 'fail', severity: 'error', tone: 'err', glyph: 'x', blocking: true },
    { status: 'fail', severity: 'warning', tone: 'warn', glyph: '!', blocking: false },
    { status: 'unknown', severity: 'error', tone: 'unknown', glyph: '?', blocking: false },
    { status: 'unknown', severity: 'warning', tone: 'unknown', glyph: '?', blocking: false },
  ];

  for (const testCase of cases) {
    it(testCase.status + '/' + testCase.severity + ' reads as ' + testCase.tone, () => {
      const presentation = rulePresentation(testCase);
      expect(presentation.tone).toBe(testCase.tone);
      expect(presentation.glyph).toBe(testCase.glyph);
      expect(presentation.blocking).toBe(testCase.blocking);
    });
  }

  it('gives every status a distinct glyph, so greyscale still separates them', () => {
    const glyphs = cases.map((testCase) => rulePresentation(testCase).glyph);
    expect(new Set(glyphs).size).toBe(4);
  });

  it('gives every status a distinct word, so a glyph is not the only non-colour cue', () => {
    const words = cases.map((testCase) => rulePresentation(testCase).word);
    expect(new Set(words).size).toBe(4);
  });

  // The failure this component exists to prevent: an applicant reading "we have
  // not asked you yet" as "you have been refused".
  it('separates unknown from a blocking failure on every channel, not only colour', () => {
    const waiting = rulePresentation({ status: 'unknown', severity: 'error' });
    const refused = rulePresentation({ status: 'fail', severity: 'error' });
    expect(waiting.glyph).not.toBe(refused.glyph);
    expect(waiting.word).not.toBe(refused.word);
    expect(waiting.spoken).not.toBe(refused.spoken);
    expect(waiting.blocking).toBe(false);
    expect(refused.blocking).toBe(true);
  });

  it('treats a warning as advisory rather than as a refusal', () => {
    expect(rulePresentation({ status: 'fail', severity: 'warning' }).blocking).toBe(false);
  });
});

describe('overallRulePresentation', () => {
  it('reads a fold of pass as met', () => {
    expect(overallRulePresentation('pass').tone).toBe('ok');
  });

  it('reads a fold of unknown as awaiting, not as a refusal', () => {
    expect(overallRulePresentation('unknown').tone).toBe('unknown');
    expect(overallRulePresentation('unknown').blocking).toBe(false);
  });

  it('reads a fold of fail as blocking', () => {
    expect(overallRulePresentation('fail').tone).toBe('err');
    expect(overallRulePresentation('fail').blocking).toBe(true);
  });
});

describe('formatRuleDelta', () => {
  const money = (minorUnits: number) => moneyFromMinorUnits(minorUnits);

  it('renders a money gap through the domain formatter, grouped and at full scale', () => {
    const delta = moneyDelta({ actual: money(16_400_000), required: money(19_400_000) });
    expect(formatRuleDelta(delta)).toBe(
      'Now $164,000.00, needs $194,000.00 -- up by $30,000.00',
    );
  });

  it('renders a basis-point gap as a percentage, which is what the unit means', () => {
    const delta = basisPointsDelta({ actual: 8800, required: 8000 });
    expect(formatRuleDelta(delta)).toBe('Now 88%, needs 80% -- down by 8%');
  });

  it('names the direction rather than relying on a sign the shortfall never has', () => {
    const up = countDelta({ actual: 1, required: 3 });
    const down = countDelta({ actual: 3, required: 1 });
    expect(up.shortfall).toBe(2);
    expect(down.shortfall).toBe(2);
    expect(formatRuleDelta(up)).toContain('up by 2');
    expect(formatRuleDelta(down)).toContain('down by 2');
  });

  it('singularises a unit of one', () => {
    expect(formatRuleDelta(yearsDelta({ actual: 1, required: 2 }))).toBe(
      'Now 1 year, needs 2 years -- up by 1 year',
    );
    expect(formatRuleDelta(acresDelta({ actual: 1, required: 5 }))).toBe(
      'Now 1 acre, needs 5 acres -- up by 4 acres',
    );
  });

  it('drops the gap clause when there is no gap', () => {
    expect(formatRuleDelta(countDelta({ actual: 4, required: 4 }))).toBe('Now 4, needs 4');
  });

  it('falls back to the raw figure rather than throwing inside a template', () => {
    // Money that does not fit numeric(14,2). A thrown RangeError during change
    // detection blanks the screen; a readable-but-unformatted number does not.
    const outOfRange: RuleDelta = {
      unit: 'money_minor_units',
      actual: 0,
      required: Number.MAX_SAFE_INTEGER,
      shortfall: Number.MAX_SAFE_INTEGER,
      direction: 'increase',
    };
    expect(() => formatRuleDelta(outOfRange)).not.toThrow();
    expect(formatRuleDelta(outOfRange)).toContain(String(Number.MAX_SAFE_INTEGER));
  });
});

describe('formatMissingInputs', () => {
  it('turns field names into words without renaming the field', () => {
    expect(formatMissingInputs(['annual_revenue', 'land_acres'])).toBe(
      'annual revenue, land acres',
    );
  });
});

describe('ruleRow', () => {
  it('carries what an unknown is waiting for and no delta', () => {
    const row = ruleRow(
      ruleUnknown({
        id: 'dscr',
        label: 'Debt service coverage',
        explain: 'Enter your operating income to see this.',
        missing: ['net_operating_income'],
      }),
    );
    expect(row.waitingOn).toBe('net operating income');
    expect(row.delta).toBeNull();
    expect(row.presentation.tone).toBe('unknown');
  });

  it('carries a failure gap and nothing it is waiting for', () => {
    const row = ruleRow(
      ruleFailed({
        id: 'ltv',
        label: 'Loan to value',
        explain: 'The loan is larger than this land supports.',
        delta: basisPointsDelta({ actual: 8800, required: 8000 }),
      }),
    );
    expect(row.waitingOn).toBeNull();
    expect(row.delta).toBe('Now 88%, needs 80% -- down by 8%');
    expect(row.presentation.tone).toBe('err');
  });

  it('carries neither for a pass', () => {
    const row = ruleRow(
      rulePassed({ id: 'acreage', label: 'Acreage', explain: '120 acres, at least 40 needed.' }),
    );
    expect(row.waitingOn).toBeNull();
    expect(row.delta).toBeNull();
    expect(row.presentation.tone).toBe('ok');
  });
});
