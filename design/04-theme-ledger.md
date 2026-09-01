# Theme 04 - Ledger

> Dense operator console. Dark-first, built for the queue.

![Ledger palette preview](preview/ledger.svg)

*Light and dark, with the palette and the application's signature surface - the eligibility card
from `plan/05-option2-application.md`. Generated from `tokens.json` by `preview.py`.*

## Character

Ledger is designed dark-first for someone who sits in the tool all day. Near-black
ground, layered slate surfaces, a single confident blue, and status tones tuned for legibility at
small sizes against dark rather than being light-mode colours dropped onto a dark ground.

The light mode is a genuine counterpart rather than an afterthought, but the theme's centre of
gravity is the dark lender console.

## Pick this if

- The lender queue and the decision screen are what you want to demo. Ledger is the only
  candidate designed around dense rows and long sessions.
- You want dark mode to be the thing that gets noticed, and you are confident enough in the
  implementation to demo it as the default.
- You like that the three-level surface stack (`bg` / `surface` / `raised`) gives you real depth
  without shadows, which is how dense tools stay legible.

## Avoid this if

- The borrower application is your centrepiece. A long financial form in a dark console
  palette reads as intimidating, which is the opposite of the intent in Option 2.
- You have not budgeted time to check both modes. A dark-first theme with a neglected light mode
  is worse than a light-first theme with a neglected dark mode, because reviewers default to light.

## Tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--lj-bg` | `#FBFBFC` | `#0E1116` | Page ground. The only thing behind everything else. |
| `--lj-surface` | `#F2F3F5` | `#171B22` | Recessed panels: the rule-list card, the form step body. |
| `--lj-raised` | `#FFFFFF` | `#1F242D` | Cards sitting on a surface: a product row, a document slot. |
| `--lj-border` | `#DCDFE4` | `#2A313C` | Decorative separators. Low contrast on purpose. |
| `--lj-border-strong` | `#868F9E` | `#5C6779` | Real affordances: input outlines, outlined buttons. 3:1 minimum. |
| `--lj-text` | `#12161C` | `#E3E8EF` | Primary copy. |
| `--lj-muted` | `#5A6472` | `#98A2B3` | Secondary copy, labels, helper text. Never below 4.5:1. |
| `--lj-primary` | `#2E5AAC` | `#7BA5EE` | Primary action, active nav, focus ring, links. |
| `--lj-primary-hover` | `#254889` | `#98B9F4` | Hover and pressed state for primary. |
| `--lj-on-primary` | `#FFFFFF` | `#0A1220` | Text and icons sitting on primary. |
| `--lj-primary-subtle` | `#E8EDF8` | `#1A2740` | Selected rows, active step, primary-tinted banners. |
| `--lj-ok` | `#1B7A4B` | `#4FBE8B` | RuleResult status 'pass'. Also the 'accepted' document slot. |
| `--lj-ok-subtle` | `#E4F3EB` | `#13291F` | Background for a pass pill or banner. |
| `--lj-warn` | `#8A5A0B` | `#D9A94A` | Advisory severity: a consistency warning that does not block. |
| `--lj-warn-subtle` | `#F8EEDA` | `#2B2416` | Background for a warning pill or banner. |
| `--lj-err` | `#B3261E` | `#F08A82` | Blocking severity: a failed guard, a rejected document. |
| `--lj-err-subtle` | `#FBE9E7` | `#2F191A` | Background for an error pill or banner. |
| `--lj-unknown` | `#5A6472` | `#98A2B3` | RuleResult status 'unknown' - not enough entered yet. |
| `--lj-unknown-subtle` | `#EDEFF2` | `#2E3541` | Background for the 'more info needed' pill. |

Every pair is verified by `preview.py`: text tokens meet 4.5:1 against the ground they sit on,
`border-strong` meets 3:1, and each status tone meets 4.5:1 against `bg`, `surface` and its own
`-subtle` background, in both modes. Run `python3 design/preview.py` after any edit; it exits
non-zero on a failure.

## Known risks

**You must actually build both modes.** Every other theme degrades gracefully if you only
polish light. Ledger does not - its light mode is the one an assessor sees first, and if it looks
like an inverted afterthought the theme has failed.

**Dark mode hides layout sins.** Low-contrast dark surfaces forgive spacing and alignment errors
that light mode exposes immediately. Build screens in light, then verify in dark.

## Angular Material 3 notes

Material 3 source colour `#2E5AAC`. Ledger benefits most from M3's density API - set
`mat.density(-2)` on the lender queue and `-1` globally. Build the dark theme with
`mat.theme` using explicit `surface-container` levels mapped to `surface` and `raised`; M3's
default elevation tints are too subtle at these values.
