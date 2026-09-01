import type { Money } from './money.js';

/**
 * The derived lending figures (CLAUDE.md section 7): DSCR, LTV, current ratio.
 *
 * A ratio of two money amounts is a rational number, and the moment it becomes
 * a float the comparison against a threshold stops being decidable at the
 * boundary -- 1.2499999999999998 is not 1.25, and a criterion that says "at
 * least 1.25" would refuse an application that exactly meets it. So a ratio is
 * carried as an integer number of basis points, computed with BigInt, and every
 * threshold in packages/rules is stated in the same unit. The comparison is
 * then integer equality, which has no boundary case.
 *
 * Thresholds themselves are deliberately absent from this file. A threshold is
 * a policy, it belongs to the rule that applies it (CLAUDE.md section 9), and a
 * copy of it here would be the second copy.
 */

declare const BASIS_POINTS_BRAND: unique symbol;

/** Hundredths of a percent. 10,000 bps = 1.00 = 100%. */
export type BasisPoints = number & { readonly [BASIS_POINTS_BRAND]: 'basis points' };

export const BASIS_POINTS_PER_UNIT = 10_000;

const BASIS_POINTS_PER_UNIT_BIG = BigInt(BASIS_POINTS_PER_UNIT);

export function basisPointsFromNumber(value: number): BasisPoints {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('Basis points must be a safe integer; received ' + String(value));
  }
  return value as BasisPoints;
}

/**
 * numerator / denominator, in basis points, or null when the denominator is
 * zero.
 *
 * Null rather than zero, Infinity or a thrown error, because "no debt service
 * was entered" is not "a coverage ratio of zero". It is the case RuleResult
 * calls 'unknown', and collapsing it into a number here would make the wall of
 * red on an empty form unavoidable further up.
 */
export function ratioBasisPoints(numerator: Money, denominator: Money): BasisPoints | null {
  if (denominator === 0) {
    return null;
  }

  const top = BigInt(numerator) * BASIS_POINTS_PER_UNIT_BIG;
  const bottom = BigInt(denominator);
  const negative = top < 0n !== bottom < 0n;
  const topMagnitude = top < 0n ? -top : top;
  const bottomMagnitude = bottom < 0n ? -bottom : bottom;

  // Half away from zero, done in integers: adding half the divisor before the
  // truncating division is the standard exact form. Rounding the magnitude and
  // reapplying the sign keeps the two directions symmetric, which matters when
  // a ledger nets to a negative figure.
  const rounded = (topMagnitude * 2n + bottomMagnitude) / (bottomMagnitude * 2n);
  const signed = negative ? -rounded : rounded;

  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Ratio does not fit a safe integer number of basis points');
  }
  return (Number(signed) + 0) as BasisPoints;
}

/** Net operating income over annual debt service. */
export function debtServiceCoverageRatioBasisPoints(
  netOperatingIncome: Money,
  annualDebtService: Money,
): BasisPoints | null {
  return ratioBasisPoints(netOperatingIncome, annualDebtService);
}

/** Loan amount over the value of the asset securing it. */
export function loanToValueBasisPoints(loanAmount: Money, assetValue: Money): BasisPoints | null {
  return ratioBasisPoints(loanAmount, assetValue);
}

/** Current assets over current liabilities. */
export function currentRatioBasisPoints(
  currentAssets: Money,
  currentLiabilities: Money,
): BasisPoints | null {
  return ratioBasisPoints(currentAssets, currentLiabilities);
}

function splitMagnitude(value: BasisPoints): { sign: string; whole: bigint; fraction: bigint } {
  const units = BigInt(value);
  const magnitude = units < 0n ? -units : units;
  return {
    sign: units < 0n ? '-' : '',
    whole: magnitude / BASIS_POINTS_PER_UNIT_BIG,
    fraction: magnitude % BASIS_POINTS_PER_UNIT_BIG,
  };
}

/** "1.25" -- how a credit memo states a coverage ratio. Always two decimals. */
export function formatBasisPointsAsRatio(value: BasisPoints | number): string {
  const { sign, whole, fraction } = splitMagnitude(value as BasisPoints);
  const hundredths = fraction / 100n;
  return sign + whole.toString() + '.' + hundredths.toString().padStart(2, '0');
}

/** "80%", "87.8%", "0.01%" -- trailing zeros trimmed, because nobody reads them. */
export function formatBasisPointsAsPercentage(value: BasisPoints | number): string {
  const units = BigInt(value as BasisPoints);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toString() + (fraction === '' ? '' : '.' + fraction) + '%';
}
