import { z } from 'zod';

/**
 * Money, as integer minor units (CLAUDE.md section 10). No floats, ever.
 *
 * The hard part is the boundary. Postgres stores money as `numeric(14,2)`, and
 * PostgREST renders it as a JSON NUMBER -- `1234.56` -- unless the select asks
 * for `column::text`, which renders the string '1234.56'. Both spellings are in
 * this codebase and both are read below.
 *
 * This header asserted the opposite for three phases: that PostgREST always
 * sent a string. It does not, and MoneyFromNumericSchema being a `z.string()`
 * meant it would have refused every real row it was pointed at. It went
 * unnoticed because the only column it was applied to is null in every fixture,
 * and two delivery-layer modules quietly worked around it instead of asking
 * why (issue #57).
 *
 * A number is safe to accept, and that is measured rather than assumed: the
 * widest value numeric(14,2) can hold is 999,999,999,999.99, which is fourteen
 * significant digits, and a double round-trips fifteen to seventeen. So every
 * value the column can carry survives the wire intact, and rendering it back to
 * its shortest round-tripping decimal recovers the original digits exactly. The
 * float is never arithmetic on; it is only printed.
 *
 * What must not happen is the obvious conversion, which throws that away:
 *
 *     Math.trunc(Number('0.29') * 100)   // 28, not 29
 *     Math.trunc(Number('1.15') * 100)   // 114, not 115
 *
 * Neither 0.29 nor 1.15 is representable in binary floating point, so the
 * multiplication lands just below the intended cent and the truncation takes
 * the cent away. Rounding instead of truncating hides those cases and creates
 * others (Number('1.005') is already below 1.005). Either way the error is one
 * cent per row, in the direction nobody notices until a reconciliation fails.
 *
 * So the string is never converted to a number at all. It is split into its
 * sign, its integer digits and its fraction digits by a regular expression;
 * the fraction is padded or checked to exactly two digits; the digits are
 * concatenated and handed to BigInt, which is exact by construction. Only the
 * final, already-integral value becomes a `number`, and only after it is proved
 * to be inside the safe-integer range.
 *
 * Minor units fit a `number` comfortably: numeric(14,2) tops out at
 * 999,999,999,999.99, which is 99,999,999,999,999 minor units -- two decimal
 * orders below Number.MAX_SAFE_INTEGER. Using `number` rather than `bigint` for
 * the carried value keeps the type JSON-serialisable, which matters because
 * these values cross the wire inside eligibility snapshots and API bodies.
 */

declare const MONEY_BRAND: unique symbol;

/**
 * An integer number of minor units (cents). The brand exists so that a raw
 * `number` cannot be passed where an amount is expected: that mistake is how a
 * major-unit figure or a float ends up in a ledger, and the compiler is a
 * cheaper place to catch it than a reconciliation.
 */
export type Money = number & { readonly [MONEY_BRAND]: 'minor units' };

/** Decimal places Postgres keeps, and therefore the minor unit's exponent. */
export const MONEY_SCALE = 2;

const MINOR_UNITS_PER_MAJOR = 10n ** BigInt(MONEY_SCALE);

/** The widest value `numeric(14,2)` can hold, in minor units. */
export const MAX_MONEY_MINOR_UNITS = 99_999_999_999_999;
export const MIN_MONEY_MINOR_UNITS = -MAX_MONEY_MINOR_UNITS;

export const ZERO_MONEY = 0 as Money;

/**
 * A plain decimal literal and nothing else. Exponent notation, thousands
 * separators and surrounding whitespace are all rejected rather than tolerated:
 * every one of them means the value came from somewhere other than a `numeric`
 * column, and guessing what it meant is how a wrong amount gets stored.
 */
const NUMERIC_LITERAL = /^([+-]?)(\d+)(?:\.(\d*))?$/;

export function isMoney(value: unknown): value is Money {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MONEY_MINOR_UNITS &&
    value <= MAX_MONEY_MINOR_UNITS
  );
}

function assertInRange(minorUnits: bigint): Money {
  if (minorUnits > BigInt(MAX_MONEY_MINOR_UNITS) || minorUnits < BigInt(MIN_MONEY_MINOR_UNITS)) {
    throw new RangeError(
      'Amount ' + minorUnits.toString() + ' minor units does not fit numeric(' +
        '14,' + String(MONEY_SCALE) + ')',
    );
  }
  // Adding 0 is what turns -0n's Number form back into 0: a signed zero would
  // compare equal everywhere but serialise as "-0" in JSON.
  return (Number(minorUnits) + 0) as Money;
}

/** Wrap a value already counted in minor units. */
export function moneyFromMinorUnits(value: number): Money {
  if (!isMoney(value)) {
    throw new RangeError(
      'Money must be an integer number of minor units within numeric(14,2); received ' +
        String(value),
    );
  }
  return value;
}

/**
 * Parse a `numeric` value as PostgREST renders it. Throws rather than returning
 * a fallback: an amount that cannot be read exactly has no safe default, and a
 * silent zero is worse than a stack trace.
 */
export function moneyFromNumericString(text: string): Money {
  const match = NUMERIC_LITERAL.exec(text);
  if (match === null) {
    throw new RangeError(
      "Not a Postgres numeric literal: '" + text + "'. Expected plain decimal digits, " +
        'optionally signed, with no separators and no exponent.',
    );
  }

  const [, sign = '', wholeDigits = '', fractionDigits = ''] = match;

  // Postgres will not render more digits than the column's scale, but a value
  // that arrived from elsewhere might. Trailing zeros carry no value and are
  // dropped; anything else would have to be rounded away, and rounding money at
  // a trust boundary is how fractions of a cent go missing.
  const significantFraction = fractionDigits.slice(0, MONEY_SCALE);
  const excessFraction = fractionDigits.slice(MONEY_SCALE);
  if (/[1-9]/.test(excessFraction)) {
    throw new RangeError(
      "Amount '" + text + "' has more than " + String(MONEY_SCALE) +
        ' decimal places and cannot be stored without rounding.',
    );
  }

  const paddedFraction = significantFraction.padEnd(MONEY_SCALE, '0');
  const magnitude = BigInt(wholeDigits + paddedFraction);
  return assertInRange(sign === '-' ? -magnitude : magnitude);
}

/** Render for a `numeric(14,2)` column or a SQL literal, always at full scale. */
export function moneyToNumericString(value: Money): string {
  const units = BigInt(value);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / MINOR_UNITS_PER_MAJOR;
  const fraction = magnitude % MINOR_UNITS_PER_MAJOR;
  return (
    (negative ? '-' : '') +
    whole.toString() +
    '.' +
    fraction.toString().padStart(MONEY_SCALE, '0')
  );
}

export interface FormatMoneyOptions {
  /** Currency symbol, placed inside the sign. Pass '' for a bare figure. */
  readonly symbol?: string;
  /**
   * 'auto' shows a minus on negatives only, 'always' also shows a plus on
   * positives (a ledger of draws and repayments needs it), 'never' renders the
   * magnitude for a column whose heading already carries the direction.
   */
  readonly signDisplay?: 'auto' | 'always' | 'never';
}

function groupThousands(digits: string): string {
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return groups.join(',');
}

/**
 * The single money formatter (CLAUDE.md section 9). It lives here rather than
 * in packages/ui because the API renders amounts into explanation strings too,
 * and two formatters would eventually disagree about a negative sign.
 *
 * Intl.NumberFormat is deliberately not used: it takes a float, which is the
 * one thing this module exists to avoid, and its output is locale-dependent in
 * ways that would make the rule explanations non-deterministic across
 * environments.
 */
export function formatMoney(value: Money, options: FormatMoneyOptions = {}): string {
  const { symbol = '$', signDisplay = 'auto' } = options;
  const units = BigInt(value);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / MINOR_UNITS_PER_MAJOR;
  const fraction = magnitude % MINOR_UNITS_PER_MAJOR;

  let sign = '';
  if (signDisplay !== 'never') {
    if (negative) {
      sign = '-';
    } else if (signDisplay === 'always' && units > 0n) {
      sign = '+';
    }
  }

  return (
    sign +
    symbol +
    groupThousands(whole.toString()) +
    '.' +
    fraction.toString().padStart(MONEY_SCALE, '0')
  );
}

export function addMoney(left: Money, right: Money): Money {
  return assertInRange(BigInt(left) + BigInt(right));
}

export function subtractMoney(left: Money, right: Money): Money {
  return assertInRange(BigInt(left) - BigInt(right));
}

export function negateMoney(value: Money): Money {
  return assertInRange(-BigInt(value));
}

export function absMoney(value: Money): Money {
  const units = BigInt(value);
  return assertInRange(units < 0n ? -units : units);
}

export function sumMoney(values: readonly Money[]): Money {
  let total = 0n;
  for (const value of values) {
    total += BigInt(value);
  }
  return assertInRange(total);
}

/** -1, 0 or 1, so this can be passed straight to Array.prototype.sort. */
export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * An amount arriving as minor units, which is how amounts cross this project's
 * own API. Distinct from MoneyFromNumericSchema on purpose: our wire format and
 * Postgres's are different, and one schema pretending to accept both would
 * accept a major-unit float as a minor-unit integer.
 */
export const MoneyMinorUnitsSchema = z
  .number()
  .int()
  .min(MIN_MONEY_MINOR_UNITS)
  .max(MAX_MONEY_MINOR_UNITS)
  .transform((value) => value as Money);

/**
 * An amount arriving from Postgres, in either spelling PostgREST uses.
 *
 * A plain `select=amount` gives a JSON number; `select=amount::text` gives a
 * string. Both are accepted, because both are in this codebase and a boundary
 * that took only one of them would be worked around locally -- which is exactly
 * what happened twice before this accepted the pair (issue #57).
 *
 * A number is turned into its shortest round-tripping decimal and handed to the
 * exact parser. No arithmetic is performed on the double, so nothing is rounded
 * on the way through; `String` is a rendering, not a calculation. NaN and the
 * infinities render as words the numeric grammar rejects, so they fail here
 * rather than needing a check of their own.
 */
export const MoneyFromNumericSchema = z
  .union([z.string(), z.number()])
  .transform((value, context) => {
    const text = typeof value === 'string' ? value : String(value);
    try {
      return moneyFromNumericString(text);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : "Invalid numeric value '" + text + "'",
      });
      return z.NEVER;
    }
  });

/**
 * A nullable `numeric` column, read into an amount.
 *
 * Null stays null, because a column that holds no amount is not an amount of
 * zero -- a product with no minimum has no floor, and reading that as a floor of
 * nothing happens to be the same thing but only by accident.
 *
 * A value that is present and unreadable THROWS, and the direction matters. The
 * two hand-rolled conversions this replaces both returned null there, which for
 * `loan_product.min_amount` means "this product has no minimum" -- so a
 * malformed figure silently REMOVED a lending floor and widened who qualified.
 * That is failing open, on a credit criterion, without anything being logged.
 * The caller now has to decide, and both of them drop the product, which is
 * what they already do when its criteria will not parse.
 */
export function readNumericMoney(value: unknown): Money | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = MoneyFromNumericSchema.safeParse(value);
  if (!parsed.success) {
    throw new RangeError(
      'Expected a numeric amount as PostgREST renders one; received ' + JSON.stringify(value),
    );
  }
  return parsed.data;
}
