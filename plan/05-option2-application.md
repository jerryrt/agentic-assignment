# Plan 05 -- Option 2: Loan Application with Eligibility Matching

> The interesting part: a form long enough that state management is a real problem, plus rules
> that change what the user sees as they go.

This option carries the most weight overall, because assessment criterion #1 (front-end craft,
"forms at real complexity") is largely judged here.

## The form

Four steps, and the length is the point -- a three-field toy would dodge the assessment.

| Step | Route | Fields (~) | Notes |
|---|---|---|---|
| 1 Borrower | `/apply/:id/borrower` | 9 | entity type drives conditional fields: sole trader vs. corporation asks different things |
| 2 Farm | `/apply/:id/farm` | 12 | **repeating group**: parcels (acreage, tenure, commodity) -- this is where naive form state breaks |
| 3 Financials | `/apply/:id/financials` | 14 | derived, read-only fields: DSCR, current ratio, LTV computed live from inputs |
| 4 Loan request | `/apply/:id/request` | 6 | amount + purpose + term; the eligibility panel reacts hardest here |

Conditional fields, a repeating FormArray, and computed cross-step values -- all three are real
state-management problems rather than volume for its own sake.

## Form architecture

**Typed Reactive Forms as the backbone, signals for everything derived.** Reactive Forms remain
the mature path for validators, async validators, `FormArray`, and dirty/touched tracking;
signals are better at derived state. Bridge them once:

```ts
// packages/ui or apps/web/core
export function formSignal<T>(form: AbstractControl<T>): Signal<T> {
  return toSignal(form.valueChanges.pipe(startWith(form.value)), { requireSync: true });
}
```

Then everything downstream is a `computed()`:

```ts
readonly value       = formSignal(this.form);            // raw
readonly financials  = computed(() => deriveFinancials(this.value()));   // DSCR, LTV, ...
readonly eligibility = computed(() => evaluateEligibility(this.products(), {
                          ...this.value(), ...this.financials() }));
readonly qualifying  = computed(() => this.eligibility().filter(p => p.status === 'eligible'));
```

Zero manual subscriptions, zero `OnPush` guesswork, and the eligibility panel is a pure function
of the form. *(If Angular 22's signal forms are stable at build time, prefer them for step 4's
simple shape and keep Reactive Forms for step 2's FormArray. Verify before committing -- do not
plan around an API you have not run.)*

**A store per application, not per step.** One `ApplicationStore` (`providedIn` the `/apply/:id`
route) owns the whole payload; steps are views over slices of it. Step components stay dumb and
the "does step 2 know about step 3's data" problem never arises.

## Draft durability

Per `03`, three layers: URL holds the step, server holds `application.data`, localStorage is the
seatbelt. Concretely here:

- Autosave: `toObservable(this.value).pipe(debounceTime(800), distinctUntilChanged(deepEq))`
  -> `PATCH /api/application/:id/draft` (or direct Supabase update under the draft RLS policy --
  faster, no cold start; the trigger still blocks any state change).
- Flush immediately on step navigation and on `visibilitychange -> hidden` via `sendBeacon`.
- `furthest_step` updates on each successful step validation; the route guard redirects a
  deep-link beyond it.
- A subtle one worth getting right: **do not autosave a pristine untouched form over good server
  data on load.** Gate the autosave effect on `form.dirty`. This is the bug that silently eats a
  user's application, and it is the kind of thing the CTO may well probe.

## Eligibility matching

Products carry criteria as data (`loan_product.criteria`), evaluated by `packages/rules`:

```ts
export type RuleResult = {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'unknown';   // 'unknown' = not enough entered yet
  severity: 'error' | 'warning';
  explain: string;                        // "Needs 1.25 DSCR -- you're at 1.08"
  inputs: Record<string, unknown>;        // for the [explain] drawer
};
```

Criteria set (enough to make matching non-trivial, small enough to build):

| Rule | Operating line | Equipment loan |
|---|---|---|
| Min acreage | 200 | -- |
| DSCR floor | 1.25 | 1.15 |
| Max LTV | -- | 80% |
| Amount band | 25k-500k | 10k-250k |
| Eligible commodity | grain, oilseed | any |
| Years farming | 3 | 1 |
| Region | in-footprint provinces | in-footprint provinces |

**`unknown` is the load-bearing status.** On step 1 nothing has been entered, so every product is
"we need more information" -- not "you don't qualify." Showing a wall of red on a form the user
has barely started is the failure mode this option is built to expose. Status resolves to
pass/fail only once its inputs exist.

## The panel that "changes what the user sees as they go"

A sticky sidebar, present from step 1, updating on every keystroke:

![Eligibility panel, light and dark](../design/preview/fieldwork.svg)

*The right-hand card in each half. Rendered from `design/tokens.json`, so this is the real
palette rather than an impression of it.*


Two things make this good rather than a checklist:

1. **Actionable failure.** A failing numeric rule computes the delta to passing. "LTV 88%
   (max 80%) -> borrow $164k, or add $30k down" is a product; "ineligible" is a wall.
2. **It never blocks submission by itself.** The `submit` guard requires *at least one* eligible
   product (`03`), not all of them. Borrowers may proceed with the one they qualify for.

An `eligibility_snapshot` row is written on submit, so the lender sees what the borrower was told
at the time, even if criteria change later. Small table, disproportionate credibility.

## Build notes

- Products load once per application into a signal; evaluation is fully client-side for
  responsiveness and re-run server-side inside the submit guard. Same package, no drift.
- Rules are unit-tested as pure functions -- a table-driven test per product per criterion. This is
  fast, and it is where tests actually pay for themselves.
- Accessibility floor: every field labelled, errors wired via `aria-describedby`, the eligibility
  panel is an `aria-live="polite"` region. The brief does not assess visual polish but a loan
  officer moving quickly is a keyboard user.
