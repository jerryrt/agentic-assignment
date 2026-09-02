/**
 * Lets plain `node` import a `@lj/*` workspace package. Development only.
 *
 * The workspace consumes its internal packages as TypeScript SOURCE -- each
 * manifest maps `"exports"` at `./src/index.ts` (plan/01-architecture.md) -- and
 * those sources import each other two ways that Node cannot follow:
 *
 *   ./primitives.js   a specifier that exists only as ./primitives.ts. Node 24
 *                     strips types but performs no extension rewriting, so it
 *                     looks for a .js file that this repository never builds.
 *   ./config          an extensionless specifier, which only a bundler resolves.
 *
 * Both are correct for the bundlers that actually consume this code -- esbuild
 * for the Vercel function, Vite for Vitest -- and both are invisible to Node.
 * The handoff on issue #9 records this as a property of the workspace rather
 * than of any one package, and it meets anyone writing a Node command against
 * these packages; the transition codegen bundles with esbuild for the same
 * reason.
 *
 * This hook is the smaller answer for the dev server: it re-runs the default
 * resolver on a rewritten specifier only after the real one has failed, so
 * nothing that already resolves changes, and no dependency is added to do it.
 *
 * NOT loaded by the deployed function. Vercel builds `api/*.ts` with a bundler
 * that resolves both forms natively, and a resolution hook in production would
 * be a second, divergent module graph.
 */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/** A `.js` specifier written by TypeScript source means the sibling `.ts`. */
const TYPESCRIPT_EQUIVALENT: ReadonlyMap<string, string> = new Map([
  ['.js', '.ts'],
  ['.mjs', '.mts'],
  ['.cjs', '.cts'],
]);

function candidatesFor(specifier: string): readonly string[] {
  for (const [javascript, typescript] of TYPESCRIPT_EQUIVALENT) {
    if (specifier.endsWith(javascript)) {
      return [specifier.slice(0, -javascript.length) + typescript];
    }
  }
  // Extensionless: a file, then a directory index, in the order a bundler
  // would try them.
  return [specifier + '.ts', specifier + '/index.ts'];
}

interface Resolution {
  readonly url: string;
}

/**
 * Node's resolver reports a missing file two different ways depending on the
 * specifier: some forms throw, and some return a URL for a file that is not
 * there. Both mean "not resolved" here, so both are folded into null.
 */
function attempt(resolve: () => Resolution): Resolution | null {
  try {
    const resolution = resolve();
    if (resolution.url.startsWith('file:') && !existsSync(fileURLToPath(resolution.url))) {
      return null;
    }
    return resolution;
  } catch {
    return null;
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const direct = attempt(() => nextResolve(specifier, context));
    if (direct !== null) {
      return direct;
    }
    for (const candidate of candidatesFor(specifier)) {
      const rewritten = attempt(() => nextResolve(candidate, context));
      if (rewritten !== null) {
        return rewritten;
      }
    }
    // Nothing worked. Hand the original specifier back so the error names what
    // the source actually asked for rather than a rewrite of it.
    return nextResolve(specifier, context);
  },
});
