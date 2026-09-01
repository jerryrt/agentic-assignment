# Theme 02 - Terra

> Soil and season. Warm, agricultural, human.

![Terra palette preview](preview/terra.svg)

*Light and dark, with the palette and the application's signature surface - the eligibility card
from `plan/05-option2-application.md`. Generated from `tokens.json` by `preview.py`.*

## Character

Terra is soil, stubble and season. Warm off-white ground, olive primary, and neutrals
that carry a little ochre rather than being flat grey. It is the only candidate that looks like it
belongs to agriculture specifically, and on a borrower-facing form it reads as human rather than
institutional.

The warmth is in the neutrals, not in the accents - which is why it stays readable over a long
form instead of becoming tiring.

## Pick this if

- The borrower experience is what you want to showcase. A farmer filling in fourteen
  financial fields is the user this palette is kindest to.
- You want the submission to be visually memorable and are willing to defend a non-obvious choice.
- You like that the theme argues for the product's domain without a single tractor icon.

## Avoid this if

- The lender queue is your centrepiece. Dense data tables in warm neutrals read softer and
  scan slightly slower than in cool ones.
- You are short on time. Terra has one real design problem to manage (below) and the others do not.

## Tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--lj-bg` | `#FDFCF8` | `#15120D` | Page ground. The only thing behind everything else. |
| `--lj-surface` | `#F5F1E8` | `#1F1B14` | Recessed panels: the rule-list card, the form step body. |
| `--lj-raised` | `#FFFFFF` | `#2A251B` | Cards sitting on a surface: a product row, a document slot. |
| `--lj-border` | `#E2DACA` | `#332C21` | Decorative separators. Low contrast on purpose. |
| `--lj-border-strong` | `#9A8C77` | `#7A6D58` | Real affordances: input outlines, outlined buttons. 3:1 minimum. |
| `--lj-text` | `#221C14` | `#F0EADD` | Primary copy. |
| `--lj-muted` | `#6A5D4C` | `#B2A491` | Secondary copy, labels, helper text. Never below 4.5:1. |
| `--lj-primary` | `#41552F` | `#A8C287` | Primary action, active nav, focus ring, links. |
| `--lj-primary-hover` | `#334425` | `#BCD39E` | Hover and pressed state for primary. |
| `--lj-on-primary` | `#FFFFFF` | `#141A0D` | Text and icons sitting on primary. |
| `--lj-primary-subtle` | `#EAEFE0` | `#2B331F` | Selected rows, active step, primary-tinted banners. |
| `--lj-ok` | `#3F6B33` | `#8FBE73` | RuleResult status 'pass'. Also the 'accepted' document slot. |
| `--lj-ok-subtle` | `#E9F0E3` | `#232C1B` | Background for a pass pill or banner. |
| `--lj-warn` | `#8A5A0B` | `#E0AC4E` | Advisory severity: a consistency warning that does not block. |
| `--lj-warn-subtle` | `#F8EEDA` | `#332818` | Background for a warning pill or banner. |
| `--lj-err` | `#A93222` | `#EE8C79` | Blocking severity: a failed guard, a rejected document. |
| `--lj-err-subtle` | `#F9E8E4` | `#361F19` | Background for an error pill or banner. |
| `--lj-unknown` | `#6A5D4C` | `#B2A491` | RuleResult status 'unknown' - not enough entered yet. |
| `--lj-unknown-subtle` | `#F0EBE1` | `#3A3227` | Background for the 'more info needed' pill. |

Every pair is verified by `preview.py`: text tokens meet 4.5:1 against the ground they sit on,
`border-strong` meets 3:1, and each status tone meets 4.5:1 against `bg`, `surface` and its own
`-subtle` background, in both modes. Run `python3 design/preview.py` after any edit; it exits
non-zero on a failure.

## Known risks

**Primary olive and success green are neighbours.** `#41552F` and `#3F6B33` sit close
enough in hue that a filled primary button and a pass indicator can read as the same thing. This
is inherent to an earth palette with a green primary and cannot be tuned away without losing what
makes Terra Terra. Manage it with three rules, all of which are good practice anyway:

1. **Primary is never a status.** It appears on actions and navigation only. A rule row never uses
   the primary token.
2. **Status always carries a glyph**, never colour alone - `[+]`, `[x]`, `[!]`, `[?]`. This is
   required by `00-foundations.md` regardless of theme, and here it is load-bearing.
3. **Status colour appears as a subtle-background pill**, not as a filled button shape, so the two
   never share a silhouette.

If that constraint sounds fragile to you, pick Fieldwork instead - it is the same warmth of idea
with the hue collision engineered out.

## Angular Material 3 notes

Material 3 source colour `#41552F`. Terra needs an explicit **warm neutral** tonal
palette (`neutral: #6A5D4C`), otherwise M3 produces grey greys and the whole warmth of the theme
disappears from the components while surviving only in your own CSS.
