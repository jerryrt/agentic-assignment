/**
 * The shared flat config for every package in the workspace.
 *
 * It carries only what CLAUDE.md makes mandatory for all of them: the layering
 * rule (section 8), the 7-bit ASCII rule (section 4), and the two style rules
 * section 11 states as absolutes. It knows nothing about Angular on purpose -
 * a config that imported angular-eslint would drag the framework into the lint
 * step of packages/rules, which is the dependency direction the layering rule
 * exists to forbid. apps/web and packages/ui compose angular-eslint on top of
 * this array in their own eslint.config.js.
 *
 * Usage, from any package or from the workspace root:
 *
 *   import lj from '@lj/eslint-config';
 *   export default [...lj];
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

import { asciiRules, MESSAGE_CATALOGUE_GLOBS } from './ascii.js';
import { layerRules, layerZones } from './layers.js';

const TYPESCRIPT_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const ALL_SOURCE_FILES = [...TYPESCRIPT_FILES, '**/*.js', '**/*.mjs', '**/*.cjs'];
const TEST_FILES = ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'];

const ljPlugin = {
  meta: { name: '@lj/eslint-config' },
  rules: { ...asciiRules, ...layerRules },
};

export default [
  {
    // Build output and the local Supabase stack are not ours to lint. Listed
    // once here because a flat config with only `ignores` applies globally.
    ignores: [
      '**/dist/**',
      '**/.angular/**',
      '**/.turbo/**',
      '**/.vercel/**',
      // Bundled output. Generated files are never hand-edited, so linting them
      // reports on a generator's choices rather than on anything anyone wrote.
      '**/generated/**',
      '**/coverage/**',
      '**/node_modules/**',
      'supabase/.temp/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    name: 'lj/layering',
    files: TYPESCRIPT_FILES,
    plugins: { 'import-x': importX, lj: ljPlugin },
    settings: {
      // Without a resolver that understands `"exports": "./src/index.ts"` and
      // the workspace symlinks, `import-x/no-restricted-paths` resolves nothing
      // and therefore reports nothing - see the note in layers.js.
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ alwaysTryTypes: true }),
      ],
    },
    rules: {
      'import-x/no-restricted-paths': ['error', { zones: layerZones }],
      'lj/layer-imports': 'error',
    },
  },

  {
    name: 'lj/ascii',
    files: ALL_SOURCE_FILES,
    plugins: { lj: ljPlugin },
    rules: {
      'lj/no-non-ascii': 'error',
      // Catches the whitespace half of the problem in the places a plain
      // codepoint scan would still see: an irregular space inside a string is
      // ASCII-visible as a space and invisible as a bug.
      'no-irregular-whitespace': [
        'error',
        {
          skipStrings: false,
          skipComments: false,
          skipRegExps: false,
          skipTemplates: false,
          skipJSXText: false,
        },
      ],
    },
  },

  {
    name: 'lj/ascii-message-catalogues',
    files: MESSAGE_CATALOGUE_GLOBS,
    rules: {
      // The narrow exception of CLAUDE.md section 4. Display text keeps its real
      // characters; an intentional non-breaking space in a translated string is
      // data, not a defect.
      'lj/no-non-ascii': 'off',
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
    },
  },

  {
    name: 'lj/style',
    files: TYPESCRIPT_FILES,
    rules: {
      // CLAUDE.md section 11, stated as absolutes rather than preferences.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // A leading underscore marks a binding kept deliberately: a parameter
      // that documents a required signature, or a destructured field being
      // omitted. Without this the only way to satisfy the rule is to delete
      // the name, which loses the documentation the signature was carrying.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    name: 'lj/tests',
    files: TEST_FILES,
    rules: {
      // "No non-null assertions outside tests." A test asserting on a value it
      // has just constructed is not making a claim about production data.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
