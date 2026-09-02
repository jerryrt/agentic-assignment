import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type {
  AppRole,
  ApplicationState,
  AudienceLabels,
  CreditReleaseState,
  LabelAudience,
  StateLabelMap,
  WorkflowEvent,
  WorkflowMachine,
} from '@lj/domain';
import { APPLICATION_STATE_LABELS, CREDIT_RELEASE_STATE_LABELS } from '@lj/domain';

/**
 * The audit trail, rendered.
 *
 * `workflow_event` is one append-only log for all three machines, so its
 * `from_state` and `to_state` are plain text rather than any one machine's
 * union -- narrowing them would force either three tables or a discriminated
 * union no SQL query can produce (packages/domain/src/entities/workflow-event.ts).
 * That is why this file resolves a label through a lookup with a fallback,
 * where <lj-state-badge> refuses to: there the state is typed and a missing
 * label is a bug the compiler can catch, here it is text out of a database
 * column and a row written by an older release must still render.
 *
 * The fallback is not a second label map. It reads the domain's maps whenever
 * the machine has one and only humanises the underscored state name otherwise,
 * which is the case for document_slot -- a machine with no borrower-facing
 * vocabulary to split.
 */
function labelFrom<S extends string>(
  map: StateLabelMap<S>,
  state: string,
  audience: LabelAudience,
): string | null {
  // One widening cast, rather than a cast on the key: `state` is untyped text
  // and asserting it into the union would be claiming something not known.
  const labels = (map as Record<string, AudienceLabels | undefined>)[state];
  return labels === undefined ? null : labels[audience];
}

/** "docs_pending" -> "Docs pending". Only ever reached for an unmapped state. */
function humanise(name: string): string {
  const words = name.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function workflowEventStateLabel(
  machine: WorkflowMachine,
  state: string,
  audience: LabelAudience,
): string {
  const mapped =
    machine === 'application'
      ? labelFrom<ApplicationState>(APPLICATION_STATE_LABELS, state, audience)
      : machine === 'credit_release'
        ? labelFrom<CreditReleaseState>(CREDIT_RELEASE_STATE_LABELS, state, audience)
        : null;
  return mapped ?? humanise(state);
}

const ACTOR_LABELS: { readonly [K in AppRole]: string } = {
  borrower: 'Borrower',
  lender: 'Lender',
  admin: 'Admin',
};

/** Null actor means the system moved the file, not a person. */
export function workflowEventActorLabel(role: AppRole | null): string {
  return role === null ? 'System' : ACTOR_LABELS[role];
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * "2026-09-01 14:32 UTC".
 *
 * UTC, and formatted by hand rather than through Intl.DateTimeFormat, for the
 * reason packages/domain gives for formatting money the same way: Intl's output
 * depends on the environment's locale, and an audit trail that reads
 * differently on two machines is not an audit trail. A timeline is the one
 * surface where an unambiguous instant matters more than a friendly one, and
 * the machine-readable value is still on the <time> element for anything that
 * wants to localise it.
 */
export function formatWorkflowTimestamp(timestamp: string): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) {
    return timestamp;
  }
  return (
    String(at.getUTCFullYear()) +
    '-' +
    twoDigits(at.getUTCMonth() + 1) +
    '-' +
    twoDigits(at.getUTCDate()) +
    ' ' +
    twoDigits(at.getUTCHours()) +
    ':' +
    twoDigits(at.getUTCMinutes()) +
    ' UTC'
  );
}

/** One rendered entry, with no logic left in the template. */
export interface TimelineRow {
  readonly id: number;
  readonly state: string;
  readonly from: string | null;
  readonly event: string;
  readonly actor: string;
  readonly at: string;
  readonly timestamp: string;
}

export function timelineRow(event: WorkflowEvent, audience: LabelAudience): TimelineRow {
  return {
    id: event.id,
    state: workflowEventStateLabel(event.machine, event.to_state, audience),
    from:
      event.from_state === null
        ? null
        : workflowEventStateLabel(event.machine, event.from_state, audience),
    event: humanise(event.event),
    actor: workflowEventActorLabel(event.actor_role),
    at: formatWorkflowTimestamp(event.created_at),
    timestamp: event.created_at,
  };
}

@Component({
  selector: 'lj-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'lj-timeline' },
  template: `
    @if (rows().length === 0) {
      <p class="timeline__empty" data-testid="empty">Nothing has happened yet.</p>
    } @else {
      <ol class="timeline">
        @for (row of rows(); track row.id) {
          <li class="timeline__entry" data-testid="event">
            <span class="timeline__marker" aria-hidden="true"></span>
            <span class="timeline__body">
              <span class="timeline__state" data-testid="event-state">{{ row.state }}</span>
              <span class="timeline__meta">
                <span data-testid="event-name">{{ row.event }}</span>
                <span aria-hidden="true">&middot;</span>
                <span data-testid="event-actor">{{ row.actor }}</span>
                <span aria-hidden="true">&middot;</span>
                <time [attr.datetime]="row.timestamp" data-testid="event-time">{{ row.at }}</time>
              </span>
            </span>
          </li>
        }
      </ol>
    }
  `,
  styles: `
    :host {
      display: block;
      color: var(--lj-text);
      font-size: 14px;
      line-height: 21px;
    }

    .timeline {
      margin: 0;
      padding: 0 0 0 16px;
      list-style: none;
      border-left: 1px solid var(--lj-border);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .timeline__entry {
      position: relative;
      display: flex;
      gap: 8px;
    }

    .timeline__marker {
      position: absolute;
      left: -21px;
      top: 6px;
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--lj-bg);
      border: 2px solid var(--lj-border-strong);
    }

    .timeline__body {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .timeline__state {
      font-weight: 600;
    }

    .timeline__meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      color: var(--lj-muted);
      font-size: 12.5px;
      line-height: 18px;
      font-variant-numeric: tabular-nums;
    }

    .timeline__empty {
      margin: 0;
      color: var(--lj-muted);
    }
  `,
})
export class LjTimeline {
  /**
   * Rendered in the order given. The log is append-only and ordered by id, so
   * whether the newest belongs at the top is the caller's decision, not this
   * component's.
   */
  readonly events = input.required<readonly WorkflowEvent[]>();

  readonly audience = input.required<LabelAudience>();

  protected readonly rows = computed<readonly TimelineRow[]>(() =>
    this.events().map((event) => timelineRow(event, this.audience())),
  );
}
