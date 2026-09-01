# Plan 09 - Build Order

**This file owns the work breakdown and the effort total.** The parallel schedule in
[`../docs/03-agent-scopes.md`](../docs/03-agent-scopes.md) derives from it; it does not restate
it. If an estimate changes, it changes here.

Sequenced so the build is **submittable at four checkpoints**. If time runs out you stop at a
checkpoint and submit, rather than abandoning a half-cut trench. Per
[`10-scope-and-risks.md`](10-scope-and-risks.md), saying where you stopped and why is itself
assessed (criterion #7).

Test-first for the pure packages - `domain`, `workflow`, `rules` - because red-green-refactor is
cheaper there than a manual check. See `../CLAUDE.md` (**Test-driven development**).

---

## Phase 0 - Skeleton, pipeline, local stack (1.0 h)

Scope `platform` in [`../docs/03-agent-scopes.md`](../docs/03-agent-scopes.md).

- `pnpm init`, workspace, `turbo.json`, `tooling/tsconfig`, `tooling/eslint-config`.
- **Install from the pinned toolchain table in
  [`01-architecture.md`](01-architecture.md#pinned-toolchain).** Do not resolve versions from
  `latest` - npm's latest TypeScript is a major Angular 22 refuses, and the resulting error does
  not name its cause.
- Angular 22 app in `apps/web`; empty `apps/api` with one health route.
- Empty `packages/{domain,workflow,rules,db,ui}` that each export and import cleanly.
- `supabase init`, and **`supabase start` verified green** - twelve containers, about 42 s, per
  [`../docs/01-local-development.md`](../docs/01-local-development.md). The inner loop is local
  from here on.
- CI green on an empty repo.

Do this first and completely. A pipeline retrofitted at hour four is a pipeline that eats hour
four. Proving the deploy path now is also what keeps local-first development honest - it is the
one thing local-first must not defer (`../CLAUDE.md`, **Local-first development**).

**Connecting the two Vercel projects to the repository is the immediate follow-up, not part of the
phase.** Both projects are provisioned already, but connecting either before `apps/web` and
`apps/api` exist produces a failed deployment on the spot, and branch protection cannot require a
check GitHub has never observed. Both are the user's to perform once this phase lands
(`../CLAUDE.md`, **The board belongs to the user**). Phase 0 is not finished until they are done -
it is the same hour, in the same sitting, in the order the dependency forces.

## Phase 1 - Contracts: types, schema, RLS (2.0 h)

Scopes `contracts` and `data`. **This phase was previously implicit and is the one most likely to
be skipped under time pressure. It cannot be.**

- `packages/domain`: entities, Zod schemas, `RuleResult`, the audience-keyed state-label maps.
- Initial migration: the tables in [`02-domain-model.md`](02-domain-model.md), the
  profile-on-signup trigger, and the borrower/lender projection views.
- **Row-level security on every table, with the policies from
  [`02-domain-model.md`](02-domain-model.md)**, plus a test that an anonymous request returns none
  of the rows an authenticated borrower's own session returns. RLS is the security boundary
  (`../CLAUDE.md`, **Security baseline**); an API-only gate is not a substitute, and this is
  verifiable locally in seconds - it was measured that way in
  [`../docs/01-local-development.md`](../docs/01-local-development.md).
- `packages/db`: generated types, client factories, query helpers.

Everything downstream imports these types. Starting a feature before they exist means writing
against a shape that will change.

## Phase 2 - Engines (2.5 h)

Scopes `workflow` and `rules`. Independent of each other - the two halves can run concurrently.

Tests first: the `engine.can()` truth table, then the engine; table-driven cases per rule.

- `packages/workflow`: `defineMachine`, `can()`, `apply()`, guard composition.
- All three machine definitions ([`03-workflow-engine.md`](03-workflow-engine.md)) - definitions
  are data, so writing all three now costs minutes and locks the shape of everything downstream.
- `workflow:gen` codegen, the Postgres trigger, and the parity test.
- `packages/rules`: evaluator, `requireAll`, numeric and exact comparators, tolerance,
  delta-to-pass.
- The three rule sets: eligibility ([`05`](05-option2-application.md)), completeness and
  consistency ([`04`](04-option1-documents.md)), credit availability
  ([`06`](06-option3-servicing.md)).

Nothing is visible yet. Resist building a screen first: every screen in every option calls this,
and deferring it guarantees a client-side state machine appearing behind it.

## Phase 3 - Design system (1.0 h)

Scope `design-system`. Concurrent with Phase 2 - it needs only `RuleResult` from Phase 1.

- Token emitter: `tokens.json` to `_tokens.css` and `_palette.scss`, per
  [`../design/02-implementation.md`](../design/02-implementation.md).
- `tokens:check` wired into CI beside `workflow:check`.
- `packages/ui`: `<lj-rule-list>`, `<lj-state-badge>`, `<lj-timeline>`, `<lj-money>`.

`<lj-rule-list>` is the highest-leverage component in the build - it renders eligibility,
document cross-checks and every blocked guard. Getting it right once is what makes three options
affordable.

## Phase 4 - Delivery spine (2.25 h)

Scopes `api`, `web-core`, plus the test harness.

- `POST /api/transition`: guard evaluation, optimistic locking, the event log, effects in the
  same transaction.
- Supabase Auth signup and login, `authGuard`, `roleGuard`.
- App shell, nav, borrower versus lender routing, the store base class.
- `seed.sql` with the four interesting states from [`02-domain-model.md`](02-domain-model.md).
- **Playwright harness**: fixtures, per-role saved auth state, database reset, and one smoke
  journey. Built now, not at the end, so every later phase lands against a suite that already
  runs. See [`../docs/02-browser-testing.md`](../docs/02-browser-testing.md).

### >>> CHECKPOINT A - submittable
A deployed, authenticated app with a modelled workflow, enforced RLS and no feature. A weak
submission, but honest and running. You should reach this comfortably.

## Phase 5 - Option 2, application and eligibility (2.5 h)

Highest assessment weight (criterion #1), so it goes first among the features. It is also first
by necessity: options 1 and 3 attach to an application that must exist.

- `ApplicationStore`, four steps, the parcels `FormArray` on step 2, derived financials.
- Draft durability: debounce, `sendBeacon` flush, `furthest_step`, localStorage reconciliation,
  and the pristine-form guard from [`05-option2-application.md`](05-option2-application.md).
- Eligibility sidebar with `unknown` handling and delta-to-pass.
- `submit` transition wired to the engine.

### >>> CHECKPOINT B - a complete, strong single-option submission
If the clock is gone here, **stop and submit.** A full Option 2 on a core that visibly generalises
beats three thin options. Say so in the README.

## Phase 6 - Option 1, documents (1.5 h)

Cheapest next: it reuses `<lj-rule-list>` and the slot machine already exists.

- Slot generation from `loan_product.required_docs` on entering `docs_pending`.
- Signed-URL upload to Storage, `StubExtractor`, manual correction panel.
- Completeness bar counting accepted-and-valid only, and the cross-check panel showing both values
  and the tolerance.
- `begin_review` guard wired to completeness.

### >>> CHECKPOINT C - two options, one lifecycle
The application flows into document collection. A stronger story than either alone.

## Phase 7 - Option 3, servicing and credit release (2.0 h)

- `fund` effect creates the loan; ledger and `loan_balance_v`.
- Borrower loans list, balance detail, release compose with draft-on-first-keystroke.
- Lender queue and decision screen; the two projections.
- Realtime on `credit_release`.

### >>> CHECKPOINT D - all three, end to end
One borrower: apply, qualify, upload, get funded, draw credit. Demo the two-window realtime split.

## Phase 8 - Browser suite (1.0 h)

Scope `qa`, on the harness from Phase 4.

- The durability matrix: reload mid-step, killed context, deep-link past the furthest step, two
  tabs approving one release.
- Role separation, asserted on the network payload rather than the rendered page.
- Visual baselines and the greyscale check, generated **inside the Playwright container** so they
  are reproducible.
- `axe` scan on login, an application step, the document pack and the lender queue.

## Phase 9 - Submission (1.0 h)

- README per the brief: option choice and why (here: all three, and the argument from
  [`00-overview.md`](00-overview.md)), local setup, the workflow model, the next-two-hours list.
- The AI section - see [`10-scope-and-risks.md`](10-scope-and-risks.md), and treat it as a real
  deliverable.
- Demo logins, the `turbo-ignore` evidence, a two-minute demo script for the CTO session.

---

## Effort

| Phase | Scopes | Hours |
|---|---|---|
| 0 skeleton, pipeline, local stack | platform | 1.00 |
| 1 contracts: types, schema, RLS | contracts, data | 2.00 |
| 2 engines | workflow, rules | 2.50 |
| 3 design system | design-system | 1.00 |
| 4 delivery spine | api, web-core, harness | 2.25 |
| 5 Option 2 | feature-apply | 2.50 |
| 6 Option 1 | feature-documents | 1.50 |
| 7 Option 3 | feature-servicing | 2.00 |
| 8 browser suite | qa | 1.00 |
| 9 submission | - | 1.00 |
| **Total, one agent** | | **16.75** |

Roughly six times the brief's stated budget for one option. That is the trade being made
knowingly, and the README must say so in one sentence rather than letting the assessors work it
out.

With four agents at the graph's peak width, the same work lands in about **9 hours of wall time** -
see [`../docs/03-agent-scopes.md`](../docs/03-agent-scopes.md). More than four agents does not
help; the ceiling is the serial spine, phases 0, 1, 4 and 5.

Checkpoints A to D exist so the trade can be abandoned at any point without waste. The cut list,
in cut order, is in [`10-scope-and-risks.md`](10-scope-and-risks.md).
