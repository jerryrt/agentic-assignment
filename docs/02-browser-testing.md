# Browser test plan

Unit tests cover the engines (`../CLAUDE.md`, **Test-driven development**). They cannot answer the
question the brief actually asks:

> what happens if someone closes the tab mid-way and comes back

That is a browser question. So is "two roles seeing different truths from the same data," and so
is every claim about what a loan officer can see. Browser automation is where those get verified,
against the real containerized stack from `01-local-development.md` - real Postgres, real auth,
real RLS. No mocked network.

## Tool

**Playwright `1.62.1`**, with `@axe-core/playwright 4.13.0` for accessibility.

Chosen over the alternatives for three reasons that matter here specifically:

- **Multiple independent browser contexts in one test.** The borrower and the lender are two
  sessions with two cookie jars, asserted against each other inside a single test. This is the
  direct expression of option 3's "two roles, two truths", and it is awkward in single-context
  runners.
- **First-class durability control.** `page.reload()`, closing and reopening a context,
  `context.setOffline(true)`, and clock control are all built in. The draft-recovery behaviour in
  `../plan/05-option2-application.md` is otherwise untestable.
- **Built-in visual comparison** with `toHaveScreenshot()`, plus an official container image, which
  is what makes visual baselines reproducible (see below).

## The three layers

### 1. System - end-to-end journeys

One borrower, one lender, the whole lifecycle. These are slow, few, and they are the tests that
prove the three options are one product.

| Test | Path |
|---|---|
| `lifecycle.spec.ts` | signup -> apply (4 steps) -> qualify -> submit -> lender requests docs -> upload pack -> lender approves -> funds -> borrower draws credit -> lender disburses |
| `two-roles.spec.ts` | two contexts open at once; lender approves a release; borrower's view reflects it without a manual reload |
| `auth.spec.ts` | signup, logout, login, session survives reload, `/lender/**` refuses a borrower |

Three system tests. Not thirty - they are the most expensive and most brittle tests in the suite,
and their job is coverage of the seams, not of the branches.

### 2. Functional - behaviour that is specifiable

Where the interesting logic actually is. Each maps to a claim made in `../plan/`.

**Durability** (`../plan/03-workflow-engine.md`, the brief's own question):

- Fill steps 1-3, reload mid-step-3: values and step position both restored.
- Fill a step, kill the context without a navigation, reopen: the unsaved-changes prompt appears
  and restores.
- Deep-link to step 4 of an application still on step 2: redirected to the furthest legal step.
- Two lender tabs approve the same credit release: the second gets a conflict and refetches
  rather than double-approving.

**Rules and guards** (`../plan/04`, `../plan/05`):

- Eligibility panel shows `unknown`, not failure, on a form that has barely been started.
- Entering a DSCR below the floor flips a product to not-eligible **and** states the delta to
  passing.
- Submit is refused while no product is eligible, and the blocker text names the reason.
- Completeness percentage counts accepted-and-valid slots only: uploading a document that then
  fails must not move the bar forward and back.
- An expired document reports "upload current", not "expired".

**Roles** (`../plan/06`):

- The borrower's available credit is net of pending requests; the lender's exposure figure is not.
- `internal_note` never appears in any borrower response body - assert on the network payload, not
  only on the rendered page. A field hidden in a template is not hidden.

### 3. Visual - layout and theme

`toHaveScreenshot()` on a small set of surfaces that carry the design system, in **both colour
schemes**, at two viewports:

| Surface | Why |
|---|---|
| Eligibility panel, all four statuses | The signature surface; verifies the token contract |
| Document pack, mid-completion | Progress, expiry and cross-check states together |
| Lender queue | Density and tabular numerals |
| Application step 2 with the parcels FormArray | The layout most likely to break |
| A focused input and a focused button | Focus ring visible on `bg`, `surface` and `raised` |

Plus one **greyscale assertion** on the eligibility panel: the desaturation check from
`../design/00-foundations.md` is a rule with no enforcement until a test performs it. Apply a
`grayscale(1)` filter and compare against a committed baseline, so a future change that makes
status depend on colour alone fails CI instead of a code review.

And an **axe scan** on each of: login, an application step, the document pack, the lender queue.
Assert zero violations at serious and critical. The a11y floor in `../design/00-foundations.md` is
otherwise a promise nobody checks.

## Determinism, which is the whole difficulty

A flaky visual suite gets disabled within a week, and then it is worse than nothing. Five rules:

1. **Run visual tests only inside the container.** Font rasterisation differs between Linux, macOS
   and CI, so a baseline captured on a laptop will never match. Baselines are generated and
   compared in `mcr.microsoft.com/playwright:v1.62.1-noble` (verified to exist), which is the same
   image CI uses. This is the concrete reason the containerized rule extends to tests.
2. **Freeze the clock.** `page.clock.setFixedTime()`. Document expiry is computed against `now`
   (`../plan/04-option1-documents.md`), so an unfrozen clock makes a document expire mid-suite.
3. **Reset the database per spec file**, not per test - a fixture that truncates and re-seeds. Per
   test is too slow; shared state across files makes failures unreadable.
4. **Disable animation.** `reducedMotion: 'reduce'` in the Playwright config, which the app already
   honours (`../design/00-foundations.md`).
5. **Mask what is genuinely dynamic** - relative timestamps, generated ids - with the `mask`
   option rather than loosening the pixel threshold globally.

Never fix a flake by raising `maxDiffPixels`. That converts a real regression into a silent one.

## Fixtures

```
apps/web/e2e/
  fixtures/
    db.ts             truncate + seed, exposed as a worker fixture
    roles.ts          borrowerPage / lenderPage, pre-authenticated contexts
    seed.sql          the interesting states from ../plan/02-domain-model.md
  system/
  functional/
  visual/
```

Authenticate once per role by hitting the auth API directly and saving storage state, rather than
driving the login form in every test. The login form is exercised by `auth.spec.ts`; everywhere
else it is setup cost.

Seed the **interesting** states - an expired document, an inconsistent pair of extracted values, a
declined release, an application mid-draft. A suite seeded with empty tables tests nothing that
matters.

## Running

```bash
supabase start                       # the stack from 01-local-development.md
pnpm dev &                           # app under test
pnpm e2e                             # functional + system, headed browsers on the host
pnpm e2e:visual                      # visual + greyscale, inside the container
pnpm e2e:update                      # regenerate baselines, container only
```

`pnpm e2e:visual` and `pnpm e2e:update` wrap the same `docker run` so a baseline can never be
produced outside the container by accident.

## CI

Add a job after `verify` in `../plan/08-cicd.md`. It runs on the same container image, starts the
Supabase stack in the runner, and uploads the Playwright HTML report and any diff images as
artefacts - a visual failure is unreadable without the diff.

Keep it a **separate job**, not a step inside `verify`. It is the slowest thing in the pipeline
and it must not delay the signal from lint and unit tests.

## What this plan deliberately does not do

- **No coverage target.** The brief says so, and a percentage would push the suite toward testing
  layout, which is exactly what browser tests are worst at.
- **No cross-browser matrix.** Chromium only. Multi-browser triples runtime to defend against a
  risk this application does not have.
- **No testing of business rules through the UI.** Those are pure functions with unit tests
  (`../CLAUDE.md`). A browser test asserting a DSCR calculation is a slow, flaky duplicate of a
  fast, reliable one - and duplicating a rule is the thing the conventions forbid outright. The
  browser tests assert that the *right rule result reaches the screen*, not that the arithmetic is
  correct.
