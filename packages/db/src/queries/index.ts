/**
 * The query helpers, one module per table or projection.
 *
 * They are deliberately thin: a filter, an order, and the unwrapping of
 * PostgREST's `{ data, error }` pair.  Anything that decides something --
 * whether a transition is legal, whether an applicant is eligible, what a
 * state is called for an audience -- belongs above this layer, in
 * `packages/workflow`, `packages/rules` or `packages/domain` (CLAUDE.md
 * section 8).
 */

export * from './application-decisions.ts';
export * from './applications.ts';
export * from './credit-releases.ts';
export * from './documents.ts';
export * from './eligibility-snapshots.ts';
export * from './loan-products.ts';
export * from './loans.ts';
export * from './organisations.ts';
export * from './profiles.ts';
export * from './workflow-events.ts';
export * from './workflow-transitions.ts';
