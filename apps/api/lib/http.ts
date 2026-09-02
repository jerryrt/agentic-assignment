/**
 * One response shape for every way this endpoint can answer.
 *
 * A caller renders a refusal through the same code path whatever caused it, so
 * every failure carries the same four fields and only the values differ:
 *
 *     { ok: false, code, reason, blockers, current }
 *
 * `blockers` is `RuleResult[]` -- the type packages/rules produces -- and it is
 * present and empty on the refusals that have no criteria to show, rather than
 * absent. An optional property does not survive `JSON.parse(JSON.stringify(x))`
 * unchanged, and the browser renders this list through the same component as an
 * unmet eligibility criterion; a field that is sometimes missing turns that one
 * component into two.
 *
 * `code` rather than only a sentence, because the caller has to branch: a 409
 * means refetch and retry, a 422 means show the blockers, a 403 means the
 * button should not have been there. `reason` is for a person reading a log or
 * a developer console; it is never the thing a client switches on.
 */

import type { RuleResult } from '@lj/domain';

/**
 * Every way a transition request can fail, named once.
 *
 * The list is deliberately finer than the three branches of the sequence
 * diagram in plan/03. That diagram draws the happy path and the two refusals
 * that are about the subject; it does not enumerate the ways a request can be
 * incoherent or unauthorised, and collapsing those into "422 with blockers"
 * would tell a caller their data was wrong when the truth is that they may not
 * do this at all.
 */
export const TRANSITION_FAILURE_CODES = [
  /** The body did not parse, or named a machine or event that does not exist. */
  'invalid_request',
  /** No bearer token, or one the auth server does not recognise. */
  'unauthenticated',
  /** Authenticated, but with no profile row and therefore no role. */
  'no_profile',
  /** A real machine whose subjects have no table yet. */
  'machine_not_persisted',
  /** No such subject, or none this caller could have read under RLS. */
  'subject_not_found',
  /** The machine has no such transition out of the subject's current state. */
  'state_conflict',
  /** The transition exists, but not for this actor's role. */
  'role_not_permitted',
  /** A guard said no, and said why. This is the one that carries blockers. */
  'guard_refused',
  /** The transition declares an effect this API cannot yet carry out. */
  'effect_not_implemented',
  /** The subject moved under the caller: the two-tabs case. */
  'revision_conflict',
  /** The database trigger rejected a move the machine believes is legal. */
  'transition_rejected_by_database',
  /** The state moved but the audit entry did not land. Always loud. */
  'event_log_write_failed',
  'internal_error',
] as const;

export type TransitionFailureCode = (typeof TRANSITION_FAILURE_CODES)[number];

/** What the caller must reconcile against when it has lost a race. */
export interface SubjectSnapshot {
  readonly state: string;
  readonly revision: number;
}

export interface FailureDetail {
  readonly blockers: readonly RuleResult[];
  readonly current: SubjectSnapshot | null;
}

const NOTHING_TO_ADD: FailureDetail = { blockers: [], current: null };

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      // A transition answer describes one instant of one row. A cached copy of
      // it is a lie about the present, and this endpoint is the one place the
      // client is told what the truth now is.
      'cache-control': 'no-store',
    },
  });
}

export function failure(
  status: number,
  code: TransitionFailureCode,
  reason: string,
  detail: FailureDetail = NOTHING_TO_ADD,
): Response {
  return json(status, {
    ok: false,
    code,
    reason,
    blockers: detail.blockers,
    current: detail.current,
  });
}

export function success(payload: Record<string, unknown>): Response {
  return json(200, { ok: true, ...payload });
}
