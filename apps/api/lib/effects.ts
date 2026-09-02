/**
 * The declared effects this API can actually carry out.
 *
 * A machine declares an effect rather than holding a callback, so the runner
 * decides how to execute it (plan/03). This file is the runner's half of that
 * contract, and today it is empty on purpose: `create_loan` needs a `loan`
 * table and `post_ledger_entry` needs a ledger, and neither exists -- Option 3
 * is Phase 7 in plan/09-build-order.md and owns both.
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
 * When a kind gains an implementation it is added to the set below and run
 * after the state change, inside the same transaction -- see the note on the
 * transaction boundary in `api/transition.ts`.
 */

import type { EffectSpec } from '@lj/workflow';

export type EffectKind = EffectSpec['kind'];

export const RUNNABLE_EFFECT_KINDS: ReadonlySet<EffectKind> = new Set<EffectKind>();

/** The declared kinds this API has no implementation for, in declared order. */
export function unrunnableEffects(effects: readonly EffectSpec[]): readonly EffectKind[] {
  return effects
    .map((effect) => effect.kind)
    .filter((kind) => !RUNNABLE_EFFECT_KINDS.has(kind));
}
