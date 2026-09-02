import {
  APPLICATION_STEPS,
  type ApplicationData,
  type ApplicationStep,
  type RuleResult,
  requirementsForStep,
  rulePassed,
  ruleUnknown,
  unmetRequirements,
} from '@lj/domain';

import { joinWords } from '../engine/figures.ts';

/**
 * "Is the multi-step form finished?" -- the rule set behind the `submit`
 * guard's `completeness` bucket.
 *
 * `applicationMachine` guards `submit` on
 * `requireRules('the application is not complete', context.completeness)`, and
 * `requireRules` reads an empty set as "the caller did not evaluate this" and
 * fails closed. Until this existed, every submit was refused with a 422 that
 * said the criteria had not been evaluated -- correct, and useless to the
 * applicant.
 *
 * One result per step rather than one per field, for two reasons. The panel
 * that renders it has four rows instead of thirty, which is a thing a person
 * can read; and a step is what the applicant can act on -- they go to it and
 * finish it. The fields are still named, in `missing`, so the form can focus
 * the control and the sentence can list them.
 *
 * **A step is never `fail`.** An applicant who has answered nothing has
 * answered nothing wrong, and 'unknown' is the status that says so
 * (packages/domain/src/rule-result.ts). That is why these are built with
 * rulePassed and ruleUnknown directly rather than through the `predicate`
 * helper: predicate's third outcome is a failure with a sentence explaining
 * it, and there is no such sentence to write here.
 *
 * The thresholds question does not arise. Which fields a step needs is
 * `APPLICATION_STEP_REQUIREMENTS` in @lj/domain, read here and read again by
 * the form's validators, so the rule and the control agree by construction.
 */

const STEP_LABELS: { readonly [K in ApplicationStep]: string } = {
  borrower: 'About your business',
  farm: 'About your farm',
  financials: 'Your financial position',
  request: 'What you are asking for',
};

/** Stable across releases: an eligibility_snapshot is compared by rule id. */
export function applicationCompletenessRuleId(step: ApplicationStep): string {
  return 'step_' + step;
}

function completenessOfStep(step: ApplicationStep, data: ApplicationData): RuleResult {
  const applicable = requirementsForStep(step, data);
  const outstanding = unmetRequirements(step, data);
  const id = applicationCompletenessRuleId(step);
  const label = STEP_LABELS[step];

  // Counted from the applicable requirements rather than from the whole list,
  // so a sole trader is not shown "7 of 9" for a step they have finished.
  const inputs = {
    step,
    required: applicable.length,
    answered: applicable.length - outstanding.length,
  };

  if (outstanding.length === 0) {
    return rulePassed({
      id,
      label,
      explain: 'Every question on this step is answered.',
      inputs,
    });
  }

  return ruleUnknown({
    id,
    label,
    // The sentence reads in the applicant's words; `missing` below carries the
    // paths, which is what a form focuses and what a stored snapshot has to be
    // unambiguous about.
    explain:
      'Still needed: ' + joinWords(outstanding.map((requirement) => requirement.label)) + '.',
    inputs,
    missing: outstanding.map((requirement) => requirement.path),
  });
}

export function evaluateApplicationCompleteness(data: ApplicationData): RuleResult[] {
  return APPLICATION_STEPS.map((step) => completenessOfStep(step, data));
}
