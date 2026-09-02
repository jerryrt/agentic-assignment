import {
  type Money,
  moneyFromNumericString,
  moneyToNumericString,
} from '@lj/domain';

/**
 * The one place a form control's text becomes a payload value, and back.
 *
 * **Every control in this feature holds a string.** That is the decision this
 * file exists to implement, and it is not laziness. An `<input type="number">`
 * bound to a numeric control reports an empty box as null, a partially typed
 * '-' as null, and a value the user is mid-way through as NaN, so three
 * different states arrive as the same one. A string control has exactly one
 * "not answered" -- the empty string -- and every conversion below turns it
 * into the one null the payload schema also uses.
 *
 * **Money never touches a float.** money.ts spells out why:
 * `Math.trunc(Number('1.15') * 100)` is 114, and the cent goes missing in
 * exactly the direction nobody notices. So an amount is typed as a decimal
 * string, converted by @lj/domain's exact parser, and rendered back through the
 * exact formatter. There is no `parseFloat` in this feature, and there must not
 * be one.
 *
 * The conversions are total and they never throw. A half-typed amount is not an
 * error the applicant should be shown mid-keystroke; it is a value that has not
 * arrived yet, which reads as unanswered until the format validator in ./form.ts
 * says otherwise once they leave the field.
 */

/** Blank, and blank alone, is "not answered". Whitespace counts as blank. */
function blank(text: string): boolean {
  return text.trim() === '';
}

export function textToValue(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

export function textFromValue(value: string | null): string {
  return value ?? '';
}

export function integerToValue(text: string): number | null {
  if (blank(text)) {
    return null;
  }
  // Number() rather than parseInt: parseInt('12abc') is 12, which silently
  // accepts a typo as a figure. Number('12abc') is NaN, which is a refusal.
  const value = Number(text.trim());
  return Number.isSafeInteger(value) ? value : null;
}

export function integerFromValue(value: number | null): string {
  return value === null ? '' : String(value);
}

/**
 * Separators are stripped before parsing, and only separators.
 *
 * moneyFromNumericString rejects '25,000' deliberately -- it is not a Postgres
 * numeric literal, and guessing at one is how a wrong amount gets stored. But a
 * person typing an amount into a form types the separators, and refusing their
 * input would be pedantry aimed at the wrong audience. Commas and spaces are
 * removed here, at the form boundary, and nothing else is: a currency symbol,
 * an exponent or a second decimal point still fails, because each of those
 * means the value came from somewhere this field cannot interpret.
 */
export function moneyToValue(text: string): Money | null {
  if (blank(text)) {
    return null;
  }
  const cleaned = text.replaceAll(',', '').replaceAll(' ', '');
  try {
    return moneyFromNumericString(cleaned);
  } catch {
    return null;
  }
}

/** True when there is something in the box that is not an amount. */
export function isMalformedMoney(text: string): boolean {
  return !blank(text) && moneyToValue(text) === null;
}

/** True when there is something in the box that is not a whole number. */
export function isMalformedInteger(text: string): boolean {
  return !blank(text) && integerToValue(text) === null;
}

/** Always at full scale -- '25000.00' -- because that is what the column holds. */
export function moneyFromValue(value: Money | null): string {
  return value === null ? '' : moneyToNumericString(value);
}

/**
 * A choice, where the empty option is "not answered".
 *
 * The value is not checked against the vocabulary here: the payload schema is
 * the trust boundary and rejects an unknown member, and a `<select>` cannot
 * produce one anyway. Narrowing it twice would put the vocabulary in two files.
 */
export function choiceToValue(text: string): string | null {
  return blank(text) ? null : text;
}

export function choiceFromValue(value: string | null): string {
  return value ?? '';
}

/**
 * Yes, no, or not answered -- three states, which is why this is a select and
 * not a checkbox. A checkbox has two, so an unanswered question would arrive as
 * 'no' and the applicant would be recorded as having said something they did
 * not say.
 */
export const FLAG_YES = 'yes';
export const FLAG_NO = 'no';

export function flagToValue(text: string): boolean | null {
  if (text === FLAG_YES) {
    return true;
  }
  return text === FLAG_NO ? false : null;
}

export function flagFromValue(value: boolean | null): string {
  if (value === null) {
    return '';
  }
  return value ? FLAG_YES : FLAG_NO;
}
