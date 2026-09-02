/**
 * Render one stylesheet from design/tokens.json to standard output.
 *
 *   node tools/render-tokens.ts css  <path to tokens.json>
 *   node tools/render-tokens.ts scss <path to tokens.json>
 *
 * Two artefacts rather than one, because the two consumers need different
 * things and neither can read the other's format (design/02-implementation.md):
 * Tailwind and the components need *runtime* CSS variables that swap with the
 * colour scheme, while Angular Material's mat.theme needs a *build-time* Sass
 * map to generate its tonal palettes. Both come from the same JSON in the same
 * step, so this is two renderings of one definition, not two definitions.
 *
 * Everything that decides *where* files live is in generate-tokens.sh; this
 * file reads one path and prints one artefact. That split is copied from
 * packages/workflow/tools/generate-transitions.sh, and it is what lets `check`
 * be a plain `diff -u` against the committed file rather than a bespoke
 * comparison written twice.
 *
 * Unlike that generator this one needs no bundler. It imports nothing from the
 * workspace -- its whole input is a JSON file -- so Node's own type stripping
 * runs it directly. esbuild would be ceremony here, and a build step that is
 * not needed is a build step that can break.
 */

import { readFileSync } from 'node:fs';

/** Prefix on every emitted custom property. The one place it is written. */
const PREFIX = '--lj-';

/** Uppercase six-digit hex, which is what preview.py's contrast report reads. */
const HEX = /^#[0-9A-F]{6}$/;

const GENERATED_BY = 'packages/ui/tools/generate-tokens.sh';
const SOURCE = 'design/tokens.json';

type Scheme = Readonly<Record<string, string>>;

interface Theme {
  readonly name: string;
  readonly tagline: string;
  readonly light: Scheme;
  readonly dark: Scheme;
}

function fail(message: string): never {
  throw new Error('render-tokens: ' + message);
}

function readScheme(theme: Record<string, unknown>, mode: 'light' | 'dark'): Scheme {
  const scheme = theme[mode];
  if (typeof scheme !== 'object' || scheme === null || Array.isArray(scheme)) {
    fail("theme." + mode + ' must be an object of token name to hex colour');
  }
  const entries = Object.entries(scheme as Record<string, unknown>);
  if (entries.length === 0) {
    fail('theme.' + mode + ' defines no tokens');
  }
  for (const [name, value] of entries) {
    if (typeof value !== 'string' || !HEX.test(value)) {
      fail(
        "theme." + mode + '.' + name + ' is ' + JSON.stringify(value) +
          '; every token is an uppercase six-digit hex colour such as "#0B6A6E"',
      );
    }
  }
  return Object.fromEntries(entries) as Scheme;
}

/**
 * The token *contract* is the set of names, and both schemes have to expose all
 * of it (design/00-foundations.md). A name defined in one mode and not the
 * other is the bug that produces an unstyled element in dark mode only, which
 * is the mode nobody screenshots. Order is compared as well as membership so
 * that the two blocks of the emitted CSS can be read side by side.
 */
function assertSameContract(light: Scheme, dark: Scheme): void {
  const lightNames = Object.keys(light);
  const darkNames = Object.keys(dark);
  if (lightNames.join(',') !== darkNames.join(',')) {
    fail(
      'theme.light and theme.dark must define the same token names in the same order.\n' +
        '  light: ' + lightNames.join(' ') + '\n' +
        '  dark:  ' + darkNames.join(' '),
    );
  }
}

function loadTheme(path: string): Theme {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    fail(path + ' is not a JSON object');
  }
  const theme = (parsed as Record<string, unknown>)['theme'];
  if (typeof theme !== 'object' || theme === null) {
    fail(path + ' has no "theme" object');
  }
  const record = theme as Record<string, unknown>;
  const name = record['name'];
  const tagline = record['tagline'];
  if (typeof name !== 'string' || typeof tagline !== 'string') {
    fail('theme.name and theme.tagline must both be strings');
  }
  const light = readScheme(record, 'light');
  const dark = readScheme(record, 'dark');
  assertSameContract(light, dark);
  return { name, tagline, light, dark };
}

function declarations(scheme: Scheme, indent: string): string {
  return Object.entries(scheme)
    .map(([name, value]) => indent + PREFIX + name + ': ' + value + ';')
    .join('\n');
}

function renderCss(theme: Theme): string {
  return [
    '/*',
    ' * ' + theme.name + ' -- the runtime colour contract.',
    ' *',
    ' * GENERATED from ' + SOURCE + ' by ' + GENERATED_BY + '.',
    ' * Never hand-edit: `pnpm tokens:check` fails the build when this file and',
    ' * the JSON disagree. Change the JSON and run `pnpm tokens:gen`.',
    ' *',
    ' * The light palette is defined on bare :root so that no token has its only',
    ' * definition inside a media query. Dark is then redefined twice -- once for',
    ' * the system preference, once for an explicit choice -- so that a stored',
    ' * override wins in both directions (design/00-foundations.md).',
    ' */',
    '',
    ':root {',
    declarations(theme.light, '  '),
    '  color-scheme: light dark;',
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    declarations(theme.dark, '    '),
    '  }',
    '}',
    '',
    ':root[data-theme="dark"] {',
    declarations(theme.dark, '  '),
    '}',
    '',
  ].join('\n');
}

function sassMap(name: string, scheme: Scheme): string {
  const entries = Object.entries(scheme)
    .map(([token, value]) => "  '" + token + "': " + value + ',')
    .join('\n');
  return '$' + name + ': (\n' + entries + '\n);';
}

/**
 * The three source colours Material has to be told about (design/01-theme.md):
 * left to itself M3 derives a tertiary from the primary and generates its own
 * error red, and the app then shows two greens and two reds that are almost but
 * not quite the token values. They are emitted rather than restated in the app's
 * Sass so that they cannot drift from the palette they are taken from.
 */
function sourceColour(theme: Theme, token: string): string {
  const value = theme.light[token];
  if (value === undefined) {
    fail("theme.light has no '" + token + "' token, which the Material wiring needs");
  }
  return value;
}

function renderScss(theme: Theme): string {
  return [
    '// ' + theme.name + ' -- the build-time colour contract for Angular Material.',
    '//',
    '// GENERATED from ' + SOURCE + ' by ' + GENERATED_BY + '.',
    '// Never hand-edit: `pnpm tokens:check` fails the build when this file and',
    '// the JSON disagree. Change the JSON and run `pnpm tokens:gen`.',
    '//',
    '// Components must not read these maps. They read the CSS variables in',
    '// _tokens.css, which follow the colour scheme at runtime; a Sass value is',
    '// resolved once at build time and would freeze the light palette into the',
    '// stylesheet. This file exists for mat.theme, which cannot read a variable.',
    '',
    sassMap('lj-light', theme.light),
    '',
    sassMap('lj-dark', theme.dark),
    '',
    "$lj-schemes: (\n  'light': $lj-light,\n  'dark': $lj-dark,\n);",
    '',
    '// M3 source colours. See design/01-theme.md.',
    '$lj-primary-source: ' + sourceColour(theme, 'primary') + ';',
    '$lj-tertiary-source: ' + sourceColour(theme, 'ok') + ';',
    '$lj-error-source: ' + sourceColour(theme, 'err') + ';',
    '',
  ].join('\n');
}

function main(argv: readonly string[]): void {
  const [artefact, tokensPath] = argv;
  if (tokensPath === undefined || (artefact !== 'css' && artefact !== 'scss')) {
    fail('usage: render-tokens.ts <css|scss> <path to tokens.json>');
  }
  const theme = loadTheme(tokensPath);
  process.stdout.write(artefact === 'css' ? renderCss(theme) : renderScss(theme));
}

main(process.argv.slice(2));
