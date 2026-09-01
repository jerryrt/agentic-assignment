import {
  type RuleDelta,
  type RuleDeltaUnit,
  acresDelta,
  basisPointsDelta,
  countDelta,
  formatBasisPointsAsPercentage,
  formatBasisPointsAsRatio,
  formatMoney,
  moneyDelta,
  moneyFromMinorUnits,
  yearsDelta,
} from '@lj/domain';

/**
 * What a rule's numbers are counted in, and therefore how they are rendered.
 *
 * `RuleDeltaUnit` in @lj/domain answers "what unit is this delta measured in";
 * this answers the finer question "how does a reader want to see it". Both a
 * coverage ratio and a loan-to-value are basis points, but one is quoted as
 * 1.25 and the other as 80%, and a renderer that only knew the unit would have
 * to guess. Keeping the kind on the rule rather than on the delta means the
 * explanation sentence and the delta agree by construction.
 */
export const RULE_FIGURE_KINDS = [
  'money',
  'ratio',
  'percentage',
  'count',
  'years',
  'acres',
] as const;

export type RuleFigureKind = (typeof RULE_FIGURE_KINDS)[number];

const FIGURE_UNITS: { readonly [K in RuleFigureKind]: RuleDeltaUnit } = {
  money: 'money_minor_units',
  ratio: 'basis_points',
  percentage: 'basis_points',
  count: 'count',
  years: 'years',
  acres: 'acres',
};

export function figureUnit(kind: RuleFigureKind): RuleDeltaUnit {
  return FIGURE_UNITS[kind];
}

/** The noun a threshold in this unit is counted in, for a parse error message. */
export function figureUnitNoun(kind: RuleFigureKind): string {
  switch (kind) {
    case 'money':
      return 'minor units (cents)';
    case 'ratio':
    case 'percentage':
      return 'basis points';
    case 'count':
      return 'whole units';
    case 'years':
      return 'whole years';
    case 'acres':
      return 'whole acres';
  }
}

function pluralise(value: number, singular: string): string {
  return String(value) + ' ' + singular + (value === 1 ? '' : 's');
}

function assertIntegerFigure(kind: RuleFigureKind, value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      'A ' + kind + ' figure must be an integer number of ' + figureUnitNoun(kind) +
        '; received ' + String(value) + '. A float here makes a threshold undecidable ' +
        'exactly at its boundary.',
    );
  }
  return value;
}

export function formatFigure(kind: RuleFigureKind, value: number): string {
  switch (kind) {
    case 'money':
      return formatMoney(moneyFromMinorUnits(value));
    case 'ratio':
      return formatBasisPointsAsRatio(assertIntegerFigure(kind, value));
    case 'percentage':
      return formatBasisPointsAsPercentage(assertIntegerFigure(kind, value));
    case 'count':
      return String(assertIntegerFigure(kind, value));
    case 'years':
      return pluralise(assertIntegerFigure(kind, value), 'year');
    case 'acres':
      return pluralise(assertIntegerFigure(kind, value), 'acre');
  }
}

/**
 * The gap to passing, built through the @lj/domain factories so that
 * `shortfall` and `direction` cannot contradict `actual` and `required` -- the
 * RuleResult schema rejects that combination, and there is no reason for a
 * caller to have to get it right twice.
 */
export function figureDelta(kind: RuleFigureKind, actual: number, required: number): RuleDelta {
  switch (kind) {
    case 'money':
      // moneyFromMinorUnits is the integrality check for this branch, and it
      // additionally rejects an amount numeric(14,2) could not hold.
      return moneyDelta({
        actual: moneyFromMinorUnits(actual),
        required: moneyFromMinorUnits(required),
      });
    case 'ratio':
    case 'percentage':
      return basisPointsDelta({
        actual: assertIntegerFigure(kind, actual),
        required: assertIntegerFigure(kind, required),
      });
    case 'count':
      return countDelta({
        actual: assertIntegerFigure(kind, actual),
        required: assertIntegerFigure(kind, required),
      });
    case 'years':
      return yearsDelta({
        actual: assertIntegerFigure(kind, actual),
        required: assertIntegerFigure(kind, required),
      });
    case 'acres':
      return acresDelta({
        actual: assertIntegerFigure(kind, actual),
        required: assertIntegerFigure(kind, required),
      });
  }
}

/** "a", "a and b", "a, b and c" -- explanations are sentences, not arrays. */
export function joinWords(words: readonly string[]): string {
  if (words.length === 0) {
    return '';
  }
  if (words.length === 1) {
    return words[0] ?? '';
  }
  return words.slice(0, -1).join(', ') + ' and ' + (words[words.length - 1] ?? '');
}
