import type { RuleResult } from '@lj/domain';
import type { GuardResult } from '@lj/workflow';

/**
 * Which set of blockers to put on the screen: the server's, or the client's
 * prediction of them.
 *
 * The two should agree -- same machine definition, same rule sets, same payload
 * -- and the whole point of running the engine in the browser is that they
 * usually do, so the applicant is told what is wrong without a round trip. When
 * they disagree the SERVER wins, because it is the one holding the state
 * (core/workflow/transition.service.ts). The prediction is a courtesy; the
 * answer to a request is the decision.
 *
 * The prediction is shown only on the last step. Earlier on, every criterion is
 * still unanswered by definition, and a list of them under the Continue button
 * would be the wall of red this option exists to avoid -- the eligibility panel
 * beside the form is already saying the same thing, in the register that suits
 * it.
 *
 * A separate function rather than a `computed` in the template's component so
 * that this precedence can be tested directly. It is the piece with a decision
 * in it; the component around it only renders.
 */
export function refusalToShow(input: {
  readonly fromServer: readonly RuleResult[];
  readonly guard: GuardResult;
  readonly isLastStep: boolean;
}): readonly RuleResult[] {
  if (input.fromServer.length > 0) {
    return input.fromServer;
  }
  if (!input.isLastStep || input.guard.ok) {
    return [];
  }
  return input.guard.blockers;
}
