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

export * from './application-decisions';
export * from './applications';
export * from './loan-products';
export * from './organisations';
export * from './profiles';
export * from './workflow-events';
export * from './workflow-transitions';
