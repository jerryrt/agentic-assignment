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

export * from './engine/reading.ts';
export * from './engine/figures.ts';
export * from './engine/rule.ts';
export * from './engine/numeric.ts';
export * from './engine/exact.ts';
export * from './engine/agreement.ts';
export * from './engine/predicate.ts';

export * from './application/context.ts';
export * from './application/completeness.ts';

export * from './eligibility/context.ts';
export * from './eligibility/fields.ts';
export * from './eligibility/criteria.ts';
export * from './eligibility/rules.ts';

export * from './documents/context.ts';
export * from './documents/required-docs.ts';
export * from './documents/entity-name.ts';
export * from './documents/completeness.ts';
export * from './documents/consistency.ts';

export * from './servicing/availability.ts';
