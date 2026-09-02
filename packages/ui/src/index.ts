/**
 * @lj/ui -- the shared Angular primitives, and the colour contract they render.
 *
 * The delivery layer, above @lj/domain and importing nothing else from the
 * workspace (CLAUDE.md section 8). These components render; they hold no
 * business rules and make no decisions. Everything they show arrives decided:
 * a RuleResult from packages/rules or a workflow guard, a state from a machine,
 * an amount already in minor units.
 *
 * The stylesheets are not exported from here because they are not TypeScript.
 * An application imports them by path:
 *
 *   @import "@lj/ui/tokens/_tokens.css";     runtime CSS variables
 *   @use "@lj/ui/tokens/_palette.scss";      build-time Sass maps for Material
 *
 * Both are generated from design/tokens.json and guarded by `pnpm tokens:check`.
 * A deep import into src/ is a layering violation the lint rules reject, so
 * this file is the whole TypeScript contract.
 */

export * from './rule-presentation.ts';
export * from './rule-list.ts';
export * from './state-badge.ts';
export * from './timeline.ts';
export * from './money.ts';
