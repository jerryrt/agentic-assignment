/**
 * @lj/domain -- entities, schemas and pure calculation.
 *
 * The bottom of the dependency graph: this package imports nothing from the
 * workspace and nothing that performs I/O, which is what lets the browser and
 * the server run byte-identical logic over these types (CLAUDE.md section 8).
 *
 * Everything the rest of the workspace consumes crosses this file. A deep
 * import into `src/` from another package is a layering violation the lint
 * rules reject, so this list is the whole contract.
 */

export * from './primitives.ts';
export * from './roles.ts';
export * from './money.ts';
export * from './finance.ts';
export * from './states.ts';
export * from './labels.ts';
export * from './rule-result.ts';

export * from './entities/organisation.ts';
export * from './entities/profile.ts';
export * from './entities/loan-product.ts';
export * from './entities/application.ts';
export * from './entities/workflow-event.ts';
export * from './entities/workflow-transition.ts';
