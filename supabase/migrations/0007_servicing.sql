-- Option 3: the facility a funded application becomes, the ledger that records
-- what moved, and the requests to draw against it.
--
-- Shape is fixed by plan/06-option3-servicing.md.  Migrations are append-only
-- (docs/03-agent-scopes.md), so this file adds and never edits 0001..0006.
--
-- Four decisions are made here that the plan leaves open.  Each is argued at
-- the point it applies; they are listed together first because they are the
-- reason this file is not simply the plan's DDL retyped.
--
--   1. The balance is DERIVED, never stored.  There is no balance column
--      anywhere below; `loan_balance_v` is the whole of it.
--   2. `internal_note` is a TABLE, not a column a view omits.  `decline_reason`
--      is a column.  The two differ because one is private to the lender and
--      the other is written by the lender FOR the borrower, and row-level
--      security can express the first only as a row question.
--   3. `ledger_entry` is append-only in the strongest sense available: no
--      client write of any kind, and no UPDATE or DELETE for anyone, including
--      `service_role`.  A ledger that can be edited after the fact is not a
--      ledger.
--   4. No client may write a release's `state`.  That is a transition, and
--      transitions go through POST /api/transition, which re-checks the
--      actor's role against the machine.

-- the facility -------------------------------------------------------------
--
-- One row per funded application.  `borrower_id` and `org_id` are denormalised
-- from the application deliberately: every read of a loan filters on one of
-- them, and reaching them through `application` would put a join in front of
-- the borrower's own dashboard.  They cannot drift, because a loan is written
-- once by the funding effect and no grant lets anything move one to another
-- borrower.
--
-- `on delete cascade` on application_id, matching application_decision,
-- eligibility_snapshot and document_slot: the application is the loan file, and
-- the facility is part of it.  It is also the only route by which the rows
-- below can ever be removed, because UPDATE and DELETE on `ledger_entry` are
-- revoked from every role including `service_role` -- and a referential action
-- runs as the owner of the referencing table rather than as the deleting role.
--
-- `status` carries no check constraint and no state machine.  `delinquent` is a
-- judgement a human records, not a state anything derives: arrears are a
-- function of the ledger and the clock, and a status that changed without an
-- event would be a state machine that lies (plan/03).  @lj/domain narrows it on
-- the way in.
create table loan (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references application(id) on delete cascade,
  borrower_id    uuid not null references profile(id),
  org_id         uuid not null references organisation(id),
  product_id     uuid not null references loan_product(id),
  -- numeric, never float, for the reason 0001_init.sql gives on loan_product:
  -- money must not acquire a rounding error on the way through the database.
  approved_limit numeric(14,2) not null check (approved_limit > 0),
  rate_bps       integer not null check (rate_bps >= 0),
  -- A `date`, not a `timestamptz`.  A loan opens on a calendar day in the place
  -- it was written; an instant would make the answer depend on the reader's
  -- time zone, the same argument document_slot.valid_until makes.
  opened_at      date not null default current_date,
  status         text not null default 'active',
  created_at     timestamptz not null default now()
);

create index loan_borrower_idx on loan (borrower_id);
create index loan_org_idx on loan (org_id);

-- the request ---------------------------------------------------------------
--
-- Declared before ledger_entry because the ledger references it: a disbursement
-- names the release it came from.
--
-- `internal_note` is NOT here, and its absence is the substance of this file.
-- See credit_release_note below.
--
-- `decline_reason` IS here.  It is lender-authored, but it is addressed to the
-- borrower -- "the reason text and what to change", in plan/06's table of who
-- sees what -- so withholding it from the borrower would be withholding the
-- one thing a decline is for.  It is therefore an ordinary column on a row the
-- borrower's own policy admits, and no view has to pretend otherwise.
--
-- What that costs is stated plainly in the grants below: no client holds an
-- UPDATE privilege on this column.  A borrower and a lender are the SAME
-- database role here -- `authenticated` -- and are told apart only by a claim
-- inside the JWT, so a grant wide enough to let a lender autosave a decline
-- reason is wide enough to let a borrower write one onto their own draft, and
-- a forged lender-authored field is worse than a missing one because it is
-- believed.  The reason arrives with the `decline` transition, written by the
-- API's service role in the same statement that moves the state -- which is
-- also the only moment at which a decline reason means anything.
create table credit_release (
  id             uuid primary key default gen_random_uuid(),
  loan_id        uuid not null references loan(id) on delete cascade,
  amount         numeric(14,2) not null check (amount > 0),
  purpose        text not null,
  -- Legality is not a check constraint, for the reason application.state is
  -- not: the legal set is generated from packages/workflow into
  -- workflow_transition, and the trigger below reads it.  Two definitions of
  -- which moves are legal is one too many.
  state          text not null default 'draft',
  -- Optimistic concurrency, as on application and document_slot.  POST
  -- /api/transition matches on it, which is what makes two lender tabs
  -- approving one release serialise instead of double-approving.
  revision       integer not null default 0,
  requested_by   uuid not null references profile(id),
  decided_by     uuid references profile(id),
  decline_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index credit_release_loan_idx on credit_release (loan_id, created_at desc);
-- The lender's queue is "everything not yet settled, oldest first", across
-- every loan at the organisation.  Ordering by age is the queue's whole
-- premise (plan/06), so the index carries the order rather than leaving a sort
-- on top of a scan.
create index credit_release_state_idx on credit_release (state, created_at);

-- the lender-only half of a decision ----------------------------------------
--
-- One row per release, and the reason it is a row at all is the argument
-- 0001_init.sql makes for application_decision, applied to the field that
-- actually needs it.
--
-- Row-level security filters ROWS and never COLUMNS.  PostgREST publishes every
-- table in `public`, so a borrower holding a select policy on their own release
-- can read every column of it straight off the base table, however carefully
-- `credit_release_borrower_v` omits one.  A view hides a column; it does not
-- protect one.
--
-- Postgres does offer column-level GRANTs, and they do not help here for the
-- reason 0001_init.sql already established: borrowers and lenders are the same
-- database role, so withholding a column from a borrower withholds it from a
-- lender too, and handing it back needs a definer view whose predicate then
-- sits beside the row policies instead of being one of them.
--
-- Splitting the field into its own table turns the column question back into a
-- row question, which is the shape RLS is good at: one row policy here, no
-- privilege for a borrower at all, ordinary table-level SELECT on
-- credit_release, and no definer view anywhere.
--
-- This is also what makes plan/06's "mid-decision refresh" safe to serve
-- client-side.  A lender typing an internal note autosaves it straight to this
-- row, debounced, exactly as a borrower autosaves a draft application -- and
-- the write is safe precisely because a borrower has no policy on this table at
-- all.  The same treatment could not be given to decline_reason, which is why
-- it is not.
--
-- `recorded_by` is not null: an audit entry with no author is worse than no
-- entry, because it is believed.  The service role bypasses row-level security,
-- so the policy that pins this column on a client write cannot constrain the
-- API path; the column constraint is what covers both.
create table credit_release_note (
  release_id    uuid primary key references credit_release(id) on delete cascade,
  internal_note text,
  recorded_by   uuid not null references profile(id),
  recorded_at   timestamptz not null default now()
);

-- An audit timestamp the writer can choose is not an audit timestamp, and the
-- column default fires on insert only -- so an amended note would otherwise
-- keep the instant of the first draft and misdate the trail.
--
-- The function is 0001_init.sql's, reused rather than copied.  It sets
-- `new.recorded_at := now()` and nothing else, which is exactly and only what
-- is wanted here; a second function with the same body would be the second copy
-- CLAUDE.md section 9 is about.  Its name says "decision" because
-- application_decision was the first caller, and a lender's private note on a
-- release is the same kind of record.
create trigger credit_release_note_recorded_at
  before insert or update on public.credit_release_note
  for each row execute function public.stamp_decision_recorded_at();

-- the ledger ----------------------------------------------------------------
--
-- `amount` is SIGNED -- draws, fees and accrued interest positive, repayments
-- negative -- so the outstanding balance is a plain sum rather than a case
-- expression over `kind`.  That is what lets loan_balance_v below be readable
-- at a glance, and it means `kind` is a label for the reader rather than an
-- input to the arithmetic.
--
-- `kind` DOES carry a check constraint, unlike every `state` column in this
-- schema, and the difference is not an oversight.  A state's legal set is
-- generated from packages/workflow, so writing it twice would create the second
-- copy the generator exists to prevent.  Nothing generates this vocabulary, no
-- transition moves an entry from one kind to another, and a ledger row with a
-- misspelled kind is invisible to every filter and impossible to correct in
-- place.  @lj/domain states the same four names: two enforcers of one
-- vocabulary, the way MAX_UPLOAD_BYTES and the bucket's file_size_limit are two
-- enforcers of one size limit (0006_documents.sql).
--
-- No check ties a sign to a kind.  It is tempting -- a repayment is negative --
-- and it would make a correction unrepresentable: this table is append-only, so
-- reversing a fee charged in error is a second `fee` entry with the opposite
-- sign, and a constraint that forbade it would leave the only remedy a
-- migration.  `amount <> 0` is the check that is actually wanted: an entry that
-- moves nothing still appears on a timeline, which is how a reconciliation
-- acquires a row nobody can account for.
--
-- `release_id` is provenance, and it is UNIQUE.  plan/06 requires that a funded
-- release with no ledger entry, and a doubled disbursement, both be
-- unrepresentable; the second half is a constraint, and this is it.  A retried
-- `disburse` is refused by the database rather than by the API remembering to
-- look first -- a check-then-insert is a race, and the failure it produces is a
-- balance nobody can explain.  Postgres allows many NULLs in a unique column,
-- which is what leaves room for the entries that have no release: the opening
-- advance, whose provenance is the application itself, and the fees and
-- interest the lender posts.  A not-null constraint here would make a loan's
-- first entry unrepresentable.
create table ledger_entry (
  id         bigserial primary key,
  loan_id    uuid not null references loan(id) on delete cascade,
  kind       text not null check (kind in ('draw', 'repayment', 'interest', 'fee')),
  amount     numeric(14,2) not null check (amount <> 0),
  -- A `date` for the same reason opened_at is one: money moves on a calendar
  -- day, and the ledger reads the same to everyone.
  effective  date not null,
  -- No `on delete` action, deliberately.  NO ACTION is checked at the end of
  -- the statement, so deleting a loan cascades both this row and the release it
  -- names without tripping over the order they go in; deleting a funded release
  -- on its own is refused, which is correct -- a disbursement whose request has
  -- vanished is a balance with no story behind it.
  release_id uuid unique references credit_release(id),
  memo       text,
  created_at timestamptz not null default now()
);

-- Every read of this table is one loan's entries, newest effect first: the
-- borrower's statement and the lender's file view are both that query.
create index ledger_entry_loan_idx on ledger_entry (loan_id, effective desc, id desc);

-- the transition guard ------------------------------------------------------
--
-- The trigger every machine's table carries.  assert_legal_transition() was
-- written in 0001_init.sql to take the machine as an argument for exactly this
-- moment, so there is one guard serving three tables rather than three copies
-- of one.  Braces to the type system's belt: even a leaked service key cannot
-- move a release to a state the machine does not contain.
create trigger credit_release_assert_legal_transition
  before update on credit_release
  for each row execute function public.assert_legal_transition('credit_release');

-- security ------------------------------------------------------------------
--
-- A table added without policies is not "not locked down yet": PostgREST
-- publishes every table in `public` and Supabase's default privileges hand
-- `anon` and `authenticated` full DML on each one, so it is a public API
-- returning every row to anyone holding the anon key.  0002_rls.sql makes that
-- argument in full; this section applies it to four more tables.

alter table public.loan                enable row level security;
alter table public.credit_release      enable row level security;
alter table public.credit_release_note enable row level security;
alter table public.ledger_entry        enable row level security;

revoke all on public.loan                from anon, authenticated;
revoke all on public.credit_release      from anon, authenticated;
revoke all on public.credit_release_note from anon, authenticated;
revoke all on public.ledger_entry        from anon, authenticated;

-- "Is the caller a lender at the organisation this release's loan belongs to?"
--
-- A composition of is_lender_of_org(), not a second definition of it -- the
-- same relationship is_lender_of_application() has to it in 0002_rls.sql.  It
-- exists because the predicate is needed three times by the
-- credit_release_note policies below, and three hand-written copies of a
-- security predicate are three things that have to be kept in step.
--
-- Deliberately NOT security definer: it reads `credit_release` and `loan` as
-- the CALLER, so a caller who cannot see the release cannot reach its note
-- either.  That composes the existing rules instead of adding a new one, and it
-- fails closed -- a borrower gets nothing here even though the borrower CAN see
-- the release row, because is_lender_of_org() is false for them.
create function public.is_lender_of_release(p_release uuid)
  returns boolean
  language sql
  stable
  set search_path = ''
as $fn$
  select exists (
    select 1
    from public.credit_release r
    join public.loan l on l.id = r.loan_id
    where r.id = p_release
      and public.is_lender_of_org(l.org_id)
  )
$fn$;

-- EXECUTE is granted to PUBLIC by default, which includes `anon`.  Every policy
-- below is `to authenticated`, so there is no reason for an unauthenticated
-- caller to be able to invoke this.
revoke execute on function public.is_lender_of_release(uuid) from public;
grant execute on function public.is_lender_of_release(uuid) to authenticated;

-- loan ----------------------------------------------------------------------
--
-- SELECT and nothing else.  A loan is created by the funding effect with the
-- service role, and no part of the design lets a client open, close or re-price
-- a facility.
--
-- The audience is the application's audience: the borrower who owns it, or a
-- lender at the organisation it was sent to.  Stated as ONE policy that reads
-- `application` under the CALLER's own policies, rather than as two restating
-- `borrower_id = auth.uid()` and `is_lender_of_org(org_id)` -- the
-- workflow_event_read_visible_subject pattern from 0002_rls.sql, which both
-- 0005 and 0006 also used.  A second copy of "who may read this loan file" is a
-- second answer the first time either changes.  It is also why the
-- denormalised borrower_id and org_id above are not a security surface: they
-- are read by application code, never by a policy.
--
-- `admin` therefore reads nothing here, because 0002_rls.sql deliberately gives
-- admin no policy on `application`.  An untested privilege is an assumption,
-- and failing closed is the correct direction to be wrong in.
grant select on public.loan to authenticated;

create policy loan_read_visible_application on public.loan
  for select to authenticated
  using (
    exists (
      select 1 from public.application a
      where a.id = loan.application_id
    )
  );

-- credit_release ------------------------------------------------------------
--
-- The one table in this migration a client may write, and the grants are where
-- the limits are.
--
-- INSERT omits `state`, so a client-created release can only take the 'draft'
-- default.  UPDATE omits `state` for the same reason, so the compose-and-
-- autosave path from plan/06 physically cannot move a release through the
-- machine; state changes go through POST /api/transition, which re-checks the
-- actor's role against the machine, and are re-checked by the trigger above.
-- Exactly the treatment `application` gets in 0002_rls.sql.
--
-- UPDATE also omits `decline_reason` and `decided_by`.  Those are the lender's
-- decision, they arrive with the transition that makes them true, and a column
-- privilege cannot distinguish the lender from the borrower because both are
-- `authenticated`.
--
-- DELETE is granted, and the policy confines it to the borrower's own draft:
-- abandoning something never submitted is the borrower's to do, and a release
-- that has been seen by a lender is a record.  That is also why the machine has
-- no transition out of `draft` other than `submit` -- an unsubmitted draft is
-- deleted, not cancelled.
grant select on public.credit_release to authenticated;
grant insert (loan_id, amount, purpose, requested_by) on public.credit_release to authenticated;
grant update (amount, purpose, revision, updated_at) on public.credit_release to authenticated;
grant delete on public.credit_release to authenticated;

-- The release's audience is the loan's audience, reached by reading `loan`
-- under the caller's own policies -- which in turn reads `application` under
-- them.  Three tables, one definition of who may see this file.
create policy credit_release_read_visible_loan on public.credit_release
  for select to authenticated
  using (
    exists (
      select 1 from public.loan l
      where l.id = credit_release.loan_id
    )
  );

-- The insert check pins the loan to the caller as its BORROWER, not merely to a
-- loan the caller can see.  A lender can see the same loan, and a lender who
-- could insert here would be fabricating a borrower's request -- the same
-- forgery `decided_by = auth.uid()` prevents on application_decision, in the
-- other direction.  `requested_by` is pinned for the same reason.
--
-- `state = 'draft'` restates a guarantee the missing column privilege already
-- gives.  It is kept because a future grant would otherwise silently widen
-- this, which is the argument 0002_rls.sql makes for the identical clause on
-- application_insert_own_draft.
create policy credit_release_insert_own_draft on public.credit_release
  for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and state = 'draft'
    and exists (
      select 1 from public.loan l
      where l.id = loan_id
        and l.borrower_id = (select auth.uid())
    )
  );

-- `using` and `with check` both require 'draft', so a row cannot be edited out
-- of draft or into it.  This is the compose-side half of plan/06's
-- "surviving a refresh": the row exists from the first keystroke, the URL names
-- it, and the autosave writes straight to Postgres with no serverless cold
-- start in the way.
create policy credit_release_update_own_draft on public.credit_release
  for update to authenticated
  using (requested_by = (select auth.uid()) and state = 'draft')
  with check (requested_by = (select auth.uid()) and state = 'draft');

create policy credit_release_delete_own_draft on public.credit_release
  for delete to authenticated
  using (requested_by = (select auth.uid()) and state = 'draft');

-- credit_release_note -------------------------------------------------------
--
-- SELECT, INSERT and UPDATE for a lender at the organisation the loan belongs
-- to, and for nobody else -- in particular not the borrower the row is about,
-- which is the whole reason internal_note is a table rather than a column.
--
-- No DELETE, for anyone.  A note is the lender's side of the audit trail; it is
-- superseded by an update, not erased, and it disappears only with the release
-- it belongs to, by the cascade above.
--
-- UPDATE is granted per column rather than per table, exactly as
-- application_decision's is.  A policy chooses rows and has no notion of "this
-- column changed", so a whole-table update grant would let a lender backdate
-- `recorded_at` on their own audit entry and repoint `release_id` at another
-- release of the same organisation -- both sides satisfy the policy, so a note
-- could be moved between files unremarked.
grant select, insert on public.credit_release_note to authenticated;
grant update (internal_note, recorded_by) on public.credit_release_note to authenticated;

create policy credit_release_note_read_as_lender on public.credit_release_note
  for select to authenticated
  using (public.is_lender_of_release(release_id));

-- `recorded_by` is pinned to the caller on every client write.  A lender who
-- may write a note could otherwise attribute it to a colleague, and a forged
-- attribution in an audit trail is worse than a missing one.  The API's service
-- role bypasses RLS and is unaffected, so a system-written note is still
-- possible where it is meant to be.
create policy credit_release_note_insert_as_lender on public.credit_release_note
  for insert to authenticated
  with check (
    public.is_lender_of_release(release_id)
    and recorded_by = (select auth.uid())
  );

create policy credit_release_note_update_as_lender on public.credit_release_note
  for update to authenticated
  using (public.is_lender_of_release(release_id))
  with check (
    public.is_lender_of_release(release_id)
    and recorded_by = (select auth.uid())
  );

-- ledger_entry --------------------------------------------------------------
--
-- SELECT and nothing else, for any client.  Entries are written by the
-- `disburse` effect and by the lender's servicing operations, with the service
-- role, in the same transaction as the state change that justifies them.  A
-- client that could append to a ledger could invent a repayment.
--
-- UPDATE, DELETE and TRUNCATE are revoked from `service_role` as well, exactly
-- as workflow_event's and eligibility_snapshot's are.  service_role bypasses
-- row-level security, so a policy could never have stopped it; a missing grant
-- does.  Nothing in the design rewrites a ledger entry -- that is what a ledger
-- is -- so making it structurally true costs nothing and removes a
-- leaked-service-key scenario in which the record of what moved can be edited
-- to agree with what was said afterwards.  A correction is a compensating
-- entry.  Rows still go with their loan, and their loan with its application,
-- by the cascades above: a referential action runs as the owner of the
-- referencing table rather than as the deleting role, which is what makes the
-- cascade the ONLY route out and not merely the convenient one.
grant select on public.ledger_entry to authenticated;

revoke update, delete, truncate on public.ledger_entry from service_role;

create policy ledger_entry_read_visible_loan on public.ledger_entry
  for select to authenticated
  using (
    exists (
      select 1 from public.loan l
      where l.id = ledger_entry.loan_id
    )
  );

-- the release timeline ------------------------------------------------------
--
-- 0002_rls.sql's policy on workflow_event whitelists `machine = 'application'`
-- and says why: subject_id has no foreign key, so there is no generic way to
-- resolve a subject, and each machine's clause is added by the migration that
-- creates its table.  This is that clause for credit_release.
--
-- It is a SECOND policy rather than an edit to the first.  Migrations are
-- append-only, and multiple permissive policies for the same command are OR'd,
-- so adding one widens the read exactly as intended without restating the
-- application clause.  The subject is resolved by reading `credit_release`
-- under the caller's own policies, so the log inherits the release's audience
-- and carries no access rule of its own.
create policy workflow_event_read_credit_release on public.workflow_event
  for select to authenticated
  using (
    machine = 'credit_release'
    and exists (
      select 1 from public.credit_release r
      where r.id = workflow_event.subject_id
    )
  );

-- realtime ------------------------------------------------------------------
--
-- `supabase_realtime` exists in a fresh Supabase database and, until this
-- statement, contains NO TABLES.  supabase/config.toml sets
-- `[realtime] enabled = true`, so the service runs and a client subscribes
-- happily; what it never does is deliver anything.  Nothing errors, nothing
-- logs, and the screen simply never updates -- which is the worst shape a
-- defect can have, because it is indistinguishable from "no changes happened
-- yet".  plan/06 calls the two-window demo "a few lines and the whole demo",
-- and those few lines are inert without the two below.
--
-- Publishing a table does NOT publish it past row-level security.  Realtime
-- evaluates the subscriber's own policies per row before delivering it, so a
-- borrower is sent changes to their own releases and a lender is sent changes
-- to their organisation's, by exactly the policies above and no second copy of
-- them.  That is worth stating here rather than leaving to be looked up,
-- because "does a publication leak rows?" is the first question the next reader
-- has and the answer belongs beside the statement.
--
-- Only the two tables that are subscribed to.  A publication is a firehose of
-- row changes, and `loan`, `ledger_entry` and `credit_release_note` have no
-- subscriber -- every row added to a publication nobody listens to is work done
-- and bytes moved for nothing.  `credit_release` is Option 3's live demo;
-- `document_slot` is Option 1's, deferred in phase 6 for want of a channel
-- factory that now exists, so the table being published is the other half of
-- it.
--
-- Postgres has no "add if not present" here, so a second migration adding
-- either table again would fail.  Not guarded: migrations run once and in
-- order, and this is the only place either table is added.
alter publication supabase_realtime add table public.credit_release;
alter publication supabase_realtime add table public.document_slot;

-- the balance ---------------------------------------------------------------
--
-- Derived on every read.  plan/06 states the rule and the reason: a stored
-- balance is a cache with no invalidation strategy, and every reconciliation
-- bug in lending starts there.
--
-- `security_invoker = on`, like every view in this schema.  A view defined by
-- the owner runs as the owner and reads straight past the row policies, which
-- would make the view the gate and leave two definitions of who may read a loan
-- file.  Here it also means the arithmetic is done over the rows the CALLER can
-- see -- which is correct, because a caller who cannot see the ledger cannot
-- see the loan either.
--
-- Written with two lateral subqueries rather than plan/06's `left join ... group
-- by` shape.  The plan's form spells the pending-releases subquery out twice --
-- once for the `pending` column and again inside `available` -- and two copies
-- of an expression that must agree is exactly the duplication CLAUDE.md section
-- 9 names.  Here each quantity is stated once and `available` is arithmetic
-- over the two.
--
-- The three states in `held` are @lj/domain's PENDING_CREDIT_RELEASE_STATES.
-- `draft` is out because nobody has been asked yet; the terminal states are out
-- because the question is settled -- `funded` in particular, whose money is
-- already on the ledger and would otherwise be counted twice.  `approved` is IN
-- because the money is committed and not yet moved, and leaving it out is
-- precisely how a borrower spends the same credit twice.
--
-- borrower_id and org_id are projected so a caller can filter without joining
-- back to `loan` on every read.  They are not a widening: this view is
-- security_invoker, so a caller who sees the balance row already sees the loan
-- row it derives from.
create view loan_balance_v
  with (security_invoker = on) as
  select l.id                                                  as loan_id,
         l.borrower_id,
         l.org_id,
         l.approved_limit,
         coalesce(drawn.total, 0)                              as outstanding,
         coalesce(held.total, 0)                               as pending,
         l.approved_limit - coalesce(drawn.total, 0) - coalesce(held.total, 0)
                                                               as available
  from public.loan l
  left join lateral (
    select sum(e.amount) as total
    from public.ledger_entry e
    where e.loan_id = l.id
  ) drawn on true
  left join lateral (
    select sum(r.amount) as total
    from public.credit_release r
    where r.loan_id = l.id
      and r.state in ('submitted', 'under_review', 'approved')
  ) held on true;

-- the two projections -------------------------------------------------------
--
-- plan/06 asks for these as views rather than template conditionals, because
-- hiding a column in HTML is not hiding it.  True, and not sufficient: hiding a
-- column in a VIEW is not hiding it either, which is why the lender-only field
-- was made a row above.  What the views are for is that each audience reads one
-- row in the shape it needs -- not as a second gate.  Both are
-- `security_invoker` and neither carries a predicate of its own.
--
-- Columns are listed rather than written as `r.*`, because Postgres expands
-- `r.*` once at definition time: the shorthand would silently mean "the columns
-- credit_release had on the day this ran" and read as though it tracked the
-- table (0001_init.sql makes the same point).

-- Nothing is withheld here.  Every column is one `authenticated` holds an
-- ordinary privilege on, and the rows come from the credit_release policies.
-- The view exists so a borrower's screen has a name to read from, and so that
-- adding a lender-only field later has an obvious wrong place to go.
create view credit_release_borrower_v
  with (security_invoker = on) as
  select id, loan_id, amount, purpose, state, revision,
         requested_by, decided_by, decline_reason,
         created_at, updated_at
  from credit_release;

-- The lender's reading of the same rows: the note, and the two names.
--
-- `decided_by` appears on BOTH projections, deliberately.  Omitting the raw
-- uuid from the borrower's would be theatre -- it is a column on a base table
-- their own policy admits, so no view could withhold it.  What plan/06 means by
-- "the lender sees who decided" is the NAME, and that is protected properly, by
-- the `profile` policies: a borrower cannot read a lender's profile row, so
-- under security_invoker `decided_by_name` comes back null for them.
--
-- The join to `profile` for the requester is an INNER join, matching
-- application_lender_v: a lender who can see the release can see the borrower's
-- profile, because can_read_borrower_profile() admits a borrower who has
-- applied to the lender's organisation and a loan exists only where an
-- application did.  The other two joins are LEFT: a release under review has no
-- decider yet, and a release nobody has annotated has no note -- an inner join
-- would silently drop every row in the lender's queue that still needs
-- deciding, which is all of them.
create view credit_release_lender_v
  with (security_invoker = on) as
  select r.id, r.loan_id, r.amount, r.purpose, r.state, r.revision,
         r.requested_by, r.decided_by, r.decline_reason,
         r.created_at, r.updated_at,
         l.borrower_id, l.org_id,
         n.internal_note,
         n.recorded_by  as note_recorded_by,
         n.recorded_at  as note_recorded_at,
         p.full_name    as requested_by_name,
         d.full_name    as decided_by_name
  from credit_release r
  join loan l on l.id = r.loan_id
  join profile p on p.id = r.requested_by
  left join profile d on d.id = r.decided_by
  left join credit_release_note n on n.release_id = r.id;

-- Both views are auto-updatable, so the default grants would let a client
-- INSERT and UPDATE through them.  Reads are all either is meant to offer.
revoke all on public.loan_balance_v            from anon, authenticated;
revoke all on public.credit_release_borrower_v from anon, authenticated;
revoke all on public.credit_release_lender_v   from anon, authenticated;

grant select on public.loan_balance_v            to authenticated;
grant select on public.credit_release_borrower_v to authenticated;
grant select on public.credit_release_lender_v   to authenticated;

-- ---------------------------------------------------------------------------
-- Demo data
-- ---------------------------------------------------------------------------
--
-- plan/06 asks for a seeded loan with about eight ledger entries and two
-- historical releases -- one funded, one declined -- so that the timeline and
-- the decline-reason path are both visible without anybody clicking.  It is
-- worth more than it looks: a screen with no data proves nothing about a
-- projection, and the two-truths demo is a comparison between two numbers that
-- are equal on an empty loan.
--
-- There is a THIRD release here, `under_review`, which the plan does not ask
-- for.  Without one, `pending` is zero, the borrower's `available` equals the
-- lender's undrawn limit, and the one invariant this option exists to
-- demonstrate is invisible on the seeded data.  It also puts a row in the
-- lender's queue, which is the screen criterion #1 is judged on.
--
-- The loan belongs to the demo borrower's APPROVED application
-- (...d3, Ada Fenwick at Meadowbank), not the draft: it is the only demo file
-- that has been decided, and a loan against an undecided application would be a
-- row that contradicts its own history.
--
-- Fixed ids, following 0004_demo_data.sql's convention of a readable tail --
-- a0 organisations, b0 products, c0 users, d0 applications -- extended with
-- e0 loans and f0 credit releases.  Ledger ids are left to the sequence: they
-- are identified by their loan and their effective date, and nothing bookmarks
-- one.
--
-- Written to survive being applied twice to the same database, exactly as
-- 0004_demo_data.sql is: `supabase db reset` always starts empty, but a seed
-- that only works once is a seed nobody can iterate on.  The deletes below run
-- as the migration's owner rather than as `service_role`, which is why they can
-- remove ledger rows that no request could: correction of a ledger is a
-- migration -- reviewable -- and not something an API call can do.

delete from public.workflow_event
 where machine = 'credit_release'
   and subject_id in (
     '00000000-0000-4000-8000-0000000000f1',
     '00000000-0000-4000-8000-0000000000f2',
     '00000000-0000-4000-8000-0000000000f3'
   );

-- credit_release_note and credit_release go with the loan by cascade, and
-- ledger_entry with them; the loan goes with its application.  Naming the loan
-- explicitly is what makes the seed re-runnable without deleting the
-- application it hangs off.
delete from public.loan where id = '00000000-0000-4000-8000-0000000000e1';

insert into public.loan (
  id, application_id, borrower_id, org_id, product_id,
  approved_limit, rate_bps, opened_at, status
) values (
  '00000000-0000-4000-8000-0000000000e1',
  '00000000-0000-4000-8000-0000000000d3',
  '00000000-0000-4000-8000-0000000000c2',
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000b1',
  -- The amount the application asked for and was approved at: 25000000 minor
  -- units in the application's `data`, which is 250000.00 here.  The two are
  -- the same figure in the two units this codebase uses, and a demo where they
  -- disagreed would be a demo of the bug.
  250000.00,
  875,
  current_date - 9,
  'active'
);

-- The releases.  Inserted before the ledger, because a disbursement names the
-- release it came from.
--
-- `state` is written directly rather than walked through the machine: the
-- trigger fires on UPDATE only, so an insert at a historical state is
-- deliberate and not a hole -- the same way 0004_demo_data.sql seeds an
-- `approved` application.  The event log below is what makes the history real.
insert into public.credit_release (
  id, loan_id, amount, purpose, state, revision,
  requested_by, decided_by, decline_reason, created_at, updated_at
) values
-- (a) Funded.  Its ledger entry is posted below and is the only draw with a
--     release behind it.
(
  '00000000-0000-4000-8000-0000000000f1',
  '00000000-0000-4000-8000-0000000000e1',
  85000.00,
  'Fuel and custom spraying for the second pass',
  'funded',
  4,
  '00000000-0000-4000-8000-0000000000c2',
  '00000000-0000-4000-8000-0000000000c1',
  null,
  now() - interval '7 days',
  now() - interval '6 days'
),
-- (b) Declined, with a reason the borrower can read and a note they cannot.
--     This is the pair the projections exist to separate.
(
  '00000000-0000-4000-8000-0000000000f2',
  '00000000-0000-4000-8000-0000000000e1',
  40000.00,
  'Additional nitrogen ahead of the third pass',
  'declined',
  4,
  '00000000-0000-4000-8000-0000000000c2',
  '00000000-0000-4000-8000-0000000000c1',
  'The line is drawn to 71 per cent nine days into a twelve-month term. '
  || 'Resubmit after the first grain delivery settles, or with a signed '
  || 'forward contract covering the amount requested.',
  now() - interval '4 days',
  now() - interval '3 days'
),
-- (c) In flight.  This is the row that makes `pending` non-zero, and therefore
--     the row that makes the borrower's available credit differ from the
--     lender's undrawn limit on the seeded data.
(
  '00000000-0000-4000-8000-0000000000f3',
  '00000000-0000-4000-8000-0000000000e1',
  30000.00,
  'Trucking and elevator fees for the first delivery',
  'under_review',
  2,
  '00000000-0000-4000-8000-0000000000c2',
  null,
  null,
  now() - interval '2 days',
  now() - interval '1 day'
);

-- The lender's private reasoning, on the declined request and on the one still
-- in review.  Two rows rather than one, because a note on a decided request
-- shows the decline path and a note on a live one shows the triage path, and
-- the second is the one a borrower must not see while it is still being
-- formed.
--
-- recorded_at is NOT supplied: credit_release_note_recorded_at overwrites it,
-- so a value here would be a value silently discarded -- and the point of the
-- trigger is that the timestamp is not the writer's to choose.
insert into public.credit_release_note (release_id, internal_note, recorded_by)
values
(
  '00000000-0000-4000-8000-0000000000f2',
  'Second request inside a week and the first one has not been repaid. '
  || 'Fenwick is not in trouble -- coverage was 1.79x at approval -- but the '
  || 'pattern is worth watching. Ask for the marketing plan before the next '
  || 'one, and do not raise the limit until the SE-22 tenure is settled.',
  '00000000-0000-4000-8000-0000000000c1'
),
(
  '00000000-0000-4000-8000-0000000000f3',
  'Trucking is a reasonable ask and the delivery is contracted. Waiting on '
  || 'the elevator confirmation before approving; if it does not arrive by '
  || 'Friday, approve at 20k and revisit.',
  '00000000-0000-4000-8000-0000000000c1'
);

-- Eight entries, spanning the nine days since the facility opened.
--
-- The arithmetic is the demo, so it is worth reading: the signed sum is
-- 128442.47 outstanding against a 250000.00 limit, with 30000.00 held by the
-- release still under review.  The borrower's available credit is therefore
-- 91557.53 and the lender's undrawn limit is 121557.53 -- the same row, two
-- legitimate readings, differing by exactly the pending amount.  On an empty
-- loan those two numbers are equal and the projection proves nothing.
--
-- Only one entry names a release.  The opening advance's provenance is the
-- application itself, and the fees and the interest are the lender's own
-- postings; that is what `release_id` being nullable is for.
insert into public.ledger_entry (loan_id, kind, amount, effective, release_id, memo)
values
  ('00000000-0000-4000-8000-0000000000e1', 'fee',        1250.00, current_date - 9,
   null, 'Facility establishment fee'),
  ('00000000-0000-4000-8000-0000000000e1', 'draw',     120000.00, current_date - 9,
   null, 'Opening advance -- seed and fertiliser'),
  ('00000000-0000-4000-8000-0000000000e1', 'repayment', -15000.00, current_date - 7,
   null, 'Input rebate applied against the balance'),
  ('00000000-0000-4000-8000-0000000000e1', 'draw',      85000.00, current_date - 6,
   '00000000-0000-4000-8000-0000000000f1', 'Disbursement of release f1'),
  ('00000000-0000-4000-8000-0000000000e1', 'fee',         350.00, current_date - 5,
   null, 'Wire transfer fee'),
  ('00000000-0000-4000-8000-0000000000e1', 'repayment', -40000.00, current_date - 3,
   null, 'Grain delivery proceeds'),
  ('00000000-0000-4000-8000-0000000000e1', 'interest',   1842.47, current_date - 2,
   null, 'Interest accrued to date at 8.75 per cent'),
  ('00000000-0000-4000-8000-0000000000e1', 'repayment', -25000.00, current_date - 1,
   null, 'Scheduled instalment');

-- The history the three releases would have accumulated if the machine had
-- been walked.  Without it the timeline component renders an empty box on the
-- one screen a reviewer opens to check the audit story is real rather than
-- promised (0004_demo_data.sql makes the same argument for applications).
--
-- from_state is null for the creation events, which is what
-- workflow_event.from_state being nullable is for: the machine's `[*] -> draft`
-- edge has to be representable.
--
-- The event names are the transition names in workflow_transition, generated
-- from packages/workflow.  A mismatch between these and the generated rows is
-- detectable, and if one appears the generated table is right and this is
-- wrong.
insert into public.workflow_event
  (machine, subject_id, from_state, to_state, event, actor_id, actor_role, payload, created_at)
values
-- (a) the funded one, walked all the way through
('credit_release', '00000000-0000-4000-8000-0000000000f1',
 null, 'draft', 'create',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 null, now() - interval '7 days'),
('credit_release', '00000000-0000-4000-8000-0000000000f1',
 'draft', 'submitted', 'submit',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 '{"amount": "85000.00"}'::jsonb, now() - interval '7 days' + interval '20 minutes'),
('credit_release', '00000000-0000-4000-8000-0000000000f1',
 'submitted', 'under_review', 'begin_review',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 null, now() - interval '7 days' + interval '4 hours'),
('credit_release', '00000000-0000-4000-8000-0000000000f1',
 'under_review', 'approved', 'approve',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 null, now() - interval '6 days' - interval '2 hours'),
('credit_release', '00000000-0000-4000-8000-0000000000f1',
 'approved', 'funded', 'disburse',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 '{"kind": "draw", "amount": "85000.00"}'::jsonb, now() - interval '6 days'),
-- (b) the declined one
('credit_release', '00000000-0000-4000-8000-0000000000f2',
 null, 'draft', 'create',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 null, now() - interval '4 days'),
('credit_release', '00000000-0000-4000-8000-0000000000f2',
 'draft', 'submitted', 'submit',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 '{"amount": "40000.00"}'::jsonb, now() - interval '4 days' + interval '10 minutes'),
('credit_release', '00000000-0000-4000-8000-0000000000f2',
 'submitted', 'under_review', 'begin_review',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 null, now() - interval '3 days' - interval '6 hours'),
('credit_release', '00000000-0000-4000-8000-0000000000f2',
 'under_review', 'declined', 'decline',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 null, now() - interval '3 days'),
-- (c) the one still in review
('credit_release', '00000000-0000-4000-8000-0000000000f3',
 null, 'draft', 'create',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 null, now() - interval '2 days'),
('credit_release', '00000000-0000-4000-8000-0000000000f3',
 'draft', 'submitted', 'submit',
 '00000000-0000-4000-8000-0000000000c2', 'borrower',
 '{"amount": "30000.00"}'::jsonb, now() - interval '2 days' + interval '5 minutes'),
('credit_release', '00000000-0000-4000-8000-0000000000f3',
 'submitted', 'under_review', 'begin_review',
 '00000000-0000-4000-8000-0000000000c1', 'lender',
 null, now() - interval '1 day');
