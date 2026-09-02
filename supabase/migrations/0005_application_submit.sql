-- What submitting an application records, beyond the state change itself.
--
-- Two things, and both exist because a state name on its own does not survive
-- being read six months later:
--
--   1. WHEN it was submitted, stamped by the database rather than chosen by the
--      writer.
--   2. WHAT the borrower was told at the time, kept as written.
--
-- Migrations are append-only (docs/03-agent-scopes.md), so this file adds and
-- never edits.  0001_init.sql already declares `application.submitted_at`; what
-- it lacks is anything that fills it in.

-- submitted_at ------------------------------------------------------------
--
-- The API patches `state` and nothing else, and says why: which events stamp a
-- timestamp is a policy no machine definition declares, and an
-- `if (event === 'submit')` in a route handler is a business rule in the
-- delivery layer, which CLAUDE.md section 8 forbids.  So the stamp lives here,
-- for the same reason `stamp_decision_recorded_at` in 0001_init.sql does: an
-- audit timestamp the writer chooses is not an audit timestamp.  The service
-- role bypasses row-level security but not a trigger, so this covers the API
-- path as well as any client one.
--
-- BEFORE UPDATE only.  The demo rows in 0004_demo_data.sql arrive by INSERT
-- with their own `submitted_at`, and re-stamping them at reset time would
-- replace a deliberate history with the instant of the reset.
--
-- The null check is what makes the stamp write-once: an application that
-- re-enters `submitted` keeps the instant of its first submission, because the
-- question the column answers is when the lender received this file, not when
-- it was last touched.
--
-- Not `security definer`: it writes only the row already being written, so it
-- needs no privilege the caller does not have, and a definer function here
-- would widen what an untrusted caller can reach for no gain.  `search_path` is
-- pinned empty regardless, so every name below is schema-qualified -- the same
-- reasoning 0001_init.sql gives for its own functions.
create function public.stamp_application_submitted_at()
  returns trigger
  language plpgsql
  set search_path = ''
as $fn$
begin
  if new.state = 'submitted' and new.submitted_at is null then
    new.submitted_at := now();
  end if;
  return new;
end
$fn$;

-- Postgres fires same-timing triggers in name order, so
-- `application_assert_legal_transition` runs first and an illegal move is
-- rejected before anything is stamped.  That ordering is not relied on for
-- correctness -- a rejected statement writes nothing either way -- but it is
-- the order a reader should expect to see in a trace.
create trigger application_submitted_at
  before update on public.application
  for each row execute function public.stamp_application_submitted_at();

-- eligibility_snapshot ----------------------------------------------------
--
-- What the borrower was told, kept as it was said.
--
-- plan/05-option2-application.md: a product's criteria are content, and content
-- changes.  Without this row a lender reading a file next quarter evaluates it
-- against today's thresholds and sees a decision whose stated reason no longer
-- reproduces.  Small table, disproportionate credibility.
--
-- One row per submit, never updated.  `revision` is the application's revision
-- as it stands submitted, so the row also says which version of the payload was
-- evaluated -- the state change patches no `data`, so that payload is still the
-- one on the application at this revision.
--
-- `eligibility` holds the evaluated `ProductEligibility[]` from packages/rules
-- as jsonb.  `RuleResult` was designed to survive
-- JSON.parse(JSON.stringify(x)) unchanged -- every field present, absences as
-- null -- so it stores as it stands and reads back as the same object.  It is
-- deliberately not decomposed into columns: this is a record of what was said,
-- not a queryable model, and normalising it would create a second definition of
-- a shape packages/domain already owns.
create table eligibility_snapshot (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references application(id) on delete cascade,
  -- The application's revision at the moment of the submit.  Paired with the
  -- application id it identifies the submission, hence the unique constraint:
  -- a retried write cannot leave two rows answering "what was the borrower
  -- told" differently, and one row per submit is a fact of the schema rather
  -- than a convention the writer is trusted to keep.
  revision       integer not null,
  eligibility    jsonb not null,
  created_at     timestamptz not null default now(),
  unique (application_id, revision)
);

-- No further index.  The read is always "this application's snapshots, ordered
-- by revision" -- the lender's file view and the borrower's own history -- and
-- the unique constraint above is already exactly that index.

-- security ----------------------------------------------------------------
--
-- A table added without policies is not "not locked down yet": PostgREST
-- publishes every table in `public` and Supabase's default privileges hand
-- `anon` and `authenticated` full DML on each one, so it is a public API
-- returning every row to anyone holding the anon key.  0002_rls.sql makes that
-- argument in full; this section is that argument applied to one more table.

alter table public.eligibility_snapshot enable row level security;

revoke all on public.eligibility_snapshot from anon, authenticated;

-- SELECT and nothing else.  Only the service role writes a snapshot, from
-- inside the submit transition, so no client needs INSERT, UPDATE or DELETE --
-- and a borrower who could write one could quote criteria back at a lender as
-- though the product had said them.
grant select on public.eligibility_snapshot to authenticated;

-- UPDATE and DELETE are revoked from `service_role` as well, exactly as
-- workflow_event's are.  service_role bypasses row-level security, so a policy
-- could never have stopped it; a missing grant does.  Nothing in the design
-- rewrites a snapshot -- that is the whole point of taking one -- so making it
-- structurally true costs nothing and removes a leaked-service-key scenario in
-- which the record of what was said can be edited to agree with what happened.
-- A snapshot still goes when its application goes: a referential action runs as
-- the owner of the referencing table, so the cascade above is unaffected.
revoke update, delete, truncate on public.eligibility_snapshot from service_role;

-- The audience is the application's audience: the borrower who owns it, or a
-- lender at the organisation it was sent to.  Stated as one policy that reads
-- `application` under the CALLER's own policies, rather than as two policies
-- restating `borrower_id = auth.uid()` and `is_lender_of_org(org_id)` -- the
-- pattern `workflow_event_read_visible_subject` in 0002_rls.sql already uses,
-- and for the same reason: a second copy of "who may read this loan file" is a
-- second answer the first time either changes.
--
-- `admin` therefore reads nothing here, because 0002_rls.sql deliberately gives
-- admin no policy on `application`.  An untested privilege is an assumption,
-- and failing closed is the correct direction to be wrong in.
create policy eligibility_snapshot_read_visible_application on public.eligibility_snapshot
  for select to authenticated
  using (
    exists (
      select 1 from public.application a
      where a.id = eligibility_snapshot.application_id
    )
  );
