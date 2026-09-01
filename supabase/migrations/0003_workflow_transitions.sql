-- GENERATED FILE -- DO NOT EDIT.
--
-- Emitted by `pnpm workflow:gen` from the machine definitions in
-- packages/workflow/src/machines. Legality is enforced twice -- by those
-- definitions in TypeScript and by the assert_legal_transition trigger
-- reading this table -- and defined once, here being the once. Edit a
-- machine and regenerate; the parity test in packages/workflow compares the
-- two on every run.
--
-- The table is replaced rather than added to. These rows have exactly one
-- source, so a regeneration is a replacement, and delete-then-insert makes
-- the migration safe to apply a second time. Migrations are append-only, so
-- a later machine edit emits a new numbered file rather than editing this
-- one; applied in order, the newest wins.
--
-- No BEGIN/COMMIT: the Supabase CLI already runs each migration in one
-- transaction, and a nested explicit block would only make that harder to
-- reason about.

delete from public.workflow_transition;

insert into public.workflow_transition
  (machine, from_state, event, to_state, actor_role)
values
  ('application', 'approved', 'fund', 'funded', 'lender'),
  ('application', 'docs_pending', 'begin_review', 'under_review', 'lender'),
  ('application', 'docs_pending', 'withdraw', 'withdrawn', 'borrower'),
  ('application', 'draft', 'submit', 'submitted', 'borrower'),
  ('application', 'draft', 'withdraw', 'withdrawn', 'borrower'),
  ('application', 'needs_borrower_action', 'resubmit', 'under_review', 'borrower'),
  ('application', 'needs_borrower_action', 'withdraw', 'withdrawn', 'borrower'),
  ('application', 'submitted', 'request_docs', 'docs_pending', 'lender'),
  ('application', 'submitted', 'withdraw', 'withdrawn', 'borrower'),
  ('application', 'under_review', 'approve', 'approved', 'lender'),
  ('application', 'under_review', 'decline', 'declined', 'lender'),
  ('application', 'under_review', 'request_info', 'needs_borrower_action', 'lender'),
  ('credit_release', 'approved', 'disburse', 'funded', 'lender'),
  ('credit_release', 'draft', 'submit', 'submitted', 'borrower'),
  ('credit_release', 'submitted', 'begin_review', 'under_review', 'lender'),
  ('credit_release', 'submitted', 'cancel', 'cancelled', 'borrower'),
  ('credit_release', 'under_review', 'approve', 'approved', 'lender'),
  ('credit_release', 'under_review', 'cancel', 'cancelled', 'borrower'),
  ('credit_release', 'under_review', 'decline', 'declined', 'lender'),
  ('document_slot', 'accepted', 'replace', 'uploaded', 'borrower'),
  ('document_slot', 'extracted', 'accept', 'accepted', 'lender'),
  ('document_slot', 'extracted', 'reject', 'rejected', 'lender'),
  ('document_slot', 'rejected', 'replace', 'uploaded', 'borrower'),
  ('document_slot', 'required', 'upload', 'uploaded', 'borrower'),
  ('document_slot', 'uploaded', 'extract', 'extracted', 'admin');
