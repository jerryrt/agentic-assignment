-- Who may read a document slot's transition history.
--
-- 0002_rls.sql gates the append-only event log with
-- workflow_event_read_visible_subject, whose predicate whitelists
-- `machine = 'application'`, and says in its own comment that each machine's
-- clause is added by the migration that creates that machine's table.
--
-- 0007_servicing.sql did that for `credit_release`.  0006_documents.sql did NOT
-- do it for `document_slot`, and nothing caught the omission because the
-- consequence is silent: every slot transition -- upload, extract, accept,
-- reject, replace -- is written to the log and readable by nobody.  A timeline
-- over a document renders empty and nothing errors, which is indistinguishable
-- from a document that has no history.
--
-- Nothing renders one yet, which is the only reason phase 6 shipped without
-- anybody noticing.  <lj-timeline> exists and takes WorkflowEvent[], so the
-- first screen to use it would have shown an empty list with no way to tell
-- that from a policy refusal.
--
-- A SECOND policy rather than an edit to either existing one.  Migrations are
-- append-only, and multiple permissive policies for one command are OR'd, so
-- adding a clause widens the read exactly as intended without restating the
-- others.
--
-- The subject is resolved by reading `document_slot` under the CALLER's own
-- policies, so the log inherits the slot's audience -- which is itself the
-- application's audience, by the policy in 0006 -- and carries no access rule
-- of its own.  A second copy of "who may read this loan file" is a second
-- answer the first time either changes.
create policy workflow_event_read_document_slot on public.workflow_event
  for select to authenticated
  using (
    machine = 'document_slot'
    and exists (
      select 1 from public.document_slot s
      where s.id = workflow_event.subject_id
    )
  );
