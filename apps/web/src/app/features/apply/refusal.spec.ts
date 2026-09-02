import type { RuleResult } from '@lj/domain';

import { refusalToShow } from './refusal.ts';

function result(id: string): RuleResult {
  return {
    id,
    label: id,
    status: 'unknown',
    severity: 'error',
    explain: 'Still needed.',
    inputs: {},
    missing: ['a.b'],
    delta: null,
  };
}

const PASSES = { ok: true } as const;

function refuses(...ids: string[]) {
  return { ok: false, reason: 'refused', blockers: ids.map(result) } as const;
}

describe('refusalToShow', () => {
  it('shows nothing while the application could be submitted', () => {
    expect(refusalToShow({ fromServer: [], guard: PASSES, isLastStep: true })).toEqual([]);
  });

  // Every criterion is unanswered on step one by definition, and listing them
  // under the Continue button is the wall of red this option exists to avoid.
  // The panel beside the form is already saying it, in a register that suits.
  it('holds the prediction back until the last step', () => {
    expect(
      refusalToShow({ fromServer: [], guard: refuses('step_request'), isLastStep: false }),
    ).toEqual([]);
  });

  it('shows the prediction on the last step, so it can be fixed without a round trip', () => {
    const shown = refusalToShow({
      fromServer: [],
      guard: refuses('step_request'),
      isLastStep: true,
    });
    expect(shown.map((blocker) => blocker.id)).toEqual(['step_request']);
  });

  // The prediction is a courtesy; the answer to a request is the decision. If
  // the two ever disagree, the one holding the state is right.
  it('prefers what the server answered over the prediction of it', () => {
    const shown = refusalToShow({
      fromServer: [result('step_financials')],
      guard: refuses('step_request'),
      isLastStep: true,
    });
    expect(shown.map((blocker) => blocker.id)).toEqual(['step_financials']);
  });

  it('shows what the server answered even on a step where the prediction is held back', () => {
    const shown = refusalToShow({
      fromServer: [result('step_financials')],
      guard: PASSES,
      isLastStep: false,
    });
    expect(shown.map((blocker) => blocker.id)).toEqual(['step_financials']);
  });
});
