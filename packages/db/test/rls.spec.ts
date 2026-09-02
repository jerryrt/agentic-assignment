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

import {
  LoanBalanceSchema,
  borrowerAvailableCredit,
  lenderUndrawnLimit,
} from '@lj/domain';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/database.types.ts';
import {
  getApplicationDecision,
  recordApplicationDecision,
} from '../src/queries/application-decisions.ts';
import {
  deleteCreditReleaseDraft,
  getCreditRelease,
  getCreditReleaseForBorrower,
  getCreditReleaseForLender,
  getCreditReleaseNote,
  insertCreditRelease,
  listCreditReleaseQueue,
  listCreditReleasesForBorrower,
  updateCreditRelease,
  upsertCreditReleaseNote,
} from '../src/queries/credit-releases.ts';
import {
  insertEligibilitySnapshot,
  listEligibilitySnapshots,
} from '../src/queries/eligibility-snapshots.ts';
import {
  getLoan,
  getLoanBalance,
  insertLedgerEntry,
  listLedgerEntries,
  listLoans,
} from '../src/queries/loans.ts';

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
let slotReviewed: string; // a required slot on appReviewed, borrower A
let slotOther: string; // a required slot on appOther, borrower B
let uploadReviewed: string; // the file submitted against slotReviewed
let slotEventReviewed: number; // a transition on borrower A's slot
let slotEventOther: number; // a transition on borrower B's slot
/**
 * A real object in the private bucket, so the storage assertions are about a
 * policy refusing rather than about a file that is not there. The path is the
 * convention 0006_documents.sql fixes and its policy reads --
 * <application_id>/<slot_code>/<uuid>.<ext> -- written out rather than
 * assembled, so a change to the convention breaks this visibly.
 */
let storedObject: string;
let snapshotReviewed: string; // the eligibility snapshot taken for appReviewed
let snapshotOther: string; // borrower B's snapshot, at the other organisation

// Option 3. Two loans, one per organisation, so every "cannot read" below has
// a matching "and this caller can" -- a refusal probed only against an absent
// row proves nothing.
let productBeta: string; // orgBeta needs a product of its own to hang a loan on
let loanA: string; // borrower A, org alpha, against appReviewed
let loanOther: string; // borrower B, org beta, against appOther
let releaseDraft: string; // loan A, still being composed by borrower A
let releaseSubmitted: string; // loan A, pending -- the row that makes `pending` non-zero
let releaseDeclined: string; // loan A, decided, with a reason and a private note
let releaseTransient: string; // loan A, walked through the machine by the balance probe
let releaseOther: string; // loan B, pending, at the other organisation
let ledgerDraw: number; // the draw on loan A, named so the append-only probe can find it
let ledgerOtherDraw: number; // the draw on loan B

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
// The lender's private note on the declined release, and the reason the
// borrower is entitled to read. Named literals for the reason the decision note
// is one: a leak has to be legible, and a probe that only checked "some text
// came back" would pass on an empty column. These two strings are the whole
// point of the column-versus-row argument -- one is readable by the borrower
// the release belongs to and the other must not be, and they sit on the same
// request.
const releaseInternalNote = 'internal: second request this month, watch the pattern';
const releaseDeclineReason = 'The line is drawn to 71 per cent. Resubmit after the first delivery.';
const otherInternalNote = 'internal: beta org note, visible to beta lenders only';

// The figures loan A's balance derives from. Written as the exact decimal text
// Postgres renders, because that is what these assertions are about: the
// balance must arrive with its cents intact, and 45000.00 must be exactly
// 4,500,000 minor units rather than whatever a binary double lands on.
const loanApprovedLimit = '100000.00';
const loanDrawAmount = '40000.00';
const loanRepaymentAmount = '-10000.00';
const releaseSubmittedAmount = '25000.00';

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

  // signUpUser posts no full_name, so handle_new_user leaves the column null.
  // The lender projection resolves two names out of `profile`, and a null name
  // would make "the borrower cannot see who decided" pass against a name that
  // was never there -- the absent-object failure #41 shipped, in another shape.
  const named = await service
    .from('profile')
    .update({ full_name: 'Fixture Lender' })
    .eq('id', lender.id)
    .select('id');
  if (named.error !== null || named.data?.length !== 1) {
    throw new Error(`could not name the lender fixture: ${named.error?.message ?? 'no row'}`);
  }
  //
  // Only the lender is named here. Borrower A's display name is written by the
  // profile_update_own probe further down, so pinning it in a fixture would set
  // up two authors for one column and a failure that depends on test order.

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

  // One document slot per borrower, for the same reason as the snapshots: so
  // "reads their own" and "reads nobody else's" are both assertions about rows
  // that exist. Written with the service role because `authenticated` holds
  // SELECT and nothing else on either table -- which is itself probed below.
  const slots = await service
    .from('document_slot')
    .insert([
      {
        application_id: appReviewed,
        code: 'land_title',
        label: 'Land title or lease',
        required: true,
        extract_required: ['legal_description'],
      },
      {
        application_id: appOther,
        code: 'land_title',
        label: 'Land title or lease',
        required: true,
        extract_required: ['legal_description'],
      },
    ])
    .select('id, application_id');
  if (slots.error !== null || slots.data === null) {
    throw new Error(`fixture document_slot failed: ${slots.error?.message ?? 'no rows'}`);
  }
  const insertedSlots = slots.data;
  const slotFor = (applicationId: string): string => {
    const row = insertedSlots.find((slot) => slot.application_id === applicationId);
    if (row === undefined) {
      throw new Error(`fixture slot for ${applicationId} did not come back as inserted`);
    }
    return row.id;
  };
  slotReviewed = slotFor(appReviewed);
  slotOther = slotFor(appOther);
  storedObject = `${appReviewed}/land_title/00000000-0000-4000-8000-00000000bb01.pdf`;

  // The path convention 0006_documents.sql fixes, and the storage policy reads:
  // <application_id>/<slot_code>/<uuid>.<ext>. It is written out here rather
  // than assembled from a helper so that a change to the convention breaks this
  // fixture visibly.
  const upload = await service
    .from('document_upload')
    .insert({
      slot_id: slotReviewed,
      storage_path: `${appReviewed}/land_title/00000000-0000-4000-8000-00000000aa01.pdf`,
      filename: 'land-title.pdf',
      bytes: 12_345,
      mime: 'application/pdf',
    })
    .select('id')
    .single();
  if (upload.error !== null || upload.data === null) {
    throw new Error(`fixture document_upload failed: ${upload.error?.message ?? 'no row'}`);
  }
  uploadReviewed = upload.data.id;

  // A transition on each borrower's slot, so "reads their own history" and
  // "reads nobody else's" are both assertions about rows that exist. 0006
  // created document_slot without a workflow_event clause, so until 0008 these
  // were readable by nobody and a document timeline rendered empty with nothing
  // to distinguish that from a document with no history (issue #58).
  const slotEvents = await service
    .from('workflow_event')
    .insert([
      {
        machine: 'document_slot',
        subject_id: slotReviewed,
        from_state: 'required',
        to_state: 'uploaded',
        event: 'upload',
        actor_id: borrowerA.id,
        actor_role: 'borrower',
      },
      {
        machine: 'document_slot',
        subject_id: slotOther,
        from_state: 'required',
        to_state: 'uploaded',
        event: 'upload',
        actor_id: borrowerB.id,
        actor_role: 'borrower',
      },
    ])
    .select('id, subject_id');
  if (slotEvents.error !== null || slotEvents.data === null) {
    throw new Error(`fixture slot workflow_event failed: ${slotEvents.error?.message ?? 'no rows'}`);
  }
  const slotEventFor = (slotId: string): number => {
    const row = slotEvents.data?.find((e) => e.subject_id === slotId);
    if (row === undefined) {
      throw new Error(`fixture slot event for ${slotId} did not come back as inserted`);
    }
    return row.id;
  };
  slotEventReviewed = slotEventFor(slotReviewed);
  slotEventOther = slotEventFor(slotOther);

  // A real object in the private bucket, put there with the service role. It
  // matters that this exists: without it, every "cannot read another
  // borrower's file" assertion below would pass because the file is absent
  // rather than because the policy refused it, which is a test that proves
  // nothing and looks like it proves everything.
  const stored = await service.storage
    .from('documents')
    .upload(storedObject, new Blob(['%PDF-1.4 land title'], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (stored.error !== null) {
    throw new Error(`fixture storage object failed: ${stored.error.message}`);
  }

  // Option 3 -------------------------------------------------------------
  //
  // A loan per organisation. Borrower B's exists so that every refusal below
  // is answered by the same read succeeding for the caller it is meant for:
  // "borrower B cannot see loan A" is only evidence if borrower B can see a
  // loan at all.
  productBeta = await insertReturningId('loan_product', {
    org_id: orgBeta,
    name: 'Beta operating line',
    criteria: { dscr_floor: 1.1 },
    required_docs: [],
    active: true,
  });

  // `as never` for the reason insertReturningId uses it, plus one specific to
  // money: the generated Insert type says `approved_limit` is a number, and
  // money is written as the exact decimal string PostgREST parses without a
  // float in the way. The database checks the payload; the type does not.
  const loans = await service
    .from('loan')
    .insert([
      {
        application_id: appReviewed,
        borrower_id: borrowerA.id,
        org_id: orgAlpha,
        product_id: productAlpha,
        approved_limit: loanApprovedLimit,
        rate_bps: 875,
      },
      {
        application_id: appOther,
        borrower_id: borrowerB.id,
        org_id: orgBeta,
        product_id: productBeta,
        approved_limit: '50000.00',
        rate_bps: 940,
      },
    ] as never)
    .select('id, application_id');
  if (loans.error !== null || loans.data === null) {
    throw new Error(`fixture loans failed: ${loans.error?.message ?? 'no rows'}`);
  }
  const insertedLoans = loans.data;
  const loanFor = (applicationId: string): string => {
    const row = insertedLoans.find((loan) => loan.application_id === applicationId);
    if (row === undefined) {
      throw new Error(`fixture loan for ${applicationId} did not come back as inserted`);
    }
    return row.id;
  };
  loanA = loanFor(appReviewed);
  loanOther = loanFor(appOther);

  // Four releases across the two loans, each in a state that is probed for
  // something different: a draft the borrower may still edit, a pending one
  // that holds credit against the balance, a decided one carrying both a
  // shared reason and a private note, and one at the other organisation.
  //
  // `state` is written directly because the transition trigger fires on UPDATE
  // only. Walking each through the machine would be exercising the API's job,
  // not the policies'.
  const releases = await service
    .from('credit_release')
    .insert([
      // `state` is spelled out on every row, including the one that wants the
      // default. A PostgREST bulk insert unifies the keys across the array and
      // sends null for any a row omits, so leaving it off here is not "take
      // the default" -- it is a not-null violation.
      {
        loan_id: loanA,
        amount: '5000.00',
        purpose: 'fixture: draft',
        state: 'draft',
        requested_by: borrowerA.id,
      },
      {
        loan_id: loanA,
        amount: releaseSubmittedAmount,
        purpose: 'fixture: submitted',
        state: 'submitted',
        requested_by: borrowerA.id,
      },
      {
        loan_id: loanA,
        amount: '12000.00',
        purpose: 'fixture: declined',
        state: 'declined',
        requested_by: borrowerA.id,
        decided_by: lender.id,
        decline_reason: releaseDeclineReason,
      },
      // Walked through the machine by the balance probe, which needs a request
      // it can legally move without disturbing the three above. It starts as a
      // draft and ends cancelled, so it holds no credit at either end and the
      // named balance figures elsewhere in this file stay true.
      {
        loan_id: loanA,
        amount: '7000.00',
        purpose: 'fixture: transient',
        state: 'draft',
        requested_by: borrowerA.id,
      },
      {
        loan_id: loanOther,
        amount: '3000.00',
        purpose: 'fixture: other org',
        state: 'submitted',
        requested_by: borrowerB.id,
      },
    ] as never)
    .select('id, purpose');
  if (releases.error !== null || releases.data === null) {
    throw new Error(`fixture credit_release failed: ${releases.error?.message ?? 'no rows'}`);
  }
  const insertedReleases = releases.data;
  const releaseFor = (purpose: string): string => {
    const row = insertedReleases.find((release) => release.purpose === purpose);
    if (row === undefined) {
      throw new Error(`fixture release "${purpose}" did not come back as inserted`);
    }
    return row.id;
  };
  releaseDraft = releaseFor('fixture: draft');
  releaseSubmitted = releaseFor('fixture: submitted');
  releaseDeclined = releaseFor('fixture: declined');
  releaseTransient = releaseFor('fixture: transient');
  releaseOther = releaseFor('fixture: other org');

  // One note per organisation. The beta one is what turns "a lender at another
  // organisation reads no note" from a statement about an empty table into a
  // statement about a policy.
  const notes = await service.from('credit_release_note').insert([
    {
      release_id: releaseDeclined,
      internal_note: releaseInternalNote,
      recorded_by: lender.id,
    },
    {
      release_id: releaseOther,
      internal_note: otherInternalNote,
      recorded_by: lenderBeta.id,
    },
  ]);
  if (notes.error !== null) {
    throw new Error(`fixture credit_release_note failed: ${notes.error.message}`);
  }

  // Two entries on loan A so the outstanding figure is a SUM of a positive and
  // a negative rather than a single number that a case expression would have
  // produced just as well. 40000.00 - 10000.00 = 30000.00 outstanding.
  const ledger = await service
    .from('ledger_entry')
    .insert([
      {
        loan_id: loanA,
        kind: 'draw',
        amount: loanDrawAmount,
        effective: '2026-08-20',
        memo: 'fixture: opening advance',
      },
      {
        loan_id: loanA,
        kind: 'repayment',
        amount: loanRepaymentAmount,
        effective: '2026-08-27',
        memo: 'fixture: repayment',
      },
      {
        loan_id: loanOther,
        kind: 'draw',
        amount: '1500.00',
        effective: '2026-08-21',
        memo: 'fixture: other org advance',
      },
    ] as never)
    .select('id, memo');
  if (ledger.error !== null || ledger.data === null) {
    throw new Error(`fixture ledger_entry failed: ${ledger.error?.message ?? 'no rows'}`);
  }
  const insertedLedger = ledger.data;
  const ledgerFor = (memo: string): number => {
    const row = insertedLedger.find((entry) => entry.memo === memo);
    if (row === undefined) {
      throw new Error(`fixture ledger entry "${memo}" did not come back as inserted`);
    }
    return row.id;
  };
  ledgerDraw = ledgerFor('fixture: opening advance');
  ledgerOtherDraw = ledgerFor('fixture: other org advance');

  // One event per release, so the timeline policy added by 0007 is probed
  // against a row that exists rather than against an empty log.
  const releaseEvents = await service.from('workflow_event').insert([
    {
      machine: 'credit_release',
      subject_id: releaseSubmitted,
      from_state: 'draft',
      to_state: 'submitted',
      event: 'submit',
      actor_id: borrowerA.id,
      actor_role: 'borrower',
    },
    {
      machine: 'credit_release',
      subject_id: releaseOther,
      from_state: 'draft',
      to_state: 'submitted',
      event: 'submit',
      actor_id: borrowerB.id,
      actor_role: 'borrower',
    },
  ]);
  if (releaseEvents.error !== null) {
    throw new Error(`fixture credit_release events failed: ${releaseEvents.error.message}`);
  }
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
  //
  // The Option 3 fixtures go the same way, and only that way. `loan` cascades
  // from `application`, and `ledger_entry`, `credit_release` and
  // `credit_release_note` cascade from `loan` -- which is not a convenience
  // here either: 0007_servicing.sql revokes DELETE on ledger_entry from
  // service_role too, so a teardown that removed entries directly would be
  // exercising a path production does not have.
  await service
    .from('application')
    .delete()
    .in('id', [appDraft, appReviewed, appQueued, appOther]);
  await service.from('loan_product').delete().in('id', [productAlpha, productBeta]);
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

  // Every table and every projection Option 3 adds. Listed one by one rather
  // than looped, because the failure has to name the relation that leaked.
  it('reads nothing of a loan, its ledger or its releases', async () => {
    expect(readable(await anon.from('loan').select('id'))).toEqual([]);
    expect(readable(await anon.from('ledger_entry').select('id'))).toEqual([]);
    expect(readable(await anon.from('credit_release').select('id'))).toEqual([]);
    expect(readable(await anon.from('credit_release_note').select('release_id'))).toEqual([]);
    expect(readable(await anon.from('loan_balance_v').select('loan_id'))).toEqual([]);
    expect(readable(await anon.from('credit_release_borrower_v').select('id'))).toEqual([]);
    expect(readable(await anon.from('credit_release_lender_v').select('id'))).toEqual([]);
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
describe('the document pack', () => {
  it('is read by the borrower the application belongs to', async () => {
    const { data, error } = await clientA
      .from('document_slot')
      .select('*')
      .eq('id', slotReviewed)
      .single();
    expect(error).toBeNull();
    expect(data?.code).toBe('land_title');
  });

  it('is not read by another borrower', async () => {
    const rows = readable(await clientB.from('document_slot').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(slotReviewed);
    // The positive half: borrower B holds a slot of their own, so the assertion
    // above is filtering rather than an empty table or a missing privilege.
    expect(rows.map((row) => row.id)).toContain(slotOther);
  });

  it('is read by a lender at the organisation the application was sent to', async () => {
    const { data, error } = await clientLender
      .from('document_slot')
      .select('*')
      .eq('id', slotReviewed)
      .single();
    expect(error).toBeNull();
    expect(data?.label).toBe('Land title or lease');
  });

  it('is not read by a lender at another organisation', async () => {
    const rows = readable(await clientLenderBeta.from('document_slot').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(slotReviewed);
    expect(rows.map((row) => row.id)).toContain(slotOther);
  });

  it('is read by nobody anonymous', async () => {
    expect(readable(await anon.from('document_slot').select('id'))).toEqual([]);
    expect(readable(await anon.from('document_upload').select('id'))).toEqual([]);
  });

  // The one that matters most. A borrower who could write `state` could accept
  // their own documents, and `accept` is a lender's decision -- so this is a
  // privilege refusal rather than a policy one, exactly as application.state is.
  it('cannot have its state written by the borrower it belongs to', async () => {
    const { error } = await clientA
      .from('document_slot')
      .update({ state: 'accepted' })
      .eq('id', slotReviewed);
    expect(error).not.toBeNull();

    const check = await service
      .from('document_slot')
      .select('state')
      .eq('id', slotReviewed)
      .single();
    expect(check.data?.state).toBe('required');
  });

  // Nor by the lender who is entitled to decide it. Accepting a document is a
  // transition, and a transition goes through the API, which re-checks the
  // role against the machine and appends an event. A direct write would move
  // the state with no audit entry behind it.
  it('cannot have its state written by the lender either', async () => {
    const { error } = await clientLender
      .from('document_slot')
      .update({ state: 'accepted' })
      .eq('id', slotReviewed);
    expect(error).not.toBeNull();
  });

  it('cannot have a slot invented by a client', async () => {
    const { error } = await clientA.from('document_slot').insert({
      application_id: appDraft,
      code: 'invented',
      label: 'Invented',
    });
    expect(error).not.toBeNull();

    const check = await service
      .from('document_slot')
      .select('id')
      .eq('application_id', appDraft);
    expect(check.data ?? []).toEqual([]);
  });
});

/**
 * A schema invariant rather than a policy, and it sits here because this is the
 * only suite that talks to a real database.
 *
 * plan/06 and packages/domain both treat "a funded application becomes one
 * loan" as a fact. Until 0009 it was not one -- application_id carried a
 * foreign key and no uniqueness, so the invariant rested entirely on the
 * application machine refusing a second `fund`. A second loan is a second
 * credit limit, and every balance in loan_balance_v is grouped BY LOAN, so
 * nothing downstream would have reported a total as wrong. It would simply
 * have been wrong, in the direction of more available credit.
 */
describe('one live loan per application', () => {
  it('refuses a second loan against an application that already has one', async () => {
    // `as never` for the reason the loan fixture above uses it: the generated
    // Insert type says approved_limit is a number, and money is written as the
    // exact decimal string PostgREST parses without a float in the way.
    const { error } = await service.from('loan').insert({
      application_id: appReviewed,
      borrower_id: borrowerA.id,
      org_id: orgAlpha,
      product_id: productAlpha,
      approved_limit: '100000.00',
      rate_bps: 0,
    } as never);
    expect(error).not.toBeNull();
    expect(error?.code).toBe('23505');
  });

  // The index is PARTIAL on purpose. Closing a facility and opening a
  // replacement against the same application is an ordinary lending operation,
  // and a blanket constraint would have forbidden it forever on the strength of
  // a phase that has no refinancing in it. This is the half that says so.
  it('allows a replacement once the first is closed', async () => {
    await service.from('loan').update({ status: 'closed' }).eq('id', loanA);
    const replacement = await service
      .from('loan')
      .insert({
        application_id: appReviewed,
        borrower_id: borrowerA.id,
        org_id: orgAlpha,
        product_id: productAlpha,
        approved_limit: '100000.00',
        rate_bps: 0,
      } as never)
      .select('id')
      .single();

    expect(replacement.error).toBeNull();

    // Put the fixture back for whatever runs after this.
    if (replacement.data !== null) {
      await service.from('loan').delete().eq('id', replacement.data.id);
    }
    await service.from('loan').update({ status: 'active' }).eq('id', loanA);
  });
});

describe("a document slot's transition history", () => {
  // THE POSITIVE CONTROL, and the reason the refusals below mean anything.
  // Before 0008 this failed: no policy admitted a document_slot event, so the
  // log was readable by nobody and every "cannot read" assertion would have
  // passed against rows nobody could reach.
  it('is read by the borrower whose document it is', () => {
    return clientA
      .from('workflow_event')
      .select('id, event')
      .eq('id', slotEventReviewed)
      .single()
      .then(({ data, error }) => {
        expect(error).toBeNull();
        expect(data?.event).toBe('upload');
      });
  });

  it('is not read by another borrower', async () => {
    const rows = readable(
      await clientB.from('workflow_event').select('id').eq('machine', 'document_slot'),
    );
    expect(rows.map((row) => row.id)).not.toContain(slotEventReviewed);
    expect(rows.map((row) => row.id)).toContain(slotEventOther);
  });

  it('is read by a lender at the organisation, and not by one elsewhere', async () => {
    const mine = readable(
      await clientLender.from('workflow_event').select('id').eq('machine', 'document_slot'),
    );
    expect(mine.map((row) => row.id)).toContain(slotEventReviewed);

    const theirs = readable(
      await clientLenderBeta.from('workflow_event').select('id').eq('machine', 'document_slot'),
    );
    expect(theirs.map((row) => row.id)).not.toContain(slotEventReviewed);
  });

  it('is read by nobody anonymous', async () => {
    expect(
      readable(await anon.from('workflow_event').select('id').eq('machine', 'document_slot')),
    ).toEqual([]);
  });
});

describe('a submitted document', () => {
  it('is read by the borrower who submitted it', async () => {
    const { data, error } = await clientA
      .from('document_upload')
      .select('*')
      .eq('id', uploadReviewed)
      .single();
    expect(error).toBeNull();
    expect(data?.filename).toBe('land-title.pdf');
  });

  it('is not read by another borrower', async () => {
    const rows = readable(await clientB.from('document_upload').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(uploadReviewed);
  });

  it('is read by a lender at the organisation, and not by one elsewhere', async () => {
    const mine = readable(await clientLender.from('document_upload').select('id'));
    expect(mine.map((row) => row.id)).toContain(uploadReviewed);

    const theirs = readable(await clientLenderBeta.from('document_upload').select('id'));
    expect(theirs.map((row) => row.id)).not.toContain(uploadReviewed);
  });

  // No client holds INSERT. The row is written by the API on the `upload`
  // transition, from a path the API minted -- a client-supplied path is a
  // client choosing which application's folder to write into.
  it('cannot be recorded by a client', async () => {
    const { error } = await clientA.from('document_upload').insert({
      slot_id: slotReviewed,
      storage_path: `${appOther}/land_title/forged.pdf`,
      filename: 'forged.pdf',
      bytes: 1,
      mime: 'application/pdf',
    });
    expect(error).not.toBeNull();
  });

  // Append-only, and meant literally: no UPDATE and no DELETE for anyone,
  // service_role included. A record of what was submitted that can be edited to
  // agree with what happened afterwards is not a record.
  it('cannot be rewritten or removed, by a client or by the service role', async () => {
    expect(
      (await clientA.from('document_upload').update({ filename: 'x.pdf' }).eq('id', uploadReviewed))
        .error,
    ).not.toBeNull();
    expect(
      (await service.from('document_upload').update({ filename: 'x.pdf' }).eq('id', uploadReviewed))
        .error,
    ).not.toBeNull();
    expect(
      (await service.from('document_upload').delete().eq('id', uploadReviewed)).error,
    ).not.toBeNull();

    const check = await service
      .from('document_upload')
      .select('filename')
      .eq('id', uploadReviewed)
      .single();
    expect(check.data?.filename).toBe('land-title.pdf');
  });
});

describe('the documents bucket', () => {
  const objectUnder = (applicationId: string): string =>
    `${applicationId}/land_title/00000000-0000-4000-8000-00000000bb01.pdf`;

  // The bucket is private. A public one serves every object to anyone holding
  // the URL, and a loan file's documents are the last thing that should be one
  // guessed path away from the internet.
  it('is private', async () => {
    const { data } = await service.storage.getBucket('documents');
    expect(data?.public).toBe(false);
  });

  // THE POSITIVE CONTROL, and the reason the three refusals below mean
  // anything: the object is really there and really readable by the borrower
  // whose application it is filed under. Without this, "cannot read" would pass
  // for a file that does not exist.
  it('is read by the borrower whose application it is filed under', async () => {
    const { data, error } = await clientA.storage.from('documents').download(storedObject);
    expect(error).toBeNull();
    expect(await data?.text()).toContain('land title');
  });

  it('is read by a lender at the organisation, and not by one elsewhere', async () => {
    expect((await clientLender.storage.from('documents').download(storedObject)).error).toBeNull();
    expect(
      (await clientLenderBeta.storage.from('documents').download(storedObject)).error,
    ).not.toBeNull();
  });

  it('is not read by anyone anonymous', async () => {
    const { error } = await anon.storage.from('documents').download(storedObject);
    expect(error).not.toBeNull();
  });

  // The read policy gates on the FIRST PATH SEGMENT as the application id, so
  // borrower B cannot reach an object filed under borrower A's application
  // however the rest of the path is spelled.
  it('is not read by a borrower it is not filed under', async () => {
    const { error } = await clientB.storage.from('documents').download(storedObject);
    expect(error).not.toBeNull();
  });

  // No client holds an insert policy on storage.objects for this bucket:
  // uploads arrive on a signed URL the API mints, so the API stays the only
  // thing that decides a path may be written. Borrower A is refused even under
  // their OWN application, which is what makes the signed URL the sole route.
  it('refuses a direct upload, even from the borrower it would belong to', async () => {
    const { error } = await clientA.storage
      .from('documents')
      .upload(objectUnder(appReviewed) + '.direct', new Blob(['nope']));
    expect(error).not.toBeNull();
  });

  it('refuses a borrower writing under another application entirely', async () => {
    const { error } = await clientB.storage
      .from('documents')
      .upload(objectUnder(appReviewed) + '.forged', new Blob(['nope']));
    expect(error).not.toBeNull();
  });
});

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

// Option 3: the facility, the ledger, the requests, and the two truths -------
//
// Every refusal below is paired with the same read succeeding for the caller it
// is meant for, in the same test wherever the pairing is what makes the point.
// A "cannot read" that is never shown to read for anybody proves only that
// something is absent.

describe('the loan', () => {
  it('is read by the borrower it belongs to', async () => {
    const { data, error } = await clientA.from('loan').select('*').eq('id', loanA).single();
    expect(error).toBeNull();
    expect(data?.borrower_id).toBe(borrowerA.id);
  });

  it('is not read by another borrower, who reads their own', async () => {
    const rows = readable(await clientB.from('loan').select('id'));
    expect(rows.map((row) => row.id)).toEqual([loanOther]);
  });

  it('is read by a lender at the organisation, and not by one elsewhere', async () => {
    const mine = readable(await clientLender.from('loan').select('id'));
    expect(mine.map((row) => row.id)).toEqual([loanA]);

    const theirs = readable(await clientLenderBeta.from('loan').select('id'));
    expect(theirs.map((row) => row.id)).toEqual([loanOther]);
  });

  // SELECT and nothing else. A facility is opened by the funding effect with
  // the service role -- which the fixtures above have just demonstrated -- and
  // no part of the design lets a client open, close or re-price one.
  it('cannot be opened by a client, though the service role opens one', async () => {
    const borrowerAttempt = await clientA.from('loan').insert({
      application_id: appReviewed,
      borrower_id: borrowerA.id,
      org_id: orgAlpha,
      product_id: productAlpha,
      approved_limit: 999_999,
      rate_bps: 0,
    });
    expect(borrowerAttempt.error).not.toBeNull();

    const lenderAttempt = await clientLender.from('loan').insert({
      application_id: appReviewed,
      borrower_id: borrowerA.id,
      org_id: orgAlpha,
      product_id: productAlpha,
      approved_limit: 999_999,
      rate_bps: 0,
    });
    expect(lenderAttempt.error).not.toBeNull();

    const check = await service.from('loan').select('id').eq('application_id', appReviewed);
    expect(check.data?.length).toBe(1);
  });

  // A borrower raising their own limit is the most valuable write in the
  // schema, so it is the one worth naming.
  it('cannot have its limit raised by the borrower or by the lender', async () => {
    expect(
      (await clientA.from('loan').update({ approved_limit: 999_999 }).eq('id', loanA)).error,
    ).not.toBeNull();
    expect(
      (await clientLender.from('loan').update({ approved_limit: 999_999 }).eq('id', loanA)).error,
    ).not.toBeNull();

    const check = await getLoan(service, loanA);
    expect(check?.approved_limit).toBe(loanApprovedLimit);
  });
});

describe('the ledger', () => {
  it('is read by the borrower whose loan it records', async () => {
    const rows = readable(await clientA.from('ledger_entry').select('id'));
    expect(rows.map((row) => row.id)).toContain(ledgerDraw);
  });

  it('is not read by another borrower, who reads their own', async () => {
    const rows = readable(await clientB.from('ledger_entry').select('id'));
    expect(rows.map((row) => row.id)).not.toContain(ledgerDraw);
    expect(rows.map((row) => row.id)).toContain(ledgerOtherDraw);
  });

  it('is read by a lender at the organisation, and not by one elsewhere', async () => {
    const mine = readable(await clientLender.from('ledger_entry').select('id'));
    expect(mine.map((row) => row.id)).toContain(ledgerDraw);

    const theirs = readable(await clientLenderBeta.from('ledger_entry').select('id'));
    expect(theirs.map((row) => row.id)).not.toContain(ledgerDraw);
    expect(theirs.map((row) => row.id)).toContain(ledgerOtherDraw);
  });

  // No client write of any kind. A client that could append to a ledger could
  // invent a repayment; a lender that could append could invent a draw against
  // a borrower who never asked for one.
  it('takes no entry from any client, though the service role posts one', async () => {
    const borrowerAttempt = await clientA.from('ledger_entry').insert({
      loan_id: loanA,
      kind: 'repayment',
      amount: -30_000,
      effective: '2026-08-28',
    });
    expect(borrowerAttempt.error).not.toBeNull();

    const lenderAttempt = await clientLender.from('ledger_entry').insert({
      loan_id: loanA,
      kind: 'fee',
      amount: 99,
      effective: '2026-08-28',
    });
    expect(lenderAttempt.error).not.toBeNull();

    // The positive control, and the reason the two refusals above mean
    // something: the same insert succeeds for the caller the ledger IS written
    // by. There is no delete for it, by design, so it goes with its loan by
    // cascade at teardown -- and it is posted against the OTHER loan, because
    // the balance assertions below name loan A's figures to the cent and a
    // probe that moved them would be a probe that had to be kept in step with
    // an arithmetic assertion in another file section.
    const posted = await insertLedgerEntry(service, {
      loan_id: loanOther,
      kind: 'fee',
      amount: '25.00',
      effective: '2026-08-28',
      memo: 'fixture: probe fee',
    });
    expect(posted?.amount).toBe('25.00');
  });

  // Append-only, and meant literally: no UPDATE and no DELETE for anyone,
  // service_role included. A ledger that can be edited after the fact is not a
  // ledger, and a leaked service key must not be able to make one agree with
  // whatever was said afterwards.
  it('cannot be rewritten or removed, by a client or by the service role', async () => {
    expect(
      (await clientA.from('ledger_entry').update({ amount: 0.01 }).eq('id', ledgerDraw)).error,
    ).not.toBeNull();
    expect(
      (await service.from('ledger_entry').update({ amount: 0.01 }).eq('id', ledgerDraw)).error,
    ).not.toBeNull();
    expect((await service.from('ledger_entry').delete().eq('id', ledgerDraw)).error).not.toBeNull();

    const entries = await listLedgerEntries(service, loanA);
    expect(entries.map((entry) => entry.amount)).toContain(loanDrawAmount);
  });
});

describe('the balance view', () => {
  it('is read by the borrower whose loan it derives from', async () => {
    const balance = await getLoanBalance(clientA, loanA);
    expect(balance?.loan_id).toBe(loanA);
  });

  it('is not read by another borrower, who reads their own', async () => {
    expect(await getLoanBalance(clientB, loanA)).toBeNull();
    expect((await getLoanBalance(clientB, loanOther))?.loan_id).toBe(loanOther);
  });

  it('is read by a lender at the organisation, and not by one elsewhere', async () => {
    expect((await getLoanBalance(clientLender, loanA))?.loan_id).toBe(loanA);
    expect(await getLoanBalance(clientLenderBeta, loanA)).toBeNull();
    expect((await getLoanBalance(clientLenderBeta, loanOther))?.loan_id).toBe(loanOther);
  });

  // The assertion this whole option exists to make.
  //
  // `available` is net of pending because the submit guard compares against
  // that same quantity. If the view and the guard disagreed, a borrower could
  // submit a request the screen had just told them was affordable -- and the
  // disagreement would be invisible until somebody reconciled a statement.
  //
  // The numbers are named rather than recomputed from the fixtures, so a view
  // that quietly stopped subtracting `pending` fails here with a figure a
  // reader can check by hand: 100000.00 limit, 40000.00 drawn less a 10000.00
  // repayment, 25000.00 held by the request under review, 45000.00 left.
  it('nets the borrower available credit against pending releases', async () => {
    const row = await getLoanBalance(clientA, loanA);
    expect(row).not.toBeNull();
    const balance = LoanBalanceSchema.parse(row);

    expect(balance.approved_limit).toBe(10_000_000);
    expect(balance.outstanding).toBe(3_000_000);
    expect(balance.pending).toBe(2_500_000);
    expect(balance.available).toBe(4_500_000);

    expect(borrowerAvailableCredit(balance)).toBe(balance.available);
    expect(lenderUndrawnLimit(balance) - borrowerAvailableCredit(balance)).toBe(balance.pending);
  });

  // Money arrives as text and not as the float PostgREST renders from a numeric
  // column. Asserted here, at the boundary, rather than trusted: JSON.parse
  // turns 45000.00 into a binary double before any schema sees it, and the cent
  // this codebase refuses to lose is lost by then.
  it('renders money as exact decimal text, not as a JSON number', async () => {
    const row = await getLoanBalance(clientA, loanA);
    expect(typeof row?.available).toBe('string');
    expect(row?.available).toBe('45000.00');
  });

  // A pending release holds credit and posts nothing, so submitting one must
  // move `available` and leave `outstanding` alone, and cancelling it must give
  // the credit back. The derivation is not a snapshot, and this is the cheapest
  // way to say so.
  //
  // Walked on the transient fixture rather than on the submitted one, and only
  // along edges the machine declares. `assert_legal_transition` refuses
  // anything else -- cancelled -> submitted included -- so a probe that
  // "restored" a fixture by writing a state backwards would be a probe fighting
  // the guard this schema exists to carry.
  it('holds credit while a request is pending and gives it back when cancelled', async () => {
    const before = LoanBalanceSchema.parse(await getLoanBalance(clientA, loanA));

    const submitted = await service
      .from('credit_release')
      .update({ state: 'submitted' })
      .eq('id', releaseTransient)
      .select('id');
    expect(submitted.error).toBeNull();

    const held = LoanBalanceSchema.parse(await getLoanBalance(clientA, loanA));
    expect(held.outstanding).toBe(before.outstanding);
    expect(held.pending).toBe(before.pending + 700_000);
    expect(held.available).toBe(before.available - 700_000);

    const cancelled = await service
      .from('credit_release')
      .update({ state: 'cancelled' })
      .eq('id', releaseTransient)
      .select('id');
    expect(cancelled.error).toBeNull();

    const after = LoanBalanceSchema.parse(await getLoanBalance(clientA, loanA));
    expect(after.outstanding).toBe(before.outstanding);
    expect(after.pending).toBe(before.pending);
    expect(after.available).toBe(before.available);
  });
});

describe('a credit release', () => {
  it('is read by the borrower who requested it', async () => {
    const rows = readable(await clientA.from('credit_release').select('id'));
    expect(ids(rows)).toEqual(
      [releaseDraft, releaseSubmitted, releaseDeclined, releaseTransient].sort(),
    );
  });

  it('is not read by another borrower, who reads their own', async () => {
    const rows = readable(await clientB.from('credit_release').select('id'));
    expect(ids(rows)).toEqual([releaseOther]);
  });

  it('is read by a lender at the organisation, and not by one elsewhere', async () => {
    const mine = readable(await clientLender.from('credit_release').select('id'));
    expect(mine.map((row) => row.id)).toContain(releaseSubmitted);

    const theirs = readable(await clientLenderBeta.from('credit_release').select('id'));
    expect(theirs.map((row) => row.id)).not.toContain(releaseSubmitted);
    expect(theirs.map((row) => row.id)).toContain(releaseOther);
  });

  // The compose-and-autosave path, and the positive control every refusal below
  // is measured against: a borrower really can write their own draft.
  it('is composed and autosaved by the borrower while it is a draft', async () => {
    const updated = await updateCreditRelease(clientA, {
      releaseId: releaseDraft,
      expectedRevision: 0,
      patch: { purpose: 'fixture: draft, edited' },
    });
    expect(updated?.revision).toBe(1);

    // And the revision guard: the same expected revision no longer matches.
    const stale = await updateCreditRelease(clientA, {
      releaseId: releaseDraft,
      expectedRevision: 0,
      patch: { purpose: 'fixture: draft, from a stale tab' },
    });
    expect(stale).toBeNull();
  });

  // A borrower who could write `state` could approve their own request. This is
  // a privilege refusal rather than a policy one, exactly as application.state
  // and document_slot.state are.
  it('cannot have its state written by the borrower who requested it', async () => {
    const { error } = await clientA
      .from('credit_release')
      .update({ state: 'approved' })
      .eq('id', releaseSubmitted);
    expect(error).not.toBeNull();

    const check = await service
      .from('credit_release')
      .select('state')
      .eq('id', releaseSubmitted)
      .single();
    expect(check.data?.state).toBe('submitted');
  });

  // Nor by the lender who is entitled to decide it. Approving is a transition,
  // and a transition goes through the API, which re-checks the role against the
  // machine and appends an event. A direct write would move the state with no
  // audit entry behind it, and would skip the revision check that makes two
  // lender tabs serialise.
  it('cannot have its state written by the lender either', async () => {
    const { error } = await clientLender
      .from('credit_release')
      .update({ state: 'approved' })
      .eq('id', releaseSubmitted);
    expect(error).not.toBeNull();
  });

  // decline_reason is lender-authored and borrower-readable, and no client
  // holds an UPDATE privilege on it -- because a borrower and a lender are the
  // same database role, so a grant wide enough for the lender is wide enough
  // for the borrower to forge one onto their own draft.
  it('takes no decline reason from any client, borrower or lender', async () => {
    expect(
      (
        await clientA
          .from('credit_release')
          .update({ decline_reason: 'forged by the borrower' })
          .eq('id', releaseDraft)
      ).error,
    ).not.toBeNull();
    expect(
      (
        await clientLender
          .from('credit_release')
          .update({ decline_reason: 'written without a decline' })
          .eq('id', releaseSubmitted)
      ).error,
    ).not.toBeNull();

    const check = await service
      .from('credit_release')
      .select('decline_reason')
      .eq('id', releaseDeclined)
      .single();
    expect(check.data?.decline_reason).toBe(releaseDeclineReason);
  });

  // `using` and `with check` on the update policy both require 'draft', so a
  // request that has left the borrower's hands is a record.
  it('cannot be edited by the borrower once it has been submitted', async () => {
    const updated = await updateCreditRelease(clientA, {
      releaseId: releaseSubmitted,
      expectedRevision: 0,
      patch: { purpose: 'edited after submitting' },
    });
    expect(updated).toBeNull();

    const check = await service
      .from('credit_release')
      .select('purpose')
      .eq('id', releaseSubmitted)
      .single();
    expect(check.data?.purpose).toBe('fixture: submitted');
  });

  // The positive control for the three refusals that follow: a borrower really
  // can start a request on their own loan, and really can abandon it.
  it('is started by the borrower on their own loan, and deleted again', async () => {
    const created = await insertCreditRelease(clientA, {
      loan_id: loanA,
      amount: '1000.00',
      purpose: 'fixture: probe draft',
      requested_by: borrowerA.id,
    });
    expect(created?.state).toBe('draft');
    expect(created?.revision).toBe(0);

    const releaseId = created?.id;
    if (releaseId === undefined) {
      throw new Error('the probe draft did not come back as inserted');
    }
    expect(await deleteCreditReleaseDraft(clientA, releaseId)).toBe(true);
  });

  it('cannot be started by a borrower against another borrower loan', async () => {
    const { error } = await clientB.from('credit_release').insert({
      loan_id: loanA,
      amount: 1000,
      purpose: 'fixture: forged',
      requested_by: borrowerB.id,
    });
    expect(error).not.toBeNull();
  });

  // A lender CAN see the loan, so "a loan the caller can see" would have been
  // the wrong predicate: the insert check pins it to the caller as the loan's
  // BORROWER. A lender inserting here would be fabricating a borrower's
  // request.
  it('cannot be started by a lender on a borrower loan', async () => {
    const { error } = await clientLender.from('credit_release').insert({
      loan_id: loanA,
      amount: 1000,
      purpose: 'fixture: fabricated by the lender',
      requested_by: lender.id,
    });
    expect(error).not.toBeNull();
  });

  it('cannot be attributed by a borrower to another user', async () => {
    const { error } = await clientA.from('credit_release').insert({
      loan_id: loanA,
      amount: 1000,
      purpose: 'fixture: misattributed',
      requested_by: borrowerB.id,
    });
    expect(error).not.toBeNull();
  });

  // Abandoning something never submitted is the borrower's to do; a request a
  // lender has seen is a record, and stays.
  it('cannot be deleted once it has been submitted', async () => {
    expect(await deleteCreditReleaseDraft(clientA, releaseSubmitted)).toBe(false);

    const check = await service.from('credit_release').select('id').eq('id', releaseSubmitted);
    expect(check.data?.length).toBe(1);
  });
});

describe('the lender-only note, from the borrower side', () => {
  // The column-versus-row argument, stated as an assertion. If internal_note
  // were a column on credit_release this key would be here, because the
  // borrower's own row policy admits the row whatever a projection omits.
  it('is not a column on the release the borrower can read', async () => {
    const { data, error } = await clientA
      .from('credit_release')
      .select('*')
      .eq('id', releaseDeclined)
      .single();
    expect(error).toBeNull();

    const row: Record<string, unknown> = data ?? {};
    expect(Object.keys(row)).not.toContain('internal_note');
    // The positive control on the same row: the borrower CAN read the reason,
    // which is the field the lender wrote FOR them. Two fields, one row, two
    // answers -- which is the whole point.
    expect(row['decline_reason']).toBe(releaseDeclineReason);
  });

  it('is not a column on the borrower projection either', async () => {
    const release = await getCreditReleaseForBorrower(clientA, releaseDeclined);
    expect(Object.keys(release ?? {})).not.toContain('internal_note');
    expect(release?.decline_reason).toBe(releaseDeclineReason);
  });

  // The sharp end: the note is about this borrower, on a release this borrower
  // owns, and they still cannot reach it.
  it('reads back as an empty set from credit_release_note', async () => {
    const rows = readable(
      await clientA.from('credit_release_note').select('*').eq('release_id', releaseDeclined),
    );
    expect(rows).toEqual([]);
    expect(await getCreditReleaseNote(clientA, releaseDeclined)).toBeNull();

    // The positive control, without which the assertion above would pass
    // against a note that was never written: the lender reads that exact row,
    // with that exact text.
    expect((await getCreditReleaseNote(clientLender, releaseDeclined))?.internal_note).toBe(
      releaseInternalNote,
    );
  });

  it('cannot be written by the borrower it is about', async () => {
    const inserted = await clientA.from('credit_release_note').insert({
      release_id: releaseDraft,
      internal_note: 'written by the borrower',
      recorded_by: borrowerA.id,
    });
    expect(inserted.error).not.toBeNull();

    // No policy admits the row, so this reports success and touches nothing --
    // the shape a client sees when a denial is a policy rather than a
    // privilege. The check below is what makes the difference legible.
    const updated = await clientA
      .from('credit_release_note')
      .update({ internal_note: 'rewritten by the borrower' })
      .eq('release_id', releaseDeclined)
      .select('release_id');
    expect(readable(updated)).toEqual([]);

    const check = await service
      .from('credit_release_note')
      .select('internal_note')
      .eq('release_id', releaseDeclined)
      .single();
    expect(check.data?.internal_note).toBe(releaseInternalNote);
  });

  // Under security_invoker the lender projection returns the borrower's own
  // release with the lender-only half null rather than a permission error. The
  // row being present is what makes the nulls meaningful.
  it('comes back null when a borrower reads the lender projection', async () => {
    const row = await getCreditReleaseForLender(clientA, releaseDeclined);
    expect(row?.id).toBe(releaseDeclined);
    expect(row?.decline_reason).toBe(releaseDeclineReason);
    expect(row?.internal_note).toBeNull();
    expect(row?.note_recorded_by).toBeNull();
    // `decided_by` is a column on a base table the borrower's policy admits, so
    // no view could withhold it and this one does not pretend to. What plan/06
    // means by "the lender sees who decided" is the NAME, and that is withheld
    // properly -- by the profile policies, which do not admit a lender's row to
    // a borrower.
    expect(row?.decided_by).toBe(lender.id);
    expect(row?.decided_by_name).toBeNull();
    // The positive control for that null: the join to `profile` DOES resolve a
    // name for this caller -- their own -- so the null above is the lender's
    // profile being withheld and not the join being empty.
    expect(row?.requested_by_name).not.toBeNull();
  });
});

describe('the lender-only note, from the lender side', () => {
  it('is read through the lender projection, with both names resolved', async () => {
    const row = await getCreditReleaseForLender(clientLender, releaseDeclined);
    expect(row?.internal_note).toBe(releaseInternalNote);
    expect(row?.note_recorded_by).toBe(lender.id);
    // The name the borrower could not read, read here by the caller entitled
    // to it. That pairing is the whole of "two roles, two truths" on one row.
    expect(row?.decided_by_name).toBe('Fixture Lender');
    expect(row?.requested_by_name).not.toBeNull();
    expect(row?.borrower_id).toBe(borrowerA.id);
  });

  // The lender's mid-decision draft, which is plan/06's third refresh case. It
  // is safe to autosave straight from the browser precisely because a borrower
  // holds no policy on this table at all.
  it('is written and amended by the lender, in one upsert either way', async () => {
    const written = await upsertCreditReleaseNote(clientLender, {
      release_id: releaseSubmitted,
      internal_note: 'triage: waiting on the elevator confirmation',
      recorded_by: lender.id,
    });
    expect(written?.internal_note).toBe('triage: waiting on the elevator confirmation');

    const amended = await upsertCreditReleaseNote(clientLender, {
      release_id: releaseSubmitted,
      internal_note: 'triage: confirmation received',
      recorded_by: lender.id,
    });
    expect(amended?.internal_note).toBe('triage: confirmation received');

    const rows = await service
      .from('credit_release_note')
      .select('release_id')
      .eq('release_id', releaseSubmitted);
    expect(rows.data?.length).toBe(1);
  });

  // recorded_at is stamped by the trigger on insert and on update, so an
  // amended note cannot keep -- or claim -- the instant of the first draft.
  it('cannot have its timestamp chosen or backdated by the lender', async () => {
    const backdated = new Date(Date.now() - 86_400_000).toISOString();
    const { error } = await clientLender
      .from('credit_release_note')
      .update({ recorded_at: backdated })
      .eq('release_id', releaseDeclined);
    expect(error).not.toBeNull();

    const check = await service
      .from('credit_release_note')
      .select('recorded_at')
      .eq('release_id', releaseDeclined)
      .single();
    expect(check.data?.recorded_at).not.toBe(backdated);
  });

  it('cannot be attributed by a lender to a colleague', async () => {
    const inserted = await clientLender.from('credit_release_note').insert({
      release_id: releaseDraft,
      internal_note: 'attributed to somebody else',
      recorded_by: lenderBeta.id,
    });
    expect(inserted.error).not.toBeNull();

    const reattributed = await clientLender
      .from('credit_release_note')
      .update({ recorded_by: lenderBeta.id })
      .eq('release_id', releaseDeclined)
      .select('release_id');
    expect(readable(reattributed)).toEqual([]);

    const check = await service
      .from('credit_release_note')
      .select('recorded_by')
      .eq('release_id', releaseDeclined)
      .single();
    expect(check.data?.recorded_by).toBe(lender.id);
  });

  it('is not read or written by a lender at another organisation', async () => {
    expect(await getCreditReleaseNote(clientLenderBeta, releaseDeclined)).toBeNull();

    const written = await clientLenderBeta
      .from('credit_release_note')
      .update({ internal_note: 'written from the other organisation' })
      .eq('release_id', releaseDeclined)
      .select('release_id');
    expect(readable(written)).toEqual([]);

    // The positive control: the beta lender reads their OWN organisation's
    // note, so the two refusals above are about the policy and not about a
    // lender who can do nothing at all.
    expect((await getCreditReleaseNote(clientLenderBeta, releaseOther))?.internal_note).toBe(
      otherInternalNote,
    );
  });
});

describe('the release timeline', () => {
  // 0002_rls.sql whitelists `machine = 'application'` on workflow_event and
  // says each machine's clause is added by the migration that creates its
  // table. 0007 adds credit_release as a SECOND policy, because migrations are
  // append-only and permissive policies for one command are OR'd.
  it('is read by the borrower whose release it records', async () => {
    const rows = readable(
      await clientA.from('workflow_event').select('subject_id').eq('machine', 'credit_release'),
    );
    expect(rows.map((row) => row.subject_id)).toEqual([releaseSubmitted]);
  });

  it('is not read by another borrower, who reads their own', async () => {
    const rows = readable(
      await clientB.from('workflow_event').select('subject_id').eq('machine', 'credit_release'),
    );
    expect(rows.map((row) => row.subject_id)).toEqual([releaseOther]);
  });

  it('is read by a lender at the organisation, and not by one elsewhere', async () => {
    const mine = readable(
      await clientLender
        .from('workflow_event')
        .select('subject_id')
        .eq('machine', 'credit_release'),
    );
    expect(mine.map((row) => row.subject_id)).toContain(releaseSubmitted);

    const theirs = readable(
      await clientLenderBeta
        .from('workflow_event')
        .select('subject_id')
        .eq('machine', 'credit_release'),
    );
    expect(theirs.map((row) => row.subject_id)).not.toContain(releaseSubmitted);
    expect(theirs.map((row) => row.subject_id)).toContain(releaseOther);
  });

  it('takes no forged entry from a client', async () => {
    const { error } = await clientA.from('workflow_event').insert({
      machine: 'credit_release',
      subject_id: releaseSubmitted,
      to_state: 'approved',
      event: 'approve',
      actor_id: borrowerA.id,
      actor_role: 'lender',
    });
    expect(error).not.toBeNull();
  });
});

describe('the servicing query helpers', () => {
  it('give the lender a queue of everything still holding credit, oldest first', async () => {
    const queued = (await listCreditReleaseQueue(clientLender)).map((row) => row.id);
    expect(queued).toContain(releaseSubmitted);
    // Settled and unsubmitted requests are not work.
    expect(queued).not.toContain(releaseDeclined);
    expect(queued).not.toContain(releaseDraft);
    // And the queue is the caller's organisation, with no filter written here
    // to forget.
    expect(queued).not.toContain(releaseOther);

    const betaQueue = await listCreditReleaseQueue(clientLenderBeta);
    expect(betaQueue.map((row) => row.id)).toEqual([releaseOther]);
  });

  it('give the borrower their own loan releases, newest first', async () => {
    const rows = await listCreditReleasesForBorrower(clientA, loanA);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [releaseDraft, releaseSubmitted, releaseDeclined, releaseTransient].sort(),
    );
  });

  it('return nothing to a caller no policy admits', async () => {
    expect(await listCreditReleasesForBorrower(clientB, loanA)).toEqual([]);
    expect(await getCreditRelease(clientB, releaseSubmitted)).toBeNull();
    expect(await getLoan(clientB, loanA)).toBeNull();
    expect(await listLedgerEntries(clientB, loanA)).toEqual([]);
    expect(await listLoans(clientB)).not.toEqual([]);
  });

  // The boundary this layer exists to get right. Every money column is selected
  // as `column::text`, so the exact decimal Postgres rendered is what arrives;
  // an uncast select would hand back a binary double and look correct doing it.
  it('carry every money column as exact decimal text', async () => {
    const loan = await getLoan(clientA, loanA);
    expect(loan?.approved_limit).toBe(loanApprovedLimit);

    const amounts = (await listLedgerEntries(clientA, loanA)).map((entry) => entry.amount);
    expect(amounts).toContain(loanDrawAmount);
    expect(amounts).toContain(loanRepaymentAmount);

    const release = await getCreditRelease(clientA, releaseSubmitted);
    expect(release?.amount).toBe(releaseSubmittedAmount);
  });
});

// Realtime ------------------------------------------------------------------
//
// `supabase_realtime` exists in a fresh Supabase database and contains NO
// TABLES until a migration adds one. `[realtime] enabled = true` in
// supabase/config.toml, so the service runs, a client subscribes and the
// subscription reports SUBSCRIBED -- and then nothing is ever delivered.
// Nothing errors and nothing logs, which is the worst shape a defect can have,
// because it is indistinguishable from "no changes happened yet".
//
// So the probe is functional rather than a check that a statement is present in
// a file: it subscribes as a real end user and waits for a real change. That is
// the only assertion that can tell a published table from an unpublished one,
// and it is the same code path plan/06's two-window demo runs on.
//
// These are the last tests in the file on purpose: each one moves a fixture row
// to generate the change it waits for.

const REALTIME_PROBE_WINDOW_MS = 40_000;
const REALTIME_PROBE_RETRY_MS = 2_000;

/**
 * Waits for the row change `column = expected` to arrive over the socket, or
 * fails with a timeout that names the likely cause.
 *
 * Two things here are about realtime's shape rather than about caution.
 *
 * It waits for the MATCHING payload rather than for the first one. Realtime
 * reads the write-ahead log a beat behind the writer and fans out to whichever
 * channels are subscribed when it gets there, so a subscription opened moments
 * after an earlier update to the same row can legitimately be handed that
 * earlier update first. Resolving on the first payload made this fail with the
 * PREVIOUS value of the column, which looks like a broken publication and is
 * not one.
 *
 * It also re-issues the change every two seconds until one arrives, rather than
 * writing once and waiting. `SUBSCRIBED` says the channel has joined; it does
 * not say the replication side is delivering yet, and on a stack whose realtime
 * container has just started the first subscription of a run can miss a change
 * written immediately after it. The retry costs nothing when the socket is warm
 * -- the first payload arrives in milliseconds -- and it removes the only
 * failure mode this probe had that was not about the publication. An UPDATE
 * writing the same value still writes a new row version, so a repeat is a real
 * change as far as the log is concerned.
 */
async function awaitRowChange(
  user: TestUser,
  table: 'credit_release' | 'document_slot',
  rowId: string,
  column: string,
  expected: string,
  // PromiseLike, not Promise: PostgREST's builder is a thenable that only
  // issues its request when awaited, and it has no .catch of its own.
  change: () => PromiseLike<unknown>,
): Promise<void> {
  const client = clientAs(user.token);
  // The socket carries its own credentials: the Authorization header on the
  // REST client does not reach the websocket, and without this the subscriber
  // is `anon`, whom no policy admits.
  await client.realtime.setAuth(user.token);

  let retry: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = (): void => {
        clearTimeout(timer);
        if (retry !== undefined) {
          clearInterval(retry);
        }
      };
      const timer = setTimeout(() => {
        stop();
        reject(
          new Error(
            `no realtime payload for ${table}.${column} within ` +
              `${String(REALTIME_PROBE_WINDOW_MS / 1000)}s; is the table in the ` +
              'supabase_realtime publication? (0007_servicing.sql adds it)',
          ),
        );
      }, REALTIME_PROBE_WINDOW_MS);

      const write = (): void => {
        void Promise.resolve(change()).catch((error: unknown) => {
          stop();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      client
        .channel(`probe-${table}-${rowId}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table, filter: `id=eq.${rowId}` },
          (payload) => {
            const row = payload.new as Record<string, unknown>;
            if (row[column] === expected) {
              stop();
              resolve();
            }
          },
        )
        .subscribe((status) => {
          // The change is made only once the subscription is live, otherwise
          // the probe races the socket and fails for the wrong reason.
          if (status === 'SUBSCRIBED') {
            write();
            retry = setInterval(write, REALTIME_PROBE_RETRY_MS);
          }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            stop();
            reject(new Error(`realtime subscription for ${table} reported ${status}`));
          }
        });
    });
  } finally {
    if (retry !== undefined) {
      clearInterval(retry);
    }
    await client.removeAllChannels();
  }
}

describe('the realtime publication', () => {
  // plan/06 calls the two-window demo "a few lines and the whole demo". Those
  // few lines are inert unless credit_release is published, and nothing about
  // an inert subscription looks wrong from the outside: the client connects,
  // the channel reports SUBSCRIBED, and no row ever arrives.
  //
  // Verified to discriminate, not merely to pass: pointed at `application`,
  // which 0007 deliberately does NOT publish, this same helper times out.
  it('delivers a credit_release change to the borrower it belongs to', async () => {
    const moved = 'fixture: transient, seen over realtime';
    await awaitRowChange(borrowerA, 'credit_release', releaseTransient, 'purpose', moved, () =>
      service.from('credit_release').update({ purpose: moved }).eq('id', releaseTransient),
    );
  }, 60_000);

  // Phase 6 deferred realtime on the document pack for want of a channel
  // factory. The factory exists now, and the table being published is the other
  // half of it -- added by 0007 rather than left for whoever picks that up to
  // rediscover from a screen that silently never updates.
  it('delivers a document_slot change to the borrower it belongs to', async () => {
    const moved = 'Land title or lease, seen over realtime';
    await awaitRowChange(borrowerA, 'document_slot', slotReviewed, 'label', moved, () =>
      service.from('document_slot').update({ label: moved }).eq('id', slotReviewed),
    );
  }, 60_000);
});
