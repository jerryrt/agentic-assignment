# Plan 09 - Build Order

Sequenced so the build is **submittable at four checkpoints**. If time runs out, you stop at a
checkpoint and submit, rather than abandoning a half-cut trench. Per `10`, saying where you
stopped and why is itself assessed (criterion #7).

Test-first throughout: the engines in phases 1-3 are pure functions, so red-green-refactor is
both cheap and the fastest way to build them. See `CLAUDE.md` for the TDD rule.

---

## Phase 0 - Skeleton

- `pnpm init`, workspace, `turbo.json`, `tooling/tsconfig`, `tooling/eslint-config`.
- Angular 22 app in `apps/web`; empty `apps/api` with one health route.
- Empty `packages/{domain,workflow,rules,db,ui}` that each export and import cleanly.
- `supabase init`, first migration (profile, organisation, trigger for profile-on-signup).
- CI green on an empty repo, both Vercel projects deploying.

Do this first and completely. A pipeline retrofitted at hour four is a pipeline that eats hour
four. It also means every later phase lands on a live URL.

## Phase 1 - Workflow engine  (the load-bearing wall)

Tests first: `engine.can()` truth table, then the engine.

- `packages/domain`: entities, Zod schemas, `RuleResult`, state-label maps.
- `packages/workflow`: `defineMachine`, `can()`, `apply()`, guard composition.
- All three machine definitions (`03`) - definitions are data, so writing all three now costs
  minutes and locks the shape of everything downstream.
- `workflow:gen` codegen + the Postgres trigger + the parity test.
- `POST /api/transition` with optimistic locking and the event log.

Nothing is visible yet. Resist the urge to build a screen first: every screen in every option
calls this, and building it under a deadline later guarantees a client-side state machine
sneaking in behind it.

## Phase 2 - Rules engine

Tests first: table-driven cases per rule.

- `packages/rules`: evaluator, `requireAll`, numeric/exact comparators, tolerance, delta-to-pass.
- Eligibility rule set (`05`), completeness and consistency rule sets (`04`), credit availability
  (`06`).
- `packages/ui`: `<lj-rule-list>`, `<lj-state-badge>`, `<lj-timeline>`, `<lj-money>`.

Phases 1 and 2 are the 60% shared core from `00`. They are the reason three options are
tractable, and they are what most of the assessment criteria actually measure.

## Phase 3 - Auth, shell, seed

- Supabase Auth signup/login, `authGuard`, `roleGuard`, profile trigger.
- App shell, nav, borrower vs. lender routing.
- `seed.sql` with the four interesting states from `02`.

### >>> CHECKPOINT A - submittable
A working, deployed, authenticated app with a modelled workflow and no feature. Weak submission,
but honest and running. You should reach this comfortably.

## Phase 4 - Option 2 (application + eligibility)

Highest weight (criterion #1), so it goes first among the features.

- `ApplicationStore`, 4 steps, FormArray on step 2, derived financials.
- Draft durability: debounce, `sendBeacon` flush, `furthest_step`, localStorage reconcile, and
  the pristine-form guard from `05`.
- Eligibility sidebar with `unknown` handling and delta-to-pass.
- `submit` transition wired to the engine.

### >>> CHECKPOINT B - a complete, strong single-option submission
If the clock is gone here, **stop and submit.** This is a full Option 2 on a core that visibly
generalises, which beats three thin options. Say so in the README.

## Phase 5 - Option 1 (documents)

Cheapest next, because it reuses `<lj-rule-list>` and the slot machine already exists.

- Slot generation from `loan_product.required_docs` on entering `docs_pending`.
- Signed-URL upload to Storage, `StubExtractor`, manual correction panel.
- Completeness bar (accepted-and-valid only) and cross-check panel with both values plus tolerance.
- `begin_review` guard wired to completeness.

### >>> CHECKPOINT C - two options, one lifecycle
Application flows into document collection. Already a stronger story than either alone.

## Phase 6 - Option 3 (servicing + credit release)

- `fund` effect creates the loan; ledger and `loan_balance_v`.
- Borrower loans list, balance detail, release compose with draft-on-first-keystroke.
- Lender queue and decision screen; borrower/lender views.
- Realtime on `credit_release`.

### >>> CHECKPOINT D - all three, end to end
One borrower: apply, qualify, upload, get funded, draw credit. Demo the two-window realtime split.

## Phase 7 - Submission

- README per the brief: option choice and why (here: all three, and the argument from `00`), local
  setup, the workflow model, next-two-hours list.
- The AI section - see `10`, and treat it as a real deliverable.
- Demo logins, the turbo-ignore evidence, a 2-minute demo script for the CTO session.

---

## Realistic effort

Stated plainly rather than optimistically, because the brief's budget is 2-3 hours for one option:

| Phase | Rough |
|---|---|
| 0 skeleton + CI | 1.0 h |
| 1 workflow engine | 1.5 h |
| 2 rules + ui primitives | 1.5 h |
| 3 auth, shell, seed | 1.0 h |
| 4 Option 2 | 2.5 h |
| 5 Option 1 | 1.5 h |
| 6 Option 3 | 2.0 h |
| 7 submission | 1.0 h |
| **Total** | **~12 h** |

Roughly 4x the stated budget. That is the trade being made knowingly, and the README must say so
in one sentence rather than letting the assessors work it out. Checkpoints A-D exist so the trade
can be abandoned at any point without waste.
