import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { LabelAudience, WorkflowEvent } from '@lj/domain';

import {
  LjTimeline,
  formatWorkflowTimestamp,
  workflowEventActorLabel,
  workflowEventStateLabel,
} from './timeline.js';

@Component({
  selector: 'lj-timeline-host',
  imports: [LjTimeline],
  template: `<lj-timeline [events]="events()" [audience]="audience()" />`,
})
class Host {
  readonly events = signal<readonly WorkflowEvent[]>([]);
  readonly audience = signal<LabelAudience>('borrower');
}

const SUBJECT = '11111111-2222-3333-4444-555555555555';

function event(overrides: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'id'>): WorkflowEvent {
  return {
    machine: 'application',
    subject_id: SUBJECT,
    from_state: null,
    to_state: 'submitted',
    event: 'submit',
    actor_id: null,
    actor_role: 'borrower',
    payload: null,
    created_at: '2026-09-01T14:32:07.000Z',
    ...overrides,
  };
}

async function render(events: readonly WorkflowEvent[], audience: LabelAudience = 'borrower') {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.events.set(events);
  fixture.componentInstance.audience.set(audience);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return [...root.querySelectorAll<HTMLElement>('[data-testid="event"]')];
}

function textOf(row: HTMLElement | undefined, testid: string): string {
  return (row?.querySelector('[data-testid="' + testid + '"]')?.textContent ?? '').trim();
}

describe('lj-timeline', () => {
  it('renders one entry per event, in the order given', async () => {
    const entries = await render([
      event({ id: 1, to_state: 'submitted' }),
      event({ id: 2, from_state: 'submitted', to_state: 'under_review', event: 'begin_review' }),
    ]);
    expect(entries.length).toBe(2);
    expect(textOf(entries[0], 'event-state')).toBe('Submitted');
    expect(textOf(entries[1], 'event-state')).toBe('With your lender');
  });

  it('speaks the audience the reader belongs to', async () => {
    const entries = await render(
      [event({ id: 1, to_state: 'under_review' })],
      'lender',
    );
    expect(textOf(entries[0], 'event-state')).toBe('Awaiting your decision');
  });

  // The log is one table for three machines, so a state arrives as text. A
  // machine with no audience-split vocabulary must still render.
  it('humanises a state from a machine with no label map', async () => {
    const entries = await render([
      event({ id: 1, machine: 'document_slot', to_state: 'accepted', event: 'accept' }),
    ]);
    expect(textOf(entries[0], 'event-state')).toBe('Accepted');
  });

  it('renders a state written by an older release rather than blanking the row', () => {
    expect(workflowEventStateLabel('application', 'some_retired_state', 'borrower')).toBe(
      'Some retired state',
    );
  });

  it('names the system when nobody did it', async () => {
    const entries = await render([event({ id: 1, actor_role: null, event: 'expire' })]);
    expect(textOf(entries[0], 'event-actor')).toBe('System');
  });

  it('names the role that acted', async () => {
    const entries = await render([event({ id: 1, actor_role: 'lender', event: 'approve' })]);
    expect(textOf(entries[0], 'event-actor')).toBe('Lender');
    expect(workflowEventActorLabel('admin')).toBe('Admin');
  });

  it('renders the transition name in words', async () => {
    const entries = await render([event({ id: 1, event: 'begin_review' })]);
    expect(textOf(entries[0], 'event-name')).toBe('Begin review');
  });

  it('renders an unambiguous instant, and keeps the machine-readable one', async () => {
    const entries = await render([event({ id: 1 })]);
    expect(textOf(entries[0], 'event-time')).toBe('2026-09-01 14:32 UTC');
    expect(
      entries[0]?.querySelector('[data-testid="event-time"]')?.getAttribute('datetime'),
    ).toBe('2026-09-01T14:32:07.000Z');
  });

  it('renders the same instant whatever the machine is set to', () => {
    // The reason UTC is formatted by hand rather than through Intl: an audit
    // trail that reads differently on two machines is not an audit trail.
    expect(formatWorkflowTimestamp('2026-01-05T04:03:00+02:00')).toBe('2026-01-05 02:03 UTC');
  });

  it('shows unparseable text rather than "Invalid Date"', () => {
    expect(formatWorkflowTimestamp('not a timestamp')).toBe('not a timestamp');
  });

  it('renders an empty log as empty', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect((root.querySelector('[data-testid="empty"]')?.textContent ?? '').trim()).toBe(
      'Nothing has happened yet.',
    );
  });
});
