# Foundations

Everything on this page is **identical whichever theme is picked**. Only the colour values in
`tokens.json` change. Read this first; it is where most of the usability of the app actually
comes from.

## The token contract

All four themes expose the same 19 token names. That is what makes the choice reversible: swapping
themes is editing one file, never touching a component. Components reference tokens, never hex
values and never a theme name.

```
ground      bg  surface  raised
structure   border  border-strong
type        text  muted
action      primary  primary-hover  on-primary  primary-subtle
status      ok  warn  err  unknown   (each with a matching -subtle)
```

The rule that keeps this honest: **if a component needs a colour that is not in this list, the
list is wrong - extend the contract in `tokens.json` for every theme at once.** A one-off hex in a
component is the beginning of a second, undocumented theme.

## Status semantics - the app's real visual language

This product's core surface is a list of `RuleResult` objects (`plan/05-option2-application.md`).
Four statuses, and they mean specific things:

| Status | Token | Meaning | Blocks progress |
|---|---|---|---|
| pass | `ok` | The criterion is met with the data entered | no |
| fail, severity `error` | `err` | Criterion not met, or a guard refuses the transition | yes |
| fail, severity `warning` | `warn` | Advisory - a consistency gap inside tolerance | no |
| unknown | `unknown` | Not enough has been entered to say | no |

`unknown` existing as a first-class status is a design decision, not a gap. A form on step one
should not be a wall of red. Neutral grey is the correct colour for "we do not know yet," and it
must look calm rather than broken.

## Never colour alone

Every status carries a **glyph and a text label** in addition to its colour. This is a WCAG 1.4.1
requirement, and it is also what makes Terra's olive-versus-green tension survivable.

| Status | Glyph | Shape |
|---|---|---|
| pass | `+` (check) | pill, `ok-subtle` ground |
| error | `x` | pill, `err-subtle` ground |
| warning | `!` | pill, `warn-subtle` ground |
| unknown | `?` | pill, `unknown-subtle` ground |

Verify by screenshotting the eligibility panel and desaturating it. If you cannot read the states
in greyscale, the screen is wrong.

## Type

One family. `Inter` via `next/font`-style self-hosting, or the system stack - do not load two.

| Role | Size / line | Weight | Use |
|---|---|---|---|
| display | 28 / 34 | 600 | page title, one per screen |
| heading | 20 / 28 | 600 | section, card title |
| subhead | 15 / 22 | 600 | step label, table group |
| body | 14 / 21 | 400 | everything |
| small | 12.5 / 18 | 400 | helper text, rule explanations |
| micro | 11 / 14 | 600, +0.04em | pill labels, table headers, uppercase |
| numeric | 14 / 21 | 500, `tnum` | **all money and all ratios** |

`font-variant-numeric: tabular-nums` on every figure is not decoration. A ledger column where the
digits do not align is a ledger column that cannot be scanned, and this app is mostly figures.

## Spacing and density

4px base. Use `4 8 12 16 24 32 48 64` and nothing between them.

Two densities, because the app has two audiences (`plan/02-domain-model.md`):

| | Borrower surfaces | Lender surfaces |
|---|---|---|
| control height | 44px | 36px |
| table row | 52px | 40px |
| section gap | 32px | 24px |
| body size | 15px | 14px |

Borrowers fill in one long form occasionally and deserve room. Loan officers work a queue all day
and need rows on screen. Same tokens, one density variable - set it at the route group, not per
component.

## Focus, and the keyboard

- Focus ring is `2px solid primary` with a `2px` offset, on **every** interactive element. Never
  `outline: none` without a replacement.
- Focus must be visible on `bg`, `surface` and `raised`. The offset is what guarantees this.
- Tab order follows visual order. The eligibility sidebar comes after the form fields it explains,
  not before.
- The lender queue is operable entirely from the keyboard: arrow between rows, `Enter` to open,
  `a` / `d` for approve and decline on the focused row.

## Motion

Restrained, and skippable.

| Change | Duration | Curve |
|---|---|---|
| hover, focus | 100ms | `ease-out` |
| pill or badge state change | 150ms | `ease-out` |
| step transition | 200ms | `cubic-bezier(.2,0,0,1)` |
| panel or drawer | 240ms | `cubic-bezier(.2,0,0,1)` |

Nothing animates above 240ms. **A rule result changing status animates its background only, never
its position** - a list that reflows while the user is typing is a list they cannot read. Wrap
everything in `@media (prefers-reduced-motion: reduce)` and drop to 0ms.

## Dark mode

Not optional, and not an inversion. Both modes are authored in `tokens.json` and both are verified.

- Follow `prefers-color-scheme` by default, with an explicit override stored per user.
- Define the light palette on bare `:root`. Redefine tokens under
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and again under
  `:root[data-theme="dark"]`, so an explicit choice wins in both directions.
- Never give a colour its only definition inside a media query.
- Dark surfaces get **lighter** as they come forward (`bg` -> `surface` -> `raised`). Do not use
  shadows to convey depth in dark mode; they do not read.

## Accessibility floor

Non-negotiable, and cheap if done from the start:

- Text 4.5:1, UI boundaries and glyphs 3:1. `preview.py` enforces this for the palette; it cannot
  enforce it for a colour you hardcode in a component.
- Every input has a real `<label>`. Placeholder text is not a label.
- Errors are wired with `aria-describedby` and announced.
- The eligibility panel and the document completeness panel are `aria-live="polite"`. They change
  while the user types, and a screen reader user needs to know.
- Hit targets 44px on borrower surfaces, 36px minimum on lender surfaces.
- Test one full path with the keyboard only before submitting. It takes four minutes and it is the
  single highest-yield accessibility check available.
