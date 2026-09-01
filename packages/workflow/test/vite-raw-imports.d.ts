/**
 * `import.meta.glob` as Vite implements it, declared here rather than by
 * pulling in `vite/client`.
 *
 * The parity test has to read a committed .sql file, and packages/workflow is a
 * pure package: it may not import `node:fs`, and the ESLint layering rule
 * enforces that. A raw glob is transformed away before the test runs -- the
 * file contents arrive as string literals -- so the test reads a file without
 * the package gaining an I/O dependency.
 *
 * `vite/client` is not declared instead because it also declares the DOM-facing
 * ambient types (`ImportMetaEnv`, asset modules, HMR), and this package has no
 * business seeing them. Only the one member used is declared, and only for the
 * test program: `tsconfig.json` includes `test`, and nothing under `src` does.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { readonly query: '?raw'; readonly import: 'default'; readonly eager: true },
  ): Record<string, string>;
}
