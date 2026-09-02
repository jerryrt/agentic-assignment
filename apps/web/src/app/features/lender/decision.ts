import type { AppRole, CreditReleaseState } from '@lj/domain';
import { CREDIT_RELEASE_EVENTS, can, creditReleaseMachine } from '@lj/workflow';
import type { CreditReleaseEvent } from '@lj/workflow';

/**
 * Which decisions are open on a release, and what each button says.
 *
 * READ OFF THE MACHINE, never listed here. `can` is the same function the
 * server runs, so a transition added, removed or re-assigned to another role in
 * `packages/workflow` changes this screen without anybody remembering to. A
 * hand-written list of buttons per state is the second copy of the machine that
 * CLAUDE.md section 9 is about, and it is the copy that goes stale silently --
 * the screen keeps offering a move the server has stopped allowing.
 *
 * The guard context is empty on purpose. Of the credit release transitions only
 * `submit` is guarded, and `submit` is the borrower's; every lender decision is
 * unguarded, because approving is a decision rather than a conditional one. An
 * empty rule set makes `requireRules` refuse, so `submit` is simply never
 * offered here -- which is correct, and is a refusal by the machine rather than
 * an omission by this file.
 *
 * What IS stated here is the wording, because there is no domain vocabulary for
 * events -- @lj/domain's label maps are keyed by state, and a state's name is
 * not a verb. The words are chosen for the person reading them: a lender's
 * button says what it does to the file.
 *
 * PREDICTION, NOT DECISION. This greys out and lays out; `POST /api/transition`
 * re-checks the actor's role against the same machine and is the answer. If the
 * two ever disagree the server is right, because it holds the state.
 */

export type DecisionEmphasis = 'primary' | 'quiet' | 'danger';

export interface DecisionAction {
  readonly event: CreditReleaseEvent;
  readonly label: string;
  readonly emphasis: DecisionEmphasis;
  /**
   * True for a decision the borrower is owed an explanation for. A decline with
   * no reason is a decision nobody can act on -- and plan/06 puts the reason and
   * "what to change" side by side on the borrower's screen for that reason.
   */
  readonly needsReason: boolean;
}

const PRESENTATION: { readonly [K in CreditReleaseEvent]: Omit<DecisionAction, 'event'> } = {
  submit: { label: 'Send to your lender', emphasis: 'primary', needsReason: false },
  begin_review: { label: 'Start reviewing', emphasis: 'primary', needsReason: false },
  approve: { label: 'Approve', emphasis: 'primary', needsReason: false },
  decline: { label: 'Decline', emphasis: 'danger', needsReason: true },
  disburse: { label: 'Disburse the funds', emphasis: 'primary', needsReason: false },
  cancel: { label: 'Withdraw the request', emphasis: 'quiet', needsReason: false },
};

/**
 * Every move this actor may make from this state, in the machine's own order.
 *
 * The order is `CREDIT_RELEASE_EVENTS`, which reads forward through the
 * lifecycle, so the ordinary decision lands to the left of the exceptional one
 * on every screen without a sort here.
 */
export function decisionActions(
  state: CreditReleaseState,
  role: AppRole,
): readonly DecisionAction[] {
  return CREDIT_RELEASE_EVENTS.filter(
    (event) => can(creditReleaseMachine, state, event, role, { availableCredit: [] }).ok,
  ).map((event) => ({ event, ...PRESENTATION[event] }));
}

/**
 * Whether a decision may be fired yet.
 *
 * The only thing this adds to the machine is the reason a decline carries, and
 * it is a POLICY rather than a rendering choice: a declined request the
 * borrower cannot act on wastes the next round trip and the phone call after
 * it. It is not a workflow guard because it constrains what the SCREEN sends
 * rather than what the machine permits -- the server does not know whether a
 * reason was typed, and cannot, until the reason travels with the transition.
 */
export function decisionIsReady(action: DecisionAction, reason: string): boolean {
  return !action.needsReason || reason.trim() !== '';
}
