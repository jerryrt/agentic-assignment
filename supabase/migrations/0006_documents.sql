-- The document pack: what a product asks for, what was submitted against it,
-- and where the bytes live.
--
-- Shape is fixed by plan/04-option1-documents.md.  Migrations are append-only
-- (docs/03-agent-scopes.md), so this file adds and never edits -- with one
-- exception the schema was designed for: 0001_init.sql deliberately left
-- `open_doc_count` off `application_lender_v` and said this migration would
-- append it with `create or replace view`.  That is done at the end.

-- the pack ----------------------------------------------------------------
--
-- Slots are GENERATED from loan_product.required_docs when an application
-- enters docs_pending, not seeded.  The required set is therefore
-- product-dependent: an equipment loan asks for an invoice and a lien search,
-- an operating line does not, and that single fact is what makes the checklist
-- read as a lending product rather than a fixed list.
create table document_slot (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references application(id) on delete cascade,
  code            text not null,
  label           text not null,
  required        boolean not null default true,
  -- Legality is not a check constraint, for the same reason application.state
  -- is not: the legal set is generated from packages/workflow into
  -- workflow_transition, and the trigger below reads it.  Two definitions of
  -- which moves are legal is one too many.
  state           text not null default 'required',
  -- Optimistic concurrency, as on application.  POST /api/transition matches on
  -- it, which is what makes two lenders accepting one document serialise
  -- instead of racing.
  revision        integer not null default 0,
  -- Copied from the product at generation time rather than read back through
  -- the product on every evaluation.  A product's pack may be edited, and a
  -- slot already generated has to keep the terms it was created under -- the
  -- same argument eligibility_snapshot makes about criteria.
  extract_required text[] not null default '{}',
  -- A `date`, not a `timestamptz`.  A certificate expires on a calendar day
  -- where it was issued; an instant would make the answer depend on the
  -- reader's time zone, so a document valid until the 12th would read as
  -- expired to anyone east of the issuer.  packages/rules compares it as an ISO
  -- calendar string for the same reason.
  valid_until     date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Generating the pack twice must not double the checklist.  Stated as a
  -- constraint rather than left to the generator checking first, because a
  -- check-then-insert is a race and this is not.
  unique (application_id, code)
);

-- The bytes' record.  Append-only: a replacement is a NEW row, which is exactly
-- what `replace` on the slot machine means.  Nothing updates or deletes one, so
-- what was submitted and when stays answerable after the fact -- including
-- after a document was replaced because it was rejected.
create table document_upload (
  id               uuid primary key default gen_random_uuid(),
  slot_id          uuid not null references document_slot(id) on delete cascade,
  -- The object key in the private bucket below.  THE CONVENTION IS
  -- LOAD-BEARING and every scope that produces a path must match it:
  --
  --     <application_id>/<slot_code>/<uuid>.<ext>
  --
  -- A storage policy can gate only on what the path says, so the application id
  -- has to be recoverable from it -- see the storage.objects policies below,
  -- which read the first path segment.  A path shaped any other way is a file
  -- nobody can prove the ownership of.
  storage_path     text not null,
  filename         text not null,
  bytes            integer not null check (bytes > 0),
  mime             text not null,
  -- { field: { value, confidence_basis_points, source } }.  Opaque here on
  -- purpose: packages/rules owns the confidence floor and the ocr-versus-human
  -- distinction, so it owns what a field means (CLAUDE.md section 8).
  extracted        jsonb,
  extraction_state text not null default 'pending',
  uploaded_at      timestamptz not null default now()
);

create index document_slot_application_idx on document_slot (application_id);
create index document_upload_slot_idx on document_upload (slot_id, uploaded_at desc);

-- The trigger every machine's table must carry.  The handoff on #9 says whoever
-- creates a table for a machine attaches this; the function was written in
-- 0001_init.sql to take the machine as an argument for exactly this moment, so
-- there is one guard serving three tables rather than three copies of one.
create trigger document_slot_assert_legal_transition
  before update on document_slot
  for each row execute function public.assert_legal_transition('document_slot');

-- security ----------------------------------------------------------------
--
-- A table added without policies is not "not locked down yet": PostgREST
-- publishes every table in `public` and Supabase's default privileges hand
-- anon and authenticated full DML on each one.  0002_rls.sql makes that
-- argument in full; this is that argument applied to two more tables and to a
-- bucket.

alter table public.document_slot   enable row level security;
alter table public.document_upload enable row level security;

revoke all on public.document_slot   from anon, authenticated;
revoke all on public.document_upload from anon, authenticated;

-- SELECT and nothing else, for either table.
--
-- A slot's `state` is not grantable to a client for the same reason
-- application.state is not: state changes go through POST /api/transition,
-- which re-checks the actor's role against the machine, and are re-checked by
-- the trigger above.  A borrower who could write `state` could accept their own
-- documents, and `accept` is a lender's decision.
--
-- document_upload takes no client INSERT either.  The row is written by the API
-- as the `upload` transition's effect, from the path the API itself minted -- a
-- client-supplied path is a client choosing which application's folder to write
-- into.  No UPDATE and no DELETE for anyone, including service_role: an upload
-- is a record of what was submitted, and a record that can be edited to agree
-- with what happened afterwards is not one.  Rows still go with their slot, and
-- their slot with its application, by the cascades above -- a referential
-- action runs as the owner of the referencing table.
grant select on public.document_slot   to authenticated;
grant select on public.document_upload to authenticated;

revoke update, delete, truncate on public.document_upload from service_role;

-- The audience is the application's audience: the borrower who owns it, or a
-- lender at the organisation it was sent to.  One policy that reads
-- `application` under the CALLER's own policies, rather than two restating
-- `borrower_id = auth.uid()` and `is_lender_of_org(org_id)` -- the
-- workflow_event_read_visible_subject pattern from 0002_rls.sql, which
-- 0005_application_submit.sql also used.  A second copy of "who may read this
-- loan file" is a second answer the first time either changes.
--
-- `admin` therefore reads nothing here, because 0002_rls.sql deliberately gives
-- admin no policy on `application`.  An untested privilege is an assumption,
-- and failing closed is the correct direction to be wrong in.
create policy document_slot_read_visible_application on public.document_slot
  for select to authenticated
  using (
    exists (
      select 1 from public.application a
      where a.id = document_slot.application_id
    )
  );

-- Reached through the slot, which is reached through the application, so the
-- same audience arrives here without this policy restating either half.
create policy document_upload_read_visible_slot on public.document_upload
  for select to authenticated
  using (
    exists (
      select 1 from public.document_slot s
      where s.id = document_upload.slot_id
    )
  );

-- storage -----------------------------------------------------------------
--
-- A private bucket, created here rather than clicked into the dashboard:
-- docs/01-local-development.md is explicit that a change made in the cloud does
-- not exist in supabase/migrations/, so it does not exist.
--
-- `public = false` is the load-bearing column.  A public bucket serves every
-- object to anyone holding the URL, and a loan file's documents are the last
-- thing that should be one guessed path away from the internet.  Reads go
-- through a signed URL the API issues after checking the caller, and writes
-- through a signed upload URL for a path the API minted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  -- 10 MB, the figure plan/04 fixes.  Stated here as well as in @lj/domain
  -- because this one is enforced by the storage service against the bytes
  -- themselves; the other is a check the client and the API make before the
  -- bytes are spent.  Two enforcers of one policy, not two policies.
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

-- storage.objects has row-level security enabled by Supabase already; what it
-- lacks is any policy for this bucket, and no policy means no access -- which
-- is the right default and the wrong destination.
--
-- The predicate reads the FIRST PATH SEGMENT as the application id and asks the
-- same question the table policies ask.  That is why the path convention is
-- part of the contract: a policy can gate only on what the path says.
-- `storage.foldername(name)` is Supabase's own splitter, so the parse is not
-- reimplemented here.
--
-- SELECT only, and only through this policy.  Nobody may INSERT, UPDATE or
-- DELETE an object directly: uploads arrive on a signed URL, which the storage
-- service authorises from the signature rather than from these policies, so the
-- API stays the only thing that decides a path may be written.
create policy documents_read_visible_application on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.application a
      where a.id = (storage.foldername(name))[1]::uuid
    )
  );

-- the lender's queue count ------------------------------------------------
--
-- 0001_init.sql left this column off and said this migration would append it,
-- rather than defining it as a constant zero: a wrong number is believed, an
-- absent column fails loudly at the first caller.
--
-- It counts REQUIRED slots not yet accepted, and it is a count rather than a
-- verdict.  Whether the pack is COMPLETE is evaluateCompleteness in
-- packages/rules, which also weighs expiry and readability; a queue ordered by
-- this and a guard decided by that are two different questions, and answering
-- both from one number would put a credit policy in a view.
--
-- The subquery runs under the caller, like everything else in a
-- security_invoker view, so a caller who cannot read the slots counts none of
-- them -- which is correct: they cannot see the application either.
create or replace view application_lender_v
  with (security_invoker = on) as
  select a.id, a.borrower_id, a.org_id, a.state, a.revision, a.data,
         a.furthest_step, a.submitted_at, a.decided_at,
         d.decision_note, d.risk_grade, d.decided_by, d.recorded_at,
         a.created_at, a.updated_at,
         p.full_name as borrower_name,
         (select count(*)
            from public.document_slot s
           where s.application_id = a.id
             and s.required
             and s.state <> 'accepted')::int as open_doc_count
  from application a
  join profile p on p.id = a.borrower_id
  left join application_decision d on d.application_id = a.id;
