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

import { createAnonClient, listWorkflowEvents } from '@lj/db';
import { createServiceRoleClient, type ServiceRoleClient } from '@lj/db/service-role';
import { RuleResultSchema } from '@lj/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
}): Promise<string> {
  const { data, error } = await service
    .from('application')
    .insert({
      borrower_id: values.borrowerId,
      org_id: values.orgId,
      state: values.state,
      revision: values.revision,
      data: {},
    })
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture application failed: ${error?.message ?? 'no row'}`);
  }
  return data.id;
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

async function eventCount(subjectId: string): Promise<number> {
  return (await listWorkflowEvents(service, 'application', subjectId)).length;
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

const SUBMITTED_REVISION = 3;

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

  [appForSuccess, appForConflict, appForRefusals, appDraft, appApproved, appForeign] =
    await Promise.all([
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'submitted',
        revision: SUBMITTED_REVISION,
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
    ]);
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
