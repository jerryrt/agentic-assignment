import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { LabelAudience } from '@lj/domain';
import { APPLICATION_STATES, CREDIT_RELEASE_STATES } from '@lj/domain';

import type { StateBadgeSubject } from './state-badge.ts';
import {
  APPLICATION_STATE_TONES,
  CREDIT_RELEASE_STATE_TONES,
  LjStateBadge,
  stateBadgeTone,
} from './state-badge.ts';

@Component({
  selector: 'lj-state-badge-host',
  imports: [LjStateBadge],
  template: `<lj-state-badge [subject]="subject()" [audience]="audience()" />`,
})
class Host {
  readonly subject = signal<StateBadgeSubject>({ machine: 'application', state: 'draft' });
  readonly audience = signal<LabelAudience>('borrower');
}

async function render(subject: StateBadgeSubject, audience: LabelAudience) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.subject.set(subject);
  fixture.componentInstance.audience.set(audience);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const badge = root.querySelector('[data-testid="badge"]');
  return {
    text: (badge?.textContent ?? '').trim(),
    tone: badge?.getAttribute('data-tone') ?? null,
  };
}

describe('lj-state-badge', () => {
  // "Two roles, two truths": the same row of the same table reads differently
  // depending on who opened it, and both readings are correct.
  it('gives the borrower and the lender their own vocabulary for one state', async () => {
    const subject: StateBadgeSubject = { machine: 'application', state: 'under_review' };
    expect((await render(subject, 'borrower')).text).toBe('With your lender');
    expect((await render(subject, 'lender')).text).toBe('Awaiting your decision');
  });

  it('reads the credit release machine from its own map', async () => {
    const subject: StateBadgeSubject = { machine: 'credit_release', state: 'funded' };
    expect((await render(subject, 'borrower')).text).toBe('Disbursed');
    expect((await render(subject, 'lender')).text).toBe('Disbursed');
  });

  it('does not restate a label the domain already owns', async () => {
    // Changing the map in @lj/domain must change what this renders. Asserting
    // against the map rather than against a literal is what makes that true.
    const { text } = await render({ machine: 'application', state: 'submitted' }, 'lender');
    expect(text).toBe('New -- awaiting triage');
  });

  const tones: ReadonlyArray<{ readonly subject: StateBadgeSubject; readonly tone: string }> = [
    { subject: { machine: 'application', state: 'draft' }, tone: 'neutral' },
    { subject: { machine: 'application', state: 'under_review' }, tone: 'info' },
    { subject: { machine: 'application', state: 'needs_borrower_action' }, tone: 'warn' },
    { subject: { machine: 'application', state: 'approved' }, tone: 'ok' },
    { subject: { machine: 'application', state: 'declined' }, tone: 'err' },
    // The borrower chose it; colouring their own decision as a failure would
    // misread the file.
    { subject: { machine: 'application', state: 'withdrawn' }, tone: 'neutral' },
    { subject: { machine: 'credit_release', state: 'cancelled' }, tone: 'neutral' },
  ];

  for (const { subject, tone } of tones) {
    it('renders ' + subject.machine + '/' + subject.state + ' as ' + tone, async () => {
      expect((await render(subject, 'borrower')).tone).toBe(tone);
    });
  }

  // The mapped types make an omission a compile error; this makes a *wrong*
  // value one too, and proves nothing was left undefined by a partial edit.
  it('has a tone for every state of every machine it renders', () => {
    for (const state of APPLICATION_STATES) {
      expect(APPLICATION_STATE_TONES[state]).toBeDefined();
      expect(stateBadgeTone({ machine: 'application', state })).toBe(
        APPLICATION_STATE_TONES[state],
      );
    }
    for (const state of CREDIT_RELEASE_STATES) {
      expect(CREDIT_RELEASE_STATE_TONES[state]).toBeDefined();
      expect(stateBadgeTone({ machine: 'credit_release', state })).toBe(
        CREDIT_RELEASE_STATE_TONES[state],
      );
    }
  });

  // Colour is never the only cue: the words differ, so the badge survives the
  // greyscale check the browser suite runs.
  it('renders words, not only a colour', async () => {
    const approved = await render({ machine: 'application', state: 'approved' }, 'borrower');
    const declined = await render({ machine: 'application', state: 'declined' }, 'borrower');
    expect(approved.text).not.toBe('');
    expect(approved.text).not.toBe(declined.text);
  });
});
