/**
 * The 7-bit ASCII rule from CLAUDE.md section 4, as an ESLint rule.
 *
 * The reason this is enforced rather than merely preferred is security, not
 * tidiness. A Cyrillic "a" and a Latin "a" render identically in every editor
 * and every code review; an identifier or a string that differs from the one
 * next to it only by a homoglyph is a substitution nobody can see. Grep cannot
 * find it either, so the diff that introduces it reads as a no-op. Everything
 * else - copy-paste damage, terminals in the wrong locale, diff tools that
 * mangle smart quotes - is a good reason to keep the rule but not the reason it
 * exists.
 *
 * The check runs over raw source text rather than over AST nodes on purpose.
 * Selector-based matching reaches literals, template chunks and identifiers,
 * but not comments, and a homoglyph hidden in a comment that explains a
 * threshold is exactly as misleading as one in the code. Scanning the text is
 * also the only way this rule can stay identical to the pre-commit
 * `grep '[^\x00-\x7F]'` that backs it up - two checks that disagree about what
 * they forbid are worse than one.
 */

// The class has to name the control range to stay byte-identical to the
// pre-commit `grep '[^\x00-\x7F]'`; narrowing it to printable ASCII would make
// the two checks forbid different things.
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/gu;

/** Name the offender by code point: the message itself has to stay ASCII. */
function codePointLabel(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return 'U+FFFD';
  }
  return 'U+' + codePoint.toString(16).toUpperCase().padStart(4, '0');
}

const noNonAscii = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require source files to be 7-bit ASCII, so that no two characters can look alike',
    },
    schema: [],
    messages: {
      nonAscii:
        'Non-ASCII character {{label}}. Sources are 7-bit ASCII (CLAUDE.md section 4): ' +
        "write '->', '--', '...', and plain quotes. User-facing display text belongs " +
        'in a message catalogue, not here.',
    },
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode;
        const text = sourceCode.getText();
        NON_ASCII.lastIndex = 0;
        let match = NON_ASCII.exec(text);
        while (match !== null) {
          const start = match.index;
          context.report({
            loc: {
              start: sourceCode.getLocFromIndex(start),
              end: sourceCode.getLocFromIndex(start + match[0].length),
            },
            messageId: 'nonAscii',
            data: { label: codePointLabel(match[0]) },
          });
          match = NON_ASCII.exec(text);
        }
      },
    };
  },
};

/**
 * The narrow exception CLAUDE.md section 4 allows: user-facing display text,
 * where the correct character is the correct character. It is expressed as a
 * path allowance rather than an inline disable so that the exception is
 * reviewable in one place, and so that display text cannot creep back into
 * logic files under cover of a comment.
 */
export const MESSAGE_CATALOGUE_GLOBS = [
  '**/i18n/**',
  '**/locale/**',
  '**/locales/**',
  '**/messages/**',
  '**/*.messages.ts',
  '**/*.messages.json',
];

export const asciiRules = { 'no-non-ascii': noNonAscii };
