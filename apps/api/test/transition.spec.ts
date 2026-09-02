// The endpoints, probed against a real database.
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
  insertDocumentUpload,
  listEligibilitySnapshots,
  listWorkflowEvents,
  type EligibilitySnapshot,
  type Json,
} from '@lj/db';
import { createServiceRoleClient, type ServiceRoleClient } from '@lj/db/service-role';
import { RuleResultSchema, type RuleResult } from '@lj/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runEffects } from '../lib/effects.ts';
import { POST as CORRECTION } from '../src/routes/documents-correction.ts';
import { POST as DOWNLOAD_URL } from '../src/routes/documents-download-url.ts';
import { POST as UPLOAD_URL } from '../src/routes/documents-upload-url.ts';
import { POST } from '../src/routes/transition.ts';

const TRANSITION_URL = 'https://lj-api.example/api/transition';
const UPLOAD_URL_URL = 'https://lj-api.example/api/documents/upload-url';
const DOWNLOAD_URL_URL = 'https://lj-api.example/api/documents/download-url';
const CORRECTION_URL = 'https://lj-api.example/api/documents/correction';

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

/** The document routes answer in the same shape, so one caller serves both. */
async function postTo(
  handler: (request: Request) => Promise<Response>,
  url: string,
  token: string | null,
  body: unknown,
): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const response = await handler(
    new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
  const raw = await response.text();
  const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
  return { status: response.status, payload: (parsed ?? {}) as Record<string, unknown>, raw };
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

/**
 * A slot written straight into the state a case needs.
 *
 * Inserted at its final state rather than walked there, which is the pattern
 * 0004_demo_data.sql uses and for the same reason: the BEFORE UPDATE trigger
 * reads `workflow_transition`, so walking a fixture through the machine makes
 * every case depend on the machine it is meant to be testing. An INSERT is not
 * a transition and the trigger does not fire on one.
 */
async function insertSlot(values: {
  applicationId: string;
  code: string;
  label: string;
  state: string;
  required?: boolean;
  extractRequired?: string[];
  validUntil?: string | null;
}): Promise<string> {
  const { data, error } = await service
    .from('document_slot')
    .insert({
      application_id: values.applicationId,
      code: values.code,
      label: values.label,
      state: values.state,
      required: values.required ?? true,
      extract_required: values.extractRequired ?? [],
      valid_until: values.validUntil ?? null,
    })
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture document_slot failed: ${error?.message ?? 'no row'}`);
  }
  return data.id;
}

async function readSlot(slotId: string): Promise<{ state: string; revision: number }> {
  const { data, error } = await service
    .from('document_slot')
    .select('state, revision')
    .eq('id', slotId)
    .single();
  if (error !== null || data === null) {
    throw new Error(`could not read slot ${slotId}: ${error?.message ?? 'no row'}`);
  }
  return { state: data.state, revision: data.revision };
}

/**
 * A file recorded against a slot, with an extraction written by hand.
 *
 * The values are the input to the completeness rules, so they are stated here
 * rather than produced by an upload: what is under test is the verdict, and
 * driving four uploads through storage to reach it would make these cases
 * depend on the extractor as well.
 */
async function insertUpload(values: {
  slotId: string;
  filename: string;
  extracted: Json;
}): Promise<string> {
  const row = await insertDocumentUpload(service, {
    slot_id: values.slotId,
    storage_path: `fixture/${values.slotId}/${values.filename}`,
    filename: values.filename,
    bytes: 4,
    mime: 'application/pdf',
    extracted: values.extracted,
    extraction_state: 'extracted',
  });
  if (row === null) {
    throw new Error('fixture document_upload failed');
  }
  return row.id;
}

/** A machine reading the rules will trust: above the floor, and from the ocr. */
function readable(value: Json): Json {
  return { value, confidence_basis_points: 9_200, source: 'ocr' };
}

/**
 * Missing, stale and unreadable, in one pack, plus a slot that is finished.
 *
 * The three are kept apart because the borrower's next action differs in each
 * case -- upload something, upload a newer one, upload a clearer scan -- and
 * collapsing them into one red dot is the version plan/04 calls lazy.
 */
async function buildIncompletePack(): Promise<void> {
  const [, stale, unreadable] = await Promise.all([
    // FINISHED: accepted, no expiry, both required fields read.
    insertSlot({
      applicationId: appPackIncomplete,
      code: 'land_title',
      label: 'Land title or lease',
      state: 'accepted',
      extractRequired: ['total_acres', 'owner_name'],
    }),
    // STALE: accepted, and expired years ago.
    insertSlot({
      applicationId: appPackIncomplete,
      code: 'crop_insurance',
      label: 'Crop insurance certificate',
      state: 'accepted',
      extractRequired: ['valid_until'],
      validUntil: '2020-01-31',
    }),
    // UNREADABLE: accepted, but the figure came back below the floor.
    insertSlot({
      applicationId: appPackIncomplete,
      code: 'tax_return_2024',
      label: '2024 tax return',
      state: 'accepted',
      extractRequired: ['net_farm_income'],
    }),
    // MISSING: nothing uploaded at all.
    insertSlot({
      applicationId: appPackIncomplete,
      code: 'id_verification',
      label: 'Photo identification',
      state: 'required',
    }),
  ]);

  const finished = (await readSlotsWithIds(appPackIncomplete)).find(
    (slot) => slot.code === 'land_title',
  );
  await Promise.all([
    insertUpload({
      slotId: finished?.id ?? '',
      filename: 'deed_1240ac_smith-farms.pdf',
      extracted: { total_acres: readable(1240), owner_name: readable('Smith Farms') },
    }),
    insertUpload({
      slotId: stale ?? '',
      filename: 'crop_insurance_2020-01-31.pdf',
      extracted: { valid_until: readable('2020-01-31') },
    }),
    insertUpload({
      slotId: unreadable ?? '',
      filename: 'scan0003.pdf',
      // Below EXTRACTION_CONFIDENCE_FLOOR_BASIS_POINTS, so the rules read it as
      // not read at all -- which is what "could not read" means.
      extracted: {
        net_farm_income: { value: 18_420_000, confidence_basis_points: 4_100, source: 'ocr' },
      },
    }),
  ]);
}

async function buildCompletePack(): Promise<void> {
  const [title, identity] = await Promise.all([
    insertSlot({
      applicationId: appPackComplete,
      code: 'land_title',
      label: 'Land title or lease',
      state: 'accepted',
      extractRequired: ['total_acres'],
    }),
    insertSlot({
      applicationId: appPackComplete,
      code: 'id_verification',
      label: 'Photo identification',
      state: 'accepted',
      extractRequired: [],
      validUntil: '2099-12-31',
    }),
  ]);

  await Promise.all([
    insertUpload({
      slotId: title ?? '',
      filename: 'deed_980ac_fenwick-grain.pdf',
      extracted: { total_acres: readable(980) },
    }),
    insertUpload({
      slotId: identity ?? '',
      filename: 'id_2099-12-31.pdf',
      extracted: { valid_until: readable('2099-12-31') },
    }),
  ]);
}

async function readSlotsWithIds(
  applicationId: string,
): Promise<{ id: string; code: string }[]> {
  const { data, error } = await service
    .from('document_slot')
    .select('id, code')
    .eq('application_id', applicationId);
  if (error !== null || data === null) {
    throw new Error(`could not read slots of ${applicationId}: ${error?.message ?? 'none'}`);
  }
  return data;
}

async function readUploads(slotId: string): Promise<
  {
    id: string;
    storage_path: string;
    filename: string;
    mime: string;
    bytes: number;
    extraction_state: string;
    extracted: Json;
  }[]
> {
  const { data, error } = await service
    .from('document_upload')
    .select('id, storage_path, filename, mime, bytes, extraction_state, extracted')
    .eq('slot_id', slotId)
    .order('uploaded_at', { ascending: false });
  if (error !== null || data === null) {
    throw new Error(`could not read uploads of ${slotId}: ${error?.message ?? 'no rows'}`);
  }
  return data;
}

function extractedField(
  row: { extracted: Json },
  field: string,
): { value: unknown; confidence_basis_points: number; source: string } | undefined {
  const extracted = row.extracted as Record<string, unknown> | null;
  const value = extracted?.[field];
  return value as
    | { value: unknown; confidence_basis_points: number; source: string }
    | undefined;
}

/**
 * The whole round trip a browser makes: ask for somewhere to put the file, PUT
 * the bytes straight to storage on the signed url, and fire the transition.
 *
 * The bytes go through an ANON client, because that is what the browser has.
 * The API never sees them.
 */
async function uploadFile(
  token: string,
  slotId: string,
  filename: string,
): Promise<{ path: string; issued: Answer }> {
  const issued = await postTo(UPLOAD_URL, UPLOAD_URL_URL, token, {
    slotId,
    filename,
    mime: 'application/pdf',
    bytes: 4,
  });
  if (issued.status !== 200) {
    throw new Error(`upload url refused: ${issued.raw}`);
  }
  const path = String(issued.payload['path']);
  const anon = createAnonClient({ url: stack.url, anonKey: stack.anonKey });
  const { error } = await anon.storage
    .from('documents')
    .uploadToSignedUrl(path, String(issued.payload['token']), new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
    });
  if (error !== null) {
    throw new Error(`uploadToSignedUrl failed: ${error.message}`);
  }
  storedObjects.push(path);
  return { path, issued };
}

async function slotEventCount(slotId: string): Promise<number> {
  return (await listWorkflowEvents(service, 'document_slot', slotId)).length;
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

/**
 * A funded application with a facility behind it, and optionally one draw.
 *
 * Written straight into its final shape rather than walked there: what is under
 * test is how a release is adjudicated against a balance, not the funding that
 * produced it, and a suite that walked every fixture through the machine would
 * fail for reasons that have nothing to do with the case.
 *
 * Money goes IN as text for the same reason it comes out that way -- PostgREST
 * accepts the exact decimal and Postgres parses it without a float in between.
 */
async function insertFundedLoan(values: {
  borrowerId: string;
  orgId: string;
  productId: string;
  approvedLimit: string;
  /** One opening draw, or null for a facility nothing has been taken from. */
  drawn: string | null;
  status?: string;
}): Promise<{ applicationId: string; loanId: string }> {
  const applicationId = await insertApplication({
    borrowerId: values.borrowerId,
    orgId: values.orgId,
    state: 'funded',
    revision: 5,
  });
  const { data, error } = await service
    .from('loan')
    .insert({
      application_id: applicationId,
      borrower_id: values.borrowerId,
      org_id: values.orgId,
      product_id: values.productId,
      approved_limit: values.approvedLimit,
      rate_bps: 875,
      status: values.status ?? 'active',
    } as never)
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture loan failed: ${error?.message ?? 'no row'}`);
  }
  const loanId = data.id;

  if (values.drawn !== null) {
    const { error: ledgerError } = await service.from('ledger_entry').insert({
      loan_id: loanId,
      kind: 'draw',
      amount: values.drawn,
      effective: '2026-01-15',
      memo: 'Api probe opening advance',
    } as never);
    if (ledgerError !== null) {
      throw new Error(`fixture ledger entry failed: ${ledgerError.message}`);
    }
  }
  return { applicationId, loanId };
}

async function insertRelease(values: {
  loanId: string;
  amount: string;
  state: string;
  requestedBy: string;
  purpose?: string;
}): Promise<string> {
  const { data, error } = await service
    .from('credit_release')
    .insert({
      loan_id: values.loanId,
      amount: values.amount,
      purpose: values.purpose ?? 'Api probe draw',
      state: values.state,
      requested_by: values.requestedBy,
    } as never)
    .select('id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`fixture credit release failed: ${error?.message ?? 'no row'}`);
  }
  return data.id;
}

interface ReleaseFixtureRow {
  readonly state: string;
  readonly revision: number;
  readonly amount: string;
  readonly decided_by: string | null;
  readonly decline_reason: string | null;
}

async function readRelease(releaseId: string): Promise<ReleaseFixtureRow> {
  const { data, error } = await service
    .from('credit_release')
    .select('state, revision, amount::text, decided_by, decline_reason')
    .eq('id', releaseId)
    .single();
  if (error !== null || data === null) {
    throw new Error(`could not read release ${releaseId}: ${error?.message ?? 'no row'}`);
  }
  return data as unknown as ReleaseFixtureRow;
}

interface BalanceFixtureRow {
  readonly approved_limit: string;
  readonly outstanding: string;
  readonly pending: string;
  readonly available: string;
}

/**
 * `loan_balance_v` as the borrower's screen reads it, every figure as text.
 *
 * The view is the thing the guard's cap has to agree with, so the assertions
 * that matter read it here rather than restating the arithmetic -- a test that
 * recomputed `limit - outstanding - pending` would pass even if the view and
 * the guard had drifted apart, which is the one bug plan/06 is about.
 */
async function readBalance(loanId: string): Promise<BalanceFixtureRow> {
  const { data, error } = await service
    .from('loan_balance_v')
    .select('approved_limit::text, outstanding::text, pending::text, available::text')
    .eq('loan_id', loanId)
    .single();
  if (error !== null || data === null) {
    throw new Error(`could not read the balance of ${loanId}: ${error?.message ?? 'no row'}`);
  }
  return data as unknown as BalanceFixtureRow;
}

async function releaseEventCount(releaseId: string): Promise<number> {
  return (await listWorkflowEvents(service, 'credit_release', releaseId)).length;
}

/** One blocker by rule id, so a case can assert on the criterion it is about. */
function blockerById(answer: Answer, id: string): RuleResult {
  const found = ruleResults(answer).find((result) => result.id === id);
  if (found === undefined) {
    throw new Error(`no blocker with id ${id}; got ${JSON.stringify(blockersOf(answer))}`);
  }
  return found;
}

interface LoanFixtureRow {
  readonly id: string;
  readonly borrower_id: string;
  readonly org_id: string;
  readonly product_id: string;
  readonly approved_limit: string;
  readonly rate_bps: number;
  readonly status: string;
}

/**
 * The facilities one application has opened, money as exact decimal text.
 *
 * `approved_limit::text`, for the reason every money select in @lj/db carries
 * the cast: PostgREST renders `numeric` as a JSON number, so an uncast read
 * hands the assertion a binary double and the test agrees with the very
 * rounding it exists to catch.
 */
async function readLoans(applicationId: string): Promise<readonly LoanFixtureRow[]> {
  const { data, error } = await service
    .from('loan')
    .select('id, borrower_id, org_id, product_id, approved_limit::text, rate_bps, status')
    .eq('application_id', applicationId);
  if (error !== null) {
    throw new Error(`could not read the loans of ${applicationId}: ${error.message}`);
  }
  return (data ?? []) as unknown as readonly LoanFixtureRow[];
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
/** approved, org alpha, with the payload that took it there. Funded once. */
let appApproved: string;
/** approved, org alpha, naming no product. Funding must refuse and write nothing. */
let appFundNoProduct: string;
/** approved, org alpha, naming a product but no amount. Same, for the limit. */
let appFundNoAmount: string;
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
/** docs_pending, org alpha. Slots written straight into `extracted`. */
let appForDecision: string;
let slotToAccept: string;
let slotToReject: string;
let slotUntouched: string;
/** extracted, so no file may be added while the lender is deciding. */
let slotAwaitingDecision: string;
/** docs_pending, org alpha. The end-to-end upload; its bucket folder is used. */
let appForUpload: string;
let slotForFullRead: string;
let slotForPartialRead: string;
let slotWithNoFile: string;
/** docs_pending, org alpha, a pack failing in all three distinct ways. */
let appPackIncomplete: string;
/** docs_pending, org alpha, every required slot accepted and valid. */
let appPackComplete: string;
/** docs_pending, org alpha, with no slots at all. */
let appPackEmpty: string;
/** Every object this run put in the bucket, removed in afterAll. */
const storedObjects: string[] = [];
/** submitted, org alpha, naming a product whose document pack does not parse. */
let appUnreadablePack: string;

let productAlpha: string;
let productUnreadablePack: string;

/**
 * The servicing fixtures.
 *
 * One loan per concern rather than one loan with every release on it, and that
 * is not tidiness: two of the four availability rules read the OTHER releases
 * of the same loan -- `pending` is netted out of the borrower's available
 * credit, and `no_other_pending_release` is a policy in its own right -- so a
 * shared facility would make every case depend on which ran first.
 *
 * Every application behind these is `funded`, which is what a loan comes out
 * of, and each carries the applications' own audience: a release is readable by
 * whoever may read the application its loan came from, and nothing else.
 */
/** limit 250000.00, drawn 100000.00, so available is 150000.00. */
let appSubmitLoan: string;
let loanForSubmit: string;
let releaseWithinAvailable: string;
/** The same figures, with a request larger than they allow. */
let appTooLargeLoan: string;
let loanForTooLarge: string;
let releaseTooLarge: string;
/** limit 250000.00, drawn 10000.00. Every lender decision runs here. */
let appDecideLoan: string;
let loanForDecisions: string;
let releaseToApprove: string;
let releaseToDecline: string;
let releaseStale: string;
let releaseForRoleRefusal: string;
let releaseCancelled: string;
/** A closed facility: no further credit, but a request already with the lender. */
let appClosedLoan: string;
let loanClosed: string;
let releaseOnClosedLoan: string;
let releaseToCancel: string;
/** Org beta, another borrower. The tenant boundary on a release. */
let appForeignLoan: string;
let loanForeign: string;
let releaseForeign: string;
/** limit 250000.00, drawn 10000.00, one approved release awaiting its money. */
let appDisburseLoan: string;
let loanForDisburse: string;
let releaseToDisburse: string;

const SUBMITTED_REVISION = 3;
const DOCS_PENDING_REVISION = 4;

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
 * The same payload with the requested amount taken out.
 *
 * The figure funding opens the facility with, and the one thing the request
 * step contributes to a loan that no other row carries. A payload without it
 * parses -- every leaf is nullable, because a draft is partial by definition --
 * so nothing below the delivery layer refuses it, and the facility would
 * otherwise be opened for an amount nobody asked for.
 */
function payloadWithoutRequestedAmount(productId: string): Json {
  const payload = completePayload(productId) as Record<string, Json>;
  const request = { ...(payload['request'] as Record<string, Json>) };
  delete request['amount_requested_minor'];
  return { ...payload, request };
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
    appFundNoProduct,
    appFundNoAmount,
    appForeign,
    appComplete,
    appStale,
    appCorrupt,
    appCorruptToWithdraw,
    appUnreadablePack,
    appForPack,
    appForDecision,
    appForUpload,
    appPackIncomplete,
    appPackComplete,
    appPackEmpty,
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
      // Funding opens the facility from this payload, so an approved row with
      // an empty one is a row no borrower could have produced -- reaching
      // `approved` means the submit guard passed, and that needs every step.
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'approved',
        revision: 2,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'approved',
        revision: 0,
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'approved',
        revision: 0,
        data: payloadWithoutRequestedAmount(productAlpha),
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
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'docs_pending',
        revision: DOCS_PENDING_REVISION,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'docs_pending',
        revision: DOCS_PENDING_REVISION,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'docs_pending',
        revision: DOCS_PENDING_REVISION,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'docs_pending',
        revision: DOCS_PENDING_REVISION,
        data: completePayload(productAlpha),
      }),
      insertApplication({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        state: 'docs_pending',
        revision: DOCS_PENDING_REVISION,
        data: completePayload(productAlpha),
      }),
    ]);

  // A pack that fails in all three distinct ways at once, plus one slot that is
  // simply finished. Written straight into their final states, because what is
  // under test is the evaluation and not the walk that produced it.
  await buildIncompletePack();
  await buildCompletePack();

  [slotToAccept, slotToReject, slotUntouched, slotAwaitingDecision] = await Promise.all([
    insertSlot({
      applicationId: appForDecision,
      code: 'land_title',
      label: 'Land title or lease',
      state: 'extracted',
    }),
    insertSlot({
      applicationId: appForDecision,
      code: 'tax_return_2024',
      label: '2024 tax return',
      state: 'extracted',
    }),
    insertSlot({
      applicationId: appForDecision,
      code: 'id_verification',
      label: 'Photo identification',
      state: 'required',
    }),
    insertSlot({
      applicationId: appForDecision,
      code: 'crop_insurance',
      label: 'Crop insurance certificate',
      state: 'extracted',
    }),
  ]);

  const [submitLoan, tooLargeLoan, decideLoan, closedLoan, foreignLoan, disburseLoan] =
    await Promise.all([
      insertFundedLoan({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        productId: productAlpha,
        approvedLimit: '250000.00',
        drawn: '100000.00',
      }),
      insertFundedLoan({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        productId: productAlpha,
        approvedLimit: '250000.00',
        drawn: '100000.00',
      }),
      insertFundedLoan({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        productId: productAlpha,
        approvedLimit: '250000.00',
        drawn: '10000.00',
      }),
      insertFundedLoan({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        productId: productAlpha,
        approvedLimit: '250000.00',
        drawn: '10000.00',
        status: 'closed',
      }),
      insertFundedLoan({
        borrowerId: otherBorrower.id,
        orgId: orgBeta,
        productId: productAlpha,
        approvedLimit: '250000.00',
        drawn: null,
      }),
      insertFundedLoan({
        borrowerId: borrower.id,
        orgId: orgAlpha,
        productId: productAlpha,
        approvedLimit: '250000.00',
        drawn: '10000.00',
      }),
    ]);
  ({ applicationId: appSubmitLoan, loanId: loanForSubmit } = submitLoan);
  ({ applicationId: appTooLargeLoan, loanId: loanForTooLarge } = tooLargeLoan);
  ({ applicationId: appDecideLoan, loanId: loanForDecisions } = decideLoan);
  ({ applicationId: appClosedLoan, loanId: loanClosed } = closedLoan);
  ({ applicationId: appForeignLoan, loanId: loanForeign } = foreignLoan);
  ({ applicationId: appDisburseLoan, loanId: loanForDisburse } = disburseLoan);

  [
    releaseWithinAvailable,
    releaseTooLarge,
    releaseToApprove,
    releaseToDecline,
    releaseStale,
    releaseForRoleRefusal,
    releaseCancelled,
    releaseOnClosedLoan,
    releaseToCancel,
    releaseForeign,
    releaseToDisburse,
  ] = await Promise.all([
    insertRelease({
      loanId: loanForSubmit,
      amount: '50000.00',
      state: 'draft',
      requestedBy: borrower.id,
    }),
    // 200000.00 against 150000.00 available: a shortfall of exactly 50000.00.
    insertRelease({
      loanId: loanForTooLarge,
      amount: '200000.00',
      state: 'draft',
      requestedBy: borrower.id,
    }),
    insertRelease({
      loanId: loanForDecisions,
      amount: '20000.00',
      state: 'under_review',
      requestedBy: borrower.id,
    }),
    insertRelease({
      loanId: loanForDecisions,
      amount: '15000.00',
      state: 'under_review',
      requestedBy: borrower.id,
    }),
    insertRelease({
      loanId: loanForDecisions,
      amount: '5000.00',
      state: 'under_review',
      requestedBy: borrower.id,
    }),
    insertRelease({
      loanId: loanForDecisions,
      amount: '5000.00',
      state: 'submitted',
      requestedBy: borrower.id,
    }),
    insertRelease({
      loanId: loanForDecisions,
      amount: '1000.00',
      state: 'cancelled',
      requestedBy: borrower.id,
    }),
    insertRelease({
      loanId: loanClosed,
      amount: '5000.00',
      state: 'draft',
      requestedBy: borrower.id,
    }),
    insertRelease({
      loanId: loanClosed,
      amount: '5000.00',
      state: 'submitted',
      requestedBy: borrower.id,
    }),
    insertRelease({
      loanId: loanForeign,
      amount: '5000.00',
      state: 'draft',
      requestedBy: otherBorrower.id,
    }),
    insertRelease({
      loanId: loanForDisburse,
      amount: '25000.00',
      state: 'approved',
      requestedBy: borrower.id,
    }),
  ]);

  [slotForFullRead, slotForPartialRead, slotWithNoFile] = await Promise.all([
    insertSlot({
      applicationId: appForUpload,
      code: 'land_title',
      label: 'Land title or lease',
      state: 'required',
      extractRequired: ['total_acres', 'owner_name'],
    }),
    insertSlot({
      applicationId: appForUpload,
      code: 'tax_return_2024',
      label: '2024 tax return',
      state: 'required',
      extractRequired: ['net_farm_income'],
    }),
    insertSlot({
      applicationId: appForUpload,
      code: 'id_verification',
      label: 'Photo identification',
      state: 'required',
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
      appFundNoProduct,
      appFundNoAmount,
      appForeign,
      appComplete,
      appStale,
      appCorrupt,
      appCorruptToWithdraw,
      appUnreadablePack,
      appForPack,
      appForDecision,
      appForUpload,
      appPackIncomplete,
      appPackComplete,
      appPackEmpty,
      // loan, credit_release, credit_release_note and ledger_entry all go with
      // their application, by the cascades in 0007_servicing.sql. That is the
      // only route out for a ledger entry: UPDATE and DELETE on it are revoked
      // from service_role too, and a referential action runs as the owner of
      // the referencing table rather than as the deleting role.
      appSubmitLoan,
      appTooLargeLoan,
      appDecideLoan,
      appClosedLoan,
      appForeignLoan,
      appDisburseLoan,
    ]);
  // document_slot and document_upload rows go with their application, by the
  // cascades in 0006_documents.sql.
  await service.from('loan_product').delete().in('id', [productAlpha, productUnreadablePack]);
  await service
    .from('profile')
    .update({ org_id: null })
    .in('id', [lender.id, foreignLender.id]);
  await service.from('organisation').delete().in('id', [orgAlpha, orgBeta]);
  // Objects outlive their rows: deleting an application cascades to
  // document_upload but says nothing about the bucket.
  if (storedObjects.length > 0) {
    await service.storage.from('documents').remove(storedObjects);
  }
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
   * An application at `docs_pending` with NO slots evaluates to an empty set,
   * and requireRules reads that as "the caller did not evaluate this" -- which
   * is the right answer here rather than an accident: nothing asked this
   * applicant for documents, so there is nothing a lender could have reviewed.
   */
  it('refuses a guarded transition whose criteria nothing has evaluated', async () => {
    const before = await eventCount(appPackEmpty);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appPackEmpty,
      event: 'begin_review',
      expectedRevision: DOCS_PENDING_REVISION,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('guard_refused');
    expect(String(answer.payload['reason'])).toContain('not been evaluated');
    expect(blockersOf(answer)).toEqual([]);
    expect(await eventCount(appPackEmpty)).toBe(before);
    expect((await readApplication(appPackEmpty)).state).toBe('docs_pending');
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
      slot: null,
      upload: null,
      loanTerms: null,
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

// Funding is the seam between the two machines: `funded` is terminal for an
// application, and the `loan` row it writes is what the servicing machine then
// works on. `create_loan` was declared with no runner for four phases and the
// transition refused rather than moving -- correctly, because an application at
// `funded` with no loan behind it says money moved when nothing did. These
// cases are that refusal turning into the write, and the write is asserted
// against the database rather than against the response.
describe('funding an approved application', () => {
  it('opens one facility carrying the terms the application asked for', async () => {
    expect(await readLoans(appApproved)).toEqual([]);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appApproved,
      event: 'fund',
      expectedRevision: 2,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload['to']).toBe('funded');
    expect(answer.payload['effects']).toEqual(['create_loan']);

    const loans = await readLoans(appApproved);
    expect(loans).toHaveLength(1);
    const loan = loans[0];
    // Denormalised from the application, never from the request body.
    expect(loan?.borrower_id).toBe(borrower.id);
    expect(loan?.org_id).toBe(orgAlpha);
    expect(loan?.product_id).toBe(productAlpha);
    // 9_500_000 minor units, which is what the payload's request step asks
    // for. Asserted as text so a cent lost on the wire would fail here.
    expect(loan?.approved_limit).toBe('95000.00');
    expect(loan?.status).toBe('active');
    // Nothing in the application, the product or the decision records a rate,
    // so nothing is charged. See lib/loan-terms.ts.
    expect(loan?.rate_bps).toBe(0);
  });

  it('refuses a second funding, and opens no second facility', async () => {
    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appApproved,
      event: 'fund',
      expectedRevision: 3,
    });

    // Refused by the machine rather than by the runner: nothing leaves
    // `funded` on `fund`, so a retry cannot reach the effect at all.
    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('state_conflict');
    expect(await readLoans(appApproved)).toHaveLength(1);
  });

  it('refuses an application that names no product, and writes nothing', async () => {
    const before = await eventCount(appFundNoProduct);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appFundNoProduct,
      event: 'fund',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('effect_input_invalid');
    expect(String(answer.payload['reason'])).toContain('names no product');

    expect(await readLoans(appFundNoProduct)).toEqual([]);
    expect(await eventCount(appFundNoProduct)).toBe(before);
    expect(await readApplication(appFundNoProduct)).toEqual({
      state: 'approved',
      revision: 0,
    });
  });

  it('refuses an application that asked for no amount, rather than opening a facility at zero', async () => {
    const before = await eventCount(appFundNoAmount);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appFundNoAmount,
      event: 'fund',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('effect_input_invalid');
    expect(String(answer.payload['reason'])).toContain('amount');

    expect(await readLoans(appFundNoAmount)).toEqual([]);
    expect(await eventCount(appFundNoAmount)).toBe(before);
    expect(await readApplication(appFundNoAmount)).toEqual({
      state: 'approved',
      revision: 0,
    });
  });
});

// A document slot is the second machine with a table, and the first one whose
// authority splits within a single subject: the borrower supplies the file and
// the lender decides about it. Every case here asserts on the database
// afterwards, because a 403 that moved the row would still be a 403.
describe('moving a document slot', () => {
  it('lets the lender accept a document the borrower supplied', async () => {
    const before = await slotEventCount(slotToAccept);

    const answer = await post(lender.token, {
      machine: 'document_slot',
      subjectId: slotToAccept,
      event: 'accept',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({
      ok: true,
      machine: 'document_slot',
      subjectId: slotToAccept,
      applicationId: appForDecision,
      event: 'accept',
      from: 'extracted',
      to: 'accepted',
      revision: 1,
      actorRole: 'lender',
    });

    expect(await readSlot(slotToAccept)).toEqual({ state: 'accepted', revision: 1 });
    expect(await slotEventCount(slotToAccept)).toBe(before + 1);
  });

  /**
   * The decision is the lender's, and the endpoint is where that is enforced.
   * A borrower who could accept their own documents would clear the
   * `begin_review` guard without a lender ever reading one, and the database
   * would not notice: the trigger checks the state pair and knows nothing about
   * who asked.
   */
  it('refuses a borrower who tries to accept their own document', async () => {
    const before = await slotEventCount(slotToReject);

    const answer = await post(borrower.token, {
      machine: 'document_slot',
      subjectId: slotToReject,
      event: 'accept',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(403);
    expect(answer.payload['code']).toBe('role_not_permitted');
    expect(blockersOf(answer)).toEqual([]);
    expect(await readSlot(slotToReject)).toEqual({ state: 'extracted', revision: 0 });
    expect(await slotEventCount(slotToReject)).toBe(before);
  });

  it('lets the lender reject one, and records the move', async () => {
    const answer = await post(lender.token, {
      machine: 'document_slot',
      subjectId: slotToReject,
      event: 'reject',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({ from: 'extracted', to: 'rejected', revision: 1 });
    expect(await readSlot(slotToReject)).toEqual({ state: 'rejected', revision: 1 });

    const events = await listWorkflowEvents(service, 'document_slot', slotToReject);
    expect(events.at(-1)).toMatchObject({
      machine: 'document_slot',
      subject_id: slotToReject,
      from_state: 'extracted',
      to_state: 'rejected',
      event: 'reject',
      actor_id: lender.id,
      actor_role: 'lender',
    });
  });

  // The slot's audience is its application's audience, resolved through the
  // application rather than restated. Another borrower is not in it.
  it('hides a slot on an application the caller cannot read', async () => {
    const answer = await post(otherBorrower.token, {
      machine: 'document_slot',
      subjectId: slotUntouched,
      event: 'upload',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
    expect(await readSlot(slotUntouched)).toEqual({ state: 'required', revision: 0 });
  });

  it('hides a slot at another organisation from a lender', async () => {
    const answer = await post(foreignLender.token, {
      machine: 'document_slot',
      subjectId: slotUntouched,
      event: 'accept',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
  });

  it('refuses an event that does not leave the slot\'s state', async () => {
    const answer = await post(lender.token, {
      machine: 'document_slot',
      subjectId: slotUntouched,
      event: 'accept',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('state_conflict');
    expect(currentOf(answer)).toMatchObject({ state: 'required', revision: 0 });
  });

  // The same optimistic concurrency the application uses, on a second table:
  // two lenders accepting one document serialise rather than race.
  it('answers 409 when the slot moved under the caller', async () => {
    const answer = await post(lender.token, {
      machine: 'document_slot',
      subjectId: slotAwaitingDecision,
      event: 'accept',
      expectedRevision: 7,
    });

    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('revision_conflict');
    expect(currentOf(answer)).toMatchObject({ state: 'extracted', revision: 0 });
    expect(await readSlot(slotAwaitingDecision)).toEqual({ state: 'extracted', revision: 0 });
    expect(await slotEventCount(slotAwaitingDecision)).toBe(0);
  });
});

// The bytes never pass through this API. What it decides is that a write may
// happen, and WHERE -- the path is minted here from the slot this server
// loaded, so a caller cannot choose which application's folder to write into.
describe('issuing a signed upload url', () => {
  const PDF = 'application/pdf';

  it('mints the path itself, from the slot rather than from the request', async () => {
    const answer = await postTo(UPLOAD_URL, UPLOAD_URL_URL, borrower.token, {
      slotId: slotUntouched,
      filename: 'id_smith-farms.pdf',
      mime: PDF,
      bytes: 24_000,
      // Offered, and ignored. A client-supplied path is a client choosing
      // whose folder to write into, so the field is not read at all.
      path: `${appForeign}/id_verification/00000000-0000-4000-8000-00000000ffff.pdf`,
      storagePath: '../../etc/passwd',
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({
      ok: true,
      slotId: slotUntouched,
      applicationId: appForDecision,
      bucket: 'documents',
      event: 'upload',
      maxBytes: 10_485_760,
    });

    // <application_id>/<slot_code>/<uuid>.<ext> -- the convention the storage
    // policy reads, with the extension derived from the type and not from the
    // caller's filename.
    const path = String(answer.payload['path']);
    expect(path).toMatch(
      new RegExp(
        `^${appForDecision}/id_verification/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`,
      ),
    );
    expect(path.startsWith(appForeign)).toBe(false);
    expect(typeof answer.payload['token']).toBe('string');
    expect(String(answer.payload['signedUrl']).length).toBeGreaterThan(0);
  });

  it('hides a slot on an application the caller does not own', async () => {
    const answer = await postTo(UPLOAD_URL, UPLOAD_URL_URL, otherBorrower.token, {
      slotId: slotUntouched,
      filename: 'id.pdf',
      mime: PDF,
      bytes: 1_000,
    });

    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
  });

  // The lender decides about documents; the borrower supplies them. Read off
  // the machine, so this route cannot disagree with the transition endpoint.
  it('refuses a lender asking for somewhere to put a file', async () => {
    const answer = await postTo(UPLOAD_URL, UPLOAD_URL_URL, lender.token, {
      slotId: slotUntouched,
      filename: 'id.pdf',
      mime: PDF,
      bytes: 1_000,
    });

    expect(answer.status).toBe(403);
    expect(answer.payload['code']).toBe('role_not_permitted');
  });

  it('refuses a file larger than the policy allows', async () => {
    const answer = await postTo(UPLOAD_URL, UPLOAD_URL_URL, borrower.token, {
      slotId: slotUntouched,
      filename: 'huge.pdf',
      mime: PDF,
      bytes: 10_485_761,
    });

    expect(answer.status).toBe(413);
    expect(answer.payload['code']).toBe('upload_too_large');
  });

  it('refuses a type the bucket does not hold', async () => {
    const answer = await postTo(UPLOAD_URL, UPLOAD_URL_URL, borrower.token, {
      slotId: slotUntouched,
      filename: 'accounts.xlsx',
      mime: 'application/vnd.ms-excel',
      bytes: 4_000,
    });

    expect(answer.status).toBe(415);
    expect(answer.payload['code']).toBe('upload_type_not_accepted');
  });

  it('refuses a slot that is waiting on a decision', async () => {
    const answer = await postTo(UPLOAD_URL, UPLOAD_URL_URL, borrower.token, {
      slotId: slotAwaitingDecision,
      filename: 'again.pdf',
      mime: PDF,
      bytes: 4_000,
    });

    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('state_conflict');
  });

  it('refuses a request that names no file', async () => {
    const answer = await postTo(UPLOAD_URL, UPLOAD_URL_URL, borrower.token, {
      slotId: slotUntouched,
      filename: '../../secrets/id.pdf',
      mime: PDF,
      bytes: 1_000,
    });

    expect(answer.status).toBe(400);
    expect(String(answer.payload['reason'])).toContain('filename');
  });
});

// The bucket is private, so a read is a signed url and the API is what decides
// the caller may have one.
describe('issuing a signed download url', () => {
  let uploadId: string;
  let storagePath: string;

  beforeAll(async () => {
    storagePath = `${appForDecision}/crop_insurance/${crypto.randomUUID()}.pdf`;
    const { error } = await service.storage
      .from('documents')
      .upload(storagePath, new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }), {
        contentType: 'application/pdf',
      });
    if (error !== null) {
      throw new Error(`fixture object failed: ${error.message}`);
    }
    storedObjects.push(storagePath);

    const row = await insertDocumentUpload(service, {
      slot_id: slotAwaitingDecision,
      storage_path: storagePath,
      filename: 'crop_insurance_2027-03-01.pdf',
      bytes: 4,
      mime: 'application/pdf',
      extraction_state: 'pending',
    });
    if (row === null) {
      throw new Error('fixture document_upload failed');
    }
    uploadId = row.id;
  }, 30_000);

  it('issues one to the borrower whose file it is', async () => {
    const answer = await postTo(DOWNLOAD_URL, DOWNLOAD_URL_URL, borrower.token, {
      slotId: slotAwaitingDecision,
      uploadId,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({
      ok: true,
      uploadId,
      filename: 'crop_insurance_2027-03-01.pdf',
      expiresInSeconds: 300,
    });
    // Signed, and pointing at the object the row names.
    expect(String(answer.payload['url'])).toContain('token=');
    expect(String(answer.payload['url'])).toContain(storagePath);
  });

  it('issues one to a lender at the receiving organisation', async () => {
    const answer = await postTo(DOWNLOAD_URL, DOWNLOAD_URL_URL, lender.token, {
      slotId: slotAwaitingDecision,
      uploadId,
    });

    expect(answer.status).toBe(200);
  });

  it('refuses a lender at another organisation', async () => {
    const answer = await postTo(DOWNLOAD_URL, DOWNLOAD_URL_URL, foreignLender.token, {
      slotId: slotAwaitingDecision,
      uploadId,
    });

    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
  });

  // The upload is read THROUGH the slot whose audience was checked, so an
  // upload named with somebody else's slot is answered as absent rather than
  // signed for.
  it('refuses an upload that does not belong to the named slot', async () => {
    const answer = await postTo(DOWNLOAD_URL, DOWNLOAD_URL_URL, borrower.token, {
      slotId: slotUntouched,
      uploadId,
    });

    expect(answer.status).toBe(404);
  });
});

// Extraction, end to end: the browser asks for somewhere to put a file, PUTs it
// straight to storage, and fires the transition. The API never sees the bytes
// and never learns the path from the caller -- it finds the object in the
// folder it minted the path into.
describe('uploading a document', () => {
  it('records the file, reads it, and advances the slot to extracted', async () => {
    const { path } = await uploadFile(
      borrower.token,
      slotForFullRead,
      'deed_1240ac_smith-farms.pdf',
    );

    const answer = await post(borrower.token, {
      machine: 'document_slot',
      subjectId: slotForFullRead,
      event: 'upload',
      expectedRevision: 0,
      filename: 'deed_1240ac_smith-farms.pdf',
    });

    expect(answer.status).toBe(200);
    // `upload` moves the slot to `uploaded` and the extraction moves it on, so
    // what the caller is told is where it ended up: a browser told `uploaded`
    // would render a document as waiting for a read that already happened.
    expect(answer.payload).toMatchObject({
      ok: true,
      machine: 'document_slot',
      from: 'required',
      to: 'extracted',
      revision: 2,
      effects: ['extract_document'],
    });
    expect(await readSlot(slotForFullRead)).toEqual({ state: 'extracted', revision: 2 });

    const uploads = await readUploads(slotForFullRead);
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toMatchObject({
      storage_path: path,
      filename: 'deed_1240ac_smith-farms.pdf',
      mime: 'application/pdf',
      bytes: 4,
      extraction_state: 'extracted',
    });

    // The wire shape is the one 0006_documents.sql documents and the browser
    // reads: snake_case, integer basis points, and a source of 'ocr' or
    // 'human'. A renamed key fails nothing and makes every field unreadable.
    const acres = extractedField(uploads[0] as { extracted: Json }, 'total_acres');
    expect(acres?.value).toBe(1240);
    expect(acres?.source).toBe('ocr');
    expect(acres?.confidence_basis_points).toBeGreaterThanOrEqual(7_000);
    expect(extractedField(uploads[0] as { extracted: Json }, 'owner_name')?.value).toBe(
      'Smith Farms',
    );

    // Two moves, two entries. The second has no actor: `extract` is the
    // platform's own event and no person was behind it.
    const events = await listWorkflowEvents(service, 'document_slot', slotForFullRead);
    expect(events.map((event) => event.event)).toEqual(['upload', 'extract']);
    expect(events[0]).toMatchObject({ actor_id: borrower.id, actor_role: 'borrower' });
    expect(events[1]).toMatchObject({
      from_state: 'uploaded',
      to_state: 'extracted',
      actor_id: null,
      actor_role: null,
    });
  }, 30_000);

  /**
   * A partial read is not an error state. The slot still advances; the fields
   * that were not read become completeness failures with a next action, which
   * is what the borrower can act on. Refusing to advance would leave the
   * document in `uploaded` with nothing able to move it.
   */
  it('advances the slot on a partial read, and says it was partial', async () => {
    await uploadFile(borrower.token, slotForPartialRead, 'scan0007.pdf');

    const answer = await post(borrower.token, {
      machine: 'document_slot',
      subjectId: slotForPartialRead,
      event: 'upload',
      expectedRevision: 0,
      filename: 'scan0007.pdf',
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({ to: 'extracted', revision: 2 });

    const uploads = await readUploads(slotForPartialRead);
    expect(uploads[0]?.extraction_state).toBe('partial');
    expect(extractedField(uploads[0] as { extracted: Json }, 'net_farm_income')).toBeUndefined();
  }, 30_000);

  /**
   * An expiry read off the document is copied onto the slot, because `expired`
   * is not a state: it is derived from `valid_until` and the clock, and this is
   * where a document's shelf life enters the system.
   */
  it('copies an expiry it read onto the slot', async () => {
    const slotId = await insertSlot({
      applicationId: appForUpload,
      code: 'crop_insurance',
      label: 'Crop insurance certificate',
      state: 'required',
      extractRequired: ['valid_until'],
    });
    await uploadFile(borrower.token, slotId, 'crop_insurance_2027-03-01.pdf');

    const answer = await post(borrower.token, {
      machine: 'document_slot',
      subjectId: slotId,
      event: 'upload',
      expectedRevision: 0,
      filename: 'crop_insurance_2027-03-01.pdf',
    });

    expect(answer.status).toBe(200);
    const { data } = await service
      .from('document_slot')
      .select('valid_until')
      .eq('id', slotId)
      .single();
    expect(data?.valid_until).toBe('2027-03-01');
  }, 30_000);

  /**
   * Firing the transition without sending a file must not move the slot. A slot
   * that said `uploaded` with nothing behind it is a checklist row nobody can
   * act on: the borrower believes they sent something and the lender has
   * nothing to open.
   */
  it('refuses when no file has been uploaded, and does not move the slot', async () => {
    const answer = await post(borrower.token, {
      machine: 'document_slot',
      subjectId: slotWithNoFile,
      event: 'upload',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('effect_input_invalid');
    expect(await readSlot(slotWithNoFile)).toEqual({ state: 'required', revision: 0 });
    expect(await readUploads(slotWithNoFile)).toEqual([]);
    expect(await slotEventCount(slotWithNoFile)).toBe(0);
  });

  // The file is found in the bucket, not named by the caller, so a second
  // `upload` with no new file would otherwise record the previous one again.
  it('refuses to record a file it has already recorded', async () => {
    const slotId = await insertSlot({
      applicationId: appForUpload,
      code: 'lien_search',
      label: 'Personal property lien search',
      state: 'required',
    });
    await uploadFile(borrower.token, slotId, 'lien_search_2026-01-02.pdf');

    const first = await post(borrower.token, {
      machine: 'document_slot',
      subjectId: slotId,
      event: 'upload',
      expectedRevision: 0,
      filename: 'lien_search_2026-01-02.pdf',
    });
    expect(first.status).toBe(200);

    // Back to a state that admits a file, without sending one.
    const rejected = await post(lender.token, {
      machine: 'document_slot',
      subjectId: slotId,
      event: 'reject',
      expectedRevision: 2,
    });
    expect(rejected.status).toBe(200);

    const second = await post(borrower.token, {
      machine: 'document_slot',
      subjectId: slotId,
      event: 'replace',
      expectedRevision: 3,
      filename: 'lien_search_2026-01-02.pdf',
    });

    expect(second.status).toBe(422);
    expect(second.payload['code']).toBe('effect_input_invalid');
    expect(String(second.payload['reason'])).toContain('already recorded');
    expect((await readUploads(slotId)).length).toBe(1);
    expect(await readSlot(slotId)).toEqual({ state: 'rejected', revision: 3 });
  }, 30_000);
});

// Extraction proposes and a human confirms (plan/04). Once a person has typed a
// value in, the machine's confidence in its own reading stops being the
// question -- @lj/rules trusts `source: 'human'` whatever the confidence says.
describe('correcting what the extractor could not read', () => {
  it('appends a corrected reading and leaves the original alone', async () => {
    const before = await readUploads(slotForPartialRead);
    expect(before.length).toBe(1);
    const original = before[0];
    expect(original?.extraction_state).toBe('partial');

    const answer = await postTo(CORRECTION, CORRECTION_URL, borrower.token, {
      slotId: slotForPartialRead,
      uploadId: original?.id,
      field: 'net_farm_income',
      value: 18_420_000,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({
      ok: true,
      slotId: slotForPartialRead,
      field: 'net_farm_income',
      source: 'human',
      // A correction is not a transition: nothing moved, so a caller holding
      // this revision still holds a current one.
      state: 'extracted',
      revision: 2,
    });

    const after = await readUploads(slotForPartialRead);
    expect(after.length).toBe(2);

    // The newest row carries the human value, at the same object: a correction
    // is a claim about what the file says, not a different file.
    const corrected = after[0];
    expect(corrected?.extraction_state).toBe('corrected');
    expect(corrected?.storage_path).toBe(original?.storage_path);
    const field = extractedField(corrected as { extracted: Json }, 'net_farm_income');
    expect(field?.value).toBe(18_420_000);
    expect(field?.source).toBe('human');

    // And the original is exactly as the extractor left it. document_upload has
    // no UPDATE grant for anyone, service role included, and this is what that
    // buys: "what did the machine actually read" survives somebody disagreeing.
    expect(after[1]).toEqual(original);

    // Attributable, because a value a lender relies on has to be traceable to
    // whoever put it there.
    const events = await listWorkflowEvents(service, 'document_slot', slotForPartialRead);
    const latest = events.at(-1);
    expect(latest).toMatchObject({
      machine: 'document_slot',
      subject_id: slotForPartialRead,
      event: 'correct',
      from_state: 'extracted',
      to_state: 'extracted',
      actor_id: borrower.id,
      actor_role: 'borrower',
    });
  });

  /**
   * The lender's remedy for a document they do not believe is `reject`, which
   * is the decision they hold. Letting the party who decides also write the
   * evidence they decide on is a different system from the one plan/04
   * describes.
   */
  it('refuses a lender', async () => {
    const uploads = await readUploads(slotForPartialRead);
    const answer = await postTo(CORRECTION, CORRECTION_URL, lender.token, {
      slotId: slotForPartialRead,
      uploadId: uploads[0]?.id,
      field: 'net_farm_income',
      value: 1,
    });

    expect(answer.status).toBe(403);
    expect(answer.payload['code']).toBe('role_not_permitted');
    expect((await readUploads(slotForPartialRead)).length).toBe(uploads.length);
  });

  // The optimistic-concurrency check an append-only table can have: correcting
  // a superseded reading would append a new newest row carrying values from a
  // file that has already been replaced.
  it('refuses a correction to a reading that has been superseded', async () => {
    const uploads = await readUploads(slotForPartialRead);
    const superseded = uploads.at(-1);

    const answer = await postTo(CORRECTION, CORRECTION_URL, borrower.token, {
      slotId: slotForPartialRead,
      uploadId: superseded?.id,
      field: 'net_farm_income',
      value: 2,
    });

    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('state_conflict');
    expect((await readUploads(slotForPartialRead)).length).toBe(uploads.length);
  });

  it('refuses a field the document was never asked for', async () => {
    const uploads = await readUploads(slotForPartialRead);

    const answer = await postTo(CORRECTION, CORRECTION_URL, borrower.token, {
      slotId: slotForPartialRead,
      uploadId: uploads[0]?.id,
      field: 'anything_at_all',
      value: 'invented',
    });

    expect(answer.status).toBe(422);
    expect((await readUploads(slotForPartialRead)).length).toBe(uploads.length);
  });

  /**
   * A fractional figure would be stored, shown, and then silently ignored by
   * the cross-document comparison the correction exists to satisfy: those rules
   * read integers, because money is integer minor units.
   */
  it('refuses a value the rules could not compare', async () => {
    const uploads = await readUploads(slotForPartialRead);

    for (const value of [null, 12.5, { typed: true }, '']) {
      const answer = await postTo(CORRECTION, CORRECTION_URL, borrower.token, {
        slotId: slotForPartialRead,
        uploadId: uploads[0]?.id,
        field: 'net_farm_income',
        value,
      });
      expect(answer.status).toBe(400);
    }
    expect((await readUploads(slotForPartialRead)).length).toBe(uploads.length);
  });

  it('hides a slot on an application the caller does not own', async () => {
    const uploads = await readUploads(slotForPartialRead);

    const answer = await postTo(CORRECTION, CORRECTION_URL, otherBorrower.token, {
      slotId: slotForPartialRead,
      uploadId: uploads[0]?.id,
      field: 'net_farm_income',
      value: 5,
    });

    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
  });
});

// The guard that decides whether a lender may start reading a file. Its whole
// content is `evaluateCompleteness`, which is not restated here: what these
// cases assert is that the API hands it the right context and reports its
// verdict without flattening it.
describe('beginning a review', () => {
  it('refuses with a blocker per slot, keeping the three failures apart', async () => {
    const before = await eventCount(appPackIncomplete);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appPackIncomplete,
      event: 'begin_review',
      expectedRevision: DOCS_PENDING_REVISION,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('guard_refused');
    expect(String(answer.payload['reason'])).toContain('document pack');

    const byId = new Map(ruleResults(answer).map((result) => [result.id, result]));

    // MISSING -- nothing uploaded. `unknown`, not `fail`: nothing has gone
    // wrong, the file is simply not there yet, and the next action is to send
    // one. It names the slot as the outstanding input.
    const missing = byId.get('document_slot.id_verification');
    expect(missing?.status).toBe('unknown');
    expect(missing?.missing).toContain('id_verification');
    expect(String(missing?.explain)).toContain('upload');

    // STALE -- accepted, and out of date. A real failure with a different next
    // action: send a NEWER one.
    const stale = byId.get('document_slot.crop_insurance');
    expect(stale?.status).toBe('fail');
    expect(String(stale?.explain)).toContain('2020-01-31');
    expect(String(stale?.explain)).toContain('current');

    // UNREADABLE -- accepted, current, and the figure came back below the
    // confidence floor. Next action: a clearer scan, or type the value in.
    const unreadable = byId.get('document_slot.tax_return_2024');
    expect(unreadable?.status).toBe('fail');
    expect(String(unreadable?.explain)).toContain('Could not read');
    expect(String(unreadable?.explain)).toContain('net farm income');

    // Three failures, three explanations, and no two the same.
    const explanations = new Set([missing?.explain, stale?.explain, unreadable?.explain]);
    expect(explanations.size).toBe(3);

    // The finished slot is not a blocker. Blockers are what stands in the way,
    // not the whole checklist.
    expect(byId.has('document_slot.land_title')).toBe(false);

    expect(await eventCount(appPackIncomplete)).toBe(before);
    expect((await readApplication(appPackIncomplete)).state).toBe('docs_pending');
  });

  it('passes once every required slot is accepted and valid', async () => {
    const before = await eventCount(appPackComplete);

    const answer = await post(lender.token, {
      machine: 'application',
      subjectId: appPackComplete,
      event: 'begin_review',
      expectedRevision: DOCS_PENDING_REVISION,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({
      from: 'docs_pending',
      to: 'under_review',
      revision: DOCS_PENDING_REVISION + 1,
    });
    expect(await readApplication(appPackComplete)).toEqual({
      state: 'under_review',
      revision: DOCS_PENDING_REVISION + 1,
    });
    expect(await eventCount(appPackComplete)).toBe(before + 1);
  });

});

// A credit release is the third machine with a table and the first whose guard
// reads money. The cases below are about two things the option turns on: that
// the cap the guard applies is the same figure `loan_balance_v` shows the
// borrower, and that a request is adjudicated against the LOAN's audience --
// which is the application's audience, resolved through it rather than
// restated.
describe('adjudicating a credit release', () => {
  it('lets a borrower submit a request inside their available credit', async () => {
    const before = await readBalance(loanForSubmit);
    expect(before.available).toBe('150000.00');

    const answer = await post(borrower.token, {
      machine: 'credit_release',
      subjectId: releaseWithinAvailable,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload['to']).toBe('submitted');
    expect(answer.payload['revision']).toBe(1);
    expect(answer.payload['loanId']).toBe(loanForSubmit);

    const release = await readRelease(releaseWithinAvailable);
    expect(release.state).toBe('submitted');
    expect(release.revision).toBe(1);
    expect(await releaseEventCount(releaseWithinAvailable)).toBe(1);

    // The request now holds credit that has not moved, so the borrower's own
    // figure falls by exactly what they asked for while the ledger stands still.
    const after = await readBalance(loanForSubmit);
    expect(after.outstanding).toBe('100000.00');
    expect(after.pending).toBe('50000.00');
    expect(after.available).toBe('100000.00');
  });

  /**
   * The coherence plan/06 is about, asserted rather than asserted about.
   *
   * The cap the guard compared against is read back out of the blocker and
   * checked against `loan_balance_v.available` -- the number the borrower's
   * screen shows. A test that recomputed the arithmetic would agree with the
   * guard even if the guard and the view had drifted apart, which is the one
   * failure this criterion exists to prevent.
   */
  it('refuses a request larger than the available credit, and names the shortfall', async () => {
    const balance = await readBalance(loanForTooLarge);
    expect(balance.available).toBe('150000.00');

    const answer = await post(borrower.token, {
      machine: 'credit_release',
      subjectId: releaseTooLarge,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(422);
    expect(answer.payload['code']).toBe('guard_refused');

    const blocker = blockerById(answer, 'release_within_available');
    expect(blocker.status).toBe('fail');
    // Minor units, which is how money crosses a RuleResult.
    expect(blocker.inputs['maximum']).toBe(15_000_000);
    expect(blocker.inputs['actual']).toBe(20_000_000);
    expect(blocker.delta?.shortfall).toBe(5_000_000);
    expect(blocker.explain).toContain('$50,000.00');

    // The figure the guard used and the figure the borrower is shown.
    expect(blocker.inputs['maximum']).toBe(
      Number(balance.available.replace('.', '')),
    );

    expect((await readRelease(releaseTooLarge)).state).toBe('draft');
    expect(await releaseEventCount(releaseTooLarge)).toBe(0);
  });

  it('hides a release on a loan the caller cannot read', async () => {
    const answer = await post(borrower.token, {
      machine: 'credit_release',
      subjectId: releaseForeign,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
    expect((await readRelease(releaseForeign)).state).toBe('draft');
  });

  it('hides a release at another organisation from a lender', async () => {
    const answer = await post(foreignLender.token, {
      machine: 'credit_release',
      subjectId: releaseToApprove,
      event: 'approve',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(404);
    expect(answer.payload['code']).toBe('subject_not_found');
  });

  it('refuses a borrower firing a decision that is the lender\'s', async () => {
    const answer = await post(borrower.token, {
      machine: 'credit_release',
      subjectId: releaseForRoleRefusal,
      event: 'begin_review',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(403);
    expect(answer.payload['code']).toBe('role_not_permitted');
    expect((await readRelease(releaseForRoleRefusal)).state).toBe('submitted');
  });

  it('refuses an event that does not leave the release\'s state', async () => {
    const answer = await post(lender.token, {
      machine: 'credit_release',
      subjectId: releaseCancelled,
      event: 'approve',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('state_conflict');
    expect(currentOf(answer)['state']).toBe('cancelled');
  });

  it('answers 409 when the release moved under the caller, and writes no event', async () => {
    const answer = await post(lender.token, {
      machine: 'credit_release',
      subjectId: releaseStale,
      event: 'approve',
      expectedRevision: 7,
    });

    expect(answer.status).toBe(409);
    expect(answer.payload['code']).toBe('revision_conflict');
    expect(currentOf(answer)).toEqual({ state: 'under_review', revision: 0 });
    expect((await readRelease(releaseStale)).state).toBe('under_review');
    expect(await releaseEventCount(releaseStale)).toBe(0);
  });

  it('records the lender who approved it', async () => {
    const answer = await post(lender.token, {
      machine: 'credit_release',
      subjectId: releaseToApprove,
      event: 'approve',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload['to']).toBe('approved');

    const release = await readRelease(releaseToApprove);
    expect(release.state).toBe('approved');
    // No client holds a grant on this column, so this handler is its only
    // possible author: a decision with no decider could never be repaired.
    expect(release.decided_by).toBe(lender.id);
    expect(release.decline_reason).toBeNull();
  });

  it('refuses a decline that carries no reason, and leaves the release alone', async () => {
    const answer = await post(lender.token, {
      machine: 'credit_release',
      subjectId: releaseToDecline,
      event: 'decline',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(400);
    expect(answer.payload['code']).toBe('invalid_request');
    expect(String(answer.payload['reason'])).toContain('declineReason');

    expect((await readRelease(releaseToDecline)).state).toBe('under_review');
    expect(await releaseEventCount(releaseToDecline)).toBe(0);
  });

  it('writes the decline reason in the same statement as the state change', async () => {
    const answer = await post(lender.token, {
      machine: 'credit_release',
      subjectId: releaseToDecline,
      event: 'decline',
      expectedRevision: 0,
      declineReason: 'Ask again after the crop insurance certificate is renewed.',
    });

    expect(answer.status).toBe(200);
    expect(answer.payload['to']).toBe('declined');

    const release = await readRelease(releaseToDecline);
    expect(release.state).toBe('declined');
    expect(release.decided_by).toBe(lender.id);
    expect(release.decline_reason).toBe(
      'Ask again after the crop insurance certificate is renewed.',
    );
  });

  it('refuses a request against a closed facility', async () => {
    const answer = await post(borrower.token, {
      machine: 'credit_release',
      subjectId: releaseOnClosedLoan,
      event: 'submit',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(422);
    expect(blockerById(answer, 'loan_is_active').status).toBe('fail');
    expect((await readRelease(releaseOnClosedLoan)).state).toBe('draft');
  });

  /**
   * What issue #26 established, on the machine that made it matter.
   *
   * `cancel` declares no guard and no effect, so it reads no rule set. The
   * criteria are therefore not evaluated for it, and a balance that would
   * refuse a `submit` -- here, a facility that has been closed -- must not
   * stand between a borrower and abandoning a request they have already made.
   */
  it('lets a borrower cancel a request the criteria would refuse to submit', async () => {
    const answer = await post(borrower.token, {
      machine: 'credit_release',
      subjectId: releaseToCancel,
      event: 'cancel',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(200);
    expect(answer.payload['to']).toBe('cancelled');
    expect(blockersOf(answer)).toEqual([]);
    expect((await readRelease(releaseToCancel)).state).toBe('cancelled');
  });

  it('refuses to disburse while nothing can post the ledger entry', async () => {
    const answer = await post(lender.token, {
      machine: 'credit_release',
      subjectId: releaseToDisburse,
      event: 'disburse',
      expectedRevision: 0,
    });

    expect(answer.status).toBe(501);
    expect(answer.payload['code']).toBe('effect_not_implemented');
    expect(String(answer.payload['reason'])).toContain('post_ledger_entry');

    expect((await readRelease(releaseToDisburse)).state).toBe('approved');
    expect(await releaseEventCount(releaseToDisburse)).toBe(0);
  });
});
