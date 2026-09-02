// Row-level security probe.
//
// These are not unit tests.  Every assertion below is an HTTP request to the
// local Supabase stack, made with a real end-user JWT, because that is the only
// thing a policy actually has to survive.  A policy nobody probed is an
// assumption, and an assumption about the security boundary is a hole.
//
// The suite runs against `supabase start`; the keys are read from
// `supabase status -o json` at run time so that no key value is ever written to
// a file in this repository.  The service role key appears here only to build
// fixtures - it bypasses RLS by design, so using it for an assertion would prove
// nothing.  Every assertion uses an anonymous or an end-user client.
//
// base.json deliberately leaves the platform globals out of the pure layer's
// ambient types ("types": []).  This file needs the platform to discover the
// local stack, so it asks for the node types explicitly rather than widening
// the whole package's tsconfig for one test.
/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/database.types.ts';
import {
  getApplicationDecision,
  recordApplicationDecision,
} from '../src/queries/application-decisions.ts';
import {
  insertEligibilitySnapshot,
  listEligibilitySnapshots,
} from '../src/queries/eligibility-snapshots.ts';

type Client = SupabaseClient<Database>;

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
  // The CLI prints unstructured lines (for example "Stopped services: [...]")
  // before the JSON document, so the payload starts at the first brace.
  const start = raw.indexOf('{');
  if (start < 0) {
    throw new Error('supabase status printed no JSON; is the local stack running?');
  }
  const parsed: unknown = JSON.parse(raw.slice(start));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('supabase status printed JSON that is not an object');
  }
  const status = parsed as Record<string, unknown>;
  return {
    url: requiredString(status, 'API_URL'),
    anonKey: requiredString(status, 'ANON_KEY'),
    serviceRoleKey: requiredString(status, 'SERVICE_ROLE_KEY'),
  };
}

let stack: LocalStack;

/** A client with no credentials at all: the shape of a drive-by request. */
function anonymousClient(): Client {
  return createClient<Database>(stack.url, stack.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client carrying one end user's access token, exactly as the browser does. */
function clientAs(accessToken: string): Client {
  return createClient<Database>(stack.url, stack.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Bypasses RLS. Fixtures only - never an assertion. */
function serviceClient(): Client {
  return createClient<Database>(stack.url, stack.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

/**
 * Signs a user up through the real auth API rather than seeding auth.users, so
 * the profile row is created by the on_auth_user_created trigger the same way a
 * production signup creates it.
 */
async function signUpUser(label: string): Promise<TestUser> {
  const email = `rls-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `probe-${Math.random().toString(36).slice(2)}-Aa1!`;
  const client = anonymousClient();
  const { data, error } = await client.auth.signUp({ email, password });
  if (error !== null) {
    throw new Error(`signup failed for ${label}: ${error.message}`);
  }
  const token = data.session?.access_token;
  if (data.user === null || token === undefined) {
    throw new Error(
      `signup for ${label} returned no session; auth.email.enable_confirmations must be off locally`,
    );
  }
  return { id: data.user.id, email, token };
}

/**
 * Rows a caller can actually read.  A denial reaches the client either as an
 * empty result (no policy matched the row) or as an error (no privilege on the
 * column), and for a confidentiality assertion the two are the same answer.
 */
function readable<T>(result: { data: T[] | null }): T[] {
  return result.data ?? [];
}

// The generated types make every view column nullable, because Postgres reports
// no not-null constraint through a view. The ids never are in practice, so the
// null travels through the comparison rather than being asserted away.
function ids(rows: readonly { id: string | null }[]): (string | null)[] {
  return rows.map((row) => row.id).sort();
}

// Fixtures -----------------------------------------------------------------

let service: Client;
let anon: Client;

let borrowerA: TestUser;
let borrowerB: TestUser;
let lender: TestUser;
// A second lender, at the other organisation. Without one, "a lender sees only
// their own organisation" is only ever probed from the borrower side, and the
// tenant boundary on application_decision is never crossed by anyone who holds
// the lender role at all.
let lenderBeta: TestUser;

let clientA: Client;
let clientB: Client;
let clientLender: Client;
let clientLenderBeta: Client;

let orgAlpha: string;
let orgBeta: string;
let productAlpha: string;

let appDraft: string; // borrower A, org alpha, state draft, never decided
let appReviewed: string; // borrower A, org alpha, has an application_decision row
let appQueued: string; // borrower A, org alpha, under review, not yet decided
let appOther: string; // borrower B, org beta
let eventId: number; // the log row for appReviewed
let snapshotReviewed: string; // the eligibility snapshot taken for appReviewed
let snapshotOther: string; // borrower B's snapshot, at the other organisation

// The note recorded against appReviewed. Assertions name the literal rather
// than "some non-null string", because a leak has to be legible: a probe that
// only checked the column was populated would pass on an empty one.
const decisionNote = 'internal: thin file, second opinion requested';
const riskGrade = 'B';

// The snapshot taken when appReviewed was submitted. It quotes the borrower's
// own position back at them -- their acreage, their coverage ratio -- so it is
// as confidential as the application it belongs to, and the assertions below
// name this literal for the same reason the decision note is named: a probe
// that only checked "some jsonb came back" would pass on an empty row.
const snapshotProductName = 'Operating line, as evaluated at submit';
const snapshotEligibility = [
  {
    productId: 'fixture-product',
    productName: snapshotProductName,
    status: 'pass',
    results: [
      {
        id: 'dscr_floor',
        label: 'Debt service coverage',
        status: 'pass',
        severity: 'error',
        explain: 'Coverage is 1.42, above the 1.25 this product asks for.',
        inputs: { actual: 14_200, required: 12_500 },
        missing: [],
        delta: null,
      },
    ],
  },
];

async function insertReturningId(
  table: 'organisation' | 'loan_product',
  values: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await service
    .from(table)
    // The generated Insert types are per-table unions; the fixture builder is
    // deliberately generic, so the payload is checked by the database instead.
    .insert(values as never)
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture insert into ${table} failed: ${error?.message ?? 'no row'}`);
  }
  return data.id;
}

async function promoteToLender(user: TestUser, orgId: string): Promise<void> {
  const promoted = await service
    .from('profile')
    .update({ role: 'lender', org_id: orgId })
    .eq('id', user.id)
    .select('id');
  if (promoted.error !== null || promoted.data?.length !== 1) {
    throw new Error(
      `could not promote the lender fixture ${user.id}: ${promoted.error?.message ?? 'no row'}`,
    );
  }
}

beforeAll(async () => {
  stack = readLocalStack();
  service = serviceClient();
  anon = anonymousClient();

  [borrowerA, borrowerB, lender, lenderBeta] = await Promise.all([
    signUpUser('borrower-a'),
    signUpUser('borrower-b'),
    signUpUser('lender'),
    signUpUser('lender-beta'),
  ]);

  clientA = clientAs(borrowerA.token);
  clientB = clientAs(borrowerB.token);
  clientLender = clientAs(lender.token);
  clientLenderBeta = clientAs(lenderBeta.token);

  orgAlpha = await insertReturningId('organisation', { name: 'Alpha Lending' });
  orgBeta = await insertReturningId('organisation', { name: 'Beta Lending' });

  productAlpha = await insertReturningId('loan_product', {
    org_id: orgAlpha,
    name: 'Operating line',
    criteria: { dscr_floor: 1.25 },
    required_docs: [],
    active: true,
  });

  // Promotion to lender happens out of band, with the service role. That is the
  // whole point of the signup trigger refusing to read a role off the payload.
  await Promise.all([
    promoteToLender(lender, orgAlpha),
    promoteToLender(lenderBeta, orgBeta),
  ]);

  // `data` carries a marker rather than a plausible payload, because the two
  // under_review rows are otherwise indistinguishable and each is picked out of
  // the returned set below.
  const applications = await service
    .from('application')
    .insert([
      { borrower_id: borrowerA.id, org_id: orgAlpha, state: 'draft', data: { fixture: 'draft' } },
      {
        borrower_id: borrowerA.id,
        org_id: orgAlpha,
        state: 'under_review',
        data: { fixture: 'reviewed' },
      },
      {
        borrower_id: borrowerA.id,
        org_id: orgAlpha,
        state: 'under_review',
        data: { fixture: 'queued' },
      },
      { borrower_id: borrowerB.id, org_id: orgBeta, state: 'draft', data: { fixture: 'other' } },
    ])
    .select('id, data');
  if (applications.error !== null || applications.data === null) {
    throw new Error(`fixture applications failed: ${applications.error?.message ?? 'no rows'}`);
  }
  // Bound to a local because TypeScript drops the narrowing of a property
  // access inside a closure, and this one is read from inside `marked`.
  const insertedApplications = applications.data;
  const marked = (marker: string): string => {
    const row = insertedApplications.find(
      (a) => (a.data as { fixture?: string } | null)?.fixture === marker,
    );
    if (row === undefined) {
      throw new Error(`fixture application ${marker} did not come back as inserted`);
    }
    return row.id;
  };
  appDraft = marked('draft');
  appReviewed = marked('reviewed');
  appQueued = marked('queued');
  appOther = marked('other');

  // The lender-only fields are a row in their own table now, not two columns on
  // the application, so the fixture writes them separately and only once the
  // application it belongs to exists. `decided_by` is the lender's real id: the
  // insert and update policies pin the column to auth.uid() for a client, so a
  // fixture attributing the decision to nobody would not be the row a lender
  // could have written.
  const decision = await service.from('application_decision').insert({
    application_id: appReviewed,
    decision_note: decisionNote,
    risk_grade: riskGrade,
    decided_by: lender.id,
  });
  if (decision.error !== null) {
    throw new Error(`fixture application_decision failed: ${decision.error.message}`);
  }

  const event = await service
    .from('workflow_event')
    .insert({
      machine: 'application',
      subject_id: appReviewed,
      from_state: 'draft',
      to_state: 'under_review',
      event: 'submit',
      actor_id: borrowerA.id,
      actor_role: 'borrower',
    })
    .select('id')
    .single();
  if (event.error !== null || event.data === null) {
    throw new Error(`fixture workflow_event failed: ${event.error?.message ?? 'no row'}`);
  }
  eventId = event.data.id;

  // One snapshot per borrower, so "reads their own" and "reads nobody else's"
  // are both assertions about a row that exists rather than about an empty
  // table. Written with the service role because no client holds INSERT on this
  // table at all -- which is itself probed below.
  const snapshots = await service
    .from('eligibility_snapshot')
    .insert([
      { application_id: appReviewed, revision: 1, eligibility: snapshotEligibility },
      { application_id: appOther, revision: 1, eligibility: [] },
    ])
    .select('id, application_id');
  if (snapshots.error !== null || snapshots.data === null) {
    throw new Error(
      `fixture eligibility_snapshot failed: ${snapshots.error?.message ?? 'no rows'}`,
    );
  }
  const insertedSnapshots = snapshots.data;
  const snapshotFor = (applicationId: string): string => {
    const row = insertedSnapshots.find((s) => s.application_id === applicationId);
    if (row === undefined) {
      throw new Error(`fixture snapshot for ${applicationId} did not come back as inserted`);
    }
    return row.id;
  };
  snapshotReviewed = snapshotFor(appReviewed);
  snapshotOther = snapshotFor(appOther);
}, 60_000);

afterAll(async () => {
  if (service === undefined) {
    return;
  }
  // Reverse insertion order, and only as far as the schema allows.
  //
  // The event log survives this teardown on purpose: 0002_rls.sql revokes UPDATE
  // and DELETE on workflow_event from service_role too, so nothing reachable
  // over the API can remove a log row. workflow_event.actor_id references
  // profile, so the users cannot be removed either while their events stand.
  // That is the append-only property working, not a bug in the teardown -- the
  // reset button for the local stack is `supabase db reset`.
  //
  // Nothing left behind can affect a later run: every assertion is scoped to
  // ids created by the run making it, and an orphaned event is visible to
  // nobody once its application is gone.
  // application_decision rows go with the applications, by the cascade in
  // 0001_init.sql -- which is why there is no delete for them here. No client
  // holds DELETE on that table at all, so a teardown that removed them
  // directly would be exercising a path production does not have.
  //
  // eligibility_snapshot rows go the same way, by the cascade in
  // 0005_application_submit.sql. There DELETE is withheld from service_role
  // too, so the cascade is not a convenience here but the only route: a
  // referential action runs as the owner of the referencing table and is not
  // subject to the deleting role's privileges on it.
  await service
    .from('application')
    .delete()
    .in('id', [appDraft, appReviewed, appQueued, appOther]);
  await service.from('loan_product').delete().eq('id', productAlpha);
  // Both lenders' profiles point at an organisation, and profile rows outlive
  // the run.
  await service
    .from('profile')
    .update({ org_id: null })
    .in('id', [lender.id, lenderBeta.id]);
  await service.from('organisation').delete().in('id', [orgAlpha, orgBeta]);
}, 60_000);

// Assertions ---------------------------------------------------------------

describe('anonymous callers', () => {
  it('reads no applications, through the table or either projection', async () => {
    expect(readable(await anon.from('application').select('id'))).toEqual([]);
    expect(readable(await anon.from('application_borrower_v').select('id'))).toEqual([]);
    expect(readable(await anon.from('application_lender_v').select('id'))).toEqual([]);
  });

  it('reads no application decisions', async () => {
    // `anon` holds no privilege on the table at all (0002_rls.sql grants it
    // nothing anywhere), so this denial is an error rather than an empty set.
    // Either shape is the same answer to a confidentiality question, which is
    // what `readable` exists to say.
    const rows = readable(await anon.from('application_decision').select('application_id'));
    expect(rows).toEqual([]);
  });

  it('reads no profiles', async () => {
    expect(readable(await anon.from('profile').select('id'))).toEqual([]);
  });

  it('reads no workflow events', async () => {
    expect(readable(await anon.from('workflow_event').select('id'))).toEqual([]);
  });

  it('reads no eligibility snapshots', async () => {
    expect(readable(await anon.from('eligibility_snapshot').select('id'))).toEqual([]);
  });

  it('reads no organisations and no loan products', async () => {
    expect(readable(await anon.from('organisation').select('id'))).toEqual([]);
    expect(readable(await anon.from('loan_product').select('id'))).toEqual([]);
  });

  it('cannot insert an application', async () => {
    // No `state` in the payload: the denial under test is the policy, not the
    // separate column privilege that also withholds `state` from a client.
    const { error } = await anon
      .from('application')
      .insert({ borrower_id: borrowerA.id, org_id: orgAlpha });
    expect(error).not.toBeNull();
  });
});

describe('borrower B, who owns nothing of borrower A', () => {
  it('sees only their own application', async () => {
    const rows = readable(await clientB.from('application').select('id'));
    expect(ids(rows)).toEqual([appOther]);
  });

  it('sees only their own application through the borrower projection', async () => {
    const rows = readable(await clientB.from('application_borrower_v').select('id'));
    expect(ids(rows)).toEqual([appOther]);
  });

  it('sees only their own profile', async () => {
    const rows = readable(await clientB.from('profile').select('id'));
    expect(ids(rows)).toEqual([borrowerB.id]);
  });

  it('sees none of borrower A workflow events', async () => {
    const rows = readable(await clientB.from('workflow_event').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(eventId);
  });

  it('cannot update borrower A draft', async () => {
    const { data } = await clientB
      .from('application')
      .update({ data: { hijacked: true } })
      .eq('id', appDraft)
      .select('id');
    expect(data ?? []).toEqual([]);

    const check = await service.from('application').select('data').eq('id', appDraft).single();
    expect(check.data?.data).not.toHaveProperty('hijacked');
  });

  it('cannot delete borrower A draft', async () => {
    await clientB.from('application').delete().eq('id', appDraft);
    const check = await service.from('application').select('id').eq('id', appDraft);
    expect(ids(check.data ?? [])).toEqual([appDraft]);
  });
});

describe('borrower A', () => {
  it('sees exactly their own applications', async () => {
    const rows = readable(await clientA.from('application').select('id'));
    expect(ids(rows)).toEqual([appDraft, appReviewed, appQueued].sort());
  });

  it('sees exactly their own applications through the borrower projection', async () => {
    const rows = readable(await clientA.from('application_borrower_v').select('id'));
    expect(ids(rows)).toEqual([appDraft, appReviewed, appQueued].sort());
  });

  it('sees exactly their own profile', async () => {
    const rows = readable(await clientA.from('profile').select('id'));
    expect(ids(rows)).toEqual([borrowerA.id]);
  });

  it('sees the workflow events of their own application', async () => {
    const rows = readable(await clientA.from('workflow_event').select('id'));
    expect(rows.map((row) => row.id)).toContain(eventId);
  });

  it('can autosave their own draft', async () => {
    const { data, error } = await clientA
      .from('application')
      .update({ data: { step: 2, autosaved: true } })
      .eq('id', appDraft)
      .select('id');
    expect(error).toBeNull();
    expect(ids(data ?? [])).toEqual([appDraft]);
  });

  it('cannot edit an application that has left draft', async () => {
    const { data } = await clientA
      .from('application')
      .update({ data: { tampered: true } })
      .eq('id', appReviewed)
      .select('id');
    expect(data ?? []).toEqual([]);
  });

  it('cannot move an application to another state directly', async () => {
    const { error } = await clientA
      .from('application')
      .update({ state: 'approved' })
      .eq('id', appDraft);
    expect(error).not.toBeNull();

    const check = await service.from('application').select('state').eq('id', appDraft).single();
    expect(check.data?.state).toBe('draft');
  });

  it('cannot create an application on behalf of borrower B', async () => {
    // As above: `state` is left out so that the with-check on borrower_id is the
    // only thing that can refuse this.
    const { error } = await clientA
      .from('application')
      .insert({ borrower_id: borrowerB.id, org_id: orgAlpha });
    expect(error).not.toBeNull();
  });

  it('can read loan products, which eligibility needs', async () => {
    const rows = readable(await clientA.from('loan_product').select('id'));
    expect(ids(rows)).toContain(productAlpha);
  });
});

// The lender-only fields are the one thing in this schema a borrower may not
// see about their OWN row, so they are the case row-level security cannot state
// directly: it filters rows, never columns. The schema answers by moving them
// into `application_decision`, and every assertion below probes that answer
// from the borrower's side.
describe('the lender-only decision fields, from the borrower side', () => {
  it('are absent from application_borrower_v', async () => {
    const { data, error } = await clientA
      .from('application_borrower_v')
      .select('*')
      .eq('id', appReviewed)
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    const columns = Object.keys(data ?? {});
    expect(columns).not.toContain('decision_note');
    expect(columns).not.toContain('risk_grade');
    expect(columns).toContain('state');
  });

  it('are absent from select(*) on the application table itself', async () => {
    // The regression the schema change exists to prevent, in the form a client
    // actually meets it. A view omits a column; it does not protect one, and
    // PostgREST publishes the base table, so while these were columns on
    // `application` the borrower's own select policy handed them over in full.
    // Both halves of this matter: the read must SUCCEED -- a column privilege
    // would have made it 42501 without naming the column -- and it must carry
    // neither field.
    const { data, error } = await clientA
      .from('application')
      .select('*')
      .eq('id', appReviewed)
      .single();
    expect(error).toBeNull();
    const columns = Object.keys(data ?? {});
    expect(columns).not.toContain('decision_note');
    expect(columns).not.toContain('risk_grade');
    expect(columns).toContain('state');
    expect(JSON.stringify(data)).not.toContain(decisionNote);
  });

  it('read back as an empty set from application_decision', async () => {
    // The denial is an EMPTY RESULT, not an error, and the difference is the
    // point of the whole change: the borrower holds the same table privileges
    // every authenticated user does, and it is the row policy --
    // is_lender_of_application() -- that admits no row. An earlier version of
    // this probe asserted an error and passed for the wrong reason, because the
    // request was failing with 42703 on a column that no longer existed: proof
    // the column had moved, not proof that anything guarded it.
    const { data, error } = await clientA
      .from('application_decision')
      .select('*')
      .eq('application_id', appReviewed);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('cannot be inserted by a borrower', async () => {
    const { error } = await clientA.from('application_decision').insert({
      application_id: appDraft,
      decision_note: 'approve me',
      risk_grade: 'A',
      decided_by: borrowerA.id,
    });
    // An insert no policy admits IS an error: there is no existing row for the
    // policy to filter, so the with-check fails and Postgres raises 42501.
    expect(error?.code).toBe('42501');

    const check = await service
      .from('application_decision')
      .select('application_id')
      .eq('application_id', appDraft);
    expect(check.data ?? []).toEqual([]);
  });

  it('cannot be updated by a borrower, and the write reports success', async () => {
    const { data, error } = await clientA
      .from('application_decision')
      .update({ decision_note: 'approve me', risk_grade: 'A' })
      .eq('application_id', appReviewed)
      .select('application_id');
    // The other shape of refusal, and the one that looks like success: the
    // `using` clause matches no row, so the statement is a 200 that changed
    // nothing. A probe expecting an error here would fail; a caller expecting
    // one would conclude the write landed. Only the service-role read below
    // actually settles it.
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);

    const check = await service
      .from('application_decision')
      .select('decision_note')
      .eq('application_id', appReviewed)
      .single();
    expect(check.data?.decision_note).toBe(decisionNote);
  });

  it('come back null when a borrower reads application_lender_v', async () => {
    // Both views are security_invoker with no predicate of their own, and this
    // one is granted to every authenticated user, so a borrower reading it gets
    // their own applications rather than a permission error. What withholds the
    // decision is the LEFT join finding no application_decision row their policy
    // admits. appReviewed HAS such a row, so these nulls are filtering and not
    // absence -- which is the only version of this test worth having.
    const { data, error } = await clientA
      .from('application_lender_v')
      .select('id, decision_note, risk_grade, decided_by, recorded_at')
      .eq('id', appReviewed)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(appReviewed);
    expect(data?.decision_note).toBeNull();
    expect(data?.risk_grade).toBeNull();
    expect(data?.decided_by).toBeNull();
    expect(data?.recorded_at).toBeNull();
  });
});

describe('the lender', () => {
  it('sees the applications belonging to their organisation', async () => {
    const rows = readable(await clientLender.from('application_lender_v').select('id'));
    expect(ids(rows)).toEqual([appDraft, appReviewed, appQueued].sort());
  });

  it('does not see applications belonging to another organisation', async () => {
    const rows = readable(await clientLender.from('application_lender_v').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(appOther);
    const direct = readable(await clientLender.from('application').select('id'));
    expect(direct.map((row) => row.id)).not.toContain(appOther);
  });

  it('reads the lender-only columns through their own projection', async () => {
    const { data, error } = await clientLender
      .from('application_lender_v')
      .select('id, decision_note, risk_grade, borrower_name')
      .eq('id', appReviewed)
      .single();
    expect(error).toBeNull();
    expect(data?.decision_note).toBe(decisionNote);
    expect(data?.risk_grade).toBe(riskGrade);
  });

  it('reads the decision row itself, which is what the borrower cannot', async () => {
    // The positive half of the empty-set assertion above. Without it that one
    // would pass just as happily if the policy admitted nobody at all, or if
    // the fixture had never written the row.
    const { data, error } = await clientLender
      .from('application_decision')
      .select('*')
      .eq('application_id', appReviewed)
      .single();
    expect(error).toBeNull();
    expect(data?.decision_note).toBe(decisionNote);
    expect(data?.risk_grade).toBe(riskGrade);
    expect(data?.decided_by).toBe(lender.id);
  });

  it('cannot attribute a new decision to another user', async () => {
    // appDraft belongs to the lender's own organisation, so
    // is_lender_of_application() is satisfied and the only clause left to
    // refuse this is `decided_by = auth.uid()`. A forged attribution in an
    // audit trail is worse than a missing one, because it is believed.
    const { error } = await clientLender.from('application_decision').insert({
      application_id: appDraft,
      decision_note: 'not mine to sign',
      decided_by: borrowerA.id,
    });
    expect(error?.code).toBe('42501');

    const check = await service
      .from('application_decision')
      .select('application_id')
      .eq('application_id', appDraft);
    expect(check.data ?? []).toEqual([]);
  });

  it('cannot reattribute an existing decision to another user', async () => {
    // The update policy's `using` clause admits this row, so the statement gets
    // as far as the with-check and is refused there -- an error, unlike the
    // borrower's update above, which never matched a row to begin with.
    const { error } = await clientLender
      .from('application_decision')
      .update({ decided_by: borrowerB.id })
      .eq('application_id', appReviewed);
    expect(error?.code).toBe('42501');

    const check = await service
      .from('application_decision')
      .select('decided_by')
      .eq('application_id', appReviewed)
      .single();
    expect(check.data?.decided_by).toBe(lender.id);
  });

  it('can read the profile of a borrower who applied to their organisation', async () => {
    const rows = readable(await clientLender.from('profile').select('id'));
    expect(rows.map((row) => row.id)).toContain(borrowerA.id);
  });

  it('cannot read the profile of a borrower who applied elsewhere', async () => {
    const rows = readable(await clientLender.from('profile').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(borrowerB.id);
  });
});

describe('a lender at another organisation', () => {
  it('sees their own organisation applications, which proves the identity holds', async () => {
    // Not a duplicate of the alpha lender's queue test. It is what stops the
    // next assertion from passing because this client is unauthenticated, or
    // was never promoted, or holds no privilege on anything.
    const rows = readable(await clientLenderBeta.from('application_lender_v').select('id'));
    expect(ids(rows)).toEqual([appOther]);
  });

  it('reads no application_decision row, because none belongs to their org', async () => {
    // is_lender_of_application() reads `application` as the CALLER, so a lender
    // who cannot see the application cannot reach its decision either. The
    // tenant boundary is therefore stated once, on `application`, and this is
    // the proof that the decision table inherits it rather than restating it.
    const { data, error } = await clientLenderBeta.from('application_decision').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe('a borrower cannot promote themselves', () => {
  it('is refused when setting profile.role', async () => {
    const { error } = await clientA
      .from('profile')
      .update({ role: 'lender' })
      .eq('id', borrowerA.id);
    expect(error).not.toBeNull();

    const check = await service.from('profile').select('role').eq('id', borrowerA.id).single();
    expect(check.data?.role).toBe('borrower');
  });

  it('is refused when setting profile.org_id', async () => {
    const { error } = await clientA
      .from('profile')
      .update({ org_id: orgAlpha })
      .eq('id', borrowerA.id);
    expect(error).not.toBeNull();

    const check = await service.from('profile').select('org_id').eq('id', borrowerA.id).single();
    expect(check.data?.org_id).toBeNull();
  });

  it('is refused when promoting another user', async () => {
    await clientA.from('profile').update({ role: 'lender' }).eq('id', borrowerB.id);
    const check = await service.from('profile').select('role').eq('id', borrowerB.id).single();
    expect(check.data?.role).toBe('borrower');
  });

  it('still allows a borrower to edit their own display name', async () => {
    const { data, error } = await clientA
      .from('profile')
      .update({ full_name: 'Ada Lovelace' })
      .eq('id', borrowerA.id)
      .select('id');
    expect(error).toBeNull();
    expect(ids(data ?? [])).toEqual([borrowerA.id]);
  });
});

describe('the workflow event log is append only', () => {
  it('cannot be updated by a client', async () => {
    const { error } = await clientA
      .from('workflow_event')
      .update({ to_state: 'approved' })
      .eq('id', eventId);
    expect(error).not.toBeNull();

    const check = await service.from('workflow_event').select('to_state').eq('id', eventId).single();
    expect(check.data?.to_state).toBe('under_review');
  });

  it('cannot be deleted by a client', async () => {
    const { error } = await clientA.from('workflow_event').delete().eq('id', eventId);
    expect(error).not.toBeNull();

    const check = await service.from('workflow_event').select('id').eq('id', eventId);
    expect(check.data?.length).toBe(1);
  });

  it('cannot be forged by a client', async () => {
    const { error } = await clientA.from('workflow_event').insert({
      machine: 'application',
      subject_id: appReviewed,
      to_state: 'approved',
      event: 'approve',
      actor_id: borrowerA.id,
      actor_role: 'lender',
    });
    expect(error).not.toBeNull();
  });
});

// The snapshot inherits the application's audience rather than declaring its
// own, exactly as the workflow log does: one definition of who may read a loan
// file, and both enforcement points move together when it changes. These
// assertions are what make that inheritance a fact instead of a claim.
describe('the eligibility snapshot', () => {
  it('is read by the borrower the application belongs to', async () => {
    const { data, error } = await clientA
      .from('eligibility_snapshot')
      .select('*')
      .eq('id', snapshotReviewed)
      .single();
    expect(error).toBeNull();
    expect(data?.application_id).toBe(appReviewed);
    expect(JSON.stringify(data?.eligibility)).toContain(snapshotProductName);
  });

  it('is not read by another borrower', async () => {
    const rows = readable(await clientB.from('eligibility_snapshot').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(snapshotReviewed);
    // The positive half: borrower B does hold a snapshot, so the assertion
    // above is filtering rather than an empty table or a missing privilege.
    expect(rows.map((row) => row.id)).toContain(snapshotOther);
  });

  it('is read by a lender at the organisation the application was sent to', async () => {
    const { data, error } = await clientLender
      .from('eligibility_snapshot')
      .select('*')
      .eq('id', snapshotReviewed)
      .single();
    expect(error).toBeNull();
    expect(JSON.stringify(data?.eligibility)).toContain(snapshotProductName);
  });

  it('is not read by a lender at another organisation', async () => {
    const rows = readable(await clientLenderBeta.from('eligibility_snapshot').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(snapshotReviewed);
    expect(rows.map((row) => row.id)).toContain(snapshotOther);
  });

  it('cannot be written by the borrower it is about', async () => {
    // No client holds INSERT on this table, so this is a privilege refusal
    // rather than a policy one. A borrower who could write a snapshot could
    // quote a product's criteria back at a lender as though the product had
    // said them.
    const { error } = await clientA.from('eligibility_snapshot').insert({
      application_id: appDraft,
      revision: 0,
      eligibility: [],
    });
    expect(error).not.toBeNull();

    const check = await service
      .from('eligibility_snapshot')
      .select('id')
      .eq('application_id', appDraft);
    expect(check.data ?? []).toEqual([]);
  });

  it('cannot be rewritten by the lender reading it', async () => {
    const { error } = await clientLender
      .from('eligibility_snapshot')
      .update({ eligibility: [] })
      .eq('id', snapshotReviewed);
    expect(error).not.toBeNull();

    const check = await service
      .from('eligibility_snapshot')
      .select('eligibility')
      .eq('id', snapshotReviewed)
      .single();
    expect(JSON.stringify(check.data?.eligibility)).toContain(snapshotProductName);
  });

  it('cannot be deleted by a client, and goes only with its application', async () => {
    const { error } = await clientA.from('eligibility_snapshot').delete().eq('id', snapshotReviewed);
    expect(error).not.toBeNull();

    const check = await service
      .from('eligibility_snapshot')
      .select('id')
      .eq('id', snapshotReviewed);
    expect(check.data?.length).toBe(1);
  });
});

describe('the eligibility snapshot query helpers', () => {
  it('write one snapshot and read it back in order', async () => {
    // Written with the service role because that is the only writer there is:
    // the API takes the snapshot inside the submit transition. A second
    // snapshot at a later revision is what a resubmission would leave, and the
    // list is oldest first so the newest is the last element.
    const written = await insertEligibilitySnapshot(service, {
      applicationId: appQueued,
      revision: 7,
      eligibility: snapshotEligibility,
    });
    expect(written?.application_id).toBe(appQueued);
    expect(written?.revision).toBe(7);

    const rows = await listEligibilitySnapshots(clientA, appQueued);
    expect(rows.map((row) => row.revision)).toEqual([7]);
  });

  it('return nothing to a caller no policy admits', async () => {
    // Borrower B may not see appQueued, so they may not see what it was told
    // either. An empty list rather than an error, and the same answer as "this
    // application has never been submitted" -- deliberately indistinguishable.
    expect(await listEligibilitySnapshots(clientB, appQueued)).toEqual([]);
  });

  it('refuse a second snapshot at a revision already snapshotted', async () => {
    // One row per submit, made structural. Without the constraint a retried
    // write would quietly leave two rows saying the same thing, and "what was
    // the borrower told when they submitted" would have two answers.
    await expect(
      insertEligibilitySnapshot(service, {
        applicationId: appQueued,
        revision: 7,
        eligibility: [],
      }),
    ).rejects.toThrow();
  });
});

describe('the generated transition table', () => {
  it('is readable by an authenticated caller', async () => {
    const { error } = await clientA.from('workflow_transition').select('machine').limit(1);
    expect(error).toBeNull();
  });

  it('is not writable by a client', async () => {
    // from_state is unique per run. A fixed value would collide with the row a
    // previous unguarded run inserted, and the primary key violation would make
    // this pass for entirely the wrong reason.
    const { error } = await clientA.from('workflow_transition').insert({
      machine: 'application',
      from_state: `probe_${Date.now()}`,
      event: 'approve',
      to_state: 'approved',
      actor_role: 'borrower',
    });
    expect(error).not.toBeNull();
  });
});


// The helpers in src/queries/application-decisions.ts are the only sanctioned
// route to this table from above the persistence layer, so they are probed
// against the real policies rather than a mock. A helper that composed a filter
// or a payload the policy refuses would otherwise look correct until the first
// lender used it.
describe('the decision query helpers', () => {
  const queuedNote = 'internal: covenant headroom is thin';

  it('record a decision attributed to the lender making it, and read it back', async () => {
    const recorded = await recordApplicationDecision(clientLender, {
      applicationId: appQueued,
      decidedBy: lender.id,
      decisionNote: queuedNote,
      riskGrade: 'C',
    });
    expect(recorded?.application_id).toBe(appQueued);
    expect(recorded?.decided_by).toBe(lender.id);

    const found = await getApplicationDecision(clientLender, appQueued);
    expect(found?.decision_note).toBe(queuedNote);
    expect(found?.risk_grade).toBe('C');
  });

  it('amend the decision they recorded rather than adding a second one', async () => {
    // The primary key is the foreign key, so "record the decision" is one
    // operation whether or not a row exists. An insert-only helper would fail
    // on the second call with a duplicate key, and a caller would have to ask a
    // question it would then race against.
    const amended = await recordApplicationDecision(clientLender, {
      applicationId: appQueued,
      decidedBy: lender.id,
      decisionNote: queuedNote + ', second read',
      riskGrade: 'B',
    });
    expect(amended?.risk_grade).toBe('B');

    const rows = await service
      .from('application_decision')
      .select('application_id')
      .eq('application_id', appQueued);
    expect(rows.data?.length).toBe(1);
  });

  it('return null for a borrower, whom no policy admits', async () => {
    // The read helper cannot distinguish "not decided yet" from "not yours to
    // read", and must not: both are null, and inventing a difference here would
    // leak the existence of a decision the caller may not see.
    expect(await getApplicationDecision(clientA, appReviewed)).toBeNull();
  });
});
