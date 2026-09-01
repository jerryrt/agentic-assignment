# Plan 07 -- Angular 22 Front End

Assessment criterion #1 (heaviest weight) and #3 (component library choice).

## App structure

```
apps/web/src/app/
+-- app.config.ts            provideRouter(withComponentInputBinding()), provideHttpClient(withFetch())
+-- app.routes.ts            lazy loadChildren per feature
+-- core/
|   +-- auth/                SupabaseAuthService, authGuard, roleGuard
|   +-- api/                 typed fetch wrapper over /api + supabase client
|   +-- workflow/            TransitionService -- the only place transitions are fired
|   +-- realtime/            channel factory, cleans up on destroy
+-- features/
|   +-- apply/               Opt 2: shell + 4 steps + ApplicationStore
|   +-- documents/           Opt 1: pack view, upload, extraction review
|   +-- servicing/           Opt 3 borrower: loans, balances, release compose
|   +-- lender/              Opt 3 lender: queue, decision, application review
+-- shared/                  thin app-specific glue; reusable primitives live in packages/ui
```

Every component **standalone**; no NgModules anywhere. Routes are lazy per feature so
`turbo-ignore` + Vercel's output tracing keep the initial bundle honest.

## State: signals, with a rule about where they live

Three tiers, and the discipline is knowing which tier a piece of state belongs to:

1. **Server state** -- `httpResource()` / `resource()` for reads, keyed by route params. Route
   params come in via `withComponentInputBinding()`, so a refresh refetches with zero manual
   wiring.
2. **Aggregate state** -- one store class per aggregate (`ApplicationStore`, `LoanStore`),
   provided at the *route* level, not root. It dies when you leave the loan; no stale cross-file
   bleed. Shape: private `signal` fields, public `Signal` getters, methods that call the API and
   patch. No NgRx -- the brief wants design thinking, and 400 lines of boilerplate for four
   features would be the wrong call. Say that in the README; it is a defensible answer either way.
3. **Derived state** -- `computed()`, always. Eligibility, completeness %, available credit,
   which buttons are legal -- none of these are stored, all are computed from (1) and (2). If a
   value can be derived, deriving it removes a class of bug entirely.

`linkedSignal()` for the one genuinely awkward case: a field that is derived *but* user-editable
(e.g. requested amount pre-filled from available credit, then overridden). `effect()` is reserved
for I/O -- autosave and realtime subscriptions -- never for deriving state. If an `effect` is
writing a signal, it should have been a `computed`.

Change detection: `provideZonelessChangeDetection()` if stable in Angular 22, otherwise
`OnPush` everywhere. Verify at build time rather than planning around it.

## Component library: Angular Material 3 + Tailwind for layout

The brief asks which, and why, and says writing your own is legitimate if defensible. The
recommendation and its reasoning:

**Use Angular Material 3** for input primitives, and Tailwind for layout only.

- The heavy lift in this app is **forms** -- 40+ fields, conditional rendering, a FormArray,
  error wiring, and a11y. Material's form-field integrates with Reactive Forms' validation and
  ships correct `aria-describedby`, focus management and error announcement. Rebuilding that
  correctly costs more than the 2-3 hour budget for the whole assignment, and rebuilding it
  *incorrectly* loses points on criterion #1 rather than gaining them on #3.
- M3 theming means the app is not visibly Bootstrap-flavoured, which matters when the assessors
  see a dozen of these.
- Tailwind handles grid/spacing/responsive, where Material is weak and verbose.

Honest trade-offs to state rather than hide: Material's density on data-dense lender tables is
poor (fixed with `mat.density(-2)` on the queue), and mixing two styling systems needs a boundary
rule -- **Material owns components, Tailwind owns layout, never both on one element.**

The two rejected alternatives, briefly, because "which and why" wants a comparison:
PrimeNG (better tables out of the box, heavier and less coherent theming) and hand-rolled with
Tailwind + CDK (best control, wrong budget -- the a11y work is the hidden cost, and CDK alone
would still be the sane floor).

`packages/ui` holds what Material does not: `<lj-rule-list>`, `<lj-state-badge>`,
`<lj-timeline>`, `<lj-money>`, `<lj-step-header>`. Small, and each used in all three options --
that reuse is what makes three options fit.

## The components that pay for themselves

- **`<lj-rule-list [results]>`** -- renders `RuleResult[]`. Used by Option 2's eligibility panel,
  Option 1's cross-checks, and every blocked transition's guard blockers. One component, one
  visual language for "here is where you stand and why," three surfaces. This is the single
  highest-leverage abstraction in the build.
- **`<lj-state-badge [machine] [state] [audience]>`** -- resolves the two-vocabulary mapping from
  `02`. Guarantees the borrower and lender labels can never drift apart in a template.
- **`<lj-timeline [events]>`** -- renders `workflow_event[]`. Free audit trail everywhere.

## Auth

Supabase Auth, email + password, **working signup and login, not stubbed** (the brief says so
explicitly). Session in `localStorage` via the Supabase client; `authGuard` resolves the session
before the first render to avoid a login flash; `roleGuard('lender')` protects `/lender/**` and
is backed by RLS regardless (`02`).

On signup, a Postgres trigger creates the `profile` row with `role = 'borrower'`. The demo lender
account is seeded. Ship **two labelled demo logins in the submission README** -- the assessors
will not create accounts to see Option 3's lender side, and an unreachable feature is an unbuilt
feature.

## Performance floor

Not assessed, but cheap: lazy routes, `@defer` on the document viewer and the ledger table,
`NgOptimizedImage` if any images, `trackBy`/`@for` keys on every list. Skip anything beyond that.
