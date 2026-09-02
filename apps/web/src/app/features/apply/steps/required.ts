import { computed, type Signal } from '@angular/core';
import { requirementsForStep, type ApplicationData, type ApplicationStep } from '@lj/domain';

/**
 * Which paths a step must answer, for this applicant, right now.
 *
 * A set rather than a list because a template asks it one path at a time, and
 * it is recomputed from the live payload because required-ness is conditional:
 * choosing 'corporation' on step one adds two questions on the spot, and
 * choosing 'sole trader' takes them away again.
 *
 * This is the ONLY thing that decides whether a field is marked required, in
 * either direction. There is no Validators.required anywhere in this feature;
 * see ../form.ts for why.
 */
export function requiredPaths(
  step: ApplicationStep,
  data: Signal<ApplicationData>,
): Signal<ReadonlySet<string>> {
  return computed(
    () => new Set(requirementsForStep(step, data()).map((requirement) => requirement.path)),
  );
}
