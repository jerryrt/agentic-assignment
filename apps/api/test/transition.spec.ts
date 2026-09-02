// The transition endpoint, probed against a real database.
//
// Every assertion below runs the exported handler exactly as the Vercel runtime
// does -- hand it a `Request`, inspect the `Response` -- against the local
// Supabase stack from `supabase start`. There is no mock in between, and that is
// deliberate: the properties under test are that a forged role is not honoured,
// that a stale revision loses without writing to an append-only log, and that
// the service role client re-makes every check row-level security would have
// made. A mock would agree with whatever this code believes, which is the one
// thing that must not be assumed.
//
// Keys are read from `supabase status -o json` at run time, following
// packages/db/test/rls.spec.ts, so no key value is ever written to a file in
// this repository.
//
// Fixtures are created by this run and torn down by it. The seeded demo rows
// are never touched: another agent may be reading them, and a suite that
// mutates shared demo data is a suite that fails for reasons that have nothing
// to do with the code.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createAnonClient,
  listEligibilitySnapshots,
  listWorkflowEvents,
  type EligibilitySnapshot,
  type Json,
} from '@lj/db';
import { createServiceRoleClient, type ServiceRoleClient } from '@lj/db/service-role';
import { RuleResultSchema, type RuleResult } from '@lj/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runEffects } from '../lib/effects.ts';
import { POST } from '../src/routes/transition.ts';

const TRANSITION_URL = 'https://lj-api.example/api/transition';

// `supabase status` resolves supabase/config.toml relative to its working
// directory, and vitest runs with the package directory as cwd.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface LocalStack {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`supabase status did not report ${key}; is the local stack running?`);
  }
  return value;
}

function readLocalStack(): LocalStack {
  const raw = execFileSync('supabase', ['status', '-o', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const start = raw.indexOf('{');
  if (start < 0) {
    throw new Error('supabase status printed no JSON; is the local stack running?');
  }
  const parsed: unknown = JSON.parse(raw.slice(start));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('supabase status printed JSON that is not an object');
  }
  return {
    url: requiredString(parsed as Record<string, unknown>, 'API_URL'),
    anonKey: requiredString(parsed as Record<string, unknown>, 'ANON_KEY'),
    serviceRoleKey: requiredString(parsed as Record<string, unknown>, 'SERVICE_ROLE_KEY'),
  };
}

// Calling the handler ------------------------------------------------------

interface Answer {
  readonly status: number;
  readonly payload: Record<string, unknown>;
  readonly raw: string;
}

async function post(token: string | null, body: unknown): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const response = await POST(
    new Request(TRANSITION_URL, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  const raw = await response.text();
  const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
  return {
    status: response.status,
    payload: (parsed ?? {}) as Record<string, unknown>,
    raw,
  };
}

function blockersOf(answer: Answer): unknown[] {
  const blockers = answer.payload['blockers'];
  return Array.isArray(blockers) ? blockers : [];
}

/** The blockers as the type that owns them, so a case can read `missing`. */
function ruleResults(answer: Answer): RuleResult[] {
  return blockersOf(answer).map((blocker) => RuleResultSchema.parse(blocker));
}

function currentOf(answer: Answer): Record<string, unknown> {
  const current = answer.payload['current'];
  return typeof current === 'object' && current !== null
    ? (current as Record<string, unknown>)
    : {};
}

// Fixtures -----------------------------------------------------------------

let stack: LocalStack;
let service: ServiceRoleClient;

interface TestUser {
  readonly id: string;
  readonly token: string;
}

async function signUpUser(label: string): Promise<TestUser> {
  const email = `api-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `probe-${Math.random().toString(36).slice(2)}-Aa1!`;
  const client = createAnonClient({ url: stack.url, anonKey: stack.anonKey });
  const { data, error } = await client.auth.signUp({ email, password });
  if (error !== null) {
    throw new Error(`signup failed for ${label}: ${error.message}`);
  }
  const token = data.session?.access_token;
  if (data.user === null || token === undefined) {
    throw new Error(
      `signup for ${label} returned no session; auth.email.enable_confirmations must be off`,
    );
  }
  return { id: data.user.id, token };
}

async function insertOrganisation(name: string): Promise<string> {
  const { data, error } = await service
    .from('organisation')
    .insert({ name })
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture organisation failed: ${error?.message ?? 'no row'}`);
  }
  return data.id;
}

async function promoteToLender(user: TestUser, orgId: string): Promise<void> {
  const { error } = await service
    .from('profile')
    .update({ role: 'lender', org_id: orgId })
    .eq('id', user.id);
  if (error !== null) {
    throw new Error(`could not promote ${user.id}: ${error.message}`);
  }
}

async function insertApplication(values: {
  borrowerId: string;
  orgId: string;
  state: string;
  revision: number;
  /** The form payload. Empty unless the case is about what the form said. */
  data?: Json;
}): Promise<string> {
  const { data, error } = await service
    .from('application')
    .insert({
      borrower_id: values.borrowerId,
      org_id: values.orgId,
      state: values.state,
      revision: values.revision,
      data: values.data ?? {},
    })
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture application failed: ${error?.message ?? 'no row'}`);
  }
  return data.id;
}

/**
 * The pack this product asks for, and the four ways a slot can stand.
 *
 * Modelled on the Equipment Term Loan in 0004_demo_data.sql. The four codes are
 * chosen so one pack can express every failure the completeness rules
 * distinguish -- missing, stale, unreadable -- alongside a slot that is simply
 * finished, because the borrower's next action differs in each case and a test
 * that only proved "not complete" would not prove the difference.
 */
const PROBE_PACK: Json = {
  version: 1,
  slots: [
    {
      code: 'land_title',
      label: 'Land title or lease',
      required: true,
      extract_required: ['total_acres', 'owner_name'],
    },
    {
      code: 'crop_insurance',
      label: 'Crop insurance certificate',
      required: true,
      extract_required: ['valid_until'],
    },
    {
      code: 'tax_return_2024',
      label: '2024 tax return',
      required: true,
      extract_required: ['net_farm_income'],
    },
    { code: 'id_verification', label: 'Photo identification', required: true },
  ],
};

/**
 * A product the complete payload below actually qualifies for.
 *
 * Modelled on the Equipment Term Loan in 0004_demo_data.sql rather than
 * invented: the submit guard requires at least one eligible product, so a
 * fixture whose criteria nothing could meet would make every submit refuse for
 * a reason that has nothing to do with what is under test.
 */
async function insertLoanProduct(orgId: string): Promise<string> {
  const { data, error } = await service
    .from('loan_product')
    .insert({
      org_id: orgId,
      name: PRODUCT_NAME,
      min_amount: 10_000.0,
      max_amount: 250_000.0,
      criteria: {
        version: 1,
        rules: [
          {
            id: 'dscr_floor',
            label: 'Debt service coverage',
            kind: 'min',
            field: 'dscr',
            threshold: 11_500,
            severity: 'error',
          },
          {
            id: 'max_ltv',
            label: 'Loan to value',
            kind: 'max',
            field: 'ltv',
            threshold: 8_000,
            severity: 'error',
          },
          {
            id: 'in_footprint',
            label: 'Operating region',
            kind: 'one_of',
            field: 'province',
            allowed: ['AB', 'SK', 'MB'],
            severity: 'error',
          },
        ],
      },
      required_docs: PROBE_PACK,
      active: true,
    })
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture loan_product failed: ${error?.message ?? 'no row'}`);
  }
  return data.id;
}

/**
 * A product whose document pack cannot be read.
 *
 * An empty `slots` array is refused by parseRequiredDocs rather than read as
 * "this product asks for nothing", because a product whose pack is complete
 * before anybody uploads anything is a policy nobody has stated. Named to sort
 * after PRODUCT_NAME so that the eligibility evaluation, which orders by name,
 * still reports the probe product first.
 */
async function insertUnreadablePackProduct(orgId: string): Promise<string> {
  const { data, error } = await service
    .from('loan_product')
    .insert({
      org_id: orgId,
      name: UNREADABLE_PACK_PRODUCT_NAME,
      min_amount: 10_000.0,
      max_amount: 250_000.0,
      criteria: { version: 1, rules: [] },
      required_docs: { version: 1, slots: [] },
      active: true,
    })
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture loan_product failed: ${error?.message ?? 'no row'}`);
  }
  return data.id;
}

/** The pack one application actually holds, in the order it is rendered. */
async function readSlots(applicationId: string): Promise<
  { code: string; label: string; required: boolean; state: string; extract_required: string[] }[]
> {
  const { data, error } = await service
    .from('document_slot')
    .select('code, label, required, state, extract_required')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true })
    .order('code', { ascending: true });
  if (error !== null || data === null) {
    throw new Error(`could not read slots of ${applicationId}: ${error?.message ?? 'no rows'}`);
  }
  return data;
}

async function readApplication(
  id: string,
): Promise<{ state: string; revision: number }> {
  const { data, error } = await service
    .from('application')
    .select('state, revision')
    .eq('id', id)
    .single();
  if (error !== null || data === null) {
    throw new Error(`could not read application ${id}: ${error?.message ?? 'no row'}`);
  }
  return { state: data.state, revision: data.revision };
}

async function readSubmittedAt(id: string): Promise<string | null> {
  const { data, error } = await service
    .from('application')
    .select('submitted_at')
    .eq('id', id)
    .single();
  if (error !== null || data === null) {
    throw new Error(`could not read application ${id}: ${error?.message ?? 'no row'}`);
  }
  return data.submitted_at;
}

async function eventCount(subjectId: string): Promise<number> {
  return (await listWorkflowEvents(service, 'application', subjectId)).length;
}

async function snapshotsOf(applicationId: string): Promise<readonly EligibilitySnapshot[]> {
  return await listEligibilitySnapshots(service, applicationId);
}

let borrower: TestUser;
let otherBorrower: TestUser;
let lender: TestUser;
let foreignLender: TestUser;

let orgAlpha: string;
let orgBeta: string;

/** submitted, org alpha. The legal-transition case; this one is mutated. */
let appForSuccess: string;
/** submitted, org alpha. The stale-revision case. */
let appForConflict: string;
/** submitted, org alpha. Every refusal that must leave the log untouched. */
let appForRefusals: string;
/** draft, org alpha. The guard-refusal case. */
let appDraft: string;
/** approved, org alpha. The declared-effect case. */
let appApproved: string;
/** submitted, org beta, another borrower. The tenant boundary. */
let appForeign: string;
/** draft, org alpha, every step answered. The submit that must succeed. */
let appComplete: string;
/** draft, org alpha, complete, submitted at a revision that has moved on. */
let appStale: string;
/** draft, org alpha, carrying a payload no schema describes. */
let appCorrupt: string;
let appCorruptToWithdraw: string;

/** submitted, org alpha. The pack generation case; this one is mutated. */
let appForPack: string;
/** submitted, org alpha, naming a product whose document pack does not parse. */
let appUnreadablePack: string;

let productAlpha: string;
let productUnreadablePack: string;

const SUBMITTED_REVISION = 3;

const PRODUCT_NAME = 'Api Probe Equipment Term Loan';
const UNREADABLE_PACK_PRODUCT_NAME = 'Zz Api Probe Unreadable Pack';

/**
 * A payload with every required field answered, on every step, for one product.
 *
 * Copied from the shape packages/domain declares rather than invented, and
 * chosen so the figures clear the product above: coverage is 1.597 against a
 * floor of 1.25, loan-to-value is 76% against a cap of 80%, and Alberta is in
 * the footprint. The point of the case is a submit that succeeds, so every
 * criterion has to pass for a reason that is legible here.
 */
function completePayload(productId: string): Json {
  return {
  borrower: {
    entity_type: 'sole_trader',
    legal_name: 'Beau Marchand',
    years_farming: 2,
    province: 'AB',
    postal_code: 'T1J 4B4',
    contact_email: 'grower@example.test',
    contact_phone: '403-555-0119',
  },
  farm: {
    primary_commodity: 'mixed',
    irrigation: 'none',
    has_crop_insurance: true,
    parcels: [
      { legal_description: 'SW-08-09-22-W4', acres: 310, tenure: 'owned', commodity: 'mixed' },
    ],
  },
  financials: {
    statements_basis: 'accrual',
    gross_revenue_minor: 41_000_000,
    operating_expenses_minor: 29_500_000,
    existing_debt_service_minor: 7_200_000,
    current_assets_minor: 18_000_000,
    current_liabilities_minor: 9_500_000,
  },
  request: {
    // The product is a fixture id rather than a constant, because
    // `request_docs` now reads the pack off the product this names. A payload
    // pointing at a product that does not exist would refuse the transition
    // for a reason that has nothing to do with what each case is about.
    product_id: productId,
    amount_requested_minor: 9_500_000,
    term_months: 60,
    purpose: 'Replace a 1998 combine ahead of harvest',
    collateral_value_minor: 12_500_000,
  },
  };
}

/**
 * A payload the schema rejects outright.
 *
 * `borrower` is a string where a section belongs, which no amount of leniency
 * turns into "not answered yet". A client cannot write this through the
 * autosave path by accident, which is exactly why it has to be tested: the row
 * it describes is corrupt, and the honest answer is to say so rather than to
 * render a corrupt row as an unfinished form.
 */
const CORRUPT_PAYLOAD: Json = {
  borrower: 'Fenwick Grain Co.',
  farm: { parcels: 'two quarters' },
};

beforeAll(async () => {
  stack = readLocalStack();

  // The handler reads its configuration from the environment at request time,
  // exactly as the serverless runtime supplies it. Set here rather than stubbed
  // so that `vi.unstubAllEnvs` in the pre-flight block below restores these.
  process.env['SUPABASE_URL'] = stack.url;
  process.env['SUPABASE_ANON_KEY'] = stack.anonKey;
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = stack.serviceRoleKey;

  service = createServiceRoleClient({
    url: stack.url,
    serviceRoleKey: stack.serviceRoleKey,
  });

  [borrower, otherBorrower, lender, foreignLender] = await Promise.all([
    signUpUser('borrower'),
    signUpUser('other-borrower'),
    signUpUser('lender'),
    signUpUser('foreign-lender'),
  ]);

  orgAlpha = await insertOrganisation('Api Probe Alpha');
  orgBeta = await insertOrganisation('Api Probe Beta');

  await Promise.all([
    promoteToLender(lender, orgAlpha),
    promoteToLender(foreignLender, orgBeta),
  ]);

  [productAlpha, productUnreadablePack] = await Promise.all([
    insertLoanProduct(orgAlpha),
    insertUnreadablePackProduct(orgAlpha),
  ]);

  [
    appForSuccess,
    appForConflict,
    appForRefusals,
    appDraft,
    appApproved,
    appForeign,
    appComplete,
    appStale,
    appCorrupt,
    appCorruptToWithdraw,
    appUnreadablePack,
    appForPack,
  ] = await Promise.all([
      // Every application that reaches `submitted` carries the payload that
      // took it there: `request_docs` reads the pack off the product the
      // payload names, so a submitted row with an empty payload is one no
      // borrower could have produced.
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'draft',
        revision: 0,
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'approved',
        revision: 2,
      }),
      insertApplication({
        borrowerId: otherBorrower.id,
        orgId: orgBeta,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'draft',
        revision: 0,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'draft',
        revision: 2,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'draft',
        revision: 0,
        data: CORRUPT_PAYLOAD,
      }),
      // A second corrupt row, so the case that MOVES one does not depend on
      // running after the case that only reads one.
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'draft',
        revision: 0,
        data: CORRUPT_PAYLOAD,
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
        data: completePayload(productUnreadablePack),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
        data: completePayload(productAlpha),
      }),
    ]);
}, 60_000);

afterAll(async () => {
  if (service === undefined) {
    return;
  }
  // Only as far as the schema allows. 0002_rls.sql revokes DELETE on
  // workflow_event from service_role too, so the events this run appended
  // survive it -- that is the append-only property working, and it is why the
  // suite never asserts on a global event count. `supabase db reset` is the
  // reset button for the local stack.
  // eligibility_snapshot rows go with their applications, by the cascade in
  // 0005_application_submit.sql. That migration withholds DELETE from
  // service_role as well, so the cascade is the only route -- a referential
  // action runs as the owner of the referencing table rather than as the
  // deleting role.
  await service
    .from('application')
    .delete()
    .in('id', [
      appForSuccess,
      appForConflict,
      appForRefusals,
      appDraft,
      appApproved,
      appForeign,
      appComplete,
      appStale,
      appCorrupt,
      appCorruptToWithdraw,
      appUnreadablePack,
      appForPack,
    ]);
  // document_slot and document_upload rows go with their application, by the
  // cascades in 0006_documents.sql.
  await service.from('loan_product').delete().in('id', [productAlpha, productUnreadablePack]);
  await service
    .from('profile')
    .update({ org_id: null })
    .in('id', [lender.id, foreignLender.id]);
  await service.from('organisation').delete().in('id', [orgAlpha, orgBeta]);
}, 60_000);

// Assertions ---------------------------------------------------------------

describe('the request is refused before the database is reached', () => {
  // The environment is blanked for every case here. @lj/db treats a blank
  // variable as absent and throws at client construction, so a 400 rather than
  // a 500 is proof that no client was ever built -- which is what "rejected
  // without touching the database" has to mean to be worth claiming.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function withNoConfiguration(): void {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_ANON_KEY', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  }

  it('rejects a body that is not JSON', async () => {
    withNoConfiguration();

    const answer = await post('irrelevant', 'not json at all');

    expect(answer.status).toBe(400);
    expect(answer.payload['code']).toBe('invalid_request');
  });

  it('rejects a machine no definition declares', async () => {
    withNoConfiguration();

    const answer = await post('irrelevant', {
      machine: 'loan',
      subjectId: '00000000-0000-4000-8000-0000000000d1',
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(400);
    expect(answer.payload['code']).toBe('invalid_request');
  });

  it('rejects an event the named machine does not declare', async () => {
    withNoConfiguration();

    const answer = await post('irrelevant', {
      machine: 'application',
      subjectId: '00000000-0000-4000-8000-0000000000d1',
      event: 'disburse',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(400);
    expect(String(answer.payload['reason'])).toContain('disburse');
  });

  it('rejects a subject id that is not a uuid', async () => {
    withNoConfiguration();

    const answer = await post('irrelevant', {
      machine: 'application',
      subjectId: '../../etc/passwd',
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(400);
  });
});

describe('authentication', () => {
  const body = () => ({
    machine: 'application',
    subjectId: appForRefusals,
    event: 'request_docs',
    expectedRevision: SUBMITTED_REVISION,
  });

  it('refuses a request carrying no bearer token', async () => {
    const answer = await post(null, body());

    expect(answer.status).toBe(401);
    expect(answer.payload['code']).toBe('unauthenticated');
  });

  it('refuses a bearer token the auth server does not recognise', async () => {
    const answer = await post('not.a.token', body());

    expect(answer.status).toBe(401);
    expect(answer.payload['code']).toBe('unauthenticated');
  });

  it('never echoes the token it was given', async () => {
    const answer = await post('sentinel-bearer-token', body());

    expect(answer.raw).not.toContain('sentinel');
  });
});

describe('authorisation is decided on the server', () => {
  it('hides an application belonging to another borrower', async () => {
    const before = await eventCount(appForeign);

    const answer = await post(borrower.token, {
      machine: 'application',
      subjectId: appForeign,
      event: 'withdraw',
      expectedRevision: SUBMITTED_REVISION,
    });

    // 404 and not 403: row-level security would have returned no row, and an
    // API that distinguishes "exists but forbidden" from "does not exist"
    // hands out the existence of other people's loan files.
    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
    expect(await eventCount(appForeign)).toBe(before);
  });

  it('hides an application at another organisation from a lender', async () => {
    const answer = await post(foreignLender.token, {
      machine: 'application',
      subjectId: appForRefusals,
      event: 'request_docs',
      expectedRevision: SUBMITTED_REVISION,
    });

    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
  });

  it('refuses an event the actor\'s role may not fire', async () => {
    const before = await eventCount(appForRefusals);

    // The lender can see this application; `request_docs` is legal from
    // `submitted`; but `withdraw` belongs to the borrower alone.
    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appForRefusals,
      event: 'withdraw',
      expectedRevision: SUBMITTED_REVISION,
    });

    expect(answer.status).toBe(403);
    expect(answer.payload['code']).toBe('role_not_permitted');
    expect(blockersOf(answer)).toEqual([]);
    expect(await eventCount(appForRefusals)).toBe(before);
  });

  /**
   * The forged-role case, stated twice from both sides so that a handler which
   * happened to read the body would fail one of them whichever way it leaned.
   */
  it('ignores a role in the body in favour of the profile', async () => {
    const before = await eventCount(appForRefusals);

    const answer = await post(borrower.token, {
      machine: 'application',
      subjectId: appForRefusals,
      event: 'request_docs',
      expectedRevision: SUBMITTED_REVISION,
      role: 'lender',
      actorRole: 'lender',
      actorId: lender.id,
    });

    expect(answer.status).toBe(403);
    expect(answer.payload['code']).toBe('role_not_permitted');
    expect(String(answer.payload['reason'])).toContain('borrower');
    expect(await eventCount(appForRefusals)).toBe(before);
  });

  it('honours the profile even when the body claims a lesser role', async () => {
    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appForRefusals,
      event: 'request_docs',
      expectedRevision: SUBMITTED_REVISION + 999,
      role: 'borrower',
    });

    // The revision is deliberately impossible, so this stops at the conflict
    // rather than mutating the refusal fixture. Reaching the conflict at all
    // proves the lender's own role was used.
    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('revision_conflict');
  });
});

describe('a guard refusal', () => {
  it('answers 422 with blockers that survive serialisation', async () => {
    const before = await eventCount(appDraft);

    const answer = await post(borrower.token, {
      machine: 'application',
      subjectId: appDraft,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('guard_refused');
    expect(typeof answer.payload['reason']).toBe('string');

    // Every blocker is a RuleResult, verified against the schema that owns the
    // type, after a JSON round trip. That is the whole point of the shared
    // vocabulary: the browser renders these through the same component as an
    // unmet eligibility criterion, and an optional property lost in transit
    // would come back as a different object.
    for (const blocker of blockersOf(answer)) {
      expect(RuleResultSchema.safeParse(blocker).success).toBe(true);
    }

    expect(await eventCount(appDraft)).toBe(before);
    expect((await readApplication(appDraft)).state).toBe('draft');
  });
});

describe('optimistic concurrency', () => {
  it('answers 409 with the current state and writes no event', async () => {
    const before = await eventCount(appForConflict);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appForConflict,
      event: 'request_docs',
      expectedRevision: SUBMITTED_REVISION - 1,
    });

    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('revision_conflict');
    expect(currentOf(answer)).toMatchObject({
      state: 'submitted',
      revision: SUBMITTED_REVISION,
    });

    expect(await eventCount(appForConflict)).toBe(before);
    expect(await readApplication(appForConflict)).toEqual({
      state: 'submitted',
      revision: SUBMITTED_REVISION,
    });
  });

  it('lets the second of two identical transitions lose cleanly', async () => {
    const [first, second] = await Promise.all([
      post(lender.token, {
        machine: 'application',
        subjectId: appForConflict,
        event: 'request_docs',
        expectedRevision: SUBMITTED_REVISION,
      }),
      post(lender.token, {
        machine: 'application',
        subjectId: appForConflict,
        event: 'request_docs',
        expectedRevision: SUBMITTED_REVISION,
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly one of the two wrote, so exactly one event exists for the move.
    expect(await eventCount(appForConflict)).toBe(1);
    expect(await readApplication(appForConflict)).toEqual({
      state: 'docs_pending',
      revision: SUBMITTED_REVISION + 1,
    });
  });
});

describe('a legal transition', () => {
  it('advances the subject, appends one event, and reports both', async () => {
    const before = await eventCount(appForSuccess);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appForSuccess,
      event: 'request_docs',
      expectedRevision: SUBMITTED_REVISION,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({
      ok: true,
      machine: 'application',
      subjectId: appForSuccess,
      event: 'request_docs',
      from: 'submitted',
      to: 'docs_pending',
      revision: SUBMITTED_REVISION + 1,
      actorRole: 'lender',
    });

    expect(await readApplication(appForSuccess)).toEqual({
      state: 'docs_pending',
      revision: SUBMITTED_REVISION + 1,
    });
    expect(await eventCount(appForSuccess)).toBe(before + 1);

    // The subject's history comes back with the answer, because the timeline
    // is what the caller renders next and a second round trip to fetch it
    // would show the borrower a state the log did not yet explain.
    const events = answer.payload['events'];
    expect(Array.isArray(events)).toBe(true);
    expect((events as unknown[]).at(-1)).toMatchObject({
      to_state: 'docs_pending',
      event: 'request_docs',
    });
  });

  it('records who acted and in what capacity', async () => {
    const events = await listWorkflowEvents(service, 'application', appForSuccess);
    const latest = events.at(-1);

    expect(latest).toMatchObject({
      machine: 'application',
      subject_id: appForSuccess,
      from_state: 'submitted',
      to_state: 'docs_pending',
      event: 'request_docs',
      actor_id: lender.id,
      actor_role: 'lender',
    });
  });

  /**
   * An unevaluated rule set is a refusal, not a pass (see the handoff on #9).
   * `document_slot` has no table yet, so nothing can evaluate the document
   * pack, and `begin_review` must therefore refuse -- with a reason that says
   * the criteria were not evaluated rather than that they were not met.
   */
  it('refuses a guarded transition whose criteria nothing has evaluated', async () => {
    const before = await eventCount(appForSuccess);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appForSuccess,
      event: 'begin_review',
      expectedRevision: SUBMITTED_REVISION + 1,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('guard_refused');
    expect(String(answer.payload['reason'])).toContain('not been evaluated');
    expect(await eventCount(appForSuccess)).toBe(before);
    expect((await readApplication(appForSuccess)).state).toBe('docs_pending');
  });
});

// Asking for documents is what brings the checklist into being, so the pack is
// asserted against the product rather than against a fixed list: the whole
// point of generating it is that an equipment loan and an operating line ask
// for different things.
describe('requesting documents generates the pack', () => {
  it('creates exactly the slots the product asks for', async () => {
    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appForPack,
      event: 'request_docs',
      expectedRevision: SUBMITTED_REVISION,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({
      to: 'docs_pending',
      effects: ['create_document_slots'],
    });

    const slots = await readSlots(appForPack);
    expect(slots.map((slot) => slot.code).sort()).toEqual([
      'crop_insurance',
      'id_verification',
      'land_title',
      'tax_return_2024',
    ]);
    // Every slot starts where the machine starts, and carries the terms it was
    // created under: `extract_required` is copied onto the row rather than read
    // back through the product, so editing the product later cannot change what
    // an already generated slot is judged against.
    expect(slots.every((slot) => slot.state === 'required')).toBe(true);
    expect(slots.every((slot) => slot.required)).toBe(true);
    expect(slots.find((slot) => slot.code === 'land_title')?.extract_required).toEqual([
      'total_acres',
      'owner_name',
    ]);
    expect(slots.find((slot) => slot.code === 'id_verification')?.extract_required).toEqual([]);
    expect(slots.find((slot) => slot.code === 'crop_insurance')?.label).toBe(
      'Crop insurance certificate',
    );
  });

  /**
   * Generating twice must not double the checklist.
   *
   * Asserted on the runner rather than through the endpoint because the machine
   * has no second `request_docs` to fire -- the application has moved on -- and
   * the race this guards against is two runs of the effect, not two legal
   * transitions. The unique constraint on (application_id, code) is what makes
   * it safe; a check-then-insert would be the race.
   */
  it('adds nothing when the effect runs a second time', async () => {
    const before = await readSlots(appForPack);
    expect(before.length).toBe(4);

    const outcome = await runEffects(service, [{ kind: 'create_document_slots' }], {
      applicationId: appForPack,
      revision: SUBMITTED_REVISION + 1,
      eligibility: [],
      requiredDocs: [
        {
          code: 'land_title',
          label: 'Land title or lease',
          required: true,
          extractRequired: ['total_acres', 'owner_name'],
        },
      ],
    });

    expect(outcome.ok).toBe(true);
    expect((await readSlots(appForPack)).length).toBe(4);
  });

  /**
   * A pack that does not parse refuses the transition whole.
   *
   * The alternative -- generating the slots that did parse -- is worse than
   * refusing, because a checklist one document short reports COMPLETE once its
   * slots are accepted, and nobody notices until a file reaches a lender
   * without its land title. parseRequiredDocs fails closed for that reason and
   * this is what failing closed has to look like from outside.
   */
  it('refuses when the product pack cannot be read, and generates nothing', async () => {
    const before = await eventCount(appUnreadablePack);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appUnreadablePack,
      event: 'request_docs',
      expectedRevision: SUBMITTED_REVISION,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('effect_input_invalid');
    expect(String(answer.payload['reason'])).toContain(UNREADABLE_PACK_PRODUCT_NAME);

    expect(await readSlots(appUnreadablePack)).toEqual([]);
    expect(await eventCount(appUnreadablePack)).toBe(before);
    expect(await readApplication(appUnreadablePack)).toEqual({
      state: 'submitted',
      revision: SUBMITTED_REVISION,
    });
  });
});

// Submitting is the one transition that reads the form, stamps a timestamp and
// records what the applicant was told, so it is the one with three ways to be
// half done. Every case below asserts on the database afterwards rather than on
// the response alone: the response is this code's own account of what it did.
describe('submitting an application', () => {
  it('refuses an incomplete draft and names the missing fields by path', async () => {
    const answer = await post(borrower.token, {
      machine: 'application',
      subjectId: appDraft,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('guard_refused');
    expect(String(answer.payload['reason'])).toContain('not complete');

    // One blocker per step, in step order, and each one carries PATHS rather
    // than bare field names -- unambiguous in a 422 body, and what a form
    // focuses. A step is never 'fail': an applicant who has answered nothing
    // has answered nothing wrong.
    const steps = ruleResults(answer).filter((result) => result.id.startsWith('step_'));
    expect(steps.map((result) => result.id)).toEqual([
      'step_borrower',
      'step_farm',
      'step_financials',
      'step_request',
    ]);
    expect(steps.every((result) => result.status === 'unknown')).toBe(true);
    expect(steps[0]?.missing).toContain('borrower.legal_name');
    expect(steps[3]?.missing).toContain('request.amount_requested_minor');

    expect(await snapshotsOf(appDraft)).toEqual([]);
    expect((await readApplication(appDraft)).state).toBe('draft');
  });

  it('advances a complete, eligible draft and records what it was told', async () => {
    const before = await eventCount(appComplete);

    const answer = await post(borrower.token, {
      machine: 'application',
      subjectId: appComplete,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({
      ok: true,
      from: 'draft',
      to: 'submitted',
      revision: 1,
      effects: ['write_eligibility_snapshot'],
    });

    expect(await readApplication(appComplete)).toEqual({ state: 'submitted', revision: 1 });
    expect(await eventCount(appComplete)).toBe(before + 1);

    // Stamped by the database, not by the handler: `advanceApplication` patches
    // `state` and nothing else, so a timestamp here can only have come from the
    // trigger.
    expect(await readSubmittedAt(appComplete)).not.toBeNull();

    const rows = await snapshotsOf(appComplete);
    expect(rows.length).toBe(1);
    expect(rows[0]?.revision).toBe(1);

    // The snapshot has been through jsonb and back, which is the round trip
    // RuleResult was shaped to survive. Parsing the stored results with the
    // schema that owns the type is what proves it did: an optional property
    // lost in transit would come back as a different object.
    const stored = rows[0]?.eligibility;
    expect(Array.isArray(stored)).toBe(true);
    const evaluated = (stored as { productName: string; results: unknown[] }[])[0];
    expect(evaluated?.productName).toBe(PRODUCT_NAME);
    for (const result of evaluated?.results ?? []) {
      expect(RuleResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it('does not restamp submitted_at when the application moves on', async () => {
    // When the lender received the file is not a fact about the last thing that
    // happened to it, and the trigger fires on every update.
    const stamped = await readSubmittedAt(appComplete);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appComplete,
      event: 'request_docs',
      expectedRevision: 1,
    });

    expect(answer.status).toBe(200);
    expect(await readSubmittedAt(appComplete)).toBe(stamped);
    // And no second snapshot: only `submit` declares the effect.
    expect((await snapshotsOf(appComplete)).length).toBe(1);
  });

  it('writes no snapshot when the revision moved under the caller', async () => {
    // The guard passes -- this payload is the complete one -- so the refusal
    // comes from the revision-matched UPDATE, which is the only serialisation
    // point there is. The effect runs after that update for exactly this
    // reason: a snapshot written first would record a submission that never
    // happened.
    const answer = await post(borrower.token, {
      machine: 'application',
      subjectId: appStale,
      event: 'submit',
      expectedRevision: 1,
    });

    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('revision_conflict');
    expect(await snapshotsOf(appStale)).toEqual([]);
    expect(await eventCount(appStale)).toBe(0);
    expect(await readApplication(appStale)).toEqual({ state: 'draft', revision: 2 });
    expect(await readSubmittedAt(appStale)).toBeNull();
  });

  it('refuses a payload no schema describes, rather than reading it as unfinished', async () => {
    const answer = await post(borrower.token, {
      machine: 'application',
      subjectId: appCorrupt,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('guard_refused');
    expect(String(answer.payload['reason'])).toContain('schema');

    // No blockers, because there are no criteria to show: the rule sets could
    // not be evaluated at all. Degrading to an empty context instead would have
    // rendered four "not answered yet" rows, which tells the applicant their
    // form is unfinished when the truth is that their row is corrupt.
    expect(blockersOf(answer)).toEqual([]);
    expect(await snapshotsOf(appCorrupt)).toEqual([]);
    expect((await readApplication(appCorrupt)).state).toBe('draft');
  });

  // A corrupt payload must not trap the application.
  //
  // `withdraw` declares no guard and no effect, so it never reads a rule set
  // and there is nothing for an unparseable payload to prevent. Refusing it
  // anyway was a lockout with no way out: after a submit the borrower can no
  // longer write `data` at all -- application_update_own_draft permits an
  // update only while the state is 'draft' -- so a row stranded by a schema
  // change could be neither repaired nor abandoned by anyone, and needed a
  // hand-written UPDATE against the database.
  it('still lets the borrower walk away from an application it cannot read', async () => {
    const answer = await post(borrower.token, {
      machine: 'application',
      subjectId: appCorruptToWithdraw,
      event: 'withdraw',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({ from: 'draft', to: 'withdrawn' });
    expect(await readApplication(appCorruptToWithdraw)).toEqual({
      state: 'withdrawn',
      revision: 1,
    });
    expect(await eventCount(appCorruptToWithdraw)).toBe(1);

    // Nothing was evaluated, so nothing was recorded as having been evaluated.
    expect(await snapshotsOf(appCorruptToWithdraw)).toEqual([]);
  });
});

describe('a declared effect nothing can carry out', () => {
  it('refuses before writing anything, rather than funding without a loan', async () => {
    const before = await eventCount(appApproved);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appApproved,
      event: 'fund',
      expectedRevision: 2,
    });

    expect(answer.status).toBe(501);
    expect(answer.payload['code']).toBe('effect_not_implemented');
    expect(String(answer.payload['reason'])).toContain('create_loan');

    expect(await eventCount(appApproved)).toBe(before);
    expect(await readApplication(appApproved)).toEqual({ state: 'approved', revision: 2 });
  });
});

describe('a machine with no subject store', () => {
  it('says so rather than pretending the subject is absent', async () => {
    const answer = await post(borrower.token, {
      machine: 'credit_release',
      subjectId: appForRefusals,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(501);
    expect(answer.payload['code']).toBe('machine_not_persisted');
  });
});
