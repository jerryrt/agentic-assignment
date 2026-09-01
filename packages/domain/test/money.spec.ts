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
  moneyToNumericString,
  negateMoney,
  subtractMoney,
  sumMoney,
} from '../src/index.js';

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
  it('refuses a JSON number, because a number has already lost the decimal', () => {
    expect(MoneyFromNumericSchema.safeParse(1234).success).toBe(false);
    expect(MoneyFromNumericSchema.safeParse(1234.56).success).toBe(false);
  });

  it('reports the offending value in the issue rather than throwing out of the parse', () => {
    const result = MoneyFromNumericSchema.safeParse('1234.567');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('1234.567');
    }
  });
});
