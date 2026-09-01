# Theme - Fieldwork

> Modern agtech. Teal-forward, fresh, product-led.

**Decided 2026-09-01.** Chosen from four candidates. The three that were rejected - Meridian
(institutional navy), Terra (warm earth) and Ledger (dark-first console) - are preserved in the
history of commit `960daa1` if the decision ever needs revisiting.

![Fieldwork palette preview](preview/fieldwork.svg)

*Light and dark, showing the palette and the application's signature surface - the eligibility
card from `plan/05-option2-application.md`. Generated from `tokens.json` by `preview.py`.*

## Character

Fieldwork is what a well-funded agtech product looks like in 2026. Clean white ground, a deep teal
primary, generous whitespace, and a green reserved exclusively for success. It reads modern and
product-led without drifting into consumer-app brightness.

The teal is deliberate and is the whole design argument for this theme: it is adjacent enough to
green to keep the agricultural association, and far enough away that it can never be mistaken for
a pass indicator.

## Why this one

- **It is distinctive without being a risk.** It reads as software rather than as a bank, and it
  does not look like the default a component library hands you.
- **The primary hue cannot collide with a status.** This application's core surface is a list of
  pass/fail/warning/unknown results (`00-foundations.md`), so a primary button that reads like a
  pass badge would be a usability failure at the centre of the product, not at its edges. The
  original draft of this theme had exactly that problem - a green primary sitting almost on top of
  the success green - and the fix was to move the primary to teal rather than to document the
  collision. The candidate that could not be fixed this way (Terra) was rejected for it.
- **It serves both audiences.** Borrower forms and lender tables both work here. Meridian favoured
  the lender screens and Ledger was built around them; Fieldwork is the most neutral of the four,
  which matters when `plan/09-build-order.md` ships borrower surfaces first and lender surfaces
  last.
- **The palette does some of the accessibility work.** The primary and all four status hues are
  mutually distinguishable, including under the common forms of colour blindness. That is a
  property of the hue spacing, not of the contrast ratios, and it is not something the checker in
  `preview.py` can verify for you.

## What it costs

- **Teal is fashionable, and fashion dates.** In two years this reads as "2020s SaaS." Irrelevant
  at the timescale of an assignment; worth knowing if it becomes the product's real theme.
- **A white ground is unforgiving.** `bg` is `#FFFFFF` and `surface` is `#F4F7F5` - about 3%
  apart. If a layout does not use `raised` and `border` deliberately, the screens flatten into an
  undifferentiated sheet. Meridian and Ledger tolerated a rushed layout better. The mitigation is
  to build every screen from the three-level ground stack (`bg` / `surface` / `raised`) from the
  start rather than adding depth afterwards.
- **Both modes must be built.** Not unique to this theme, but the light mode is what a reviewer
  sees first and the dark mode is what gets noticed. Neither can be an afterthought.

## Tokens

<!-- BEGIN GENERATED TOKENS - edit tokens.json, then run preview.py -->

| Token | Light | Dark | Role |
|---|---|---|---|
| `--lj-bg` | `#FFFFFF` | `#0A1210` | Page ground. The only thing behind everything else. |
| `--lj-surface` | `#F4F7F5` | `#121C18` | Recessed panels: the rule-list card, the form step body. |
| `--lj-raised` | `#FFFFFF` | `#1A2721` | Cards sitting on a surface: a product row, a document slot. |
| `--lj-border` | `#DBE3DD` | `#22322B` | Decorative separators. Low contrast on purpose. |
| `--lj-border-strong` | `#849A8D` | `#5A7166` | Real affordances: input outlines, outlined buttons. 3:1 minimum. |
| `--lj-text` | `#0F1D16` | `#E6EFE9` | Primary copy. |
| `--lj-muted` | `#55665C` | `#93A79B` | Secondary copy, labels, helper text. Never below 4.5:1. |
| `--lj-primary` | `#0B6A6E` | `#45BFC0` | Primary action, active nav, focus ring, links. |
| `--lj-primary-hover` | `#085458` | `#67CFD0` | Hover and pressed state for primary. |
| `--lj-on-primary` | `#FFFFFF` | `#03201F` | Text and icons sitting on primary. |
| `--lj-primary-subtle` | `#DFF0F1` | `#0D3033` | Selected rows, active step, primary-tinted banners. |
| `--lj-ok` | `#0F7A4A` | `#4FC28C` | RuleResult status 'pass'. Also an accepted document slot. |
| `--lj-ok-subtle` | `#E1F3EA` | `#123227` | Background for a pass pill or banner. |
| `--lj-warn` | `#9A6206` | `#E0A93B` | Advisory severity: a consistency gap that does not block. |
| `--lj-warn-subtle` | `#FBF0DC` | `#2D2615` | Background for a warning pill or banner. |
| `--lj-err` | `#B3261E` | `#F08A82` | Blocking severity: a failed guard, a rejected document. |
| `--lj-err-subtle` | `#FBE9E7` | `#301B1A` | Background for an error pill or banner. |
| `--lj-unknown` | `#55665C` | `#93A79B` | RuleResult status 'unknown' - not enough entered yet. |
| `--lj-unknown-subtle` | `#EDF1EE` | `#29392F` | Background for the 'more info needed' pill. |

<!-- END GENERATED TOKENS -->

Every pair is verified by `preview.py`: text tokens meet 4.5:1 against the ground they sit on,
`border-strong` meets 3:1, and each status tone meets 4.5:1 against `bg`, `surface` and its own
`-subtle` background, in both modes. Run `python3 design/preview.py` after any edit; it exits
non-zero on a failure, which is what lets it act as a CI gate.

Do not add a colour to a component. If something needs a value that is not in this table, the
table is wrong - extend it in `tokens.json` and regenerate, so the preview, the guide and the
emitted stylesheet stay in agreement.

## Angular Material 3 notes

Material 3 source colour `#0B6A6E` with a **neutral-cool** tonal palette. Two overrides matter:

- Set M3's `$tertiary` from the `ok` green so Material's own success surfaces agree with
  `packages/ui`. Left at the default, M3 derives a tertiary from the teal and the two greens in
  the app stop matching.
- Override M3's generated `error` with the `err` token. M3's default red is noticeably more orange
  than `#B3261E` at some tones, which would leave the form-field error state and the rule-list
  error state visibly different reds on the same screen.

Full wiring - CSS variables, Tailwind, density, verification - is in `02-implementation.md`.
