import {
  moneyFromNumericString,
  moneyToNumericString,
} from '@lj/domain';

import {
  flagFromValue,
  flagToValue,
  integerToValue,
  isMalformedInteger,
  isMalformedMoney,
  moneyFromValue,
  moneyToValue,
  textToValue,
} from './form-fields.ts';

/**
 * The conversions are the boundary between a text box and a payload, so what
 * is worth testing is every way a person can leave one in a state that is
 * neither empty nor valid.
 */
describe('textToValue', () => {
  it('reads blank and whitespace-only as unanswered', () => {
    expect(textToValue('')).toBeNull();
    expect(textToValue('   ')).toBeNull();
  });

  it('trims what it keeps', () => {
    expect(textToValue('  Fenwick Grain Co. ')).toBe('Fenwick Grain Co.');
  });
});

describe('integerToValue', () => {
  it('reads a whole number', () => {
    expect(integerToValue('2400')).toBe(2400);
    expect(integerToValue(' 14 ')).toBe(14);
  });

  it('reads an empty box as unanswered rather than as zero', () => {
    expect(integerToValue('')).toBeNull();
  });

  // parseInt('12abc') is 12, which accepts a typo as a figure and stores it.
  it('refuses a number with something after it', () => {
    expect(integerToValue('12abc')).toBeNull();
    expect(isMalformedInteger('12abc')).toBe(true);
  });

  it('refuses a fraction, because acreage and years are whole', () => {
    expect(integerToValue('12.5')).toBeNull();
  });

  it('does not call a blank box malformed', () => {
    expect(isMalformedInteger('')).toBe(false);
  });
});

describe('moneyToValue', () => {
  // The whole reason this feature holds amounts as text. money.ts:
  // Math.trunc(Number('1.15') * 100) is 114, and the cent goes missing in the
  // direction nobody notices until a reconciliation fails.
  it('converts exactly, including the values a float rounds wrongly', () => {
    expect(moneyToValue('1.15')).toBe(115);
    expect(moneyToValue('0.29')).toBe(29);
    expect(moneyToValue('25000.00')).toBe(2500000);
  });

  it('accepts the separators a person actually types', () => {
    expect(moneyToValue('25,000.00')).toBe(2500000);
    expect(moneyToValue('182 000.00')).toBe(18200000);
  });

  it('accepts a whole number of dollars', () => {
    expect(moneyToValue('25000')).toBe(2500000);
  });

  it('reads an empty box as unanswered rather than as zero', () => {
    expect(moneyToValue('')).toBeNull();
    expect(isMalformedMoney('')).toBe(false);
  });

  // Each of these means the value came from somewhere the field cannot
  // interpret, and guessing at it is how a wrong amount gets stored.
  it('refuses a currency symbol, an exponent and a third decimal place', () => {
    for (const text of ['$25000', '2.5e4', '1.005']) {
      expect(moneyToValue(text)).toBeNull();
      expect(isMalformedMoney(text)).toBe(true);
    }
  });

  it('round-trips an amount through the exact formatter', () => {
    const amount = moneyFromNumericString('182000.00');
    expect(moneyFromValue(amount)).toBe(moneyToNumericString(amount));
    expect(moneyToValue(moneyFromValue(amount))).toBe(amount);
  });
});

describe('flagToValue', () => {
  // Three states, which is why this is a select and not a checkbox: an
  // unanswered question arriving as 'no' records something nobody said.
  it('separates no from not answered', () => {
    expect(flagToValue('yes')).toBe(true);
    expect(flagToValue('no')).toBe(false);
    expect(flagToValue('')).toBeNull();
  });

  it('round-trips all three', () => {
    for (const value of [true, false, null]) {
      expect(flagToValue(flagFromValue(value))).toBe(value);
    }
  });
});
