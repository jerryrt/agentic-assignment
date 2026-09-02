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

import {
  appendWorkflowEvent,
  listWorkflowEvents,
  type DatabaseClient,
  type Json,
} from '@lj/db';
import { createServiceRoleClient } from '@lj/db/service-role';
import type { AppRole, ApplicationState, WorkflowMachine } from '@lj/domain';
import type { ProductEligibility, RequiredDocSlot } from '@lj/rules';
import {
  applicationMachine,
  apply,
  creditReleaseMachine,
  documentSlotMachine,
  type ApplicationEvent,
  type EffectSpec,
  type MachineShape,
} from '@lj/workflow';

import { authenticateActor, bearerToken, type Actor } from '../../lib/actor.ts';
import {
  advanceApplication,
  applicationReadableBy,
  applicationTransitionNeedsEvaluation,
  asApplicationEvent,
  evaluateApplication,
  loadApplication,
  UNEVALUATED_APPLICATION_CONTEXT,
  type ApplicationEvaluation,
  type ApplicationSubject,
} from '../../lib/application-subject.ts';
import {
  advanceCreditRelease,
  asCreditReleaseEvent,
  creditReleaseEventRecordsDecider,
  creditReleaseTransitionNeedsEvaluation,
  evaluateCreditReleaseSubject,
  loadCreditRelease,
  loadLoan,
  UNEVALUATED_CREDIT_RELEASE_CONTEXT,
  type CreditReleaseEvaluation,
} from '../../lib/credit-release-subject.ts';
import { resolveRequiredDocs } from '../../lib/document-pack.ts';
import { resolveLoanTerms, type LoanTerms } from '../../lib/loan-terms.ts';
import {
  advanceDocumentSlot,
  asDocumentSlotEvent,
  loadDocumentSlot,
  NO_DOCUMENT_SLOT_CRITERIA,
} from '../../lib/document-slot-subject.ts';
import { prepareUpload, type PreparedUpload } from '../../lib/document-upload.ts';
import { declaresEffect, runEffects, unrunnableEffects } from '../../lib/effects.ts';
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

  // Answered before authentication because it is a property of this
  // deployment, not of the caller, and answering it as "no such subject" would
  // send someone hunting for a row that was never going to be there.
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

  // Two subjects, two adjudicators, and no registry over them. They share who
  // the audience is and how the audit entry is written, and those two are
  // shared as functions; everything else -- the table, the schema that
  // validates a row, the guard context, what an effect needs -- differs, and a
  // generic pipeline with a switch inside every step would read worse than
  // both of these do (CLAUDE.md section 9).
  const adjudication: AdjudicationRequest = {
    actor,
    machine: parsed.machine,
    subjectId,
    event,
    expectedRevision,
    filename: parsed.request.filename,
    declineReason: parsed.request.declineReason,
  };
  switch (machine) {
    case 'document_slot':
      return await adjudicateDocumentSlot(service, adjudication);
    case 'credit_release':
      return await adjudicateCreditRelease(service, adjudication);
    case 'application':
      return await adjudicateApplication(service, adjudication);
  }
}

/** What both adjudicators take, once the request has been made sense of. */
interface AdjudicationRequest {
  readonly actor: Actor;
  /** The definition behind the machine id, resolved by the parse. */
  readonly machine: MachineShape;
  readonly subjectId: string;
  readonly event: string;
  readonly expectedRevision: number;
  /** The label on the file an upload is about. Read by no other transition. */
  readonly filename: string | null;
  /** The reason a decline is refused for. Read by no other transition. */
  readonly declineReason: string | null;
}

/**
 * The two refusals that are structural rather than about criteria.
 *
 * Asked of the machine definition rather than inferred from the engine's
 * message, and asked before the guard context is built, because neither answer
 * needs one: no transition leaves this state on this event, or one does and
 * this role may not fire it. Both carry an empty `blockers` list, because there
 * is no criterion to show -- the request was never coherent.
 *
 * Written out once per adjudicator until `credit_release` made it three
 * copies of one paragraph, each of which had to keep saying 409 for a state
 * with no such exit and 403 for a role, in that order. Getting the order wrong
 * in one copy would tell a borrower they may not fire a transition that does
 * not exist, and nothing would catch it (CLAUDE.md section 9).
 */
function structuralRefusal(
  machine: MachineShape,
  actor: Actor,
  event: string,
  current: SubjectSnapshot,
): Response | null {
  const candidates = transitionsFrom(machine, current.state, event);
  if (candidates.length === 0) {
    return failure(
      409,
      'state_conflict',
      "'" + event + "' does not leave '" + current.state + "'",
      { blockers: [], current },
    );
  }
  if (!anyPermits(candidates, actor.role)) {
    return failure(
      403,
      'role_not_permitted',
      "role '" + actor.role + "' may not fire '" + event + "' from '" + current.state + "'",
      { blockers: [], current },
    );
  }
  return null;
}

async function adjudicateApplication(
  service: DatabaseClient,
  request: AdjudicationRequest,
): Promise<Response> {
  const { actor, subjectId, event, expectedRevision } = request;

  // 3 -- load the subject, and re-make the policies' decision about it.
  const subject = await loadApplication(service, subjectId);
  if (subject === null || !applicationReadableBy(subject, actor)) {
    return failure(404, 'subject_not_found', 'no such application');
  }
  const current: SubjectSnapshot = { state: subject.state, revision: subject.revision };

  const refused = structuralRefusal(request.machine, actor, event, current);
  if (refused !== null) {
    return refused;
  }

  const narrowed = asApplicationEvent(event);
  if (narrowed === null) {
    // Unreachable: the parse rejected any event this machine does not declare.
    return failure(400, 'invalid_request', "unknown event '" + event + "'");
  }

  // 4 -- the decision. Guards run in TypeScript because they need context, and
  // the context is evaluated rule sets that packages/rules produced just now.
  //
  // Only for a transition that reads one. `withdraw` declares no guard and no
  // effect, so evaluating for it would be work nobody looks at -- and, worse,
  // a payload that does not parse would refuse it. That was a lockout: after a
  // submit the borrower cannot write `data` any more, so a row stranded by a
  // schema change could be neither repaired nor abandoned. A borrower's way
  // out of their own application must not depend on rules with nothing to say
  // about it.
  let evaluation: ApplicationEvaluation | null = null;
  if (applicationTransitionNeedsEvaluation(subject.state, narrowed)) {
    const evaluated = await evaluateApplication(service, subject);
    if (!evaluated.ok) {
      // The stored payload matches no schema, so no rule set could be evaluated
      // over it. 422 with no blockers: there is no criterion to show, and the
      // alternative -- an empty context -- would render as four unanswered
      // steps and tell the applicant their form is unfinished when their row is
      // corrupt.
      return failure(422, 'guard_refused', evaluated.reason, { blockers: [], current });
    }
    evaluation = evaluated.evaluation;
  }

  const outcome = apply(
    applicationMachine,
    subject.state,
    narrowed,
    actor.role,
    evaluation?.context ?? UNEVALUATED_APPLICATION_CONTEXT,
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

  // A declared effect is one of the two things that make a transition need an
  // evaluation, so reaching here without one is a contradiction between the
  // check above and the machine definition. Stated rather than assumed,
  // because the alternative to this branch is a snapshot recording an empty
  // evaluation as though it were what the borrower was told.
  if (outcome.effects.length > 0 && evaluation === null) {
    return failure(
      500,
      'internal_error',
      "'" + event + "' declares an effect but was adjudicated without an evaluation",
      { blockers: [], current },
    );
  }

  // 6b -- an effect whose INPUT cannot be assembled refuses in the same
  // direction, and at the same moment, as one with no runner at all. The
  // checklist a product asks for is read HERE rather than inside the runner
  // because by the time a runner is called the application has already moved:
  // a pack that does not parse would then be a `docs_pending` application with
  // a partial checklist, which reports complete once its slots are accepted.
  let requiredDocs: readonly RequiredDocSlot[] = [];
  if (declaresEffect(outcome.effects, 'create_document_slots')) {
    if (evaluation === null) {
      // Unreachable: a declared effect makes the transition need an evaluation,
      // and the branch above already answered the contradiction. Stated because
      // the alternative is reading a product id out of a payload nobody parsed.
      return failure(500, 'internal_error', "'" + event + "' was adjudicated without an evaluation", {
        blockers: [],
        current,
      });
    }
    const resolved = await resolveRequiredDocs(service, subject, evaluation.data);
    if (!resolved.ok) {
      return failure(
        422,
        'effect_input_invalid',
        "'" + event + "' generates the document checklist, and " + resolved.reason,
        { blockers: [], current },
      );
    }
    requiredDocs = resolved.slots;
  }

  // The facility, resolved HERE and for the same reason the pack is: by the
  // time a runner is called the application says `funded`, and an application
  // at `funded` with no loan behind it is the one outcome `create_loan` exists
  // to prevent. Terms that cannot be assembled refuse the transition instead.
  let loanTerms: LoanTerms | null = null;
  if (declaresEffect(outcome.effects, 'create_loan')) {
    if (evaluation === null) {
      // Unreachable, for the reason stated above the same branch on the pack.
      return failure(500, 'internal_error', "'" + event + "' was adjudicated without an evaluation", {
        blockers: [],
        current,
      });
    }
    const resolved = await resolveLoanTerms(service, subject, evaluation.data);
    if (!resolved.ok) {
      return failure(
        422,
        'effect_input_invalid',
        "'" + event + "' opens the facility, and " + resolved.reason,
        { blockers: [], current },
      );
    }
    loanTerms = resolved.terms;
  }

  return await commit(service, {
    actor,
    subject,
    event: narrowed,
    expectedRevision,
    to: outcome.to,
    effects: outcome.effects,
    eligibility: evaluation?.eligibility ?? [],
    requiredDocs,
    loanTerms,
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
  /** The pack `create_document_slots` is to generate, resolved before the write. */
  readonly requiredDocs: readonly RequiredDocSlot[];
  /** The facility `create_loan` is to open, resolved before the write. */
  readonly loanTerms: LoanTerms | null;
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

  // 6b -- the audit entry.
  const appended = await appendEvent(service, {
    machine: 'application',
    subjectId: subject.id,
    from: subject.state,
    to: advanced.state,
    event: request.event,
    actorId: actor.id,
    actorRole: actor.role,
    payload: {
      revision: advanced.revision,
      effects: request.effects.map((effect) => effect.kind),
    },
  });
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
    requiredDocs: request.requiredDocs,
    slot: null,
    upload: null,
    loanTerms: request.loanTerms,
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
 * A slot moves through the same endpoint, and for the same reason.
 *
 * Accepting a document is a lender's decision and uploading one is the
 * borrower's; both are re-checked here against the machine, because a UI that
 * hides a button is a courtesy and not a gate. The database will not catch a
 * mistake in this: `document_slot_assert_legal_transition` reads
 * `workflow_transition` for the state pair and knows nothing about who asked,
 * and every write below arrives as the service role.
 */
async function adjudicateDocumentSlot(
  service: DatabaseClient,
  request: AdjudicationRequest,
): Promise<Response> {
  const { actor, subjectId, event, expectedRevision } = request;

  const slot = await loadDocumentSlot(service, subjectId);
  if (slot === null) {
    return failure(404, 'subject_not_found', 'no such document slot');
  }

  // The audience is the application's audience, resolved through it rather than
  // restated -- the shape 0006_documents.sql gives the read policy. A caller
  // who cannot read the application is answered as though the slot did not
  // exist, because distinguishing "forbidden" from "absent" hands out the
  // existence of other people's loan files.
  const application = await loadApplication(service, slot.applicationId);
  if (application === null || !applicationReadableBy(application, actor)) {
    return failure(404, 'subject_not_found', 'no such document slot');
  }

  const current: SubjectSnapshot = { state: slot.state, revision: slot.revision };

  const refused = structuralRefusal(request.machine, actor, event, current);
  if (refused !== null) {
    return refused;
  }

  const narrowed = asDocumentSlotEvent(event);
  if (narrowed === null) {
    // Unreachable: the parse rejected any event this machine does not declare.
    return failure(400, 'invalid_request', "unknown event '" + event + "'");
  }

  const outcome = apply(
    documentSlotMachine,
    slot.state,
    narrowed,
    actor.role,
    NO_DOCUMENT_SLOT_CRITERIA,
  );
  if (!outcome.ok) {
    // Unreachable while no slot transition carries a guard, and answered rather
    // than asserted: a guard added later must refuse here like any other.
    return failure(422, 'guard_refused', outcome.reason, {
      blockers: outcome.blockers,
      current,
    });
  }

  // What this transition does besides moving the state, read off the machine
  // definition and nowhere else. It briefly had a second home in the delivery
  // layer, because the slot machine's file was outside the scope that needed
  // the effect; two places deciding which transitions have effects is the same
  // duplication as two places deciding which transitions are legal.
  const effects = outcome.effects;

  const unrunnable = unrunnableEffects(effects);
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

  // The file this transition is about, found in the bucket rather than named by
  // the caller, and found BEFORE the state change. A slot that said `uploaded`
  // with no file behind it is a checklist row nobody can act on: the borrower
  // believes they sent something and the lender has nothing to open.
  let upload: PreparedUpload | null = null;
  if (declaresEffect(effects, 'extract_document')) {
    const prepared = await prepareUpload(service, slot, request.filename);
    if (!prepared.ok) {
      return failure(422, 'effect_input_invalid', prepared.reason, {
        blockers: [],
        current,
      });
    }
    upload = prepared.upload;
  }

  const advanced = await advanceDocumentSlot(service, {
    slotId: slot.id,
    expectedRevision,
    to: outcome.to,
  });
  if (advanced === null) {
    const now = await loadDocumentSlot(service, slot.id);
    return failure(
      409,
      'revision_conflict',
      'the document moved while this request was in flight; nothing was written',
      {
        blockers: [],
        current: now === null ? null : { state: now.state, revision: now.revision },
      },
    );
  }

  const appended = await appendEvent(service, {
    machine: 'document_slot',
    subjectId: slot.id,
    from: slot.state,
    to: advanced.state,
    event: narrowed,
    actorId: actor.id,
    actorRole: actor.role,
    payload: {
      revision: advanced.revision,
      effects: effects.map((effect) => effect.kind),
    },
  });
  if (!appended) {
    return failure(
      500,
      'event_log_write_failed',
      'the document moved to ' +
        outcome.to +
        ' but its audit entry could not be written; the state change stands and the ' +
        'log is short one row',
      { blockers: [], current: advanced },
    );
  }

  // The effects, after the state change and for the same reasons as on an
  // application. `extract_document` moves the slot a second time, so what the
  // caller is told about is where the slot ended up rather than where this
  // transition left it -- a browser told `uploaded` would render a document as
  // waiting for a read that has already happened.
  const ran = await runEffects(service, effects, {
    applicationId: slot.applicationId,
    revision: advanced.revision,
    eligibility: [],
    requiredDocs: [],
    slot,
    upload,
    loanTerms: null,
  });
  if (!ran.ok) {
    return failure(
      500,
      'effect_write_failed',
      'the document moved to ' +
        advanced.state +
        " but the declared effect '" +
        ran.kind +
        "' did not: " +
        ran.reason +
        '; the state change stands',
      { blockers: [], current: advanced },
    );
  }
  const settled = ran.subject ?? advanced;

  return success({
    machine: 'document_slot' satisfies WorkflowMachine,
    subjectId: slot.id,
    applicationId: slot.applicationId,
    event: narrowed,
    from: slot.state,
    to: settled.state,
    revision: settled.revision,
    actorRole: actor.role,
    effects: effects.map((effect) => effect.kind),
    events: await listWorkflowEvents(service, 'document_slot', slot.id),
  });
}

/**
 * A credit release moves through the same endpoint, and it is the first subject
 * whose guard reads money.
 *
 * Two properties are load-bearing here and neither is visible from the machine
 * definition alone.
 *
 * THE CAP AND THE BORROWER'S FIGURE ARE ONE QUANTITY. The `submit` guard
 * compares against `availableCredit` in packages/rules, computed over
 * `loan_balance_v` -- the same view, the same row and the same function the
 * borrower's screen uses. plan/06 is explicit that they must not be two
 * numbers, because a borrower who was told a request was affordable and then
 * refused has been lied to by one of the two.
 *
 * WHAT A DECISION WRITES ARRIVES WITH IT. `decided_by` and `decline_reason`
 * have no client grant at all -- a borrower and a lender are the same database
 * role -- so this handler is their only possible author, and they are written
 * in the same revision-matched statement that moves the state. A decline that
 * landed without its reason could never acquire one afterwards, so one is
 * required rather than optional.
 */
async function adjudicateCreditRelease(
  service: DatabaseClient,
  request: AdjudicationRequest,
): Promise<Response> {
  const { actor, subjectId, event, expectedRevision } = request;

  const release = await loadCreditRelease(service, subjectId);
  if (release === null) {
    return failure(404, 'subject_not_found', 'no such credit release');
  }

  // The audience is the loan's, which is the application's, resolved through
  // both rather than restated over the loan's denormalised columns -- the shape
  // `credit_release_read_visible_loan` has in 0007_servicing.sql. A caller who
  // cannot read the application is answered as though the release did not
  // exist, because distinguishing "forbidden" from "absent" hands out the
  // existence of other people's loans.
  const loan = await loadLoan(service, release.loanId);
  if (loan === null) {
    return failure(404, 'subject_not_found', 'no such credit release');
  }
  const application = await loadApplication(service, loan.applicationId);
  if (application === null || !applicationReadableBy(application, actor)) {
    return failure(404, 'subject_not_found', 'no such credit release');
  }

  const current: SubjectSnapshot = { state: release.state, revision: release.revision };

  const refused = structuralRefusal(request.machine, actor, event, current);
  if (refused !== null) {
    return refused;
  }

  const narrowed = asCreditReleaseEvent(event);
  if (narrowed === null) {
    // Unreachable: the parse rejected any event this machine does not declare.
    return failure(400, 'invalid_request', "unknown event '" + event + "'");
  }

  // Only for a transition that reads a rule set. `begin_review`, `approve`,
  // `decline` and `cancel` declare no guard and no effect, so evaluating for
  // them would be two reads nobody looks at -- and, worse, a balance that could
  // not be read would refuse them. A borrower's way out of a request they have
  // already made must not depend on rules with nothing to say about it (#26).
  let evaluation: CreditReleaseEvaluation | null = null;
  if (creditReleaseTransitionNeedsEvaluation(release.state, narrowed)) {
    const evaluated = await evaluateCreditReleaseSubject(service, loan, release);
    if (!evaluated.ok) {
      // No criteria to show: the figures the criteria are about could not be
      // read at all, which is a different problem from a request that is too
      // large, and only one of the two is the borrower's to fix.
      return failure(422, 'guard_refused', evaluated.reason, { blockers: [], current });
    }
    evaluation = evaluated.evaluation;
  }

  const outcome = apply(
    creditReleaseMachine,
    release.state,
    narrowed,
    actor.role,
    evaluation?.context ?? UNEVALUATED_CREDIT_RELEASE_CONTEXT,
  );
  if (!outcome.ok) {
    return failure(422, 'guard_refused', outcome.reason, {
      blockers: outcome.blockers,
      current,
    });
  }

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

  // A decline with no reason is refused before anything is written. The column
  // has no client UPDATE grant, so the reason arrives here or never: a decline
  // that landed without one would be permanently unexplained, and "the reason
  // text and what to change" is what plan/06 says a decline is for.
  if (narrowed === 'decline' && request.declineReason === null) {
    return failure(
      400,
      'invalid_request',
      "'decline' must carry declineReason: no client may write it afterwards, so a " +
        'decline recorded without one could never be explained',
      { blockers: [], current },
    );
  }

  const advanced = await advanceCreditRelease(service, {
    releaseId: release.id,
    expectedRevision,
    to: outcome.to,
    ...(creditReleaseEventRecordsDecider(narrowed) ? { decidedBy: actor.id } : {}),
    ...(narrowed === 'decline' && request.declineReason !== null
      ? { declineReason: request.declineReason }
      : {}),
  });
  if (advanced === null) {
    const now = await loadCreditRelease(service, release.id);
    return failure(
      409,
      'revision_conflict',
      'the request moved while this transition was in flight; nothing was written',
      {
        blockers: [],
        current: now === null ? null : { state: now.state, revision: now.revision },
      },
    );
  }

  const appended = await appendEvent(service, {
    machine: 'credit_release',
    subjectId: release.id,
    from: release.state,
    to: advanced.state,
    event: narrowed,
    actorId: actor.id,
    actorRole: actor.role,
    payload: {
      revision: advanced.revision,
      effects: outcome.effects.map((effect) => effect.kind),
    },
  });
  if (!appended) {
    return failure(
      500,
      'event_log_write_failed',
      'the request moved to ' +
        advanced.state +
        ' but its audit entry could not be written; the state change stands and the ' +
        'log is short one row',
      { blockers: [], current: advanced },
    );
  }

  const ran = await runEffects(service, outcome.effects, {
    applicationId: loan.applicationId,
    revision: advanced.revision,
    eligibility: [],
    requiredDocs: [],
    slot: null,
    upload: null,
    loanTerms: null,
  });
  if (!ran.ok) {
    return failure(
      500,
      'effect_write_failed',
      'the request moved to ' +
        advanced.state +
        " but the declared effect '" +
        ran.kind +
        "' did not: " +
        ran.reason +
        '; the state change stands',
      { blockers: [], current: advanced },
    );
  }

  return success({
    machine: 'credit_release' satisfies WorkflowMachine,
    subjectId: release.id,
    loanId: loan.id,
    event: narrowed,
    from: release.state,
    to: advanced.state,
    revision: advanced.revision,
    actorRole: actor.role,
    effects: outcome.effects.map((effect) => effect.kind),
    events: await listWorkflowEvents(service, 'credit_release', release.id),
  });
}

/** One audit entry, as every machine writes it. */
interface EventRecord {
  readonly machine: WorkflowMachine;
  readonly subjectId: string;
  readonly from: string;
  readonly to: string;
  readonly event: string;
  /** Null when the platform acted and no person is behind the move. */
  readonly actorId: string | null;
  readonly actorRole: AppRole | null;
  readonly payload: Json;
}

/**
 * Append the audit entry, retrying once.
 *
 * One retry, not a loop: the failure this covers is a dropped connection on a
 * write that is idempotent in practice because the log has no uniqueness to
 * violate. A persistent failure is a real fault and must surface as one rather
 * than be absorbed by a handler that keeps trying until the request times out.
 *
 * One log serves every machine, so one writer does too. `actor_id` and
 * `actor_role` are the authenticated caller and their profile role, never
 * anything the body offered.
 */
async function appendEvent(service: DatabaseClient, record: EventRecord): Promise<boolean> {
  const row = {
    machine: record.machine,
    subject_id: record.subjectId,
    from_state: record.from,
    to_state: record.to,
    event: record.event,
    actor_id: record.actorId,
    actor_role: record.actorRole,
    payload: record.payload,
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
 * All three now do: `application` from `0001_init.sql`, `document_slot` from
 * `0006_documents.sql` and `credit_release` from `0007_servicing.sql`, each
 * with `assert_legal_transition` attached -- the requirement the handoff on
 * issue #9 states for anyone creating one.
 *
 * Written as an exhaustive switch rather than deleted along with its refusal.
 * A fourth machine declared in `packages/domain` and given no table would
 * otherwise reach an adjudicator that cannot serve it; here it fails to
 * compile, and if it somehow did not, the 501 below is the honest answer --
 * "this deployment cannot keep one of those", rather than "no such subject",
 * which would send someone hunting for a row that was never going to be there.
 * Whoever adds the fourth adds the trigger, a loader that validates the row
 * with the schema that owns it, a re-make of the read policy's decision, and a
 * branch in `adjudicate`.
 */
function hasSubjectStore(machine: WorkflowMachine): boolean {
  switch (machine) {
    case 'application':
    case 'document_slot':
    case 'credit_release':
      return true;
  }
}
