/**
 * Build each route into a self-contained serverless function.
 *
 * Vercel's zero-config Node builder transpiles the entry file and leaves every
 * import to be resolved at run time. That cannot work here: the workspace
 * packages are consumed as TypeScript source through pnpm's symlinked
 * `node_modules`, so the function starts and immediately fails with
 * ERR_MODULE_NOT_FOUND on a `.ts` file that was never uploaded. Asking Vercel
 * to include those sources fails differently and more clearly -- "the framework
 * produced an invalid deployment package ... files in symlinked directories".
 *
 * So the function is built rather than traced. esbuild inlines every workspace
 * import into one file with no `node_modules` behind it, which removes the
 * question of what the platform will or will not follow. The result is written
 * in the Build Output API layout, so Vercel deploys exactly what was built
 * instead of inferring it.
 *
 * Nothing is left external, including the Supabase driver. A function
 * directory in the Build Output API carries no `node_modules`, so an external
 * import is a runtime resolution that has nowhere to succeed. Inlining
 * everything costs a larger artefact and buys the guarantee that the function
 * has no resolution left to get wrong.
 */
import { build } from 'esbuild';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(apiRoot, '.vercel', 'output');

/** Matches the `engines.node` in this package's manifest and the CI runtime. */
const RUNTIME = 'nodejs24.x';

async function buildRoute(routeFile: string): Promise<string> {
  const name = routeFile.replace(/\.ts$/, '');
  const funcDir = join(outputRoot, 'functions', 'api', `${name}.func`);
  await mkdir(funcDir, { recursive: true });

  await build({
    entryPoints: [join(apiRoot, 'api', routeFile)],
    outfile: join(funcDir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'warning',
  });

  await writeFile(
    join(funcDir, '.vc-config.json'),
    JSON.stringify({ runtime: RUNTIME, handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: true }, null, 2) + '\n',
  );
  // The bundle is ESM but carries no package.json of its own, and Node reads
  // the nearest one to decide module type.
  await writeFile(join(funcDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
  return `api/${name}`;
}

const routes = (await readdir(join(apiRoot, 'api'))).filter((f) => f.endsWith('.ts'));
const built = await Promise.all(routes.map(buildRoute));

await mkdir(join(outputRoot, 'static'), { recursive: true });
await writeFile(
  join(outputRoot, 'config.json'),
  JSON.stringify({ version: 3, routes: [{ handle: 'filesystem' }] }, null, 2) + '\n',
);

process.stdout.write(`built ${built.length} function(s): ${built.join(', ')}\n`);
