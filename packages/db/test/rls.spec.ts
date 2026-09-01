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

import type { Database } from '../src/database.types';

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

let clientA: Client;
let clientB: Client;
let clientLender: Client;

let orgAlpha: string;
let orgBeta: string;
let productAlpha: string;

let appDraft: string; // borrower A, org alpha, state draft
let appReviewed: string; // borrower A, org alpha, carries the lender-only columns
let appOther: string; // borrower B, org beta
let eventId: number; // the log row for appReviewed

const decisionNote = 'internal: thin file, second opinion requested';
const riskGrade = 'B';

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

beforeAll(async () => {
  stack = readLocalStack();
  service = serviceClient();
  anon = anonymousClient();

  [borrowerA, borrowerB, lender] = await Promise.all([
    signUpUser('borrower-a'),
    signUpUser('borrower-b'),
    signUpUser('lender'),
  ]);

  clientA = clientAs(borrowerA.token);
  clientB = clientAs(borrowerB.token);
  clientLender = clientAs(lender.token);

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
  const promoted = await service
    .from('profile')
    .update({ role: 'lender', org_id: orgAlpha })
    .eq('id', lender.id)
    .select('id');
  if (promoted.error !== null || promoted.data?.length !== 1) {
    throw new Error(`could not promote the lender fixture: ${promoted.error?.message ?? 'no row'}`);
  }

  const applications = await service
    .from('application')
    .insert([
      { borrower_id: borrowerA.id, org_id: orgAlpha, state: 'draft', data: { step: 1 } },
      {
        borrower_id: borrowerA.id,
        org_id: orgAlpha,
        state: 'under_review',
        data: { step: 4 },
        decision_note: decisionNote,
        risk_grade: riskGrade,
      },
      { borrower_id: borrowerB.id, org_id: orgBeta, state: 'draft', data: { step: 1 } },
    ])
    .select('id, borrower_id, state');
  if (applications.error !== null || applications.data === null) {
    throw new Error(`fixture applications failed: ${applications.error?.message ?? 'no rows'}`);
  }
  const draft = applications.data.find((a) => a.borrower_id === borrowerA.id && a.state === 'draft');
  const reviewed = applications.data.find((a) => a.state === 'under_review');
  const other = applications.data.find((a) => a.borrower_id === borrowerB.id);
  if (draft === undefined || reviewed === undefined || other === undefined) {
    throw new Error('fixture applications did not come back as inserted');
  }
  appDraft = draft.id;
  appReviewed = reviewed.id;
  appOther = other.id;

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
  await service.from('application').delete().in('id', [appDraft, appReviewed, appOther]);
  await service.from('loan_product').delete().eq('id', productAlpha);
  // The lender's profile points at orgAlpha, and profile rows outlive the run.
  await service.from('profile').update({ org_id: null }).eq('id', lender.id);
  await service.from('organisation').delete().in('id', [orgAlpha, orgBeta]);
}, 60_000);

// Assertions ---------------------------------------------------------------

describe('anonymous callers', () => {
  it('reads no applications, through the table or either projection', async () => {
    expect(readable(await anon.from('application').select('id'))).toEqual([]);
    expect(readable(await anon.from('application_borrower_v').select('id'))).toEqual([]);
    expect(readable(await anon.from('application_lender_v').select('id'))).toEqual([]);
  });

  it('reads no profiles', async () => {
    expect(readable(await anon.from('profile').select('id'))).toEqual([]);
  });

  it('reads no workflow events', async () => {
    expect(readable(await anon.from('workflow_event').select('id'))).toEqual([]);
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
    expect(ids(rows)).toEqual([appDraft, appReviewed].sort());
  });

  it('sees exactly their own applications through the borrower projection', async () => {
    const rows = readable(await clientA.from('application_borrower_v').select('id'));
    expect(ids(rows)).toEqual([appDraft, appReviewed].sort());
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

describe('the borrower projection hides the lender-only columns', () => {
  it('omits decision_note and risk_grade from application_borrower_v', async () => {
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

  it('refuses a borrower reading decision_note straight off the table', async () => {
    const { data, error } = await clientA
      .from('application')
      .select('id, decision_note, risk_grade')
      .eq('id', appReviewed);
    // A view omits a column; it does not protect it. The base table is
    // client-reachable through PostgREST, so the column privilege is the gate.
    expect(error).not.toBeNull();
    expect(JSON.stringify(data ?? [])).not.toContain(decisionNote);
  });

  it('refuses a borrower writing decision_note on their own draft', async () => {
    const { error } = await clientA
      .from('application')
      .update({ decision_note: 'approve me' })
      .eq('id', appDraft);
    expect(error).not.toBeNull();
  });
});

describe('the lender', () => {
  it('sees the applications belonging to their organisation', async () => {
    const rows = readable(await clientLender.from('application_lender_v').select('id'));
    expect(ids(rows)).toEqual([appDraft, appReviewed].sort());
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

  it('can read the profile of a borrower who applied to their organisation', async () => {
    const rows = readable(await clientLender.from('profile').select('id'));
    expect(rows.map((row) => row.id)).toContain(borrowerA.id);
  });

  it('cannot read the profile of a borrower who applied elsewhere', async () => {
    const rows = readable(await clientLender.from('profile').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(borrowerB.id);
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
