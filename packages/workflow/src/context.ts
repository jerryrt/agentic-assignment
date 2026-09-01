import type { RuleResult } from '@lj/domain';

/**
 * The seam between this package and packages/rules.
 *
 * Guards need rules -- "the steps are complete", "at least one product fits",
 * "the document pack is complete", "the request is within available credit" --
 * and every one of those lives in packages/rules, which sits beside this package
 * rather than below it. Importing it would point a dependency sideways and would
 * give a guard a way to reach for data instead of being handed it.
 *
 * So a machine declares the rule sets it needs and never evaluates them. The
 * caller -- apps/api on the server, the feature store in the browser -- runs
 * packages/rules first and passes the results in. Each field below is one rule
 * set's evaluated output, named for the guard that consumes it.
 *
 * A field must never arrive empty. An empty set is read as "this was not
 * evaluated" and refuses the transition (see requireRules), because the
 * alternative is a forgotten evaluation silently unlocking a transition.
 */

export interface ApplicationGuardContext {
  /** Is the multi-step form finished? Blocks `submit`. */
  readonly completeness: readonly RuleResult[];
  /** Does at least one product still fit? Blocks `submit`. */
  readonly eligibility: readonly RuleResult[];
  /** Is every required document accepted and current? Blocks `begin_review`. */
  readonly documentPack: readonly RuleResult[];
}

/**
 * No transition in the document machine is guarded: uploading, extracting,
 * accepting and rejecting are decisions in themselves, not conditional ones.
 * The type is written out anyway so the machine's third type argument says so
 * explicitly rather than by being `unknown`.
 */
export type DocumentSlotGuardContext = Readonly<Record<string, never>>;

export interface CreditReleaseGuardContext {
  /** Does the request fit inside the undrawn balance? Blocks `submit`. */
  readonly availableCredit: readonly RuleResult[];
}
