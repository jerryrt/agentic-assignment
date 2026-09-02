/**
 * POST /api/transition -- the one place a state machine may be moved.
 *
 * Supabase's row-level security could serve the whole app from the browser, and
 * for reads it does. This endpoint exists for one reason: a workflow transition
 * has to be adjudicated somewhere the client cannot lie. The browser imports
 * the same `packages/workflow` to grey out an illegal button and show a guard's
 * blockers before a round trip -- that is a prediction. This is the decision,
 * and if the two disagree the server wins.
 *
 * THE ORDER OF OPERATIONS IS THE SPECIFICATION. It is the sequence diagram in
 * plan/03-workflow-engine.md section 3, and the numbered steps below are that
 * diagram:
 *
 *   1. Parse the body. Every field through a schema from packages/domain, and
 *      nothing the caller sent is carried past `lib/request.ts`.
 *   2. Authenticate, and read the role from the caller's PROFILE. Never from
 *      the body -- a client-supplied role is the first thing to forge.
 *   3. Load the subject, re-make every check row-level security would have
 *      made, and run packages/rules to build the guard context.
 *   4. `apply(machine, from, event, role, context)`.
 *   5. Refusal -> 422 with the blockers, as `RuleResult[]`.
 *   6. Legal -> update matching the expected revision, append the event, run
 *      the declared effects.
 *   7. Zero rows updated -> 409 with the refetched current state.
 *
 * Two refinements to step 5, both deliberate and both about not lying to the
 * caller. `can` refuses for three different reasons, and only one of them is
 * about criteria: a role that may not fire the transition gets 403, and a state
 * that has no such exit gets 409 with the current state, because that is the
 * two-tabs case seen one step earlier. 422 is reserved for a guard, which is
 * the only refusal that has blockers to render.
 *
 * ON AUTHORITY. This handler holds the service role key, which bypasses RLS
 * completely. Everything the policies in `0002_rls.sql` would have enforced,
 * this code enforces instead -- see `applicationReadableBy`. The
 * `assert_legal_transition` trigger still runs underneath, but it is the second
 * line and not the first: it rejects a state pair absent from
 * `workflow_transition`, which is REACHABILITY, not AUTHORITY. Every write here
 * arrives as the service role, so as far as the database is concerned a
 * lender-only transition fired by a borrower is a legal move. Authority is this
 * file's job and nothing below it will catch a mistake in it.
 *
 * Exported as `POST` alone, so the runtime rejects every other method for us.
 */

import { appendWorkflowEvent, listWorkflowEvents, type DatabaseClient } from '@lj/db';
import { createServiceRoleClient } from '@lj/db/service-role';
import type { ApplicationState, WorkflowMachine } from '@lj/domain';
import type { ProductEligibility } from '@lj/rules';
import {
  applicationMachine,
  apply,
  type ApplicationEvent,
  type EffectSpec,
} from '@lj/workflow';

import { authenticateActor, bearerToken, type Actor } from '../../lib/actor.ts';
import {
  advanceApplication,
  applicationReadableBy,
  asApplicationEvent,
  evaluateApplication,
  loadApplication,
  type ApplicationSubject,
} from '../../lib/application-subject.ts';
import { runEffects, unrunnableEffects } from '../../lib/effects.ts';
import { readApiEnvironment } from '../../lib/environment.ts';
import { failure, success, type SubjectSnapshot } from '../../lib/http.ts';
import { anyPermits, transitionsFrom } from '../../lib/machines.ts';
import { parseTransitionRequest } from '../../lib/request.ts';

export async function POST(request: Request): Promise<Response> {
  try {
    return await adjudicate(request);
  } catch (error: unknown) {
    // Name and message only. The request body, the headers and the bearer token
    // are never logged: a token in a log is a token that has left the process.
    const described = error instanceof Error ? error.name + ': ' + error.message : 'unknown';
    console.error('POST /api/transition failed: ' + described);
    return failure(500, 'internal_error', 'the transition could not be adjudicated');
  }
}

async function adjudicate(request: Request): Promise<Response> {
  // 1 -- parse, before anything else.
  const body = await readJsonBody(request);
  if (!body.ok) {
    return failure(400, 'invalid_request', body.reason);
  }
  const parsed = parseTransitionRequest(body.value);
  if (!parsed.ok) {
    return failure(400, 'invalid_request', parsed.problems.join('; '));
  }
  const { machine, subjectId, event, expectedRevision } = parsed.request;

  // Only `application` has a table. Answered before authentication because it
  // is a property of this deployment, not of the caller, and answering it as
  // "no such subject" would send someone hunting for a row that was never
  // going to be there.
  if (!hasSubjectStore(machine)) {
    return failure(
      501,
      'machine_not_persisted',
      "machine '" + machine + "' has no table yet, so it has no subjects to move",
    );
  }

  // 2 -- authenticate, and take the role from the profile.
  const token = bearerToken(request.headers);
  if (token === null) {
    return failure(401, 'unauthenticated', 'a bearer access token is required');
  }
  const environment = readApiEnvironment(process.env);
  const authenticated = await authenticateActor(environment, token);
  if (!authenticated.ok) {
    return failure(authenticated.status, authenticated.code, authenticated.reason);
  }
  const actor = authenticated.actor;

  // The RLS-bypassing client. From here on, every check the policies would have
  // made is this code's responsibility.
  const service = createServiceRoleClient(environment.serviceRole);

  // 3 -- load the subject, and re-make the policies' decision about it.
  const subject = await loadApplication(service, subjectId);
  if (subject === null || !applicationReadableBy(subject, actor)) {
    return failure(404, 'subject_not_found', 'no such application');
  }
  const current: SubjectSnapshot = { state: subject.state, revision: subject.revision };

  // Structural authority, asked of the machine definition rather than inferred
  // from the engine's refusal message. Both answers below carry no blockers,
  // because there is no criterion to show: the request was never coherent.
  const candidates = transitionsFrom(parsed.machine, subject.state, event);
  if (candidates.length === 0) {
    return failure(
      409,
      'state_conflict',
      "'" + event + "' does not leave '" + subject.state + "'",
      { blockers: [], current },
    );
  }
  if (!anyPermits(candidates, actor.role)) {
    return failure(
      403,
      'role_not_permitted',
      "role '" + actor.role + "' may not fire '" + event + "' from '" + subject.state + "'",
      { blockers: [], current },
    );
  }

  const narrowed = asApplicationEvent(event);
  if (narrowed === null) {
    // Unreachable: the parse rejected any event this machine does not declare.
    return failure(400, 'invalid_request', "unknown event '" + event + "'");
  }

  // 4 -- the decision. Guards run in TypeScript because they need context, and
  // the context is evaluated rule sets that packages/rules produced just now.
  const evaluation = await evaluateApplication(service, subject);
  const outcome = apply(
    applicationMachine,
    subject.state,
    narrowed,
    actor.role,
    evaluation.context,
  );

  // 5 -- a guard refused, and said why.
  if (!outcome.ok) {
    return failure(422, 'guard_refused', outcome.reason, {
      blockers: outcome.blockers,
      current,
    });
  }

  // 6a -- an effect nothing can carry out refuses BEFORE the update, so that
  // nothing is written and nothing has to be undone. See lib/effects.ts.
  const unrunnable = unrunnableEffects(outcome.effects);
  if (unrunnable.length > 0) {
    return failure(
      501,
      'effect_not_implemented',
      "'" +
        event +
        "' declares the effect " +
        unrunnable.join(', ') +
        ', which this API cannot yet carry out; the transition is refused rather ' +
        'than performed without it',
      { blockers: [], current },
    );
  }

  return await commit(service, {
    actor,
    subject,
    event: narrowed,
    expectedRevision,
    to: outcome.to,
    effects: outcome.effects,
    eligibility: evaluation.eligibility,
  });
}

interface CommitRequest {
  readonly actor: Actor;
  readonly subject: ApplicationSubject;
  readonly event: ApplicationEvent;
  readonly expectedRevision: number;
  readonly to: ApplicationState;
  readonly effects: readonly EffectSpec[];
  /**
   * The evaluation the decision above was taken on, carried through so an
   * effect records what the guard read rather than re-reading it.
   */
  readonly eligibility: readonly ProductEligibility[];
}

/**
 * The write, and the transaction boundary.
 *
 * WHAT IS ATOMIC, AND WHAT IS NOT. PostgREST gives each request its own
 * transaction and offers no way to span two, so the `BEGIN ... COMMIT` the
 * sequence diagram draws around the update and the append is not available
 * over this transport. What IS available is the property the whole design rests
 * on: the revision-matched UPDATE is a single statement, and it is the only
 * serialisation point. Two tabs approving one release both send the same
 * expected revision; Postgres serialises the two updates and the second matches
 * zero rows. That is the concurrency guarantee, and it is exact.
 *
 * The two writes are therefore ordered so that the failure that can happen is
 * the one that can be detected and repaired, rather than the one that cannot:
 *
 *   update first, then append. If the append fails, an application has moved
 *   with no audit entry -- visible by comparing the state against the log, and
 *   fixable by writing the missing row, because the log is append-only and the
 *   row that is missing is known.
 *
 *   append first, then update -- the alternative -- writes an audit entry for a
 *   transition that then loses on the revision, or that the
 *   `assert_legal_transition` trigger rejects. The log has no UPDATE and no
 *   DELETE grant, for anyone, including the service role, so that entry is
 *   permanent. A forged history is worse than a missing one, because it is
 *   believed. It is also the behaviour issue #13 explicitly forbids: a stale
 *   revision must write no event.
 *
 * The window between the two is one round trip, and the append is retried once
 * before it is reported. Closing it properly needs both statements inside one
 * database transaction, which means a `security definer` function called over
 * PostgREST RPC -- one migration, owned by the `data` scope, taking exactly the
 * arguments this function assembles. Nothing in this file would change but the
 * body of this function.
 */
async function commit(
  service: DatabaseClient,
  request: CommitRequest,
): Promise<Response> {
  const { actor, subject } = request;

  const advanced = await advanceApplication(service, {
    applicationId: subject.id,
    expectedRevision: request.expectedRevision,
    to: request.to,
  });

  // 7 -- zero rows updated. The subject moved under the caller, so refetch and
  // hand back what is true now; the caller reconciles and may retry.
  if (advanced === null) {
    const now = await loadApplication(service, subject.id);
    return failure(
      409,
      'revision_conflict',
      'the application moved while this request was in flight; nothing was written',
      {
        blockers: [],
        current: now === null ? null : { state: now.state, revision: now.revision },
      },
    );
  }

  // 6b -- the audit entry. `actor_id` and `actor_role` are the authenticated
  // caller and their profile role, never anything the body offered.
  const appended = await appendEvent(service, request, advanced);
  if (!appended) {
    return failure(
      500,
      'event_log_write_failed',
      'the application moved to ' +
        request.to +
        ' but its audit entry could not be written; the state change stands and the ' +
        'log is short one row',
      { blockers: [], current: advanced },
    );
  }

  // 6c -- the declared effects, after the state change rather than before it.
  //
  // The order is forced by the same absence of a transaction the two writes
  // above work around, and it is the right way round anyway: an effect written
  // first would record a submission that the revision check then refused, and
  // "a stale revision writes nothing" is a property this endpoint is required
  // to have.
  //
  // What that costs is a window in which the state has moved and the effect has
  // not. It is reported, never absorbed. For the one effect that exists the
  // damage is bounded and repairable: the snapshot is derivable from the
  // application's own payload at this revision, which is still in the database,
  // so the missing row can be written afterwards. That is why this is a 500
  // naming what did not land rather than an attempt to undo the transition --
  // reversing it would append a second, false entry to an append-only log.
  const effects = await runEffects(service, request.effects, {
    applicationId: subject.id,
    revision: advanced.revision,
    eligibility: request.eligibility,
  });
  if (!effects.ok) {
    return failure(
      500,
      'effect_write_failed',
      'the application moved to ' +
        request.to +
        " but the declared effect '" +
        effects.kind +
        "' did not: " +
        effects.reason +
        '; the state change stands',
      { blockers: [], current: advanced },
    );
  }

  return success({
    machine: 'application' satisfies WorkflowMachine,
    subjectId: subject.id,
    event: request.event,
    from: subject.state,
    to: advanced.state,
    revision: advanced.revision,
    actorRole: actor.role,
    effects: request.effects.map((effect) => effect.kind),
    events: await listWorkflowEvents(service, 'application', subject.id),
  });
}

/**
 * Append the audit entry, retrying once.
 *
 * One retry, not a loop: the failure this covers is a dropped connection on a
 * write that is idempotent in practice because the log has no uniqueness to
 * violate. A persistent failure is a real fault and must surface as one rather
 * than be absorbed by a handler that keeps trying until the request times out.
 */
async function appendEvent(
  service: DatabaseClient,
  request: CommitRequest,
  advanced: SubjectSnapshot,
): Promise<boolean> {
  const row = {
    machine: 'application',
    subject_id: request.subject.id,
    from_state: request.subject.state,
    to_state: advanced.state,
    event: request.event,
    actor_id: request.actor.id,
    actor_role: request.actor.role,
    payload: {
      revision: advanced.revision,
      effects: request.effects.map((effect) => effect.kind),
    },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if ((await appendWorkflowEvent(service, row)) !== null) {
        return true;
      }
    } catch (error: unknown) {
      const described = error instanceof Error ? error.name + ': ' + error.message : 'unknown';
      console.error('workflow_event append failed: ' + described);
    }
  }
  return false;
}

interface JsonBody {
  readonly ok: true;
  readonly value: unknown;
}

interface UnreadableBody {
  readonly ok: false;
  readonly reason: string;
}

async function readJsonBody(request: Request): Promise<JsonBody | UnreadableBody> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    // The parse error itself is not repeated back: it quotes the body, and the
    // body is caller-controlled text that would then appear in our response.
    return { ok: false, reason: 'the request body must be JSON' };
  }
}

/**
 * Which machines have somewhere to keep a subject.
 *
 * `document_slot` arrives with the document pack in plan/04 and
 * `credit_release` with the servicing option in plan/06. Both are complete
 * machines with generated SQL rows already; what they lack is a table, and the
 * handoff on issue #9 says whoever creates one must also attach
 * `assert_legal_transition` to it.
 */
function hasSubjectStore(machine: WorkflowMachine): boolean {
  return machine === 'application';
}
