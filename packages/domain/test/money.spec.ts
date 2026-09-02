import { describe, expect, it } from 'vitest';

import {
  MAX_MONEY_MINOR_UNITS,
  MIN_MONEY_MINOR_UNITS,
  MONEY_SCALE,
  MoneyFromNumericSchema,
  MoneyMinorUnitsSchema,
  ZERO_MONEY,
  absMoney,
  addMoney,
  compareMoney,
  formatMoney,
  isMoney,
  moneyFromMinorUnits,
  moneyFromNumericString,
  readNumericMoney,
  moneyToNumericString,
  negateMoney,
  subtractMoney,
  sumMoney,
} from '../src/index.ts';

describe('the minor-unit contract', () => {
  it('fixes the scale at two, matching numeric(14,2) in Postgres', () => {
    expect(MONEY_SCALE).toBe(2);
  });

  it('bounds the range at numeric(14,2) and stays inside the safe integer range', () => {
    expect(MAX_MONEY_MINOR_UNITS).toBe(99_999_999_999_999);
    expect(MIN_MONEY_MINOR_UNITS).toBe(-99_999_999_999_999);
    expect(Number.isSafeInteger(MAX_MONEY_MINOR_UNITS)).toBe(true);
  });

  it('accepts a safe integer and rejects anything that is not one', () => {
    expect(moneyFromMinorUnits(123_456)).toBe(123_456);
    expect(() => moneyFromMinorUnits(1.5)).toThrow(RangeError);
    expect(() => moneyFromMinorUnits(Number.NaN)).toThrow(RangeError);
    expect(() => moneyFromMinorUnits(MAX_MONEY_MINOR_UNITS + 1)).toThrow(RangeError);
    expect(() => moneyFromMinorUnits(MIN_MONEY_MINOR_UNITS - 1)).toThrow(RangeError);
  });

  it('recognises a well-formed minor-unit value at runtime', () => {
    expect(isMoney(0)).toBe(true);
    expect(isMoney(-1)).toBe(true);
    expect(isMoney(0.5)).toBe(false);
    expect(isMoney('0')).toBe(false);
    expect(isMoney(MAX_MONEY_MINOR_UNITS + 1)).toBe(false);
  });
});

describe('parsing a Postgres numeric string', () => {
  it('reads whole and fractional parts exactly', () => {
    expect(moneyFromNumericString('0.00')).toBe(0);
    expect(moneyFromNumericString('1234.56')).toBe(123_456);
    expect(moneyFromNumericString('-30000.00')).toBe(-3_000_000);
    expect(moneyFromNumericString('+7.25')).toBe(725);
  });

  it('accepts a value Postgres rendered without a fraction, or with a short one', () => {
    expect(moneyFromNumericString('1234')).toBe(123_400);
    expect(moneyFromNumericString('1234.5')).toBe(123_450);
    expect(moneyFromNumericString('0.1')).toBe(10);
  });

  it('accepts trailing zeros beyond the scale because they carry no value', () => {
    expect(moneyFromNumericString('1234.500')).toBe(123_450);
    expect(moneyFromNumericString('1234.5600000')).toBe(123_456);
  });

  it('refuses to round away a third decimal rather than lose a fraction of a cent', () => {
    expect(() => moneyFromNumericString('1234.567')).toThrow(RangeError);
    expect(() => moneyFromNumericString('0.005')).toThrow(RangeError);
  });

  // The values below are the reason this parser exists. Every one of them is
  // mis-read by `Math.trunc(Number(text) * 100)`, which is the obvious
  // implementation: 0.29 becomes 28 cents, 1.15 becomes 114. A cent lost per
  // ledger row is a reconciliation bug nobody can reproduce.
  it('is exact for values that a float multiplication silently corrupts', () => {
    expect(moneyFromNumericString('0.29')).toBe(29);
    expect(moneyFromNumericString('1.15')).toBe(115);
    expect(moneyFromNumericString('8.29')).toBe(829);
    expect(moneyFromNumericString('4.35')).toBe(435);
    expect(moneyFromNumericString('16.08')).toBe(1_608);
  });

  it('treats negative zero as zero', () => {
    expect(moneyFromNumericString('-0.00')).toBe(0);
    expect(Object.is(moneyFromNumericString('-0.00'), 0)).toBe(true);
  });

  it('parses the largest and smallest values numeric(14,2) can hold', () => {
    expect(moneyFromNumericString('999999999999.99')).toBe(MAX_MONEY_MINOR_UNITS);
    expect(moneyFromNumericString('-999999999999.99')).toBe(MIN_MONEY_MINOR_UNITS);
  });

  it('rejects a value wider than the column can hold', () => {
    expect(() => moneyFromNumericString('1000000000000.00')).toThrow(RangeError);
  });

  it('rejects anything that is not a plain decimal literal', () => {
    for (const text of ['', ' ', '1.00 ', ' 1.00', '1,234.00', '1e3', 'NaN', 'Infinity', '.5', '-', '--1', '1.2.3']) {
      expect(() => moneyFromNumericString(text), text).toThrow(RangeError);
    }
  });
});

describe('rendering back to Postgres', () => {
  it('always writes the full scale so the column never has to widen a literal', () => {
    expect(moneyToNumericString(ZERO_MONEY)).toBe('0.00');
    expect(moneyToNumericString(moneyFromMinorUnits(5))).toBe('0.05');
    expect(moneyToNumericString(moneyFromMinorUnits(123_456))).toBe('1234.56');
    expect(moneyToNumericString(moneyFromMinorUnits(-3_000_000))).toBe('-30000.00');
    expect(moneyToNumericString(moneyFromMinorUnits(MAX_MONEY_MINOR_UNITS))).toBe('999999999999.99');
  });

  it('round-trips every value it can parse', () => {
    for (const text of ['0.00', '1234.56', '-30000.00', '0.05', '999999999999.99']) {
      expect(moneyToNumericString(moneyFromNumericString(text))).toBe(text);
    }
  });
});

describe('display formatting', () => {
  it('groups thousands and keeps both cents', () => {
    expect(formatMoney(ZERO_MONEY)).toBe('$0.00');
    expect(formatMoney(moneyFromMinorUnits(5))).toBe('$0.05');
    expect(formatMoney(moneyFromMinorUnits(123_456))).toBe('$1,234.56');
    expect(formatMoney(moneyFromMinorUnits(MAX_MONEY_MINOR_UNITS))).toBe('$999,999,999,999.99');
  });

  it('puts the sign outside the symbol, the way a statement reads', () => {
    expect(formatMoney(moneyFromMinorUnits(-3_000_000))).toBe('-$30,000.00');
    expect(formatMoney(moneyFromMinorUnits(-5))).toBe('-$0.05');
  });

  it('takes a symbol and a sign policy', () => {
    expect(formatMoney(moneyFromMinorUnits(123_456), { symbol: '' })).toBe('1,234.56');
    expect(formatMoney(moneyFromMinorUnits(123_456), { signDisplay: 'always' })).toBe('+$1,234.56');
    expect(formatMoney(moneyFromMinorUnits(-123_456), { signDisplay: 'never' })).toBe('$1,234.56');
    expect(formatMoney(ZERO_MONEY, { signDisplay: 'always' })).toBe('$0.00');
  });
});

describe('arithmetic', () => {
  const ten = moneyFromMinorUnits(1_000);
  const three = moneyFromMinorUnits(300);

  it('adds, subtracts, negates and sums', () => {
    expect(addMoney(ten, three)).toBe(1_300);
    expect(subtractMoney(ten, three)).toBe(700);
    expect(negateMoney(ten)).toBe(-1_000);
    expect(sumMoney([ten, three, negateMoney(ten)])).toBe(300);
    expect(sumMoney([])).toBe(ZERO_MONEY);
    expect(absMoney(negateMoney(ten))).toBe(1_000);
  });

  it('refuses a result the column could not store, rather than wrapping it', () => {
    const max = moneyFromMinorUnits(MAX_MONEY_MINOR_UNITS);
    expect(() => addMoney(max, moneyFromMinorUnits(1))).toThrow(RangeError);
    expect(() => subtractMoney(negateMoney(max), moneyFromMinorUnits(1))).toThrow(RangeError);
  });

  it('orders values', () => {
    expect(compareMoney(ten, three)).toBe(1);
    expect(compareMoney(three, ten)).toBe(-1);
    expect(compareMoney(ten, ten)).toBe(0);
  });
});

describe('the schemas', () => {
  it('parses an API body carrying minor units', () => {
    expect(MoneyMinorUnitsSchema.parse(123_456)).toBe(123_456);
    expect(MoneyMinorUnitsSchema.safeParse(1.5).success).toBe(false);
    expect(MoneyMinorUnitsSchema.safeParse('123456').success).toBe(false);
    expect(MoneyMinorUnitsSchema.safeParse(MAX_MONEY_MINOR_UNITS + 1).success).toBe(false);
  });

  it('parses a database row carrying numeric text', () => {
    expect(MoneyFromNumericSchema.parse('1234.56')).toBe(123_456);
    expect(MoneyFromNumericSchema.parse('1234')).toBe(123_400);
    expect(MoneyFromNumericSchema.safeParse('1234.567').success).toBe(false);
    expect(MoneyFromNumericSchema.safeParse('abc').success).toBe(false);
    expect(MoneyFromNumericSchema.safeParse(null).success).toBe(false);
  });

  // PostgREST renders `numeric` as a JSON string precisely so that no client
  // has to route the value through a float. Accepting a JSON number here would
  // undo that at the trust boundary, where it is least visible.
  // This test used to assert the opposite, and its name carried the reason:
  // "because a number has already lost the decimal". A number has NOT lost the
  // decimal -- 1234.56 round-trips through a double exactly, and so does every
  // value numeric(14,2) can hold. The belief was wrong, the schema built on it
  // would have refused every real row, and this test was defending it (#57).
  it('accepts a JSON number, which is what a plain select actually sends', () => {
    expect(MoneyFromNumericSchema.parse(1234)).toBe(123_400);
    expect(MoneyFromNumericSchema.parse(1234.56)).toBe(123_456);
  });

  it('reports the offending value in the issue rather than throwing out of the parse', () => {
    const result = MoneyFromNumericSchema.safeParse('1234.567');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('1234.567');
    }
  });
});

/**
 * What actually crosses the wire from PostgREST.
 *
 * The header of money.ts asserted for three phases that PostgREST renders a
 * `numeric` column as a JSON string. It does not -- it renders a JSON number,
 * and `MoneyFromNumericSchema` being a `z.string()` meant it would have refused
 * every real row it was pointed at. It went unnoticed because the only column it
 * was ever applied to is null in every fixture (issue #57).
 *
 * Both spellings are now in the codebase: the plain select gives a number, and
 * `select=column::text` gives a string. The schema takes either, because a
 * boundary that accepts only one of them gets worked around locally -- which is
 * exactly what happened, twice.
 */
describe('MoneyFromNumericSchema, against what PostgREST really sends', () => {
  it('accepts a numeric column as a plain select renders it -- a JSON number', () => {
    expect(MoneyFromNumericSchema.parse(25000.0)).toBe(2_500_000);
    expect(MoneyFromNumericSchema.parse(128442.47)).toBe(12_844_247);
  });

  it('accepts a numeric column cast with ::text -- a JSON string', () => {
    expect(MoneyFromNumericSchema.parse('25000.00')).toBe(2_500_000);
    expect(MoneyFromNumericSchema.parse('128442.47')).toBe(12_844_247);
  });

  // The reason the module exists. A number arriving as a double is rendered
  // back to its shortest round-tripping decimal before any arithmetic, so the
  // cent that `Math.trunc(value * 100)` loses is never lost here.
  it('is exact for the values a float multiplication rounds wrongly', () => {
    expect(MoneyFromNumericSchema.parse(0.29)).toBe(29);
    expect(MoneyFromNumericSchema.parse(1.15)).toBe(115);
    expect(MoneyFromNumericSchema.parse('0.29')).toBe(29);
    expect(MoneyFromNumericSchema.parse('1.15')).toBe(115);
  });

  it('accepts a whole number of dollars in either spelling', () => {
    expect(MoneyFromNumericSchema.parse(25000)).toBe(2_500_000);
    expect(MoneyFromNumericSchema.parse('25000')).toBe(2_500_000);
  });

  it('reads a negative amount, which a ledger of repayments needs', () => {
    expect(MoneyFromNumericSchema.parse(-1500.5)).toBe(-150_050);
    expect(MoneyFromNumericSchema.parse('-1500.50')).toBe(-150_050);
  });

  it('refuses what is neither, rather than coercing it', () => {
    for (const value of [null, undefined, true, {}, [], 'not a number', '1,500.00']) {
      expect(MoneyFromNumericSchema.safeParse(value).success).toBe(false);
    }
  });

  // The widest value the column can hold, both ways. This was asserted the
  // other way round first -- that a number that wide could not have survived
  // the wire -- and measuring it showed the opposite: 999999999999.99 is
  // fourteen significant digits and a double round-trips fifteen to seventeen,
  // so EVERY value numeric(14,2) can hold arrives intact. Refusing it would
  // have been an arbitrary limit dressed up as a safety property.
  it('reads the widest amount the column can hold, as a number and as text', () => {
    expect(MoneyFromNumericSchema.parse(999_999_999_999.99)).toBe(99_999_999_999_999);
    expect(MoneyFromNumericSchema.parse('999999999999.99')).toBe(99_999_999_999_999);
  });

  // What genuinely cannot be read is a value with more precision than the
  // column has. It is refused rather than rounded, because rounding money at a
  // trust boundary is how fractions of a cent go missing.
  it('refuses more precision than the column carries', () => {
    expect(MoneyFromNumericSchema.safeParse(1.005).success).toBe(false);
    expect(MoneyFromNumericSchema.safeParse('1.005').success).toBe(false);
  });

  it('refuses a number that is not one', () => {
    expect(MoneyFromNumericSchema.safeParse(Number.NaN).success).toBe(false);
    expect(MoneyFromNumericSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});

describe('readNumericMoney', () => {
  it('reads either spelling of a column that holds an amount', () => {
    expect(readNumericMoney(25000.0)).toBe(2_500_000);
    expect(readNumericMoney('25000.00')).toBe(2_500_000);
  });

  // A column holding no amount is not an amount of zero. A product with no
  // minimum has no floor; reading that as a floor of nothing is the same thing
  // only by accident, and the accident stops being harmless the moment a
  // caller compares against it.
  it('keeps an absent amount absent', () => {
    expect(readNumericMoney(null)).toBeNull();
    expect(readNumericMoney(undefined)).toBeNull();
  });

  // The direction that matters. Both conversions this replaces returned null
  // here, which for loan_product.min_amount reads as "no minimum" -- so a
  // malformed figure silently removed a lending floor and widened who
  // qualified, with nothing logged. Failing open on a credit criterion is the
  // one outcome worth a throw.
  it('refuses a present value it cannot read, rather than reporting no amount', () => {
    for (const value of ['not a number', '1,500.00', {}, true, Number.NaN, 1.005]) {
      expect(() => readNumericMoney(value)).toThrow();
    }
  });
});
