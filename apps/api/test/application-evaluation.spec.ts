import { describe, expect, it } from 'vitest';

import {
  UNEVALUATED_APPLICATION_CONTEXT,
  applicationTransitionNeedsEvaluation,
} from '../lib/application-subject.ts';

/**
 * Which transitions read a rule set, and what the ones that do not are
 * adjudicated against.
 *
 * A unit test rather than another case in transition.spec.ts, because the
 * question is about the machine definition and needs no database to answer.
 * The definition is data, so it is testable directly.
 */
describe('applicationTransitionNeedsEvaluation', () => {
  it('evaluates for a transition with a guard', () => {
    expect(applicationTransitionNeedsEvaluation('draft', 'submit')).toBe(true);
    expect(applicationTransitionNeedsEvaluation('docs_pending', 'begin_review')).toBe(true);
  });

  // An effect reads the evaluation beside the guard, so a transition that
  // declares one needs it even with no guard of its own.
  it('evaluates for a transition that declares an effect', () => {
    expect(applicationTransitionNeedsEvaluation('approved', 'fund')).toBe(true);
  });

  // The case this function exists for. Refusing `withdraw` because the payload
  // would not parse was a lockout with no way out: after a submit the borrower
  // cannot write `data` any more, so the row could be neither repaired nor
  // abandoned by anyone.
  it('does not evaluate for a transition that reads nothing', () => {
    for (const from of ['draft', 'submitted', 'docs_pending', 'needs_borrower_action'] as const) {
      expect(applicationTransitionNeedsEvaluation(from, 'withdraw')).toBe(false);
    }
    expect(applicationTransitionNeedsEvaluation('under_review', 'approve')).toBe(false);
    expect(applicationTransitionNeedsEvaluation('under_review', 'decline')).toBe(false);
    expect(applicationTransitionNeedsEvaluation('under_review', 'request_info')).toBe(false);
    expect(applicationTransitionNeedsEvaluation('needs_borrower_action', 'resubmit')).toBe(false);
    expect(applicationTransitionNeedsEvaluation('submitted', 'request_docs')).toBe(false);
  });

  // A pair the machine does not declare needs nothing, and is refused earlier
  // anyway -- transitionsFrom finds no candidate and the request is a 409.
  it('does not evaluate for a transition the machine does not have', () => {
    expect(applicationTransitionNeedsEvaluation('funded', 'submit')).toBe(false);
  });
});

/**
 * The safety argument for the whole change, in one assertion.
 *
 * Deciding wrongly that a transition needs no evaluation hands this context to
 * `apply`. Every field is empty, and requireRules reads an empty rule set as
 * "the caller did not evaluate this" and refuses -- so the mistake can only
 * ever refuse a transition, never open one.
 */
describe('UNEVALUATED_APPLICATION_CONTEXT', () => {
  it('carries no rule set, so any guard reached with it fails closed', () => {
    expect(UNEVALUATED_APPLICATION_CONTEXT).toEqual({
      completeness: [],
      eligibility: [],
      documentPack: [],
    });
  });
});
