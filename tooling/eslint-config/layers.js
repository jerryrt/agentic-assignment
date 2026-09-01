/**
 * The layering rule of CLAUDE.md section 8 and plan/01-architecture.md.
 *
 * The dependency graph is written once, in ALLOWED_IMPORTS below, and both
 * enforcement mechanisms are derived from it. Two mechanisms are needed because
 * they fail in opposite directions:
 *
 *   1. `import-x/no-restricted-paths` works on the *resolved* absolute path. It
 *      is the only thing that can catch a relative escape hatch such as
 *      `../../rules/src/engine`, or a deep import into another package. It also
 *      catches `@lj/*` specifiers, but only because the TypeScript resolver maps
 *      them through each package's `"exports": "./src/index.ts"` and then
 *      through the workspace symlink back to `packages/<name>/src`. Its failure
 *      mode is silence: the rule returns early on any specifier it cannot
 *      resolve, so a broken resolver turns the whole layering check off without
 *      a single error.
 *
 *   2. `lj/layer-imports` works on the *written* specifier and needs no
 *      resolution at all. It cannot see a relative escape hatch, but it cannot
 *      be silently disabled either.
 *
 * An architectural boundary that can fail open is not a boundary, so both run.
 */

import path from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Resolved from this file rather than from `process.cwd()`. Turborepo runs the
 * lint task once per package, with the working directory set to that package,
 * so anything anchored to the cwd would match a different set of files in every
 * invocation - or none.
 */
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Adjacency list of the graph in plan/01-architecture.md. A package may import
 * exactly the workspace packages listed for it, and nothing else in the
 * workspace. Adding a package means adding a row here and nowhere else.
 */
const ALLOWED_IMPORTS = {
  '@lj/domain': [],
  '@lj/workflow': ['@lj/domain'],
  '@lj/rules': ['@lj/domain'],
  '@lj/db': ['@lj/domain'],
  '@lj/ui': ['@lj/domain'],
  '@lj/api': ['@lj/domain', '@lj/workflow', '@lj/rules', '@lj/db'],
  '@lj/web': ['@lj/domain', '@lj/workflow', '@lj/rules', '@lj/db', '@lj/ui'],
};

/** Where each package's sources live, relative to the workspace root. */
const PACKAGE_DIRS = {
  '@lj/domain': 'packages/domain',
  '@lj/workflow': 'packages/workflow',
  '@lj/rules': 'packages/rules',
  '@lj/db': 'packages/db',
  '@lj/ui': 'packages/ui',
  '@lj/api': 'apps/api',
  '@lj/web': 'apps/web',
};

/**
 * "No I/O in workflow or rules. Everything a guard or rule needs arrives in its
 * context argument." A pure package that can reach the filesystem, the network
 * or the database is one refactor away from being untestable, and the browser
 * and the server would stop running byte-identical logic.
 */
const PURE_PACKAGES = ['@lj/domain', '@lj/workflow', '@lj/rules'];

/**
 * "No framework imports below the delivery layer." packages/ui and apps/web are
 * the delivery layer for Angular; everything else must compile and run without
 * it.
 */
const ANGULAR_PACKAGES = ['@lj/ui', '@lj/web'];

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => 'node:' + name),
]);

const ALL_PACKAGES = Object.keys(ALLOWED_IMPORTS);

function absoluteDirOf(packageName) {
  return path.join(WORKSPACE_ROOT, PACKAGE_DIRS[packageName]);
}

function forbiddenPackagesFor(packageName) {
  const allowed = new Set(ALLOWED_IMPORTS[packageName]);
  return ALL_PACKAGES.filter((other) => other !== packageName && !allowed.has(other));
}

/** True when `filePath` is inside `directory` (or is `directory` itself). */
function contains(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Zones for `import-x/no-restricted-paths`. `target` and `from` are absolute, so
 * the rule's `basePath` (which defaults to the working directory) cannot change
 * what they mean.
 */
export const layerZones = ALL_PACKAGES.map((packageName) => ({
  target: absoluteDirOf(packageName),
  from: forbiddenPackagesFor(packageName).map(absoluteDirOf),
  message:
    packageName +
    ' may import only [' +
    (ALLOWED_IMPORTS[packageName].join(', ') || 'nothing') +
    ']. Dependencies point one way (CLAUDE.md section 8): move the shared code ' +
    'down the graph rather than importing back up it.',
})).filter((zone) => zone.from.length > 0);

function layerOf(filePath) {
  return ALL_PACKAGES.find((packageName) => contains(absoluteDirOf(packageName), filePath));
}

function bareSpecifierOf(rawSpecifier) {
  const segments = rawSpecifier.split('/');
  return rawSpecifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

const layerImports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce the one-way dependency graph on written import specifiers, ' +
        'without relying on module resolution',
    },
    schema: [],
    messages: {
      forbiddenPackage:
        "'{{specifier}}' is above {{layer}} in the dependency graph. {{layer}} may " +
        'import only [{{allowed}}] (CLAUDE.md section 8).',
      forbiddenIo:
        "'{{specifier}}' performs I/O, and {{layer}} is a pure package: everything a " +
        'guard or a rule needs arrives in its context argument (CLAUDE.md section 8).',
      forbiddenFramework:
        "'{{specifier}}' is a framework import, and {{layer}} is below the delivery " +
        'layer. Keeping the framework out is what lets the browser and the server run ' +
        'byte-identical logic (CLAUDE.md section 8).',
    },
  },
  create(context) {
    const layer = layerOf(context.physicalFilename);
    if (layer === undefined) {
      return {};
    }

    const forbiddenPackages = new Set(forbiddenPackagesFor(layer));
    const isPure = PURE_PACKAGES.includes(layer);
    const allowsAngular = ANGULAR_PACKAGES.includes(layer);

    function check(node) {
      if (node === null || node.type !== 'Literal' || typeof node.value !== 'string') {
        return;
      }
      const specifier = node.value;
      const bare = bareSpecifierOf(specifier);

      if (forbiddenPackages.has(bare)) {
        context.report({
          node,
          messageId: 'forbiddenPackage',
          data: {
            specifier,
            layer,
            allowed: ALLOWED_IMPORTS[layer].join(', ') || 'nothing',
          },
        });
        return;
      }

      if (isPure && (NODE_BUILTINS.has(specifier) || bare.startsWith('@supabase/'))) {
        context.report({ node, messageId: 'forbiddenIo', data: { specifier, layer } });
        return;
      }

      if (!allowsAngular && bare.startsWith('@angular/')) {
        context.report({ node, messageId: 'forbiddenFramework', data: { specifier, layer } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
    };
  },
};

export const layerRules = { 'layer-imports': layerImports };
