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
  type ApplicationState,
  type JsonValue,
  type Money,
  type RuleResult,
} from '@lj/domain';
import {
  atLeastOneEligibleProduct,
  evaluateEligibility,
  parseEligibilityCriteria,
  type EligibilityProduct,
  type ProductEligibility,
} from '@lj/rules';
import {
  APPLICATION_EVENTS,
  type ApplicationEvent,
  type ApplicationGuardContext,
} from '@lj/workflow';

import { eligibilityContextFrom } from './application-data.ts';
import type { Actor } from './actor.ts';
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
 * Two of the three are empty today, and both are waiting on work this scope
 * does not own:
 *
 *   completeness  Whether the multi-step form is finished. The form and its
 *                 payload schema are Phase 5 (`feature-apply`); packages/rules
 *                 has no rule set for it and packages/domain has no
 *                 ApplicationDataSchema to write one against. Inventing one
 *                 here would put a business rule in the delivery layer and
 *                 create the second definition that Phase 5 would then have to
 *                 disagree with.
 *   documentPack  Whether every required document is accepted and current.
 *                 packages/rules HAS this rule set -- evaluateCompleteness --
 *                 but `document_slot` has no table (Phase 6), so there are no
 *                 slots to evaluate.
 *
 * The consequence is visible and correct: `submit` and `begin_review` refuse
 * with 422 and say the criteria have not been evaluated. Wiring each bucket is
 * one call in this function once its producer exists.
 */
export async function evaluateApplication(
  client: DatabaseClient,
  subject: ApplicationSubject,
): Promise<ApplicationEvaluation> {
  const products = eligibilityProducts(await listActiveLoanProducts(client, subject.orgId));
  const evaluated = evaluateEligibility(products, eligibilityContextFrom(subject.data));
  const eligibility: readonly RuleResult[] =
    products.length === 0 ? [] : [atLeastOneEligibleProduct(evaluated)];

  return {
    context: { completeness: [], eligibility, documentPack: [] },
    eligibility: evaluated,
  };
}

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
