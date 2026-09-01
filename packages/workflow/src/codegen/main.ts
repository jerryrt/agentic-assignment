import { allTransitionRows } from './rows.js';
import { renderTransitionsSql } from './sql.js';

/**
 * The generator's entry point. It writes the migration body to standard output
 * and stops there.
 *
 * It does not write a file, and that is deliberate rather than lazy.
 * packages/workflow is a pure package: it may not import `node:fs`, and the
 * ESLint layering rule enforces that, because a pure package that can reach the
 * filesystem is one refactor away from a guard doing the same. Choosing the
 * next migration number and placing the file are filesystem work, so they live
 * in tools/generate-transitions.sh, where the shell does them in a handful of
 * lines and nothing has to be excused.
 *
 * `process` is declared here rather than pulled in with @types/node for the
 * same reason: this package deliberately has no ambient Node types, and the one
 * member used should be visible in the one file that uses it. `write` rather
 * than `console.log` because the rendered SQL already ends with its newline.
 */
declare const process: { readonly stdout: { write(chunk: string): boolean } };

process.stdout.write(renderTransitionsSql(allTransitionRows()));
