# Theme 03 - Fieldwork

> Modern agtech. Teal-forward, fresh, product-led.

![Fieldwork palette preview](preview/fieldwork.svg)

*Light and dark, with the palette and the application's signature surface - the eligibility card
from `plan/05-option2-application.md`. Generated from `tokens.json` by `preview.py`.*

## Character

Fieldwork is what a well-funded agtech product looks like in 2026. Clean white ground,
a deep teal primary, generous whitespace, and a green reserved exclusively for success. It reads
modern and product-led without drifting into consumer-app brightness.

The teal is deliberate: it is adjacent enough to green to keep the agricultural association, and
far enough away that it can never be mistaken for a pass indicator. That separation is the whole
design argument for this theme.

## Pick this if

- You want a distinctive submission that is still unambiguously professional. This is the
  best balance of the four.
- Both roles matter to you equally. It is the most neutral across borrower forms and lender tables.
- You want the colour system to do some of the accessibility work for you: the primary hue and all
  four status hues are mutually distinguishable, including under the common forms of colour
  blindness.

## Avoid this if

- You want the palette to read as a bank. Fieldwork reads as software.
- Your assessors are conservative about anything that looks like a design trend.

## Tokens

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
| `--lj-ok` | `#0F7A4A` | `#4FC28C` | RuleResult status 'pass'. Also the 'accepted' document slot. |
| `--lj-ok-subtle` | `#E1F3EA` | `#123227` | Background for a pass pill or banner. |
| `--lj-warn` | `#9A6206` | `#E0A93B` | Advisory severity: a consistency warning that does not block. |
| `--lj-warn-subtle` | `#FBF0DC` | `#2D2615` | Background for a warning pill or banner. |
| `--lj-err` | `#B3261E` | `#F08A82` | Blocking severity: a failed guard, a rejected document. |
| `--lj-err-subtle` | `#FBE9E7` | `#301B1A` | Background for an error pill or banner. |
| `--lj-unknown` | `#55665C` | `#93A79B` | RuleResult status 'unknown' - not enough entered yet. |
| `--lj-unknown-subtle` | `#EDF1EE` | `#29392F` | Background for the 'more info needed' pill. |

Every pair is verified by `preview.py`: text tokens meet 4.5:1 against the ground they sit on,
`border-strong` meets 3:1, and each status tone meets 4.5:1 against `bg`, `surface` and its own
`-subtle` background, in both modes. Run `python3 design/preview.py` after any edit; it exits
non-zero on a failure.

## Known risks

**Teal is fashionable, and fashion dates.** In two years this palette will read as
"2020s SaaS." Irrelevant at the timescale of an assignment; worth knowing if it becomes the
product's real theme.

**White ground is unforgiving.** With `#FFFFFF` as `bg` and `#F4F7F5` as `surface`, the separation
between ground and panel is only about 3%. If the layout does not use the `raised` and `border`
tokens deliberately, the screens flatten into an undifferentiated sheet. Meridian and Ledger are
more forgiving of a rushed layout.

## Angular Material 3 notes

Material 3 source colour `#0B6A6E` with a **neutral-cool** tonal palette. Override
M3's generated `error` with the `err` token so the form-field error state matches the rule-list
error state - M3's default red is noticeably more orange than `#B3261E` at some tones.
