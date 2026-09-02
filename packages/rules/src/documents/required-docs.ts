/**
 * `loan_product.required_docs`, parsed.
 *
 * The column is `jsonb` and @lj/domain leaves it opaque for the same reason it
 * leaves `criteria` opaque: giving it a shape down there would put the schema
 * for a rule below the layer that owns the rule (CLAUDE.md section 8). So this
 * is the one place that decides what a document pack may say, and it is the
 * trust boundary for it.
 *
 * Hand-written narrowing over `unknown` rather than a Zod schema, for the
 * reason `criteria.ts` gives: zod is a dependency of @lj/domain alone, pnpm's
 * isolated node_modules does not hoist it, and adding it here would put this
 * scope in the lockfile for the sake of a fixed grammar of one shape.
 *
 * **It fails closed, and that matters more here than anywhere else in this
 * package.** An unreadable criteria set makes an applicant less eligible, which
 * is a safe direction to be wrong in. An unreadable document pack, if a slot
 * were quietly dropped, makes a pack report COMPLETE while a required document
 * is missing -- the checklist renders one row fewer and nobody notices until a
 * file reaches a lender without its land title. Every problem below is a
 * rejection of the whole pack, never a slot skipped.
 */

export const REQUIRED_DOCS_VERSION = 1;

/** One slot the product asks for, as the generator will create it. */
export interface RequiredDocSlot {
  /** Stable per product; `unique (application_id, code)` is keyed on it. */
  readonly code: string;
  readonly label: string;
  readonly required: boolean;
  /** Fields this slot must yield before the pack counts it complete. */
  readonly extractRequired: readonly string[];
}

export type RequiredDocsParse =
  | { readonly ok: true; readonly slots: readonly RequiredDocSlot[] }
  | { readonly ok: false; readonly problems: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function parseSlot(raw: unknown, index: number, problems: string[]): RequiredDocSlot | null {
  const where = 'slot ' + String(index);
  if (!isRecord(raw)) {
    problems.push(where + ': must be an object');
    return null;
  }

  const code = raw['code'];
  if (!nonEmptyString(code)) {
    problems.push(where + ': code must be a non-empty string');
    return null;
  }
  const named = "slot '" + code + "'";

  const label = raw['label'];
  if (!nonEmptyString(label)) {
    problems.push(named + ': label must be a non-empty string');
    return null;
  }

  // Absent means required. A slot that does not say otherwise is one somebody
  // has to produce, and the permissive reading would let a typo in this key
  // make a document optional without anyone deciding that.
  const requiredRaw = raw['required'];
  if (requiredRaw !== undefined && typeof requiredRaw !== 'boolean') {
    problems.push(named + ': required must be true or false when it is present');
    return null;
  }
  const required = requiredRaw ?? true;

  const extractRaw = raw['extract_required'];
  if (extractRaw !== undefined && !Array.isArray(extractRaw)) {
    problems.push(named + ': extract_required must be an array of field names');
    return null;
  }
  const extractRequired = extractRaw ?? [];
  if (!extractRequired.every(nonEmptyString)) {
    problems.push(named + ': every extract_required entry must be a non-empty field name');
    return null;
  }

  return { code, label, required, extractRequired: [...extractRequired] };
}

export function parseRequiredDocs(value: unknown): RequiredDocsParse {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return { ok: false, problems: ['required_docs must be a JSON object'] };
  }
  if (value['version'] !== REQUIRED_DOCS_VERSION) {
    problems.push(
      'required_docs version must be ' +
        String(REQUIRED_DOCS_VERSION) +
        '; received ' +
        String(value['version']),
    );
  }

  const rawSlots = value['slots'];
  if (!Array.isArray(rawSlots)) {
    problems.push('required_docs must carry a slots array');
    return { ok: false, problems };
  }

  const slots: RequiredDocSlot[] = [];
  const seen = new Set<string>();
  rawSlots.forEach((raw, index) => {
    const slot = parseSlot(raw, index, problems);
    if (slot === null) {
      return;
    }
    if (seen.has(slot.code)) {
      // Two slots with one code would collide on the table's unique constraint
      // at generation time. Refusing here names the product; refusing there
      // names a constraint, and only one of those is diagnosable.
      problems.push("slot '" + slot.code + "': code appears twice in one pack");
      return;
    }
    seen.add(slot.code);
    slots.push(slot);
  });

  // A product asking for nothing is a product whose pack is complete before
  // anyone uploads anything. That may be a real policy one day, but it is not
  // one anybody has stated, and reading it out of an empty array would be this
  // parser deciding it.
  if (slots.length === 0 && problems.length === 0) {
    problems.push('required_docs must ask for at least one document');
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, slots };
}
