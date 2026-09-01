import { describe, expect, it } from 'vitest';

import {
  BASIS_POINTS_PER_UNIT,
  currentRatioBasisPoints,
  debtServiceCoverageRatioBasisPoints,
  formatBasisPointsAsPercentage,
  formatBasisPointsAsRatio,
  loanToValueBasisPoints,
  moneyFromNumericString,
  ratioBasisPoints,
} from '../src/index.js';

const money = moneyFromNumericString;

describe('the basis-point contract', () => {
  it('defines one whole unit as ten thousand basis points', () => {
    expect(BASIS_POINTS_PER_UNIT).toBe(10_000);
  });
});

describe('ratioBasisPoints', () => {
  it('computes an exact ratio of two money amounts', () => {
    expect(ratioBasisPoints(money('125000.00'), money('100000.00'))).toBe(12_500);
    expect(ratioBasisPoints(money('164000.00'), money('205000.00'))).toBe(8_000);
    expect(ratioBasisPoints(money('100.00'), money('100.00'))).toBe(10_000);
  });

  // A ratio that cannot be computed is not zero and not "fail": it is the
  // input the applicant has not supplied yet. Returning null keeps that
  // distinction, which is what RuleResult's 'unknown' status is built on.
  it('returns null when the denominator is zero rather than inventing a number', () => {
    expect(ratioBasisPoints(money('100.00'), money('0.00'))).toBeNull();
  });

  it('rounds half away from zero, so a boundary never rounds into passing', () => {
    // 1 / 3 = 0.333333... -> 3333.33 bps
    expect(ratioBasisPoints(money('1.00'), money('3.00'))).toBe(3_333);
    // 2 / 3 = 0.666666... -> 6666.67 bps
    expect(ratioBasisPoints(money('2.00'), money('3.00'))).toBe(6_667);
    // 0.00005 exactly -> 0.5 bps -> 1
    expect(ratioBasisPoints(money('0.01'), money('200.00'))).toBe(1);
  });

  it('carries the sign of the quotient', () => {
    expect(ratioBasisPoints(money('-1.00'), money('2.00'))).toBe(-5_000);
    expect(ratioBasisPoints(money('1.00'), money('-2.00'))).toBe(-5_000);
    expect(ratioBasisPoints(money('-1.00'), money('-2.00'))).toBe(5_000);
  });
});

describe('the derived lending figures', () => {
  it('computes DSCR as income over debt service', () => {
    expect(debtServiceCoverageRatioBasisPoints(money('125000.00'), money('100000.00'))).toBe(12_500);
    expect(debtServiceCoverageRatioBasisPoints(money('108000.00'), money('100000.00'))).toBe(10_800);
  });

  it('treats no debt service as unknown rather than infinitely good', () => {
    expect(debtServiceCoverageRatioBasisPoints(money('125000.00'), money('0.00'))).toBeNull();
  });

  it('computes LTV as loan over asset value', () => {
    expect(loanToValueBasisPoints(money('180000.00'), money('205000.00'))).toBe(8_780);
    expect(loanToValueBasisPoints(money('164000.00'), money('205000.00'))).toBe(8_000);
  });

  it('computes the current ratio', () => {
    expect(currentRatioBasisPoints(money('300000.00'), money('150000.00'))).toBe(20_000);
    expect(currentRatioBasisPoints(money('300000.00'), money('0.00'))).toBeNull();
  });
});

describe('formatting a basis-point figure', () => {
  it('renders a ratio the way a credit memo states one', () => {
    expect(formatBasisPointsAsRatio(12_500)).toBe('1.25');
    expect(formatBasisPointsAsRatio(10_800)).toBe('1.08');
    expect(formatBasisPointsAsRatio(0)).toBe('0.00');
    expect(formatBasisPointsAsRatio(-5_000)).toBe('-0.50');
  });

  it('renders a percentage without a trailing zero nobody reads', () => {
    expect(formatBasisPointsAsPercentage(8_000)).toBe('80%');
    expect(formatBasisPointsAsPercentage(8_780)).toBe('87.8%');
    expect(formatBasisPointsAsPercentage(1)).toBe('0.01%');
    expect(formatBasisPointsAsPercentage(-250)).toBe('-2.5%');
  });
});
