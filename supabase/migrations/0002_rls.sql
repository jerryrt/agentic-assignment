-- Row-level security: the security boundary of this system.
--
-- Everything in 0001_init.sql is reachable from a browser.  PostgREST publishes
-- every table and view in `public`, and Supabase's default privileges hand
-- `anon` and `authenticated` full DML on each one, so a table without RLS is not
-- "not yet locked down" -- it is a public API returning every row to anyone
-- holding the anon key, which ships in the browser bundle.  This migration is
-- therefore the gate; the API layer is a convenience in front of it.
--
-- Three properties are worth stating up front, because each drove a decision
-- below that would otherwise look like over-engineering:
--
--  1. RLS filters ROWS, never COLUMNS.  Where a rule is really about a column,
--     the schema is shaped so the question becomes a row question instead: the
--     lender-only decision fields are a table, `application_decision`, with a
--     row policy of its own, rather than columns on `application` that a
--     borrower's own select policy would hand them.  0001_init.sql carries the
--     reasoning.  The one rule that cannot be reshaped that way is
--     `profile.role`, where the guarded column and the readable row belong to
--     the same subject; there, and only there, a column-level GRANT carries the
--     privilege escalation guard.
--  2. A policy on `profile` that subqueries `profile` recurses (plan/10, "Supabase
--     RLS recursion").  Every role lookup below goes through a `security definer`
--     helper, which reads as the table owner and so is not itself policed.
--  3. `service_role` bypasses RLS but NOT grants.  That is what makes the event
--     log genuinely append-only rather than append-only-by-convention.
--
-- The `admin` member of `app_role` deliberately gets no policy in this migration.
-- An untested privilege is an assumption, there is no admin surface to probe yet,
-- and failing closed is the correct direction to be wrong in.  Admin tooling runs
-- through the service role until an admin surface exists and can be probed.

-- helpers ----------------------------------------------------------------
--
-- These exist to break the recursion in 2 above.  `security definer` makes them
-- run as the owner of `profile`, and a table's owner is not subject to that
-- table's policies, so reading `profile` from inside a `profile` policy
-- terminates instead of re-entering policy evaluation.
--
-- `set search_path = ''` is not decoration.  A security definer function that
-- resolves names through the caller's search_path can be pointed at an
-- attacker's table or operator and will run it with the owner's privileges --
-- the same reasoning 0001_init.sql gives for handle_new_user().  With an empty
-- search_path nothing resolves implicitly, so every name below is qualified.
--
-- Each helper answers a question about the CALLER only.  None takes an argument
-- that would let it answer a question about somebody else, because EXECUTE is
-- granted to every authenticated user and a helper that leaked would leak to all
-- of them.

create function public.current_app_role()
  returns public.app_role
  language sql
  stable
  security definer
  set search_path = ''
as $fn$
  select p.role from public.profile p where p.id = (select auth.uid())
$fn$;

create function public.current_org_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path = ''
as $fn$
  select p.org_id from public.profile p where p.id = (select auth.uid())
$fn$;

-- "Is the caller a lender at this organisation?"  Not security definer: it reads
-- nothing itself, it only combines the two helpers above.  coalesce is load
-- bearing -- an unauthenticated caller makes both helpers null, and a policy
-- treats null as neither true nor false; saying `false` outright is clearer than
-- relying on that.
create function public.is_lender_of_org(p_org uuid)
  returns boolean
  language sql
  stable
  set search_path = ''
as $fn$
  select coalesce(
    p_org is not null
      and public.current_app_role() = 'lender'
      and p_org = public.current_org_id(),
    false)
$fn$;

-- "May the caller read this borrower's profile?"  A lender may, for a borrower
-- who has applied to the lender's organisation -- otherwise the lender queue
-- cannot show a borrower's name at all, because `application_lender_v` joins
-- `profile`.
--
-- security definer because it reads `application`, and reading `application`
-- under the caller's own policies from inside a `profile` policy would make the
-- two tables' policies mutually dependent.  It is safe to expose despite taking
-- an argument: the answer is relative to `auth.uid()`, so it tells a caller
-- nothing they could not already obtain by listing the applications they can
-- see.
create function public.can_read_borrower_profile(p_borrower uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $fn$
  select exists (
    select 1
    from public.application a
    where a.borrower_id = p_borrower
      and public.is_lender_of_org(a.org_id)
  )
$fn$;

-- "Is the caller a lender at the organisation this application was sent to?"
--
-- Not a second definition of is_lender_of_org(); it is a composition of it, the
-- way can_read_borrower_profile() is.  It exists because the predicate is needed
-- four times by the `application_decision` policies below -- one select, one
-- insert, and both sides of one update -- and four hand-written copies of a
-- security predicate are four things that have to be kept in step.
--
-- Deliberately NOT security definer: it reads `application` as the CALLER, so a
-- caller who cannot see the application cannot reach its decision either.  That
-- composes the existing rule instead of adding a second one, and it fails closed
-- -- which is why a borrower gets nothing here even though the borrower CAN see
-- the application row: is_lender_of_org() is false for them.
create function public.is_lender_of_application(p_application uuid)
  returns boolean
  language sql
  stable
  set search_path = ''
as $fn$
  select exists (
    select 1
    from public.application a
    where a.id = p_application
      and public.is_lender_of_org(a.org_id)
  )
$fn$;

-- EXECUTE is granted to PUBLIC by default, which includes `anon`.  None of the
-- policies below is reachable by `anon` (every one is `to authenticated`), so
-- there is no reason for an unauthenticated caller to be able to invoke these.
revoke execute on function public.current_app_role() from public;
revoke execute on function public.current_org_id() from public;
revoke execute on function public.is_lender_of_org(uuid) from public;
revoke execute on function public.can_read_borrower_profile(uuid) from public;
revoke execute on function public.is_lender_of_application(uuid) from public;

grant execute on function public.current_app_role() to authenticated;
grant execute on function public.current_org_id() to authenticated;
grant execute on function public.is_lender_of_org(uuid) to authenticated;
grant execute on function public.can_read_borrower_profile(uuid) to authenticated;
grant execute on function public.is_lender_of_application(uuid) to authenticated;

-- enable ------------------------------------------------------------------
--
-- Every table, not just the interesting ones.  A table with RLS off is readable
-- and writable by any holder of the anon key, so an omission here is a data
-- leak rather than an untidy corner.  Enabling RLS with no policy denies
-- everything, which is why the policies follow rather than precede.
--
-- `force row level security` is deliberately NOT used: it would subject the
-- table owner to these policies too, which would break the definer helpers
-- above and the signup trigger in 0001_init.sql.

alter table public.organisation         enable row level security;
alter table public.profile              enable row level security;
alter table public.loan_product         enable row level security;
alter table public.application          enable row level security;
alter table public.application_decision enable row level security;
alter table public.workflow_event       enable row level security;
alter table public.workflow_transition  enable row level security;

-- privileges --------------------------------------------------------------
--
-- The half of the boundary RLS cannot express.  Supabase's default privileges
-- grant `anon` and `authenticated` SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES and TRIGGER on every new table in `public`; TRUNCATE in particular
-- is not filtered by RLS at all.  Each table therefore starts from nothing and
-- is granted back exactly what a client needs.
--
-- `anon` is granted nothing anywhere.  An unauthenticated visitor has no
-- business reading application data, and a marketing surface that later wants
-- public loan products can add that one grant in its own migration, where it can
-- be reviewed as the deliberate widening it is.

revoke all on public.organisation         from anon, authenticated;
revoke all on public.profile              from anon, authenticated;
revoke all on public.loan_product         from anon, authenticated;
revoke all on public.application          from anon, authenticated;
revoke all on public.application_decision from anon, authenticated;
revoke all on public.workflow_event       from anon, authenticated;
revoke all on public.workflow_transition  from anon, authenticated;

grant select on public.organisation        to authenticated;
grant select on public.loan_product        to authenticated;
grant select on public.profile             to authenticated;
grant select on public.workflow_event      to authenticated;
grant select on public.workflow_transition to authenticated;

-- profile: a borrower must not be able to promote themselves to lender.
--
-- An UPDATE policy cannot express this.  `with check` sees only the NEW row, so
-- `with check (id = auth.uid())` is satisfied just as happily by a row whose
-- `role` has changed to 'lender' as by one where only `full_name` moved -- RLS
-- has no notion of "this column changed".  The alternatives are a BEFORE UPDATE
-- trigger comparing old.role to new.role, or the column privilege used here.
-- The privilege is preferred: it is declarative, it is visible in `\dp`, and it
-- fails at parse time with a permission error rather than after the statement
-- has been planned.
--
-- This closes the same hole handle_new_user() closed on the way in.  That
-- function refuses to read a role out of the signup payload; this refuses to let
-- one be written afterwards.  Promotion happens out of band, with the service
-- role, which is not subject to either.
grant update (full_name) on public.profile to authenticated;

-- application: ordinary table-level SELECT.
--
-- There is nothing left on this table to withhold from a borrower -- the
-- lender-only fields are rows in `application_decision` now -- so SELECT is
-- granted whole and the row policies below decide everything.  That is worth
-- more than tidiness: a column-level SELECT grant makes a client `select('*')`
-- fail with 42501, whose message does not name the withheld column, so the
-- first symptom of the gate is an error nobody can read.  A row policy returns
-- fewer rows, which is legible.
--
-- INSERT deliberately omits `state`: a borrower creates drafts, and with no
-- privilege on the column the row can only take the 'draft' default.  UPDATE
-- omits it for the same reason, so the client autosave path physically cannot
-- move an application through the machine; state changes go through the API's
-- service role and are re-checked by assert_legal_transition().
grant select on public.application to authenticated;
grant insert (borrower_id, org_id, data, furthest_step)
  on public.application to authenticated;
grant update (data, furthest_step, revision, updated_at)
  on public.application to authenticated;
grant delete on public.application to authenticated;

-- application_decision: whole-table SELECT, INSERT and UPDATE, because who may
-- touch a decision is a row question and the policy below is the answer.
--
-- No DELETE, for anyone.  A decision is the lender's side of the audit trail;
-- it is superseded by an update, not erased, and it disappears only with the
-- application it belongs to, by the cascade in 0001_init.sql.
grant select, insert on public.application_decision to authenticated;
-- Update is granted per column, not per table.  A policy chooses rows and has no
-- notion of "this column changed", so a whole-table update grant would let a
-- lender backdate `recorded_at` on their own audit entry, and repoint
-- `application_id` at another application of the same organisation - both sides
-- satisfy the policy, so a decision could be moved between files unremarked.
-- Same argument as the `profile.role` grant above.
grant update (decision_note, risk_grade, decided_by) on public.application_decision to authenticated;

-- workflow_event: append only, and meant literally.
--
-- No client may write it at all -- a client that can append can forge an audit
-- trail, which is worse than one that cannot write it, because a forged entry is
-- believed.  Events are written by the API with the service role.
--
-- UPDATE and DELETE are revoked from `service_role` as well.  service_role
-- bypasses RLS, so a policy could never have stopped it; a missing grant does.
-- Nothing in the design rewrites a log entry, so making that structurally true
-- costs nothing and removes a leaked-service-key scenario in which the trail can
-- be edited to hide the leak.  Retention or correction, if either is ever
-- needed, is a migration -- reviewable, and not something a request can do.
revoke update, delete, truncate on public.workflow_event from service_role;

-- policies ----------------------------------------------------------------
--
-- Every policy names `to authenticated`.  `anon` holds no privilege on any of
-- these tables, so an anon-reachable policy would be dead code; saying so keeps
-- the policy from being quietly resurrected by a future grant.
--
-- Multiple permissive policies for the same command are OR'd, which is how the
-- borrower and lender read paths coexist on `application` without either having
-- to know about the other.

-- organisation ------------------------------------------------------------
-- select: any authenticated user.  An organisation row is a name and an id: it
--   is the counterparty a borrower is choosing to apply to, and a borrower who
--   cannot read it cannot be shown who they are applying to.  Nothing
--   confidential lives here; when something does, it belongs in a table with a
--   narrower policy rather than a wider one here.
-- insert/update/delete: nobody.  Organisations are administered out of band with
--   the service role.
create policy organisation_read on public.organisation
  for select to authenticated
  using (true);

-- profile -----------------------------------------------------------------
-- select: your own row, plus -- for a lender -- the borrowers who have applied
--   to the lender's organisation.  The second is not a convenience: with
--   `security_invoker` on, a view that joins `profile` returns nothing for rows
--   the caller cannot see, so without it the lender queue would be empty.
-- update: your own row, and only `full_name` (see the grant above).
-- insert: nobody.  handle_new_user() creates the row; a client-created profile
--   would be a profile with no auth user behind it.
-- delete: nobody.  Removal follows the auth user, by cascade.
create policy profile_read_own on public.profile
  for select to authenticated
  using (id = (select auth.uid()));

create policy profile_read_applicant_as_lender on public.profile
  for select to authenticated
  using (public.can_read_borrower_profile(id));

create policy profile_update_own on public.profile
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- loan_product ------------------------------------------------------------
-- select: active products to every authenticated user, because eligibility is
--   evaluated in the browser against the product's criteria and a borrower who
--   cannot read the product cannot be told why they do not qualify.  A lender
--   additionally sees their own retired products, which is what makes a
--   deactivated product still explicable on an old application.
-- insert/update/delete: nobody.  Product definitions are content, and content is
--   seeded or administered, not posted by a client.
create policy loan_product_read on public.loan_product
  for select to authenticated
  using (active or public.is_lender_of_org(org_id));

-- application -------------------------------------------------------------
-- select: the borrower who owns it, or a lender at the receiving organisation.
-- insert: a borrower, for themselves, as a draft.  `state` is not grantable to
--   the client, so the check restates a guarantee the privilege already gives;
--   it is kept because a future grant would otherwise silently widen this.
-- update: the owning borrower, while the application is still a draft.  This is
--   the fast autosave path from plan/02 -- the browser writes straight to
--   Postgres with no serverless cold start in the way.  `using` and `with check`
--   both require 'draft', so a row cannot be edited out of draft or into it.
-- delete: the owning borrower, while it is still a draft.  Abandoning a draft is
--   the borrower's to do; a submitted application is a record and stays.
create policy application_read_own on public.application
  for select to authenticated
  using (borrower_id = (select auth.uid()));

create policy application_read_as_lender on public.application
  for select to authenticated
  using (public.is_lender_of_org(org_id));

create policy application_insert_own_draft on public.application
  for insert to authenticated
  with check (borrower_id = (select auth.uid()) and state = 'draft');

create policy application_update_own_draft on public.application
  for update to authenticated
  using (borrower_id = (select auth.uid()) and state = 'draft')
  with check (borrower_id = (select auth.uid()) and state = 'draft');

create policy application_delete_own_draft on public.application
  for delete to authenticated
  using (borrower_id = (select auth.uid()) and state = 'draft');

-- application_decision ----------------------------------------------------
-- select/insert/update: a lender at the receiving organisation, and nobody
--   else.  In particular not the borrower the row is about, which is the whole
--   reason these fields are a table rather than two columns on `application`.
-- delete: nobody, enforced by the missing grant above.
--
-- The organisation is not a column here.  It is read from the application the
-- row belongs to, through is_lender_of_application(), which composes the same
-- is_lender_of_org() the `application` select policy uses -- so there remains
-- one definition of "a lender at the receiving organisation" and both
-- enforcement points move together.
--
-- `decided_by` is pinned to the caller on every client write.  A lender who may
-- write a decision could otherwise attribute it to a colleague, and a forged
-- attribution in an audit trail is worse than a missing one because it is
-- believed.  The API's service role bypasses RLS and is unaffected, so a
-- system-written decision is still possible where it is meant to be.
create policy application_decision_read_as_lender on public.application_decision
  for select to authenticated
  using (public.is_lender_of_application(application_id));

create policy application_decision_insert_as_lender on public.application_decision
  for insert to authenticated
  with check (
    public.is_lender_of_application(application_id)
    and decided_by = (select auth.uid())
  );

create policy application_decision_update_as_lender on public.application_decision
  for update to authenticated
  using (public.is_lender_of_application(application_id))
  with check (
    public.is_lender_of_application(application_id)
    and decided_by = (select auth.uid())
  );

-- workflow_event ----------------------------------------------------------
-- select: whoever can see the subject.  The log carries no access rule of its
--   own; it inherits the subject's, by reading `application` under the caller's
--   own policies.  That is deliberate -- a second copy of "who may see this loan
--   file" would be a second answer the first time either changed.
-- insert/update/delete: nobody, enforced by the grants above rather than by the
--   absence of a policy, so that adding a policy later cannot re-open it by
--   accident.
--
-- The `machine = 'application'` clause is a whitelist, not a filter.  `subject_id`
-- has no foreign key (plan/02 explains the trade), so there is no generic way to
-- resolve a subject; each machine's clause is added by the migration that
-- creates its table.  Until then those events are visible to nobody, which is
-- the correct direction to be wrong in.
create policy workflow_event_read_visible_subject on public.workflow_event
  for select to authenticated
  using (
    machine = 'application'
    and exists (
      select 1 from public.application a where a.id = workflow_event.subject_id
    )
  );

-- workflow_transition -----------------------------------------------------
-- select: every authenticated user, all rows.
-- insert/update/delete: nobody.  The rows are generated from packages/workflow
--   and arrive by migration; a client writing here would be writing the machine
--   definition.
--
-- Reading the whole table is a deliberate choice and worth stating, because
-- assert_legal_transition() reads it as the CALLER (0001_init.sql says so
-- explicitly), which means a role that cannot see a transition row cannot
-- perform that transition.  Row-filtering this table by actor_role would
-- therefore turn a visibility rule into a second, invisible authorisation rule
-- that disagrees with the machine the moment the two drift.  Authorisation for a
-- transition belongs to the API, which re-checks the actor's role against the
-- machine definition; the guard trigger's job is only to reject moves the
-- machine does not contain, and it can only do that if it can see the machine.
--
-- Nothing is lost by making the table legible: it is generated from source that
-- ships to the browser anyway, so the client already knows every legal move --
-- which is exactly how the UI predicts a transition before the server confirms
-- it.  A machine definition is not a secret; the authority to move through it
-- is, and that lives elsewhere.
create policy workflow_transition_read on public.workflow_transition
  for select to authenticated
  using (true);

-- projections -------------------------------------------------------------
--
-- Both views stay exactly as 0001_init.sql defined them, with
-- `security_invoker = on`, and neither carries a predicate of its own.  That is
-- what splitting `application_decision` out bought: every column either view
-- projects is one `authenticated` holds an ordinary privilege on, and every row
-- either view returns is one the policies above already admit, so there is a
-- single definition of who may read a loan file rather than one in the policies
-- and a second inside a definer view.
--
-- What a borrower gets from `application_lender_v` is therefore their own
-- applications with the decision columns null: the left join finds no decision
-- row their policy admits.  Nothing leaks, no view in this schema runs as its
-- owner, and Supabase's `security_definer_view` lint has nothing to report.
--
-- Both views are auto-updatable, so the default grants let a client INSERT and
-- UPDATE through them.  Reads are all either is meant to offer.
revoke all on public.application_borrower_v from anon, authenticated;
revoke all on public.application_lender_v   from anon, authenticated;

grant select on public.application_borrower_v to authenticated;
grant select on public.application_lender_v   to authenticated;
