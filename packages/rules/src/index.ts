/**
 * @lj/rules -- one evaluator, three rule sets.
 *
 * Eligibility criteria (plan 05), document completeness and cross-document
 * consistency (plan 04) and credit availability (plan 06) are all
 * `evaluate(context, rules) -> RuleResult[]`. Sharing the evaluator is what
 * makes three options affordable: one vocabulary, one explanation drawer, one
 * list component, and a blocked workflow guard that reads to the user exactly
 * like an unmet criterion -- because to them it is the same thing.
 *
 * Pure by construction: no I/O, no framework, and no clock. Everything a rule
 * needs arrives in its context argument, including today's date (CLAUDE.md
 * section 8). That is what lets the browser predict a decision and the server
 * make it, running byte-identical code.
 *
 * A deep import into `src/` from another package is a layering violation the
 * lint rules reject, so this list is the whole contract.
 */

export * from './engine/reading.js';
export * from './engine/figures.js';
export * from './engine/rule.js';
export * from './engine/numeric.js';
export * from './engine/exact.js';
export * from './engine/agreement.js';
export * from './engine/predicate.js';

export * from './eligibility/context.js';
export * from './eligibility/fields.js';
export * from './eligibility/criteria.js';
export * from './eligibility/rules.js';

export * from './documents/context.js';
export * from './documents/entity-name.js';
export * from './documents/completeness.js';
export * from './documents/consistency.js';

export * from './servicing/availability.js';
