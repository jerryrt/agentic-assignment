/**
 * Bundle each route into a file the platform can deploy without resolving
 * anything.
 *
 * Vercel's zero-config Node builder transpiles a file in `api/` and leaves its
 * imports to resolve at run time. That cannot work here: the workspace
 * packages are consumed as TypeScript source through pnpm's symlinked
 * `node_modules`, so the deployed function started and failed immediately with
 * ERR_MODULE_NOT_FOUND on a `.ts` file that was never uploaded. Asking the
 * platform to include those sources fails differently and more plainly -- "the
 * framework produced an invalid deployment package ... files in symlinked
 * directories".
 *
 * So the handlers live in `src/routes` and are bundled here into plain
 * JavaScript with every import inlined, including the database driver: a
 * deployed function has no `node_modules` of its own, so an external import is
 * a resolution with nowhere to succeed. What remains in `api/` is a one-line
 * re-export of the bundle -- a real file, in this directory, reachable without
 * following a symlink.
 */
import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routesDir = join(apiRoot, 'src', 'routes');
const outDir = join(apiRoot, 'generated');

await mkdir(outDir, { recursive: true });
const routes = (await readdir(routesDir)).filter((f) => f.endsWith('.ts'));

await build({
  entryPoints: routes.map((f) => join(routesDir, f)),
  outdir: outDir,
  outExtension: { '.js': '.js' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'warning',
});

process.stdout.write(`bundled ${routes.length} route(s): ${routes.join(', ')}\n`);
