# Visual design

The project theme is **Fieldwork** - a deep teal primary on a clean ground, with green reserved
exclusively for success. Decided 2026-09-01 from four candidates.

![Fieldwork palette preview](preview/fieldwork.svg)

| File | Contents |
|---|---|
| `00-foundations.md` | Type, spacing, density, motion, status semantics, dark mode, a11y floor |
| `01-theme.md` | The theme: why it was chosen, what it costs, the full token table |
| `02-implementation.md` | Tokens to CSS variables, Tailwind, Material M3, verification |
| `tokens.json` | Source of truth for every colour in the product |
| `preview.py` | Generates `preview/fieldwork.svg` and the token table; enforces WCAG contrast |

Read `00-foundations.md` first. Almost everything that makes the app usable - density, status
semantics, focus behaviour, the never-colour-alone rule - lives there and is independent of the
palette.

## Regenerating

```bash
python3 design/preview.py
```

Rewrites the SVG preview, rewrites the generated token table inside `01-theme.md`, and re-checks
every colour pair: text at 4.5:1, UI boundaries at 3:1, in both light and dark. It exits non-zero
on a failure, which is what lets it run as the `tokens:check` gate in CI (`plan/08-cicd.md`).

Nothing here is hand-maintained except the prose. Edit `tokens.json` and regenerate.

## The decision

Recorded in `01-theme.md`, with the reasoning kept because the CTO review asks why decisions were
made rather than what they were.

The short version: this application's core surface is a list of pass / fail / warning / unknown
results, so a primary colour that can be confused with a status is a usability failure at the
centre of the product. Fieldwork's teal is far enough from the success green that the confusion is
impossible. The candidate that could not be separated that way was rejected for it.

The three rejected themes - Meridian, Terra and Ledger - are preserved in the history of commit
`960daa1`, along with the comparison that produced the decision.
