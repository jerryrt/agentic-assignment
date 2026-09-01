import { describe, expect, it } from 'vitest';

import type { ApplicationState, AudienceLabels, StateLabelMap } from '../src/index.js';

/**
 * The runtime tests in labels.spec.ts prove that today's map is complete. This
 * file proves that tomorrow's cannot be incomplete: StateLabelMap is a mapped
 * type with no optional modifier, so a state added to the union and forgotten
 * in the map is a compile error, not a blank cell in the UI.
 *
 * The assertions below are checked by `tsc --noEmit`, which is why this file
 * exists at all - vitest transpiles without typechecking, so a @ts-expect-error
 * here is a claim only the typecheck step can settle.
 */
describe('a missing state label is a type error', () => {
  it('rejects a map that omits a state', () => {
    const labels: AudienceLabels = { borrower: 'x', lender: 'y' };
    // @ts-expect-error - 'withdrawn' and the rest are missing, and must be.
    const incomplete: StateLabelMap<ApplicationState> = { draft: labels };
    expect(incomplete).toBeDefined();
  });

  it('rejects a map that invents a state', () => {
    const labels: AudienceLabels = { borrower: 'x', lender: 'y' };
    const complete = {
      draft: labels,
      submitted: labels,
      docs_pending: labels,
      under_review: labels,
      needs_borrower_action: labels,
      approved: labels,
      declined: labels,
      funded: labels,
      withdrawn: labels,
      // @ts-expect-error - not a state of the application machine.
      abandoned: labels,
    } satisfies StateLabelMap<ApplicationState>;
    expect(complete).toBeDefined();
  });

  it('rejects a state label that omits an audience', () => {
    // @ts-expect-error - 'lender' is missing.
    const partial: AudienceLabels = { borrower: 'x' };
    expect(partial).toBeDefined();
  });
});
