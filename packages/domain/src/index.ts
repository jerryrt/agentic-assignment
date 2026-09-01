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

export * from './primitives.js';
export * from './roles.js';
export * from './money.js';
export * from './finance.js';
export * from './states.js';
export * from './labels.js';
export * from './rule-result.js';

export * from './entities/organisation.js';
export * from './entities/profile.js';
export * from './entities/loan-product.js';
export * from './entities/application.js';
export * from './entities/workflow-event.js';
export * from './entities/workflow-transition.js';
