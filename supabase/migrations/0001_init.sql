-- Initial schema: identity, products, the application aggregate, the event log
-- and the generated transition table.  Shape is fixed by plan/02-domain-model.md;
-- the workflow guard by plan/03-workflow-engine.md.
--
-- Row-level security is deliberately NOT part of this migration.  It lands on its
-- own so the policies can be reviewed as a unit rather than buried in DDL.

-- identity ---------------------------------------------------------------

create type app_role as enum ('borrower', 'lender', 'admin');

-- Lending organisations.  plan/02 references organisation(id) from three tables
-- but does not spell the table out; it is kept to the identity a lender needs to
-- exist and be named, so later work adds columns rather than reworking them.
create table organisation (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- The application-visible half of an auth.users row.  Kept separate because
-- auth.users belongs to GoTrue: it is not ours to add columns to, and RLS
-- policies must not have to read it.
create table profile (
  id           uuid primary key references auth.users on delete cascade,
  role         app_role not null default 'borrower',
  org_id       uuid references organisation(id),   -- null for borrowers
  full_name    text,
  created_at   timestamptz not null default now()
);

-- products & rules -------------------------------------------------------

create table loan_product (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisation(id),
  name          text not null,
  -- numeric, never float: money must not acquire a rounding error on the way
  -- through the database.
  min_amount    numeric,
  max_amount    numeric,
  criteria      jsonb not null,   -- declarative rule set, see packages/rules
  required_docs jsonb not null,   -- doc slot definitions, see plan/04
  active        boolean not null default true
);

-- the aggregate ----------------------------------------------------------

create table application (
  id             uuid primary key default gen_random_uuid(),
  borrower_id    uuid not null references profile(id),
  org_id         uuid not null references organisation(id),
  -- Legality is not a check constraint: the legal set is generated from
  -- packages/workflow into workflow_transition, and the trigger below reads it.
  state          text not null default 'draft',
  revision       integer not null default 0,          -- optimistic concurrency
  data           jsonb not null default '{}',         -- form payload
  furthest_step  text,                                -- resume hint
  submitted_at   timestamptz,
  decided_at     timestamptz,
  decision_note  text,                                -- LENDER ONLY
  risk_grade     text,                                -- LENDER ONLY
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- the log ----------------------------------------------------------------

-- One append-only log serves all three machines, so the subject is identified by
-- (machine, subject_id) rather than by a foreign key.  The cost is no referential
-- integrity on subject_id; the gain is a single audit trail and a single timeline
-- component instead of one per machine.
create table workflow_event (
  id            bigserial primary key,
  machine       text not null,        -- 'application' | 'document_slot' | 'credit_release'
  subject_id    uuid not null,
  from_state    text,
  to_state      text not null,
  event         text not null,        -- the transition name, e.g. 'submit'
  actor_id      uuid references profile(id),
  actor_role    app_role,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

-- Ordered by id so a subject's history reads straight off the index; every
-- timeline render is this exact prefix.
create index workflow_event_subject_idx on workflow_event (machine, subject_id, id);

-- legal transitions, GENERATED from packages/workflow (see plan/03) -------
--
-- Left empty here on purpose.  The rows are emitted by `pnpm workflow:gen` from
-- the machine definitions, and hand-writing them here would create the second
-- copy that the generator exists to prevent.  Until that generated migration
-- lands the table is empty and the trigger below therefore rejects every state
-- change: the guard fails closed, which is the correct direction to be wrong in.
create table workflow_transition (
  machine    text not null,
  from_state text not null,
  event      text not null,
  to_state   text not null,
  actor_role app_role not null,
  primary key (machine, from_state, event, actor_role)
);

-- profile on signup ------------------------------------------------------

-- auth.users is written by GoTrue, not by the application, so the only way a
-- profile can be guaranteed to exist for every user is a trigger on that table.
--
-- security definer is required (the inserting role is GoTrue's, which has no
-- rights on public.profile) and is the reason search_path is pinned to the empty
-- string: a security definer function that resolves names through the caller's
-- search_path can be made to run an attacker's table or operator with the owner's
-- privileges.  With an empty search_path nothing resolves implicitly, so every
-- name below is schema-qualified.
create function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $fn$
begin
  -- role is NOT taken from the signup payload.  raw_user_meta_data is whatever
  -- the client posted, so honouring a role there would let anyone sign up as a
  -- lender.  Every profile starts as the column default and is promoted
  -- deliberately, out of band.
  insert into public.profile (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end
$fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- transition guard -------------------------------------------------------

-- Braces to the type system's belt: even a leaked service key or a bug in the API
-- cannot move a subject to a state the machine does not allow.  The machine name
-- arrives as a trigger argument so one function serves application, document_slot
-- and credit_release.
--
-- Not security definer: it reads workflow_transition as the caller, so a caller
-- who cannot see a transition row is refused the transition.  That fails closed,
-- which is the safe direction; a definer function here would only widen what an
-- untrusted caller can do.
create function public.assert_legal_transition()
  returns trigger
  language plpgsql
  set search_path = ''
as $fn$
begin
  if new.state is distinct from old.state
     and not exists (select 1 from public.workflow_transition t
                     where t.machine = tg_argv[0]
                       and t.from_state = old.state
                       and t.to_state = new.state) then
    raise exception 'illegal transition % -> % on %', old.state, new.state, tg_argv[0]
      using errcode = 'check_violation';
  end if;
  return new;
end
$fn$;

create trigger application_assert_legal_transition
  before update on application
  for each row execute function public.assert_legal_transition('application');

-- projections ------------------------------------------------------------
--
-- Two roles, two truths, enforced by column-level omission rather than by hiding
-- a field in a template.  security_invoker is on so the views read with the
-- caller's rights: a view defined by the owner otherwise runs as the owner and
-- would read straight past the row-level policies that land next.

-- No decision_note, no risk_grade: a borrower cannot select what the view does
-- not project, whatever the API does.
create view application_borrower_v
  with (security_invoker = on) as
  select id, borrower_id, org_id, state, revision, data, furthest_step,
         submitted_at, decided_at, created_at, updated_at
  from application;

-- Columns are listed rather than written as a.*, because Postgres expands a.*
-- once at definition time: the shorthand would silently mean "the columns
-- application had on the day this ran" and read as though it tracked the table.
--
-- plan/02 also projects an open_doc_count over document_slot.  That table is
-- introduced with the document pack in plan/04, so the count is added by that
-- migration with `create or replace view` appending the column at the end.
-- Defining it here as a constant zero was the alternative and is worse: a wrong
-- number is believed, whereas an absent column fails loudly at the first caller.
create view application_lender_v
  with (security_invoker = on) as
  select a.id, a.borrower_id, a.org_id, a.state, a.revision, a.data,
         a.furthest_step, a.submitted_at, a.decided_at, a.decision_note,
         a.risk_grade, a.created_at, a.updated_at,
         p.full_name as borrower_name
  from application a
  join profile p on p.id = a.borrower_id;
