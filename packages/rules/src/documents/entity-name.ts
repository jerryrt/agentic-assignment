/**
 * Entity-name normalisation, for the cross-document name check.
 *
 * "Smith Farms Ltd." on a land title and "SMITH FARMS" on a tax return are the
 * same borrower, and a rule that says otherwise generates a cross-check failure
 * on every well-formed file. What it must still catch is a genuinely different
 * name, so the normalisation is narrow and stated: case, punctuation, repeated
 * whitespace, a leading "the", the ampersand spelling, and trailing legal
 * suffixes. Nothing else -- word order, abbreviations and spelling variants are
 * left alone, because collapsing those would start matching names that differ.
 *
 * CLAUDE.md section 9 puts this alongside money and date formatting, and its
 * eventual home is @lj/domain. It lives here for now because domain has no such
 * function and is owned by another scope; there is exactly one implementation
 * either way, which is the property the rule is actually about.
 *
 * Non-ASCII folding is deliberately absent: this package's sources are 7-bit
 * ASCII (section 4), and an accent-folding table written in escapes would be
 * unreviewable. A name carrying an accent normalises to itself, which is
 * correct as long as both documents spell it the same way.
 */

const LEGAL_SUFFIXES = new Set([
  'ltd',
  'limited',
  'inc',
  'incorporated',
  'llc',
  'corp',
  'corporation',
  'co',
  'company',
  'lp',
  'llp',
  'plc',
]);

export function normaliseEntityName(raw: string): string {
  const words = raw
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter((word) => word !== '');

  if (words[0] === 'the') {
    words.shift();
  }

  // Stripping down to nothing would make every such name compare equal to
  // every other, which is the opposite of what a cross-check is for.
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (last === undefined || !LEGAL_SUFFIXES.has(last)) {
      break;
    }
    words.pop();
  }

  return words.join(' ');
}
