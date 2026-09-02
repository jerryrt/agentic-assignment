import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ApplicationState, CreditReleaseState, LabelAudience } from '@lj/domain';
import { applicationStateLabel, creditReleaseStateLabel } from '@lj/domain';

/**
 * One workflow state, in the vocabulary of whoever is reading it.
 *
 * `under_review` is "With your lender" to the borrower and "Awaiting your
 * decision" to the lender, and both are true (plan/02-domain-model.md). That
 * mapping lives once, in @lj/domain, as a mapped type with no optional
 * modifier, so a state added to a machine and forgotten there fails `tsc`
 * rather than rendering an empty badge. This component resolves it; it does not
 * hold a second copy of it.
 *
 * Why one `subject` input rather than the `[machine] [state]` pair sketched in
 * plan/07-frontend.md: the legal states depend on the machine, and two
 * independent inputs cannot express that. `machine="application"` with
 * `state="cancelled"` -- a credit-release state -- would have to be handled at
 * runtime with a fallback, and a fallback is exactly what makes a missing label
 * invisible. A discriminated union makes that combination fail to compile,
 * which is the property the label maps were written to have.
 */
export type StateBadgeSubject =
  | { readonly machine: 'application'; readonly state: ApplicationState }
  | { readonly machine: 'credit_release'; readonly state: CreditReleaseState };

/**
 * How settled a state is, in the colours the token contract already has. This
 * is a presentation decision and it lives in the presentation layer: @lj/domain
 * owns what a state is called, not what it looks like.
 *
 * Written as mapped types for the same reason the label maps are: a state added
 * to a machine and forgotten here is a compile error, not a badge that silently
 * renders in the wrong colour.
 *
 * Colour is never the only cue. The badge always renders the state's words, and
 * those differ per state, so the badge is readable in greyscale by
 * construction (design/00-foundations.md).
 */
export const BADGE_TONES = ['neutral', 'info', 'ok', 'warn', 'err'] as const;

export type BadgeTone = (typeof BADGE_TONES)[number];

export const APPLICATION_STATE_TONES: { readonly [K in ApplicationState]: BadgeTone } = {
  draft: 'neutral',
  submitted: 'info',
  docs_pending: 'warn',
  under_review: 'info',
  needs_borrower_action: 'warn',
  approved: 'ok',
  declined: 'err',
  funded: 'ok',
  // Withdrawn is neutral rather than an error: the borrower chose it, and
  // colouring a decision of theirs as a failure misreads the file.
  withdrawn: 'neutral',
};

export const CREDIT_RELEASE_STATE_TONES: { readonly [K in CreditReleaseState]: BadgeTone } = {
  draft: 'neutral',
  submitted: 'info',
  under_review: 'info',
  approved: 'ok',
  declined: 'err',
  funded: 'ok',
  cancelled: 'neutral',
};

export function stateBadgeLabel(subject: StateBadgeSubject, audience: LabelAudience): string {
  return subject.machine === 'application'
    ? applicationStateLabel(subject.state, audience)
    : creditReleaseStateLabel(subject.state, audience);
}

export function stateBadgeTone(subject: StateBadgeSubject): BadgeTone {
  return subject.machine === 'application'
    ? APPLICATION_STATE_TONES[subject.state]
    : CREDIT_RELEASE_STATE_TONES[subject.state];
}

@Component({
  selector: 'lj-state-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'lj-state-badge' },
  template: `<span class="badge" [attr.data-tone]="tone()" data-testid="badge">{{ label() }}</span>`,
  styles: `
    :host {
      display: inline-block;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border: 1px solid;
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      line-height: 14px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .badge[data-tone='neutral'] {
      color: var(--lj-muted);
      background: var(--lj-surface);
      border-color: var(--lj-border-strong);
    }

    .badge[data-tone='info'] {
      color: var(--lj-primary);
      background: var(--lj-primary-subtle);
      border-color: var(--lj-primary);
    }

    .badge[data-tone='ok'] {
      color: var(--lj-ok);
      background: var(--lj-ok-subtle);
      border-color: var(--lj-ok);
    }

    .badge[data-tone='warn'] {
      color: var(--lj-warn);
      background: var(--lj-warn-subtle);
      border-color: var(--lj-warn);
    }

    .badge[data-tone='err'] {
      color: var(--lj-err);
      background: var(--lj-err-subtle);
      border-color: var(--lj-err);
    }
  `,
})
export class LjStateBadge {
  readonly subject = input.required<StateBadgeSubject>();

  readonly audience = input.required<LabelAudience>();

  protected readonly label = computed(() => stateBadgeLabel(this.subject(), this.audience()));

  protected readonly tone = computed(() => stateBadgeTone(this.subject()));
}
