import type { AppRole, RuleResult, WorkflowMachine } from '@lj/domain';

/**
 * A refusal, in the vocabulary the rules engine already speaks.
 *
 * `blockers` is `RuleResult[]` -- the exact type packages/rules produces -- so a
 * blocked transition and an unmet eligibility criterion render through the same
 * component and read identically to the user. To the user they are the same
 * thing: "you cannot proceed, and here is precisely why."
 *
 * A refusal that is structural rather than about criteria -- an unknown event, a
 * role that may not fire this transition -- carries an empty `blockers` list and
 * only a reason. That is not a missing case: there is no criterion to show,
 * because the request was never coherent.
 */
export interface GuardRefusal {
  readonly ok: false;
  readonly reason: string;
  readonly blockers: readonly RuleResult[];
}

export type GuardResult = { readonly ok: true } | GuardRefusal;

/**
 * A side effect the transition declares and the runner executes inside the same
 * transaction as the state change.
 *
 * Declarative rather than a callback for two reasons. A callback would need I/O,
 * which a pure package must not have; and a declared effect can be read by the
 * client -- "funding this creates the loan" is visible before the round trip,
 * from the same definition the server runs.
 */
export type EffectSpec =
  | { readonly kind: 'create_loan' }
  | { readonly kind: 'post_ledger_entry' }
  | { readonly kind: 'write_eligibility_snapshot' }
  | { readonly kind: 'create_document_slots' }
  /**
   * Reading an uploaded document and recording what it says.
   *
   * Named here, and NOT YET DECLARED on `upload` and `replace` in
   * machines/document-slot.ts: that file belongs to another issue's scope, and
   * the API attaches this effect to those two events in the meantime (see
   * apps/api/lib/document-slot-subject.ts). The kind lives here rather than in
   * apps/api because an effect kind is the vocabulary a machine declares in,
   * and putting it anywhere else would mean a second vocabulary when the
   * declaration lands. Adding `effects: [{ kind: 'extract_document' }]` to
   * those two transitions is the whole of that change; the runner does not
   * move.
   */
  | { readonly kind: 'extract_document' };

/**
 * A transition as written in a machine definition. `from` accepts a single state
 * or a list because several states often share one exit -- an application may be
 * withdrawn from four of them -- and writing that once keeps the four in step.
 */
export interface Transition<S extends string, E extends string, Ctx> {
  readonly from: S | readonly S[];
  readonly event: E;
  readonly to: S;
  /** Which roles may fire this. Authorisation is re-checked here, server-side. */
  readonly actor: readonly AppRole[];
  /** Pure predicate. No I/O -- everything it needs is in ctx. */
  readonly guard?: (context: Ctx) => GuardResult;
  readonly effects?: readonly EffectSpec[];
}

/**
 * A transition after `defineMachine` has normalised it: `from` is always a list,
 * and the two optional members are always present so that no consumer has to
 * decide what an absent one means.
 */
export interface NormalisedTransition<S extends string, E extends string, Ctx> {
  readonly from: readonly S[];
  readonly event: E;
  readonly to: S;
  readonly actor: readonly AppRole[];
  readonly guard: ((context: Ctx) => GuardResult) | null;
  readonly effects: readonly EffectSpec[];
}

export interface MachineDefinition<S extends string, E extends string, Ctx> {
  readonly id: WorkflowMachine;
  readonly initial: S;
  /**
   * Every state the machine may hold, which is the union packages/domain
   * declares. Listed rather than inferred from the transitions: a state that
   * appears in no transition is an orphan, and inferring the list would define
   * the bug out of existence instead of catching it.
   */
  readonly states: readonly S[];
  readonly transitions: readonly Transition<S, E, Ctx>[];
}

export interface Machine<S extends string, E extends string, Ctx> {
  readonly id: WorkflowMachine;
  readonly initial: S;
  readonly states: readonly S[];
  readonly transitions: readonly NormalisedTransition<S, E, Ctx>[];
}

/**
 * The three machines seen without their generics, which is all the code
 * generator needs: it turns names into rows and never calls a guard.
 */
export interface TransitionShape {
  readonly from: readonly string[];
  readonly event: string;
  readonly to: string;
  readonly actor: readonly AppRole[];
}

export interface MachineShape {
  readonly id: WorkflowMachine;
  readonly initial: string;
  readonly states: readonly string[];
  readonly transitions: readonly TransitionShape[];
}

export interface TransitionSucceeded<S extends string, E extends string> {
  readonly ok: true;
  readonly machine: WorkflowMachine;
  readonly from: S;
  readonly to: S;
  readonly event: E;
  readonly actorRole: AppRole;
  readonly effects: readonly EffectSpec[];
}

/**
 * What `apply` returns. The failure branch is a `GuardRefusal` unchanged, so one
 * renderer serves a refusal from `can` and a refusal from `apply`.
 */
export type TransitionOutcome<S extends string, E extends string> =
  | TransitionSucceeded<S, E>
  | GuardRefusal;
