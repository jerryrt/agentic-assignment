-- Demo seed for the LOCAL, THROWAWAY Supabase stack.
--
-- ############################################################################
-- #  NEVER APPLY THIS FILE TO A HOSTED PROJECT.                              #
-- #  It writes rows straight into auth.users with a password that is printed  #
-- #  in the comment below, identical for every account.  On a hosted project  #
-- #  that is not a seed, it is a set of published credentials.  The local     #
-- #  stack is reachable only from 127.0.0.1 and is destroyed by the next      #
-- #  `supabase db reset`, which is the only reason it is acceptable here.     #
-- ############################################################################
--
-- Purpose, from plan/02-domain-model.md ("Seed data"): produce a demo walkable
-- in 60 seconds.  Empty tables demo nothing, so what is seeded is the
-- INTERESTING states -- a draft stopped mid-form, an application waiting on a
-- lender, and one already decided with the lender's private reasoning attached
-- -- because those are the states that show what the system does.
--
-- Re-runnability: `supabase db reset` drops the database, runs the migrations
-- and then runs this file, so the ordinary path always starts empty.  The file
-- is nevertheless written to survive being applied twice to the same database:
-- every row has a fixed id and the preamble removes the previous generation
-- first.  That matters because a seed that only works once is a seed nobody can
-- iterate on, and because a partially-applied seed is worse than no seed.
--
-- Fixed ids, not gen_random_uuid(): a demo script, a browser test and a
-- bookmarked URL all want to name a row.  The convention is a readable tail --
-- a0.. organisations, b0.. loan products, c0.. users, d0.. applications -- so a
-- row's kind is legible in a log line without a join.

-- ---------------------------------------------------------------------------
-- 0.  Remove the previous generation
-- ---------------------------------------------------------------------------
--
-- Order is forced by the foreign keys that do NOT cascade: workflow_event and
-- application both point at profile(id), and profile only disappears with its
-- auth.users row.  Deleting applications before users is therefore not tidiness,
-- it is the only order that works.  application_decision goes with its
-- application by the cascade in 0001_init.sql.

delete from public.workflow_event
 where machine = 'application'
   and subject_id in (
     '00000000-0000-4000-8000-0000000000d1',
     '00000000-0000-4000-8000-0000000000d2',
     '00000000-0000-4000-8000-0000000000d3'
   );

delete from public.application
 where id in (
   '00000000-0000-4000-8000-0000000000d1',
   '00000000-0000-4000-8000-0000000000d2',
   '00000000-0000-4000-8000-0000000000d3'
 );

delete from public.loan_product
 where id in (
   '00000000-0000-4000-8000-0000000000b1',
   '00000000-0000-4000-8000-0000000000b2'
 );

-- Cascades to public.profile.
delete from auth.users
 where id in (
   '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-0000000000c2',
   '00000000-0000-4000-8000-0000000000c3'
 );

delete from public.organisation
 where id = '00000000-0000-4000-8000-0000000000a1';

-- ---------------------------------------------------------------------------
-- 1.  The lending organisation
-- ---------------------------------------------------------------------------
--
-- One org.  A second would only be needed to prove cross-org isolation, and
-- packages/db/test/rls.spec.ts already builds its own pair of organisations for
-- exactly that probe.  Seeding a second here would add a row the demo never
-- opens and a second thing to keep in step.

insert into public.organisation (id, name)
values ('00000000-0000-4000-8000-0000000000a1', 'Meadowbank Agricultural Credit');

-- ---------------------------------------------------------------------------
-- 2.  Demo users
-- ---------------------------------------------------------------------------
--
-- Written directly into auth.users rather than posted to /auth/v1/signup,
-- because a .sql seed cannot make an HTTP call and `supabase db reset` runs
-- nothing else.  Four columns decide whether the resulting user can actually
-- authenticate, and getting any of them wrong produces a row that exists and
-- silently refuses to log in:
--
--   encrypted_password  GoTrue compares with bcrypt, so the value must be a
--                       bcrypt hash -- extensions.crypt(..., gen_salt('bf')).
--                       pgcrypto lives in the `extensions` schema on Supabase,
--                       not `public`, hence the qualification.
--   email_confirmed_at  Not null, or a confirmations-enabled stack rejects the
--                       password grant.  The local config ships with
--                       enable_confirmations = false, but relying on that would
--                       make the seed depend on a setting it does not own.
--   aud / role          Both 'authenticated'.  GoTrue filters the user lookup by
--                       aud and copies role into the JWT's `role` claim, which
--                       is the claim every grant in 0002_rls.sql is written
--                       against.
--   auth.identities     The email provider identity.  GoTrue treats a user with
--                       no identity row as one with no way to sign in, and
--                       identity_data must carry `sub` and `email`.
--
-- The empty-string token columns are deliberate: several are nullable in the
-- schema but are scanned into non-nullable Go strings, so a NULL there turns a
-- login into an unrelated-looking driver error.
--
-- Password for every account: demo-only-not-a-secret
-- Identical on purpose.  A demo where each account has its own password is a
-- demo that stops to look one up, and there is nothing here to protect.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000',
  u.id,
  'authenticated',
  'authenticated',
  u.email,
  extensions.crypt('demo-only-not-a-secret', extensions.gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  jsonb_build_object('full_name', u.full_name),
  now(),
  now(),
  '', '', '', ''
from (values
  ('00000000-0000-4000-8000-0000000000c1'::uuid,
   'lender@example.test',   'Rowan Ellis'),
  ('00000000-0000-4000-8000-0000000000c2'::uuid,
   'borrower@example.test', 'Ada Fenwick'),
  ('00000000-0000-4000-8000-0000000000c3'::uuid,
   'grower@example.test',   'Beau Marchand')
) as u(id, email, full_name);

insert into auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at,
  created_at, updated_at
)
select
  u.id::text,
  u.id,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  now(), now(), now()
from auth.users u
where u.id in (
  '00000000-0000-4000-8000-0000000000c1',
  '00000000-0000-4000-8000-0000000000c2',
  '00000000-0000-4000-8000-0000000000c3'
);

-- The profile rows already exist: on_auth_user_created fired on each insert
-- above and copied full_name out of raw_user_meta_data.  That is the point of
-- going through auth.users rather than writing public.profile directly -- the
-- seed exercises the same path a real signup takes.
--
-- What the trigger deliberately does NOT do is honour a role from the signup
-- payload, because raw_user_meta_data is whatever the client posted and a lender
-- role taken from it would be self-service privilege escalation.  Promotion is
-- out of band, and this is the out-of-band path: an UPDATE by the seed, running
-- as the table owner, past a grant that lets `authenticated` write only
-- full_name.
update public.profile
   set role = 'lender',
       org_id = '00000000-0000-4000-8000-0000000000a1'
 where id = '00000000-0000-4000-8000-0000000000c1';

-- ---------------------------------------------------------------------------
-- 3.  Two loan products with genuinely different criteria
-- ---------------------------------------------------------------------------
--
-- Different on purpose: the same applicant passes one and fails the other, so
-- the eligibility panel in plan/05 has something to say from step 1 rather than
-- rendering two identical green columns.  The operating line gates on cash flow
-- (a DSCR floor) and on being a grain or oilseed grower at scale; the equipment
-- loan gates on collateral (an LTV cap) and lets a first-year mixed farm in.
--
-- PROVISIONAL SHAPE.  packages/rules and plan/04 own the real encoding of a
-- criteria set and a document pack, and neither exists yet.  What is here is
-- chosen to be obviously declarative -- a flat list of {id, kind, field,
-- threshold} objects, no expressions, no operators to parse -- so that whoever
-- writes packages/rules can either adopt it or replace it in one edit to this
-- file.  It is NOT a rule engine and must not become one: rules are evaluated
-- in TypeScript, and the thresholds below are data those rules read.
--
-- `version` is present so the first change to the shape can be detected rather
-- than guessed at, and every rule carries `label` and `severity` because
-- plan/05's RuleResult renders both and a threshold with no label cannot be
-- explained to a borrower.
--
-- The amount band is NOT in `criteria`.  min_amount and max_amount are columns,
-- and a threshold that appears in two places becomes two thresholds the first
-- time one is edited.

insert into public.loan_product (
  id, org_id, name, min_amount, max_amount, criteria, required_docs, active
) values (
  '00000000-0000-4000-8000-0000000000b1',
  '00000000-0000-4000-8000-0000000000a1',
  'Operating Line of Credit',
  -- numeric, written as plain decimal literals: a float here would acquire a
  -- rounding error on the way through the database.
  25000.00,
  500000.00,
  '{
    "version": 1,
    "rules": [
      { "id": "min_acreage",
        "label": "Minimum acreage",
        "kind": "min",
        "field": "total_acres",
        "threshold": 200,
        "severity": "error" },
      { "id": "dscr_floor",
        "label": "Debt service coverage",
        "kind": "min",
        "field": "dscr",
        "threshold": 1.25,
        "severity": "error" },
      { "id": "eligible_commodity",
        "label": "Eligible commodity",
        "kind": "one_of",
        "field": "primary_commodity",
        "allowed": ["grain", "oilseed"],
        "severity": "error" },
      { "id": "years_farming",
        "label": "Years farming",
        "kind": "min",
        "field": "years_farming",
        "threshold": 3,
        "severity": "error" },
      { "id": "in_footprint",
        "label": "Operating region",
        "kind": "one_of",
        "field": "province",
        "allowed": ["AB", "SK", "MB"],
        "severity": "error" }
    ]
  }'::jsonb,
  '{
    "version": 1,
    "slots": [
      { "code": "tax_return_2024", "label": "2024 tax return",
        "required": true, "extract_required": ["tax_year", "net_income"] },
      { "code": "financial_statements", "label": "Year-end financial statements",
        "required": true, "extract_required": ["fiscal_year_end", "total_assets"] },
      { "code": "crop_insurance", "label": "Crop insurance certificate",
        "required": true, "extract_required": ["valid_until", "insured_acres"] },
      { "code": "land_title", "label": "Land title or lease",
        "required": true, "extract_required": ["legal_description"] },
      { "code": "id_verification", "label": "Photo identification",
        "required": true, "extract_required": ["full_name", "valid_until"] }
    ]
  }'::jsonb,
  true
), (
  '00000000-0000-4000-8000-0000000000b2',
  '00000000-0000-4000-8000-0000000000a1',
  'Equipment Term Loan',
  10000.00,
  250000.00,
  '{
    "version": 1,
    "rules": [
      { "id": "dscr_floor",
        "label": "Debt service coverage",
        "kind": "min",
        "field": "dscr",
        "threshold": 1.15,
        "severity": "error" },
      { "id": "max_ltv",
        "label": "Loan to value",
        "kind": "max",
        "field": "ltv",
        "threshold": 0.80,
        "severity": "error" },
      { "id": "years_farming",
        "label": "Years farming",
        "kind": "min",
        "field": "years_farming",
        "threshold": 1,
        "severity": "error" },
      { "id": "in_footprint",
        "label": "Operating region",
        "kind": "one_of",
        "field": "province",
        "allowed": ["AB", "SK", "MB"],
        "severity": "error" }
    ]
  }'::jsonb,
  '{
    "version": 1,
    "slots": [
      { "code": "equipment_invoice", "label": "Equipment invoice or quote",
        "required": true, "extract_required": ["vendor", "purchase_price"] },
      { "code": "lien_search", "label": "Personal property lien search",
        "required": true, "extract_required": ["search_date", "registrations"] },
      { "code": "tax_return_2024", "label": "2024 tax return",
        "required": true, "extract_required": ["tax_year", "net_income"] },
      { "code": "financial_statements", "label": "Year-end financial statements",
        "required": false, "extract_required": [] },
      { "code": "id_verification", "label": "Photo identification",
        "required": true, "extract_required": ["full_name", "valid_until"] }
    ]
  }'::jsonb,
  true
);

-- ---------------------------------------------------------------------------
-- 4.  Applications, inserted AT their final state
-- ---------------------------------------------------------------------------
--
-- Not inserted-then-advanced.  assert_legal_transition() is a BEFORE UPDATE
-- trigger reading workflow_transition, that table is generated from
-- packages/workflow (plan/03) and is still empty, so the guard currently rejects
-- every state change -- correctly, it fails closed.  An UPDATE ... set state
-- here would therefore abort the whole seed.  Every row below is written once,
-- already in the state the demo needs, and the history the walk-through would
-- have produced is recorded in workflow_event in section 6.
--
-- This is worth keeping even after the generated transitions land: a seed that
-- walks the machine is a seed that fails whenever a guard gains a precondition
-- the fixture does not satisfy.
--
-- `data` is the multi-step form payload from plan/05 and its shape is
-- PROVISIONAL for the same reason the criteria are: packages/domain owns the
-- Zod schema and does not have one yet.  Amounts inside it are integer MINOR
-- units, per the money rule -- the suffix is on the field name so a reader
-- cannot mistake 45000000 for dollars.  Money in a COLUMN is numeric; money in
-- the JSON payload is the TypeScript representation, and those are different
-- conventions on purpose.

insert into public.application (
  id, borrower_id, org_id, state, revision, data, furthest_step,
  submitted_at, decided_at
) values
-- (a) A draft stopped part way through step 3, which is what makes "resume"
--     demonstrable: furthest_step is the resume hint the route guard reads, and
--     financials is far enough in that abandoning it would visibly hurt.
--     revision is non-zero because a draft that reached step 3 was autosaved on
--     the way, and a demo of optimistic concurrency needs a number that moved.
(
  '00000000-0000-4000-8000-0000000000d1',
  '00000000-0000-4000-8000-0000000000c2',
  '00000000-0000-4000-8000-0000000000a1',
  'draft',
  7,
  '{
    "borrower": {
      "entity_type": "corporation",
      "legal_name": "Fenwick Grain Co.",
      "trade_name": "Fenwick Grain",
      "incorporation_year": 2011,
      "years_farming": 14,
      "province": "SK",
      "postal_code": "S7K 1A1",
      "contact_email": "borrower@example.test",
      "contact_phone": "306-555-0142"
    },
    "farm": {
      "total_acres": 2400,
      "primary_commodity": "grain",
      "parcels": [
        { "legal_description": "NW-14-35-05-W3",
          "acres": 1600, "tenure": "owned", "commodity": "grain" },
        { "legal_description": "SE-22-35-05-W3",
          "acres": 800, "tenure": "leased", "commodity": "oilseed" }
      ]
    },
    "financials": {
      "gross_revenue_minor": 182000000,
      "operating_expenses_minor": 121000000,
      "existing_debt_service_minor": 34000000,
      "current_assets_minor": 96000000,
      "current_liabilities_minor": 41000000
    }
  }'::jsonb,
  'financials',
  null,
  null
),
-- (b) Submitted and now sitting with the lender.  This is the row that shows
--     "two roles, two truths" without a decision existing yet: the borrower
--     reads "With your lender", the lender reads "Awaiting your decision", off
--     the same `state` value.
(
  '00000000-0000-4000-8000-0000000000d2',
  '00000000-0000-4000-8000-0000000000c3',
  '00000000-0000-4000-8000-0000000000a1',
  'under_review',
  3,
  '{
    "borrower": {
      "entity_type": "sole_trader",
      "legal_name": "Beau Marchand",
      "years_farming": 2,
      "province": "AB",
      "postal_code": "T1J 4B4",
      "contact_email": "grower@example.test",
      "contact_phone": "403-555-0119"
    },
    "farm": {
      "total_acres": 310,
      "primary_commodity": "mixed",
      "parcels": [
        { "legal_description": "SW-08-09-22-W4",
          "acres": 310, "tenure": "owned", "commodity": "mixed" }
      ]
    },
    "financials": {
      "gross_revenue_minor": 41000000,
      "operating_expenses_minor": 29500000,
      "existing_debt_service_minor": 7200000,
      "current_assets_minor": 18000000,
      "current_liabilities_minor": 9500000
    },
    "request": {
      "product_id": "00000000-0000-4000-8000-0000000000b2",
      "amount_requested_minor": 9500000,
      "term_months": 60,
      "purpose": "Replace a 1998 combine ahead of harvest",
      "collateral_value_minor": 12500000
    }
  }'::jsonb,
  'request',
  now() - interval '3 days',
  null
),
-- (c) Decided.  Approved rather than declined so the demo can carry on into the
--     funding half of the story, and it belongs to the SAME borrower as the
--     draft: one borrower with two files in different states is what makes a
--     dashboard worth looking at, and it puts the lender-only decision row on an
--     application the borrower can definitely read -- which is the sharp end of
--     the RLS probe rather than a comfortable one.
(
  '00000000-0000-4000-8000-0000000000d3',
  '00000000-0000-4000-8000-0000000000c2',
  '00000000-0000-4000-8000-0000000000a1',
  'approved',
  5,
  '{
    "borrower": {
      "entity_type": "corporation",
      "legal_name": "Fenwick Grain Co.",
      "trade_name": "Fenwick Grain",
      "incorporation_year": 2011,
      "years_farming": 14,
      "province": "SK",
      "postal_code": "S7K 1A1",
      "contact_email": "borrower@example.test",
      "contact_phone": "306-555-0142"
    },
    "farm": {
      "total_acres": 2400,
      "primary_commodity": "grain",
      "parcels": [
        { "legal_description": "NW-14-35-05-W3",
          "acres": 1600, "tenure": "owned", "commodity": "grain" },
        { "legal_description": "SE-22-35-05-W3",
          "acres": 800, "tenure": "leased", "commodity": "oilseed" }
      ]
    },
    "financials": {
      "gross_revenue_minor": 182000000,
      "operating_expenses_minor": 121000000,
      "existing_debt_service_minor": 34000000,
      "current_assets_minor": 96000000,
      "current_liabilities_minor": 41000000
    },
    "request": {
      "product_id": "00000000-0000-4000-8000-0000000000b1",
      "amount_requested_minor": 25000000,
      "term_months": 12,
      "purpose": "Seed, fertiliser and fuel for the 2026 crop year",
      "collateral_value_minor": 140000000
    }
  }'::jsonb,
  'request',
  now() - interval '21 days',
  now() - interval '9 days'
);

-- ---------------------------------------------------------------------------
-- 5.  The lender's private reasoning
-- ---------------------------------------------------------------------------
--
-- One row, on the approved application only, because that is what makes the
-- column-versus-row point demonstrable: the borrower can read the application,
-- can read decided_at off it, and still cannot read this table at all.  A
-- decision row on an application nobody can see would prove nothing.
--
-- recorded_at is NOT supplied.  stamp_decision_recorded_at() is a BEFORE INSERT
-- OR UPDATE trigger that overwrites it, so passing a value here would be a value
-- silently discarded -- and the whole point of the trigger is that the timestamp
-- is not the writer's to choose.
--
-- decided_by is not null in the schema: an audit entry with no author is worse
-- than no entry, because it is believed.
insert into public.application_decision (
  application_id, decision_note, risk_grade, decided_by
) values (
  '00000000-0000-4000-8000-0000000000d3',
  'Coverage comfortable at 1.79x on three-year average revenue. Leased '
  || 'quarter at SE-22 renews in 2027 -- revisit tenure before any increase. '
  || 'Approved at the requested amount, not the amount discussed by phone.',
  'B+',
  '00000000-0000-4000-8000-0000000000c1'
);

-- ---------------------------------------------------------------------------
-- 6.  The event log
-- ---------------------------------------------------------------------------
--
-- The history the applications above would have accumulated if the machine had
-- been walked.  Without it the timeline component renders an empty box on every
-- demo row, which is the one place a reviewer looks to check the audit story is
-- real rather than promised.
--
-- from_state is null for the creation events: workflow_event.from_state is
-- nullable precisely so the machine's `[*] --> draft` edge is representable, and
-- a draft with no events at all would leave the resume demo with a blank
-- timeline.
--
-- id is a bigserial and is left to the sequence; created_at is set explicitly so
-- the ordering tells a story rather than collapsing to one instant.  Times run
-- backwards from now(), which keeps the demo looking recent whenever it is run
-- and stops a stale seed reading as a dead system.
--
-- The event names are the transition names from plan/03.  They are written here
-- by hand for now; once packages/workflow generates workflow_transition, a
-- mismatch between these and the generated rows becomes detectable and should be
-- made an assertion rather than left to reading.

insert into public.workflow_event (
  machine, subject_id, from_state, to_state, event, actor_id, actor_role,
  payload, created_at
) values
-- (a) the draft: created and never submitted
('application', '00000000-0000-4000-8000-0000000000d1',
 null, 'draft', 'create',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 '{"source": "web"}'::jsonb, now() - interval '2 days'),

-- (b) under review: created, submitted, docs requested, review begun
('application', '00000000-0000-4000-8000-0000000000d2',
 null, 'draft', 'create',
 '00000000-0000-4000-8000-0000000000c3', 'borrower',
 '{"source": "web"}'::jsonb, now() - interval '6 days'),
('application', '00000000-0000-4000-8000-0000000000d2',
 'draft', 'submitted', 'submit',
 '00000000-0000-4000-8000-0000000000c3', 'borrower',
 '{"product_id": "00000000-0000-4000-8000-0000000000b2"}'::jsonb,
 now() - interval '3 days'),
('application', '00000000-0000-4000-8000-0000000000d2',
 'submitted', 'docs_pending', 'request_docs',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 '{"slots_created": 5}'::jsonb, now() - interval '3 days' + interval '4 hours'),
('application', '00000000-0000-4000-8000-0000000000d2',
 'docs_pending', 'under_review', 'begin_review',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 '{"pack_complete": true}'::jsonb, now() - interval '1 day'),

-- (c) approved: the full walk, ending in the decision recorded in section 5
('application', '00000000-0000-4000-8000-0000000000d3',
 null, 'draft', 'create',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 '{"source": "web"}'::jsonb, now() - interval '28 days'),
('application', '00000000-0000-4000-8000-0000000000d3',
 'draft', 'submitted', 'submit',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 '{"product_id": "00000000-0000-4000-8000-0000000000b1"}'::jsonb,
 now() - interval '21 days'),
('application', '00000000-0000-4000-8000-0000000000d3',
 'submitted', 'docs_pending', 'request_docs',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 '{"slots_created": 5}'::jsonb, now() - interval '20 days'),
('application', '00000000-0000-4000-8000-0000000000d3',
 'docs_pending', 'under_review', 'begin_review',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 '{"pack_complete": true}'::jsonb, now() - interval '12 days'),
('application', '00000000-0000-4000-8000-0000000000d3',
 'under_review', 'approved', 'approve',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 '{"risk_grade": "B+"}'::jsonb, now() - interval '9 days');

-- ---------------------------------------------------------------------------
-- Deferred, and to which plan document
-- ---------------------------------------------------------------------------
--
-- plan/02-domain-model.md's seed specification asks for more than this file
-- delivers.  The remainder is not an oversight and not a judgement call -- the
-- tables it needs do not exist in 0001_init.sql yet.  Listed here so the phase
-- that creates them EXTENDS this file rather than rediscovering the gap:
--
--   * A borrower with a FUNDED loan and ledger history, so Option 3 has
--     something to show without walking Option 2 first.
--     Needs: loan, ledger_entry, credit_release -- plan/06-option3-servicing.md.
--     Also needs the 'funded' state, which means workflow_transition must be
--     populated first: see the note in section 4 about the guard.
--
--   * An application at docs_pending with 2 of 5 slots filled, one EXPIRED and
--     one INCONSISTENT, so Option 1 shows its interesting state on first load.
--     Needs: document_slot, document_upload -- plan/04-option1-documents.md.
--     The two products above already carry the five-slot required_docs
--     definitions those rows would be generated from, so that half is ready.
--
--   * eligibility_snapshot rows written at submit, which are what let the lender
--     see what the borrower was told at the time.
--     Needs: eligibility_snapshot -- plan/05-option2-application.md.
--
--   * workflow_transition itself, which is GENERATED by `pnpm workflow:gen` from
--     packages/workflow and arrives as a migration, never as seed data
--     -- plan/03-workflow-engine.md.  Hand-writing rows here would create the
--     second copy the generator exists to prevent.
