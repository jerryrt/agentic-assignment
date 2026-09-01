# Implementation

How the picked theme becomes running code. Applies identically to all four, which is the point.

## 1. Emit the tokens from tokens.json

`tokens.json` is the source of truth. A build step emits the stylesheets, so the SVG preview, the
generated token table, the contrast report and the running app all read the same numbers - the
no-duplication rule from `../CLAUDE.md` applied to colour.

```
packages/ui/
  tokens/
    tokens.json          <- copied from design/, single theme
    emit.ts              <- writes both artefacts below
    _tokens.css          <- GENERATED. The runtime CSS variables.
    _palette.scss        <- GENERATED. Build-time Sass map for Material.
```

Two artefacts rather than one, because the two consumers need different things and neither can
read the other's format: Tailwind and the components need **runtime** CSS variables that swap with
the colour scheme, while Angular Material's `mat.theme` needs a **build-time** Sass map to
generate its tonal palettes. Both are emitted from the same JSON in the same step, so this is two
renderings of one definition, not two definitions.

```css
/* _tokens.css - generated, never hand-edited */
:root {
  --lj-bg: #FFFFFF;
  --lj-surface: #F4F7F5;
  /* ...19 tokens... */
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --lj-bg: #0A1210; /* ... */ }
}
:root[data-theme="dark"] { --lj-bg: #0A1210; /* ... */ }
```

Add `pnpm tokens:check` to CI beside `workflow:check` (`plan/08-cicd.md`): regenerate and fail if
the result differs from what is committed. Same pattern, same reason.

## 2. Wire Tailwind to the variables

Tailwind is on **v4** (`plan/01-architecture.md`), which is CSS-first. There is no
`tailwind.config.js` - the theme is declared in CSS, which suits this token contract better than
v3's JavaScript config ever did.

```css
/* apps/web/src/styles.css */
@import "tailwindcss";
@import "@lj/ui/tokens/_tokens.css";

@theme inline {
  /* Drop Tailwind's stock palette entirely, so bg-slate-100 does not exist. */
  --color-*: initial;

  --color-bg: var(--lj-bg);
  --color-surface: var(--lj-surface);
  --color-raised: var(--lj-raised);
  --color-border: var(--lj-border);
  --color-border-strong: var(--lj-border-strong);
  --color-text: var(--lj-text);
  --color-muted: var(--lj-muted);

  --color-primary: var(--lj-primary);
  --color-primary-hover: var(--lj-primary-hover);
  --color-primary-fg: var(--lj-on-primary);
  --color-primary-subtle: var(--lj-primary-subtle);

  --color-ok: var(--lj-ok);
  --color-ok-subtle: var(--lj-ok-subtle);
  --color-warn: var(--lj-warn);
  --color-warn-subtle: var(--lj-warn-subtle);
  --color-err: var(--lj-err);
  --color-err-subtle: var(--lj-err-subtle);
  --color-unknown: var(--lj-unknown);
  --color-unknown-subtle: var(--lj-unknown-subtle);
}
```

Three things this buys, all of which were awkward in v3:

- **`@theme inline` is the correct directive here**, not plain `@theme`. `inline` makes the
  utility reference `var(--lj-*)` at use site rather than resolving it once at build time, which
  is what lets a single `bg-surface` class follow the colour scheme. Plain `@theme` would bake in
  the light value and dark mode would silently do nothing.
- **`--color-*: initial` deletes the stock palette.** `bg-slate-100` and `text-gray-500` stop
  compiling, so the token contract cannot leak by accident. In v3 this needed a lint rule; in v4
  it is one line and it fails at build.
- **Dark mode costs nothing.** The variables already carry both schemes, so there is no `dark:`
  variant to remember on every element.

Still ban arbitrary values (`text-[#333]`) with `tailwindcss/no-arbitrary-value`. That is the one
remaining way to reach a colour that is not in the contract.

## 3. Angular Material M3

Material generates its own tonal palettes, which will not match `tokens.json` unless told to.
Per-theme source colours and neutral choices are in each theme guide.

```scss
@use '@angular/material' as mat;

html {
  @include mat.theme((
    color: (primary: $lj-primary-palette, tertiary: $lj-ok-palette),
    typography: Inter,
    density: -1,
  ));
}
.lender-shell { @include mat.theme((density: -2)); }   // the queue, per 00-foundations
```

Then override the handful of M3 system variables that must agree with our tokens exactly, rather
than approximately:

```scss
html {
  --mat-sys-surface: var(--lj-surface);
  --mat-sys-on-surface: var(--lj-text);
  --mat-sys-outline: var(--lj-border-strong);
  --mat-sys-outline-variant: var(--lj-border);
  --mat-sys-error: var(--lj-err);
}
```

The boundary rule from `plan/07-frontend.md` still holds: **Material owns components, Tailwind owns
layout, never both on one element.**

## 4. The status components

Three components consume the status tokens, and nothing else may:

```html
<!-- packages/ui: lj-rule-list -->
<li class="flex items-start gap-2 py-1.5">
  <span class="font-mono text-[10px] font-bold leading-5"
        [class]="toneClass()" aria-hidden="true">{{ glyph() }}</span>
  <span class="text-sm text-muted">{{ result.label }}</span>
</li>
```

`toneClass()` maps `RuleResult.status` to exactly one of `text-ok`, `text-err`, `text-warn`,
`text-unknown`. The glyph comes from the same map. One function, so colour and glyph can never
disagree - which is the mechanism that makes "never colour alone" hold under maintenance rather
than only on the day it was written.

`lj-state-badge` does the same for workflow states, resolving the borrower/lender vocabulary split
from `plan/02-domain-model.md`. `lj-money` applies `tabular-nums`.

## 5. Verify

Before submitting:

```bash
python3 design/preview.py     # palette still passes contrast
pnpm tokens:check             # generated CSS and SCSS match tokens.json
```

Then by hand, four minutes total:

1. Screenshot the eligibility panel, desaturate it, confirm every status is still readable.
2. Toggle dark mode on the borrower form and the lender queue.
3. Tab through one full application step without touching the mouse.
4. Zoom the browser to 200% and confirm the lender queue still works.

## 6. Housekeeping (done)

The theme was chosen on 2026-09-01 and the folder was trimmed the same day: the three rejected
guides and their previews were removed and `tokens.json` now holds one theme. Four palettes in a
repo invites a component to reference the wrong one, and the assignment is assessed on the
codebase someone else has to work in.

Link `preview/fieldwork.svg` from the submission README. It is evidence the palette was designed
and verified rather than taken from a component library default, which is worth more than the
screenshot it costs.
