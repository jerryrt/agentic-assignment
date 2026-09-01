# Engineering conventions

Binding rules for this repository. They apply to every commit, human or agent authored.
Implementation plans live in `plan/`; start at `plan/09-build-order.md`.

---

## 1. Priority order

When rules conflict, resolve in this order:

1. **Security** - never trade a security property for convenience or for a deadline.
2. **Readability** - the next reader is the customer. Optimise for them, not for the writer.
3. Correctness of behaviour.
4. Everything else: performance, brevity, cleverness, personal taste.

Performance work requires a measurement first. "Faster" without a number is not a reason to make
code harder to read.

## 2. Commit discipline (kernel.org rules)

Commits follow Linux kernel convention. This is not cosmetic: it makes `git log` and `git bisect`
usable, which is the point.

**One logical change per commit.** If a change can be split into independently reviewable and
independently revertable pieces, split it. A commit that both refactors and fixes a bug is two
commits. Every commit must build and pass tests on its own - `git bisect` is worthless otherwise.

**Message format:**

```
subsystem: imperative summary under 50 chars

Explain the problem this commit solves and why it is solved this way.
Describe the previous behaviour, what was wrong with it, and what the
new behaviour is. The code already shows how; the message must carry
the why, because that is the part that is lost otherwise.

Wrap the body at 72 columns.

Signed-off-by: Jerry Tian <jerryrt@gmail.com>
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Rules for the subject line:

- Prefix with the subsystem or package: `workflow:`, `rules:`, `web/apply:`, `api:`, `db:`, `ci:`.
- **Imperative mood** - "add guard for expired documents", not "added" or "adds".
- Lowercase after the colon, no trailing period, 50 chars soft limit and 72 hard.
- It completes the sentence "If applied, this commit will ...".

Rules for the body:

- Hard wrap at 72 columns. Do not rely on the reader's terminal.
- Never write "this patch", "this commit", or "I". Address the codebase in the imperative.
- Explain **why**, not what. A diff shows what changed; only the author knows why.
- Reference a prior commit as `commit <12-hex> ("its subject line")`.
- Use `Fixes:` for bug fixes that repair a specific earlier commit.

Trailers are the last block, after a blank line, one per line, no blank lines between them.

## 3. Plain ASCII only

**Source files, comments, commit messages, identifiers, and log strings are 7-bit ASCII.** No
emoji. No smart quotes, en/em dashes, ellipsis characters, arrows, box-drawing characters, or
non-breaking spaces. Write `->`, `--`, `...`, `"`, `'`.

Why this is a rule and not a preference: non-ASCII characters survive copy-paste badly, break in
terminals and diff tools with the wrong locale, make `grep` unreliable, and hide homoglyph
substitution - a security problem, not a style one.

The narrow exception is **user-facing display text** (i18n message catalogues, seeded content),
where the correct character is the correct character. Such text belongs in data or a message
file, never inline in a component template or a string literal in logic.

Enforce it: an ESLint rule and a `pre-commit` grep for `[^\x00-\x7F]` over `**/*.{ts,html,scss,sql,md,yml}`.

## 4. Test-driven development

Write the failing test first. Red, green, refactor. Non-negotiable for:

- `packages/workflow` - every transition, every guard, reachability, and TS/SQL parity.
- `packages/rules` - table-driven cases per rule, including the boundary and the `unknown` case.
- `packages/domain` - schema validation and every derived calculation (balances, DSCR, LTV).

These are pure functions with no I/O, so a test is cheaper to write than a manual check. There is
no excuse available.

For UI and I/O code, TDD applies where behaviour is specifiable: route guards, store reducers,
the draft reconciliation logic. It does not apply to layout. **We do not chase a coverage
percentage** - the brief says so explicitly and the metric rewards the wrong tests. Cover the
things that would be wrong silently.

A bug fix starts with a test that reproduces the bug. Always. That test is what stops it
returning, and it belongs in the same commit as the fix.

## 5. Layered design

Dependencies point one way. A lower layer must never import from a higher one.

```
     domain          entities, schemas, pure calculation. Zero dependencies.
       ^
   workflow, rules    pure logic over domain types. No I/O, no framework.
       ^
       db             persistence. Knows Supabase. Knows nothing about HTTP or UI.
       ^
   api, web           delivery. Knows HTTP and Angular. Holds no business rules.
```

Enforced by ESLint `import/no-restricted-paths`, not by good intentions.

Consequences to hold to:

- **No framework imports below the delivery layer.** No `@angular/*` in `packages/rules`. This is
  what lets the browser and the server run byte-identical logic, which is the whole architecture.
- **No I/O in `workflow` or `rules`.** Everything a guard or rule needs arrives in its context
  argument. A function that reaches for the database cannot be tested or reasoned about.
- **No business rules in components or route handlers.** If a template decides whether something
  is eligible, that rule is now untestable and duplicated. Components render; they do not decide.
- **SQL lives in `packages/db` or a migration.** Not in a component, not in a handler.

## 6. No duplication

Two copies of a rule become two different rules. The specific traps in this codebase:

- **State transition legality** is defined once, in `packages/workflow`, and the SQL guard table is
  **generated** from it. Never hand-write both.
- **A rule's threshold** appears once, in the rule definition. Not also in a template, not also in
  a validator message.
- **Display labels for states** come from one map in `packages/domain`, keyed by audience. A
  hardcoded status string in a template is a bug waiting for the next state to be added.
- **Money formatting, date formatting, entity-name normalisation** - one implementation each, in
  `packages/ui` or `packages/domain`.

The counterweight: do not abstract on the first repetition. Three occurrences, or a rule that must
provably stay in lockstep, justifies the abstraction. A wrong abstraction costs more than the
duplication it removed.

## 7. Security baseline

- **RLS is the boundary.** Every table has row-level security on. The API is a convenience layer,
  never the only gate. Assume any client-reachable endpoint will be called with forged input.
- **The service role key never enters a browser bundle** - not unused, not present. It exists only
  in the API's environment.
- **Validate at the trust boundary.** Every API handler parses its input with a Zod schema from
  `packages/domain` before anything else. Never trust a client-supplied state, role, or amount.
- **Authorisation is server-side.** The client may hide a button; the server decides. Every
  transition re-checks the actor's role against the machine definition.
- **No secrets in the repo.** `.env.example` holds names and shapes, never values.
- **Money is integer minor units in TypeScript** and `numeric` in Postgres. No floats, ever.
- Parameterised queries only. No string-built SQL.

## 8. Style

- TypeScript `strict`, plus `noUncheckedIndexedAccess`. No `any` - use `unknown` and narrow.
- No non-null assertions (`!`) outside tests. If a value can be absent, handle it.
- Name things for what they mean in the domain: `availableCredit`, not `amt2`.
- Comments explain **why**. A comment restating the code is noise; delete it. A comment explaining
  a tolerance, a policy choice, or a non-obvious constraint is valuable - write that one.
- Prefer a named function to a clever expression. Prefer explicit to implicit.
- Files stay small enough to hold in your head. When a file needs a table of contents, split it.
