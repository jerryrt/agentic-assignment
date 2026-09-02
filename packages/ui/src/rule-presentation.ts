import type { RuleDelta, RuleResult, RuleSeverity, RuleStatus } from '@lj/domain';
import {
  formatBasisPointsAsPercentage,
  formatMoney,
  isMoney,
  moneyFromMinorUnits,
} from '@lj/domain';

/**
 * How a RuleResult looks, decided once.
 *
 * design/00-foundations.md ("Never colour alone") requires every status to
 * carry a glyph and a text label as well as a colour, because colour alone
 * fails WCAG 1.4.1 and fails anyone reading the screen in greyscale. The way
 * that requirement survives maintenance rather than only the day it was
 * written is that all three come out of one function: there is no way to add a
 * status and give it a colour but forget its glyph, because they are one
 * record.
 *
 * The distinction this file exists to protect is 'unknown' against 'fail'. To
 * the applicant those are "you have not told us yet" and "you do not qualify",
 * and reading the first as the second is the failure <lj-rule-list> was
 * specified to prevent (packages/domain/src/rule-result.ts). They are therefore
 * separated four ways over: a different glyph ('?' against 'x'), a different
 * word, a different border treatment, and different body text -- an unknown
 * names the inputs it is waiting for, a failure states its gap to passing.
 * Only one of the four is colour.
 */

export const RULE_TONES = ['ok', 'warn', 'err', 'unknown'] as const;

/** Which of the status token pairs in design/tokens.json a result reads from. */
export type RuleTone = (typeof RULE_TONES)[number];

export interface RulePresentation {
  readonly tone: RuleTone;
  /** ASCII, and never the only carrier of the meaning. */
  readonly glyph: string;
  /** The word shown beside the glyph. Rendered, not a tooltip. */
  readonly word: string;
  /** Spoken instead of the glyph, which is aria-hidden. */
  readonly spoken: string;
  /** Whether this result stops the applicant progressing. */
  readonly blocking: boolean;
}

const PASS: RulePresentation = {
  tone: 'ok',
  glyph: '+',
  word: 'Met',
  spoken: 'Criterion met',
  blocking: false,
};

const ADVISORY: RulePresentation = {
  tone: 'warn',
  glyph: '!',
  word: 'Advisory',
  spoken: 'Advisory, does not block',
  blocking: false,
};

const BLOCKED: RulePresentation = {
  tone: 'err',
  glyph: 'x',
  word: 'Not met',
  spoken: 'Criterion not met',
  blocking: true,
};

const AWAITING: RulePresentation = {
  tone: 'unknown',
  glyph: '?',
  word: 'Not answered',
  spoken: 'Not answered yet',
  blocking: false,
};

/**
 * Severity only ever discriminates a failure. A passing criterion is a pass
 * whatever its severity, and an unknown is neutral by design: a form on step
 * one has answered nothing, and a wall of red is the wrong picture of that
 * (design/00-foundations.md).
 */
export function rulePresentation(result: {
  readonly status: RuleStatus;
  readonly severity: RuleSeverity;
}): RulePresentation {
  if (result.status === 'pass') {
    return PASS;
  }
  if (result.status === 'unknown') {
    return AWAITING;
  }
  return result.severity === 'warning' ? ADVISORY : BLOCKED;
}

/**
 * The fold of a whole criteria set, for the one-line summary above the list.
 * The counts come from @lj/domain rather than being recounted here, so the
 * summary can never disagree with the rows underneath it.
 */
export function overallRulePresentation(status: RuleStatus): RulePresentation {
  if (status === 'pass') {
    return PASS;
  }
  return status === 'unknown' ? AWAITING : BLOCKED;
}

function formatDeltaFigure(unit: RuleDelta['unit'], value: number): string {
  switch (unit) {
    case 'money_minor_units':
      // A delta arrives as a plain integer, so it has not been through the
      // Money brand. Out-of-range would throw inside a template, which renders
      // a blank screen rather than a wrong number; falling back to the raw
      // figure keeps the explanation readable when a rule emits nonsense.
      return isMoney(value) ? formatMoney(moneyFromMinorUnits(value)) : String(value);
    case 'basis_points':
      // A percentage is what the unit means -- one basis point is 0.01% -- so
      // it is the reading that cannot be wrong. A rule whose figure is better
      // read as a ratio ("DSCR 1.25") says so in its own `explain` sentence,
      // which is the field that carries prose.
      return formatBasisPointsAsPercentage(value);
    case 'count':
      return String(value);
    case 'years':
      return String(value) + (value === 1 ? ' year' : ' years');
    case 'acres':
      return String(value) + (value === 1 ? ' acre' : ' acres');
  }
}

/**
 * "Now 88%, needs 80% -- down by 8%".
 *
 * The delta is structured in the domain precisely so the UI does not have to
 * parse a sentence to find the numbers (packages/domain/src/rule-result.ts), so
 * this renders all five units through one shape rather than five bespoke
 * sentences. `direction` carries the sign, which is why `shortfall` is never
 * negative and never needs one.
 */
export function formatRuleDelta(delta: RuleDelta): string {
  const now = formatDeltaFigure(delta.unit, delta.actual);
  const needed = formatDeltaFigure(delta.unit, delta.required);
  const head = 'Now ' + now + ', needs ' + needed;
  if (delta.shortfall === 0) {
    return head;
  }
  const way = delta.direction === 'increase' ? 'up' : 'down';
  return head + ' -- ' + way + ' by ' + formatDeltaFigure(delta.unit, delta.shortfall);
}

/**
 * "Waiting on: annual revenue, land acres".
 *
 * Underscores become spaces and nothing else changes. Guessing harder -- title
 * casing, expanding abbreviations -- would produce a different name from the
 * one on the form field the applicant has to go and fill in, and a label that
 * does not match the field it points at is worse than a raw one.
 */
export function formatMissingInputs(missing: readonly string[]): string {
  return missing.map((field) => field.replaceAll('_', ' ')).join(', ');
}

/** Everything one row of <lj-rule-list> renders, with no logic left in the template. */
export interface RuleRow {
  readonly id: string;
  readonly label: string;
  readonly explain: string;
  readonly presentation: RulePresentation;
  /** Non-null exactly when the result is 'unknown'. */
  readonly waitingOn: string | null;
  /** Non-null only when a failure carried its gap to passing. */
  readonly delta: string | null;
}

export function ruleRow(result: RuleResult): RuleRow {
  return {
    id: result.id,
    label: result.label,
    explain: result.explain,
    presentation: rulePresentation(result),
    waitingOn: result.missing.length > 0 ? formatMissingInputs(result.missing) : null,
    delta: result.delta === null ? null : formatRuleDelta(result.delta),
  };
}
