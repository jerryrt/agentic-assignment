# Plan 10 - Scope, Risks, and the Submission README

## Cut list, in cut order

When time runs short, cut from the top. Each line is a thing to *drop*, plus the sentence that
goes in the README explaining it. Cutting silently is the only wrong answer here.

| # | Cut | README sentence |
|---|---|---|
| 1 | Realtime subscriptions | "Views poll on focus rather than subscribing; Realtime is a two-line change, and the polling boundary is in `core/realtime`." |
| 2 | Lender queue polish (SLA colouring, keyboard rows) | "The queue is a functional list, not a tuned work surface. Given more time this is where a loan officer's minutes actually go." |
| 3 | Manual extraction correction panel | "Extraction values come from the stub only; the `Extractor` seam and the `source: 'ocr' \| 'human'` field are in place for the correction path." |
| 4 | Option 1's cross-document consistency rules | "Completeness ships; consistency has the rule shapes and tests but only one live rule. The evaluator is the same one eligibility uses." |
| 5 | Option 3 entirely (stop at Checkpoint C) | "Servicing is modelled - schema, machine and balance view exist and are tested - but has no UI." |
| 6 | Option 1 entirely (stop at Checkpoint B) | "Option 2 is complete. The document and credit-release machines are defined and tested but unsurfaced." |

Never cut: the workflow engine, the rules engine, auth, CI, or the seed data. Those are the
assessed core (`00`), and an app without seeded interesting states cannot be demoed.

## Risks

**Angular 22 API surface.** Signal forms, zoneless change detection and `httpResource` are all
recent. The plan names them but does not depend on them - Reactive Forms plus `OnPush` is the
fallback everywhere (`07`). *Verify at Phase 0, not at Phase 4.* Building on an API that turns
out to be unstable at hour six is the single most likely way this build goes wrong.

**Turborepo plus Angular builder caching.** Angular's own `.angular/cache` can interact badly with
Turbo's outputs. Declare it in `outputs` (`01`) and verify a cold-vs-warm build early. Cheap to
check in Phase 0, expensive to debug later.

**Supabase RLS recursion.** Policies that query `profile` from within a `profile` policy deadlock
or recurse. Keep role lookups in a `security definer` helper function and test policies with the
Supabase CLI's local instance before deploying.

**Scope, which is the real one.** ~12 hours against a 2-3 hour brief (`09`). The checkpoint
structure is the mitigation. Re-read Checkpoint B's instruction before starting Phase 5: a
complete single option beats three partial ones, and the brief says so outright.

## The submission README - what the brief actually asks for

Four required items (`README.md`, "What to submit"). Notes on the two that are easy to underdo:

**The workflow model section.** Not prose. Include the three state diagrams, the transition table
with actor roles and guards, and a paragraph on durability answering the brief's four questions
in its own words: what the states are, what transitions are legal, where state lives, what happens
on refresh. Lift it from `03` - that file was written to be lifted.

**The AI section.** The brief calls this "one of the more useful things you can tell us about
yourself" and says it is not a formality. So it needs specifics, not a tool list:

- *Which tools*, and what each was actually used for.
- *What was delegated wholesale* - e.g. seed data, rule test tables, boilerplate migrations.
- *What was rejected or rewritten*, with a real example. The strongest material comes from the
  engines: generated state-machine code that stored derived state, guards written as booleans
  with no reason string, a suggested `expired` document state that violates the modelling rule
  in `04`.
- *What looked plausible and was wrong.* Keep a running note **during** the build - this is
  impossible to reconstruct afterwards and it is the highest-signal paragraph in the submission.
  Likely candidates: hallucinated Angular 22 signal-forms APIs, RLS policies that look correct
  and are recursive, a `turbo.json` missing `env` so cached builds ship stale config (`01`).

Keep a `plan/ai-log.md` from Phase 0 onward. Two lines per incident. It costs nothing during the
build and it is the section the assessors said they care most about.

## Preparing for the 45-minute session

They will ask why, and hand you one new requirement live. Prepare deliberately:

- **Rehearse a 2-minute demo path**, borrower to lender, in two windows.
- **Know every file you did not write.** Anything you cannot explain, delete or rewrite before
  submitting. The brief warns about this explicitly.
- **Have the defences ready** for the decisions most likely to be probed: no NgRx (`07`), Material
  over hand-rolled (`07`), derived balance over stored (`06`), `expired` not being a state (`04`),
  belt-and-braces transition enforcement (`03`), and all three options instead of one (`00`).
- **Predict the live requirement.** Most likely shapes: add a state to a machine (e.g. an
  `on_hold` with a resume path), add an eligibility criterion, add a role, or add a field that
  must flow from form to document cross-check. The architecture should make each a small,
  localised diff - if any of them would be a large diff, that is a design smell worth fixing
  before submitting. Time yourself doing one.
