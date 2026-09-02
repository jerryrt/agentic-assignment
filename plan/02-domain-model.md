# Plan 02 -- Domain Model, Roles & RLS

## The unifying entity

Everything hangs off one aggregate: the **loan file**. Option 2 creates it, Option 1 fills its
document pack, Option 3 services it after funding.

```mermaid
erDiagram
    ORGANISATION ||--o{ LOAN_PRODUCT : "defines criteria and required docs"
    ORGANISATION ||--o{ APPLICATION : receives
    PROFILE ||--o{ APPLICATION : submits
    APPLICATION ||--o{ DOCUMENT_SLOT : "requires (option 1)"
    DOCUMENT_SLOT ||--o{ DOCUMENT_UPLOAD : "holds files for"
    APPLICATION ||--o{ ELIGIBILITY_SNAPSHOT : "recorded at submit (option 2)"
    APPLICATION ||--o| LOAN : "created on funding (option 3)"
    LOAN ||--o{ LEDGER_ENTRY : "balance derived from"
    LOAN ||--o{ CREDIT_RELEASE : "drawn against"
    CREDIT_RELEASE ||--o{ LEDGER_ENTRY : "posts on disburse"
```

`APPLICATION` is the aggregate root and carries the workflow state. Option 2 creates it, option 1
fills its document pack, option 3 begins at `LOAN`. `application.data` (the multi-step form
payload) is a JSONB column on `APPLICATION`, not a table.

`WORKFLOW_EVENT` is deliberately outside this diagram: it references
`(machine, subject_id)` rather than a foreign key, because one append-only log serves all three
machines. That is a trade - no referential integrity on `subject_id` - taken so the event log,
the audit trail and the timeline component stay single implementations.


## Schema sketch

```sql
-- identity ---------------------------------------------------------------
create type app_role as enum ('borrower', 'lender', 'admin');

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
  min_amount    numeric, max_amount numeric,
  criteria      jsonb not null,   -- declarative rule set, see packages/rules
  required_docs jsonb not null,   -- doc slot definitions, see 04
  active        boolean not null default true
);

-- the aggregate ----------------------------------------------------------
create table application (
  id             uuid primary key default gen_random_uuid(),
  borrower_id    uuid not null references profile(id),
  org_id         uuid not null references organisation(id),
  state          text not null default 'draft',      -- validated by trigger
  revision       integer not null default 0,          -- optimistic concurrency
  data           jsonb not null default '{}',         -- form payload
  furthest_step  text,                                -- resume hint
  submitted_at   timestamptz,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The lender's private reasoning, in its own table because row-level security
-- filters rows and not columns -- see "Two roles, two truths" below.  That the
-- application was decided, and when, stays on `application`: the fact is the
-- borrower's business, only the reasoning is not.
create table application_decision (
  application_id uuid primary key references application(id) on delete cascade,
  decision_note  text,
  risk_grade     text,
  decided_by     uuid references profile(id),
  recorded_at    timestamptz not null default now()
);

-- the log ----------------------------------------------------------------
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
create index on workflow_event (machine, subject_id, id);

-- legal transitions, GENERATED from packages/workflow (see 03) ------------
create table workflow_transition (
  machine    text not null,
  from_state text not null,
  event      text not null,
  to_state   text not null,
  actor_role app_role not null,
  primary key (machine, from_state, event, actor_role)
);
```

`document_slot`, `document_upload`, `loan`, `ledger_entry`, `credit_release` are detailed in
`04` and `06`.

## Two roles, two truths

The brief's Option 3 hook -- *"two roles seeing different truths from the same data"* -- is
implemented at the **projection** layer, not by duplicating tables.

```sql
create view application_borrower_v as
  select id, borrower_id, org_id, state, revision, data, furthest_step,
         submitted_at, decided_at, created_at, updated_at
  from application;                       -- note: no decision_note, no risk_grade

create view application_lender_v as
  select a.id, a.borrower_id, a.org_id, a.state, a.revision, a.data,
         a.furthest_step, a.submitted_at, a.decided_at, a.created_at, a.updated_at,
         d.decision_note, d.risk_grade, d.decided_by, d.recorded_at,
         p.full_name as borrower_name
  from application a
  join profile p on p.id = a.borrower_id
  left join application_decision d on d.application_id = a.id;
```

Both views list their columns rather than using `a.*`. A star is expanded once, when the view is
defined, so it reads as though it tracks the table while silently meaning "the columns this table
had that day" -- and a later phase adding `open_doc_count` needs `create or replace view` to
append a column, which a star makes impossible.

**A view is a shape, not a gate.** Row-level security filters rows; it cannot withhold a column.
`application` is published by PostgREST, so a borrower holding a row policy on their own
application could select the lender's note straight off the base table no matter what the borrower
view omits. That is why the reasoning lives in its own table with its own policy, and it is the
correction to an earlier version of this document which claimed the omission was itself
enforceable. The API returns whichever view matches `profile.role`; the database enforces the
boundary either way.

The other half of "different truths" is **state labelling**. The same `state` value reads
differently per audience, and that mapping lives in `packages/domain`:

| `state` | Borrower sees | Lender sees |
|---|---|---|
| `under_review` | "With your lender" | "Awaiting your decision" |
| `needs_borrower_action` | "Action needed from you" | "Waiting on borrower" |
| `approved` | "Approved" | "Approved -- awaiting funding" |

One state, two vocabularies. Cheap to build, and it is exactly the point the brief is probing.

## RLS

RLS is on for every table. Policies are the security boundary; the API is a convenience layer,
never the only gate.

The policies below are the shape; the enforcement detail that is easy to get wrong is that a
policy chooses rows, so anything that must be hidden at column granularity has to be a separate
table or an explicit column grant. `application_decision` is the former. `profile.role` is the
latter, and has to be: an `update` policy cannot express "you may edit yourself but not your own
role", because `with check` sees only the new row and is satisfied just as happily by one whose
role changed.

```sql
alter table application enable row level security;

create policy app_borrower_read on application for select
  using (borrower_id = auth.uid());

create policy app_lender_read on application for select
  using (org_id = (select org_id from profile where id = auth.uid())
         and (select role from profile where id = auth.uid()) = 'lender');

-- Borrowers may edit their own DRAFT payload directly (fast autosave path).
create policy app_borrower_draft_write on application for update
  using (borrower_id = auth.uid() and state = 'draft')
  with check (borrower_id = auth.uid() and state = 'draft');
```

Note what that last policy does **not** allow: it cannot change `state`, because a
`BEFORE UPDATE` trigger rejects any `state` change whose tuple is absent from
`workflow_transition`. Drafts autosave straight from the browser (fast, no cold start); state
moves only via the API's service role. See `03`.

## Seed data

`supabase/migrations/0004_demo_data.sql` must produce a demo that is walkable in 60 seconds during the CTO session:

- 1 lender org, 2 loan products with genuinely different criteria (an operating line with a
  DSCR floor; an equipment loan with an LTV cap) so eligibility visibly diverges.
- 1 borrower with a **funded** loan and ledger history -> Option 3 has something to show
  immediately, without walking Option 2 first.
- 1 borrower mid-application at `docs_pending` with 2 of 5 slots filled, one of them **expired**
  and one **inconsistent** -> Option 1 shows its interesting state on first load.
- 1 borrower at `draft` on step 3 -> demonstrates resume.

Seeding the *interesting* states rather than empty tables is what makes the demo land.
