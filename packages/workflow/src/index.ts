/**
 * @lj/workflow -- the state machine engine and the three machine definitions.
 *
 * Pure TypeScript over @lj/domain: no I/O, no framework, no clock. That is what
 * lets the browser and the serverless function run byte-identical logic -- the
 * client predicts a transition to grey out a button and show its blockers, the
 * server decides it, and the server wins if they ever disagree.
 *
 * A deep import into `src/` from another package is a layering violation the
 * lint rules reject, so this list is the whole contract.
 */

export * from './types.js';
export * from './context.js';
export * from './guards.js';
export * from './engine.js';
export * from './machines/index.js';

/**
 * The code generator's pure half. Exported because the parity test compares its
 * output with the committed migration; nothing in the delivery layer needs it.
 */
export * from './codegen/rows.js';
export * from './codegen/sql.js';
