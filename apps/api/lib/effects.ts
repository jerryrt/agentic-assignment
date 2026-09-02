/**
 * The declared effects this API can actually carry out.
 *
 * A machine declares an effect rather than holding a callback, so the runner
 * decides how to execute it (plan/03). This file is the runner's half of that
 * contract.
 *
 * The load-bearing decision is what an unrunnable effect does. Skipping it
 * would move an application to `funded` with no loan behind it: a state that
 * says money moved when nothing did, discovered later by whoever reconciles.
 * So an effect nothing can execute REFUSES the transition, and refuses it
 * before the update, so that nothing is written and nothing has to be undone.
 * That is the same direction the empty `workflow_transition` table failed in
 * before it was generated, and the same direction an unevaluated rule set fails
 * in: closed.
 *
 * `create_loan` and `post_ledger_entry` are still in that position: both belong
 * to Option 3, which is Phase 7 in plan/09-build-order.md and owns the `loan`
 * table and the ledger they would write. `write_eligibility_snapshot` is not --
 * it has a table as of `0005_application_submit.sql`, and the runner below.
 *
 * Which kinds are runnable is derived from the runner map rather than listed
 * beside it. Two lists would be two answers the first time one was edited
 * (CLAUDE.md section 9), and the answer they disagreed about is whether a
 * transition writes what it promised.
 */

import { insertEligibilitySnapshot, type DatabaseClient, type Json } from '@lj/db';
import type { ProductEligibility } from '@lj/rules';
import type { EffectSpec } from '@lj/workflow';

export type EffectKind = EffectSpec['kind'];

/**
 * Everything a runner may read.
 *
 * It is assembled by the handler from the decision it has just taken, and it
 * carries the evaluation the GUARD was decided on rather than a fresh one. A
 * runner that re-evaluated could record criteria the applicant was never shown,
 * which is the failure the snapshot exists to prevent.
 */
export interface EffectContext {
  readonly applicationId: string;
  /** The application's revision after the state change landed. */
  readonly revision: number;
  /** Every product this application was evaluated against, as evaluated. */
  readonly eligibility: readonly ProductEligibility[];
}

export type EffectOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: EffectKind; readonly reason: string };

type EffectRunner = (client: DatabaseClient, context: EffectContext) => Promise<void>;

/**
 * The evaluation as jsonb.
 *
 * `ProductEligibility[]` is JSON by construction: `RuleResult` was designed so
 * that every field is present and every absence is null, precisely so that a
 * snapshot stores and reads back as the same object. TypeScript cannot infer
 * that from a type carrying `Record<string, unknown>`, so the fact is asserted
 * once, here, rather than at a call site where it would be invisible.
 */
function asJson(eligibility: readonly ProductEligibility[]): Json {
  return eligibility as unknown as Json;
}

async function writeEligibilitySnapshot(
  client: DatabaseClient,
  context: EffectContext,
): Promise<void> {
  const written = await insertEligibilitySnapshot(client, {
    applicationId: context.applicationId,
    revision: context.revision,
    eligibility: asJson(context.eligibility),
  });
  if (written === null) {
    // PostgREST accepted the statement and returned no row. Nothing can be
    // said about whether it landed, so it is reported as a failure: a snapshot
    // that might not exist is not a snapshot.
    throw new Error('the insert returned no row');
  }
}

const RUNNERS: Partial<Record<EffectKind, EffectRunner>> = {
  write_eligibility_snapshot: writeEligibilitySnapshot,
};

/** The kinds this API has an implementation for. Derived, never restated. */
export const RUNNABLE_EFFECT_KINDS: ReadonlySet<EffectKind> = new Set(
  Object.keys(RUNNERS) as EffectKind[],
);

/** The declared kinds this API has no implementation for, in declared order. */
export function unrunnableEffects(effects: readonly EffectSpec[]): readonly EffectKind[] {
  return effects
    .map((effect) => effect.kind)
    .filter((kind) => !RUNNABLE_EFFECT_KINDS.has(kind));
}

/**
 * Carry out the declared effects, in the order the transition declares them.
 *
 * Stops at the first failure and names the kind that failed. The caller has
 * already moved the state by the time this runs -- see the note on the
 * transaction boundary in src/routes/transition.ts -- so "which one" is what a
 * person repairing the row needs to know.
 *
 * The database's own message is logged and never returned: it quotes
 * constraints and column names, and a response body is not the place to publish
 * the schema.
 */
export async function runEffects(
  client: DatabaseClient,
  effects: readonly EffectSpec[],
  context: EffectContext,
): Promise<EffectOutcome> {
  for (const effect of effects) {
    const runner = RUNNERS[effect.kind];
    if (runner === undefined) {
      // Unreachable: unrunnableEffects refuses the transition before the
      // update. Stated rather than assumed, because the alternative to this
      // branch is a silently skipped effect.
      return { ok: false, kind: effect.kind, reason: 'this API has no runner for it' };
    }
    try {
      await runner(client, context);
    } catch (error: unknown) {
      const described = error instanceof Error ? error.name + ': ' + error.message : 'unknown';
      console.error("effect '" + effect.kind + "' failed: " + described);
      return { ok: false, kind: effect.kind, reason: 'the write did not land' };
    }
  }
  return { ok: true };
}
