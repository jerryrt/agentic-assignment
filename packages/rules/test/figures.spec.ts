import { describe, expect, it } from 'vitest';

import { RULE_DELTA_UNITS } from '@lj/domain';

import {
  RULE_FIGURE_KINDS,
  figureDelta,
  formatFigure,
  joinWords,
  type RuleFigureKind,
} from '../src/index.js';

describe('formatFigure', () => {
  const cases: readonly (readonly [RuleFigureKind, number, string])[] = [
    ['money', 2_500_000, '$25,000.00'],
    ['money', 0, '$0.00'],
    ['ratio', 12_500, '1.25'],
    ['ratio', 10_800, '1.08'],
    ['percentage', 8_000, '80%'],
    ['percentage', 8_800, '88%'],
    ['percentage', 690, '6.9%'],
    ['count', 1, '1'],
    ['years', 1, '1 year'],
    ['years', 3, '3 years'],
    ['acres', 1, '1 acre'],
    ['acres', 200, '200 acres'],
  ];

  it.each(cases)('renders a %s figure of %d as %s', (kind, value, expected) => {
    expect(formatFigure(kind, value)).toBe(expected);
  });

  it('names every kind it can format', () => {
    expect([...RULE_FIGURE_KINDS]).toEqual([
      'money',
      'ratio',
      'percentage',
      'count',
      'years',
      'acres',
    ]);
  });
});

describe('figureDelta', () => {
  it('measures money in minor units', () => {
    expect(figureDelta('money', 1_000_000, 2_500_000)).toEqual({
      unit: 'money_minor_units',
      actual: 1_000_000,
      required: 2_500_000,
      shortfall: 1_500_000,
      direction: 'increase',
    });
  });

  it('measures both a ratio and a percentage in basis points', () => {
    expect(figureDelta('ratio', 10_800, 12_500).unit).toBe('basis_points');
    expect(figureDelta('percentage', 8_800, 8_000)).toEqual({
      unit: 'basis_points',
      actual: 8_800,
      required: 8_000,
      shortfall: 800,
      direction: 'decrease',
    });
  });

  it('maps every figure kind onto a unit the vocabulary declares', () => {
    for (const kind of RULE_FIGURE_KINDS) {
      expect(RULE_DELTA_UNITS).toContain(figureDelta(kind, 1, 2).unit);
    }
  });

  // A non-integer figure would produce a delta the RuleResult schema rejects,
  // and it would mean a float reached a comparison. Fail at the source instead.
  it('refuses a figure that is not an integer', () => {
    expect(() => figureDelta('acres', 1.5, 2)).toThrow(RangeError);
  });
});

describe('joinWords', () => {
  it.each([
    [['one'], 'one'],
    [['one', 'two'], 'one and two'],
    [['one', 'two', 'three'], 'one, two and three'],
  ])('joins %j as %s', (words, expected) => {
    expect(joinWords(words)).toBe(expected);
  });
});
