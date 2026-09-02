/**
 * The `application` subject: loading it, deciding who may act on it, building
 * the context its guards take, and advancing it.
 *
 * It is the only machine with a table. `document_slot` and `credit_release`
 * arrive with plan/04 and plan/06, and the endpoint says so rather than
 * pretending their subjects are missing. There is deliberately no registry
 * abstraction over one implementation: a wrong abstraction costs more than the
 * duplication it removed, and the second store will show what the first one
 * really had in common with it (CLAUDE.md section 9).
 */

import {
  getBorrowerApplication,
  listActiveLoanProducts,
  updateApplication,
  type DatabaseClient,
  type LoanProduct,
} from '@lj/db';
import {
  ApplicationBorrowerViewSchema,
  moneyFromNumericString,
  parseApplicationData,
  type ApplicationData,
  type ApplicationState,
  type JsonValue,
  type Money,
  type RuleResult,
} from '@lj/domain';
import {
  atLeastOneEligibleProduct,
  eligibilityContextFromApplication,
  evaluateApplicationCompleteness,
  evaluateCompleteness,
  evaluateEligibility,
  parseEligibilityCriteria,
  type EligibilityProduct,
  type ProductEligibility,
} from '@lj/rules';
import {
  APPLICATION_EVENTS,
  applicationMachine,
  type ApplicationEvent,
  type ApplicationGuardContext,
} from '@lj/workflow';

import type { Actor } from './actor.ts';
import { buildDocumentContext } from './document-pack.ts';
import type { SubjectSnapshot } from './http.ts';

export interface ApplicationSubject {
  readonly id: string;
  readonly state: ApplicationState;
  readonly revision: number;
  readonly borrowerId: string;
  readonly orgId: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

/**
 * The subject, read with the service role and then validated.
 *
 * The borrower projection is used rather than the base table or the lender
 * view: it carries every column a transition needs and none of the lender-only
 * reasoning, so the adjudicator cannot accidentally come to hold a decision
 * note it has no business reading.
 *
 * The row is parsed with the schema from packages/domain even though it came
 * from our own database. Two reasons: the generated view types make every
 * column nullable, because Postgres reports no not-null constraint through a
 * view, so the parse is what narrows them without a non-null assertion; and a
 * `state` the machine does not know must not reach the engine as a string that
 * happens to typecheck.
 */
export async function loadApplication(
  client: DatabaseClient,
  applicationId: string,
): Promise<ApplicationSubject | null> {
  const row = await getBorrowerApplication(client, applicationId);
  if (row === null) {
    return null;
  }
  const parsed = ApplicationBorrowerViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      'application ' + applicationId + ' does not match the schema that describes it',
    );
  }
  return {
    id: parsed.data.id,
    state: parsed.data.state,
    revision: parsed.data.revision,
    borrowerId: parsed.data.borrower_id,
    orgId: parsed.data.org_id,
    data: parsed.data.data,
  };
}

/**
 * Every check row-level security would have made, re-made here.
 *
 * The service role bypasses RLS entirely, so `application_read_own` and
 * `application_read_as_lender` do not run for this client. This function is
 * those two policies, and it must stay their mirror: a borrower sees their own
 * application, a lender sees the applications sent to their organisation, and
 * `admin` sees none -- `0002_rls.sql` deliberately gives admin no policy on any
 * table, on the grounds that an untested privilege is an assumption.
 *
 * A caller this returns false for is answered as though the row did not exist.
 * Distinguishing "forbidden" from "absent" hands out the existence of other
 * people's loan files, which is what the policies refuse to do.
 */
export function applicationReadableBy(subject: ApplicationSubject, actor: Actor): boolean {
  switch (actor.role) {
    case 'borrower':
      return subject.borrowerId === actor.id;
    case 'lender':
      return actor.orgId !== null && actor.orgId === subject.orgId;
    case 'admin':
      return false;
  }
}

/** The machine's events, narrowed from the string the request carried. */
export function asApplicationEvent(event: string): ApplicationEvent | null {
  return (APPLICATION_EVENTS as readonly string[]).includes(event)
    ? (event as ApplicationEvent)
    : null;
}

/**
 * `numeric` as PostgREST renders it, turned into minor units without a float
 * multiplication.
 *
 * PostgREST emits a numeric column as a bare JSON number, so `1234.56` has
 * already been through a double by the time it reaches this process. The
 * conversion @lj/domain warns about -- `Math.trunc(value * 100)` -- would lose
 * a cent on exactly the values nobody checks. Rendering the double back to its
 * shortest round-tripping decimal recovers the original digits exactly for
 * every value `numeric(14,2)` can hold (its widest is ~1e12, four orders below
 * the safe-integer limit at two decimal places), and @lj/domain's exact string
 * parser does the rest.
 */
function moneyFromPostgrestNumeric(value: number): Money | null {
  try {
    return moneyFromNumericString(String(value));
  } catch {
    return null;
  }
}

/**
 * The products this application is evaluated against.
 *
 * A product whose `criteria` do not parse is dropped rather than skipped
 * quietly into the "matches" column: `parseEligibilityCriteria` fails closed by
 * design, and dropping the product can only ever make the applicant less
 * eligible, never more.
 */
function eligibilityProducts(rows: readonly LoanProduct[]): EligibilityProduct[] {
  const products: EligibilityProduct[] = [];
  for (const row of rows) {
    const criteria = parseEligibilityCriteria(row.criteria);
    if (!criteria.ok) {
      continue;
    }
    products.push({
      id: row.id,
      name: row.name,
      minAmount: row.min_amount === null ? null : moneyFromPostgrestNumeric(row.min_amount),
      maxAmount: row.max_amount === null ? null : moneyFromPostgrestNumeric(row.max_amount),
      criteria: criteria.criteria,
    });
  }
  return products;
}

/**
 * One evaluation of one application: what the guards read, and what the
 * declared effects record.
 *
 * The two travel together because they must be the SAME evaluation. The
 * `write_eligibility_snapshot` effect stores what the borrower was told, and a
 * runner that re-evaluated after the guard had passed could store criteria the
 * applicant was never shown -- which is exactly the drift the snapshot exists
 * to rule out.
 */
export interface ApplicationEvaluation {
  readonly context: ApplicationGuardContext;
  /** Every active product this application was evaluated against, as evaluated. */
  readonly eligibility: readonly ProductEligibility[];
  /**
   * The payload, parsed once.
   *
   * Carried rather than re-parsed by whoever needs it next: an effect resolves
   * the product from `request.product_id`, and two parses of one row are two
   * chances to disagree about what it says.
   */
  readonly data: ApplicationData;
}

/**
 * The evaluated rule sets the application machine's guards read.
 *
 * A guard never evaluates a rule (see `packages/workflow/src/context.ts`); the
 * caller runs packages/rules and passes the results in, and this is that
 * caller. Each field of the context is one rule set, and an EMPTY field is a
 * refusal rather than a pass -- `requireRules` says the criteria have not been
 * evaluated and blocks, because reading "no criteria" as "no objections" would
 * let a forgotten evaluation open a transition.
 *
 * All three are now evaluated. `documentPack` reads the slots and the files
 * against them, and an application with NO slots therefore evaluates to an
 * empty set -- which requireRules reads as "not evaluated" and refuses. That is
 * the right answer rather than an accident: an application at `docs_pending`
 * with no checklist is one nothing asked for documents on, and there is nothing
 * for a lender to have reviewed.
 *
 * It is evaluated for every transition that needs an evaluation, including the
 * ones whose guards never look at it. Two indexed reads is not a reason to make
 * the caller decide which buckets a transition will want, and a bucket filled
 * only sometimes is a bucket somebody eventually forgets to fill.
 *
 * A PAYLOAD THAT DOES NOT PARSE REFUSES, and says so. It must not fall back to
 * an empty context: that reads to the applicant as four unanswered steps, when
 * the truth is a row nothing can describe. The two are different problems with
 * different remedies, and only one of them is the applicant's to fix. Refusing
 * is also the direction everything else here fails -- an unevaluated rule set,
 * an effect with no runner -- and it costs a corrupt application every
 * transition rather than only the guarded ones, because the context is built
 * before the machine is consulted. That is deliberate: `data` is written by the
 * borrower's own autosave and by nothing else, so the row that refuses to move
 * is repaired by the same path that broke it.
 */
export type ApplicationEvaluationResult =
  | { readonly ok: true; readonly evaluation: ApplicationEvaluation }
  | { readonly ok: false; readonly reason: string };

export async function evaluateApplication(
  client: DatabaseClient,
  subject: ApplicationSubject,
): Promise<ApplicationEvaluationResult> {
  const parsed = parseApplicationData(subject.data);
  if (!parsed.ok) {
    // The problems name paths inside the stored payload, not anything the
    // caller sent, so quoting them is a diagnosis rather than an echo of
    // untrusted input. Capped, because a wholly wrong shape produces one issue
    // per leaf and a response body is not a log.
    return {
      ok: false,
      reason:
        'the stored application data does not match the schema that describes it, so its ' +
        'criteria could not be evaluated: ' +
        parsed.problems.slice(0, 3).join('; '),
    };
  }

  const [productRows, documents] = await Promise.all([
    listActiveLoanProducts(client, subject.orgId),
    buildDocumentContext(client, subject.id),
  ]);

  const products = eligibilityProducts(productRows);
  const evaluated = evaluateEligibility(
    products,
    eligibilityContextFromApplication(parsed.data),
  );
  const eligibility: readonly RuleResult[] =
    products.length === 0 ? [] : [atLeastOneEligibleProduct(evaluated)];

  return {
    ok: true,
    evaluation: {
      context: {
        completeness: evaluateApplicationCompleteness(parsed.data),
        eligibility,
        documentPack: evaluateCompleteness(documents),
      },
      eligibility: evaluated,
      data: parsed.data,
    },
  };
}

/**
 * Whether this transition needs the rule sets evaluated at all.
 *
 * Read off the machine definition, which is the one statement of what each
 * transition needs: a guard is the only thing that reads the context, and a
 * declared effect is the only other thing that reads the evaluation beside it.
 * Nothing here restates which transitions those are (CLAUDE.md section 9).
 *
 * It exists because evaluating unconditionally made a corrupt payload a
 * LOCKOUT. `withdraw` declares no guard and no effect, so it never reads a rule
 * set -- but the context was built before the machine was consulted, so an
 * unparseable `data` refused it along with everything else. After a submit the
 * borrower can no longer write `data` at all (application_update_own_draft
 * permits an update only while the state is 'draft'), so a row stranded by a
 * schema change could be neither repaired nor abandoned by anyone, and needed a
 * hand-written UPDATE against the database. A borrower's way out of their own
 * application must not depend on rules that have nothing to say about it.
 *
 * Getting this wrong in the direction of `false` is safe: the caller then
 * passes UNEVALUATED_APPLICATION_CONTEXT, whose empty rule sets requireRules
 * reads as "not evaluated" and refuses. A mistake here can only ever refuse a
 * transition, never open one.
 */
export function applicationTransitionNeedsEvaluation(
  from: ApplicationState,
  event: ApplicationEvent,
): boolean {
  return applicationMachine.transitions.some(
    (transition) =>
      transition.event === event &&
      transition.from.includes(from) &&
      (transition.guard !== null || transition.effects.length > 0),
  );
}

/**
 * What a transition that needs no evaluation is adjudicated against.
 *
 * Empty rather than absent, because `apply` takes a context whether or not the
 * transition has a guard. Every field being empty is what makes it safe to hand
 * over: requireRules reads an empty rule set as "the caller did not evaluate
 * this" and refuses, so a guard reached with this in hand fails closed.
 */
export const UNEVALUATED_APPLICATION_CONTEXT: ApplicationGuardContext = {
  completeness: [],
  eligibility: [],
  documentPack: [],
};

export interface AdvanceRequest {
  readonly applicationId: string;
  readonly expectedRevision: number;
  readonly to: ApplicationState;
}

/**
 * The state change, guarded by the revision the caller believes it holds.
 *
 * Null means nothing matched, which is the interesting outcome: the revision
 * moved under the caller. Only `state` is patched -- `revision` and
 * `updated_at` are the helper's own bookkeeping, and no other column is this
 * endpoint's to write. `submitted_at` and `decided_at` in particular are left
 * alone: which events stamp them is a policy no machine declares, and putting
 * an `if (event === 'submit')` here would be exactly the business rule in a
 * route handler that CLAUDE.md section 8 forbids.
 */
export async function advanceApplication(
  client: DatabaseClient,
  request: AdvanceRequest,
): Promise<SubjectSnapshot | null> {
  const ack = await updateApplication(client, {
    applicationId: request.applicationId,
    expectedRevision: request.expectedRevision,
    patch: { state: request.to },
  });
  return ack === null ? null : { state: ack.state, revision: ack.revision };
}
