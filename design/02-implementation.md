# Implementation

How the picked theme becomes running code. Applies identically to all four, which is the point.

## 1. Emit CSS variables from tokens.json

`tokens.json` is the source of truth. A build step emits the stylesheet, so the SVG previews, the
contrast report and the running app all read the same numbers - the no-duplication rule from
`../CLAUDE.md` applied to colour.

```
packages/ui/
  tokens/
    tokens.json          <- copied from design/, single theme
    emit.ts              <- writes _tokens.scss
    _tokens.scss         <- GENERATED, checked in, never hand-edited
```

```scss
/* _tokens.scss - generated */
:root {
  --lj-bg: #FFFFFF;
  --lj-surface: #F6F8FA;
  /* ...19 tokens... */
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --lj-bg: #0B1220; /* ... */ }
}
:root[data-theme="dark"] { --lj-bg: #0B1220; /* ... */ }
```

Add `pnpm tokens:check` to CI beside `workflow:check` (`plan/08-cicd.md`): regenerate and fail if
the result differs from what is committed. Same pattern, same reason.

## 2. Wire Tailwind to the variables, not to hex

```js
// tailwind.config.js
theme: {
  extend: {
    colors: {
      bg: 'var(--lj-bg)',
      surface: 'var(--lj-surface)',
      raised: 'var(--lj-raised)',
      border: 'var(--lj-border)',
      'border-strong': 'var(--lj-border-strong)',
      text: 'var(--lj-text)',
      muted: 'var(--lj-muted)',
      primary: { DEFAULT: 'var(--lj-primary)', hover: 'var(--lj-primary-hover)',
                 fg: 'var(--lj-on-primary)', subtle: 'var(--lj-primary-subtle)' },
      ok:   { DEFAULT: 'var(--lj-ok)',   subtle: 'var(--lj-ok-subtle)' },
      warn: { DEFAULT: 'var(--lj-warn)', subtle: 'var(--lj-warn-subtle)' },
      err:  { DEFAULT: 'var(--lj-err)',  subtle: 'var(--lj-err-subtle)' },
      unknown: { DEFAULT: 'var(--lj-unknown)', subtle: 'var(--lj-unknown-subtle)' },
    },
  },
}
```

Because the values are variables rather than compiled colours, dark mode costs nothing at build
time and there is no `dark:` variant to remember on every element.

Ban raw colour utilities. `bg-slate-100` and `text-[#333]` are the leak that ends the token
contract - forbid them with `tailwindcss/no-arbitrary-value` plus a lint rule on the default
palette, and delete Tailwind's stock colours from the config so they cannot be reached.

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
pnpm tokens:check             # generated SCSS matches tokens.json
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
