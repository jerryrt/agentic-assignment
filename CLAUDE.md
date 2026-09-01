# Engineering conventions

Binding rules for this repository. They apply to every commit, human or agent authored.

Implementation plans live in `plan/`; start at `plan/09-build-order.md`. Visual design candidates
live in `design/`. Work is coordinated through GitHub Issues - read section 3 before starting on
one.

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
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MvY3mYfveuBRKnN6jUoftn
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

## 3. Working as one of several agents

Implementation is carried out by multiple agents in parallel. **GitHub Issues are the
coordination channel and the progress record.** The person running this repo manages the board;
agents work inside it.

The constraint that shapes every rule below: agents do not share memory, and a context window
ends. The issue thread is the only project state that survives.

### The thread is the source of truth

Before touching anything on an issue, **read the whole thread, top to bottom.** Not the title,
not the last comment. Work may already be done, redirected, or blocked by a decision recorded
three comments up. Never act on remembered state from an earlier session - reconcile against the
thread and against `git log` first.

### Claim before working

- Assign yourself and post a claim comment **before the first edit**.
- If the issue is already assigned and its last comment is recent, do not start. Pick another, or
  say so in the thread and wait.
- One agent per issue. One issue per branch. No exceptions - two agents on one issue produces two
  divergent branches and no way to tell which is correct.

### Ownership boundaries

This is what makes parallel work safe, and it is the practical reason the layering rule in
section 7 exists.

- **Every issue names the paths it owns**, in its body. An agent edits only those paths. If the
  issue does not name them, add them and say so before starting.
- Independent by construction: `packages/workflow`, `packages/rules`, and each feature under
  `apps/web/features/` do not share files, so they proceed concurrently.
- **Contended files** are the shared contracts: `packages/domain`, `design/tokens.json`,
  `turbo.json`, `supabase/migrations/`, and anything generated. Changing one of these gets its
  own issue and lands on its own; other agents rebase afterwards.
- If your work needs a file another open issue owns, **comment on both issues and stop.** Do not
  edit it and do not work around it with a duplicate. Duplication introduced to dodge a merge
  conflict is the worst kind, because it is invisible until the two copies disagree.

### Reporting

The thread is a log, not a conversation. Comment when state changes; do not narrate. Every
comment must be **self-contained** - the agent reading it next has none of your context - and
plain ASCII per section 4.

```
status:     in-progress | blocked | ready-for-review
done:       what is now true that was not before
next:       the immediate next step, or "none - ready for review"
blocked-by: #12, or nothing
touched:    packages/workflow/src/engine.ts, packages/workflow/test/engine.spec.ts
commits:    a1b2c3d workflow: reject transitions absent from the machine
```

Report **blockers immediately**, with the specific thing that is blocking. A silent agent is
indistinguishable from a crashed one, and the difference costs someone an hour to establish.

### The board belongs to the user

- Agents **never close an issue, never merge a pull request, never move a milestone.** Post
  `status: ready-for-review` and stop.
- Commit trailers reference issues with `Refs: #<n>`. **Never `Closes`, `Fixes` or `Resolves`** -
  GitHub acts on those keywords automatically on merge, which takes the decision away from the
  person managing progress. `Fixes:` in its kernel sense (naming a broken commit by SHA, per
  section 2) is unaffected and still correct.

### Branches and pull requests

- Branch name: `<type>/<issue>-<slug>`, e.g. `feat/14-workflow-engine`, `docs/22-theme-guides`.
- Rebase onto `main` before marking ready for review. Never force-push a branch another agent has
  based work on; if one has, coordinate in the thread first.
- The pull request body states what changed, why, how it was verified, and `Refs: #<n>`. The
  commits carry the detail (section 2); the PR body carries the summary.

### Done means

An issue is ready for review only when all of these hold. State them in the closing comment:

1. Tests were written first and pass (section 6).
2. CI is green, including `workflow:check` and `tokens:check`.
3. Layering is intact (section 7) and nothing was duplicated to avoid a conflict (section 8).
4. Sources are plain ASCII (section 4).
5. Only the paths the issue owns were touched.

### Never in an issue

No secrets, keys, tokens, `.env` values, connection strings, or real borrower data. The
repository is a public fork and issues are public with it. Refer to a secret by its variable
name, never its value.

## 4. Plain ASCII only

**Source files, comments, commit messages, identifiers, and log strings are 7-bit ASCII.** No
emoji. No smart quotes, en/em dashes, ellipsis characters, arrows, box-drawing characters, or
non-breaking spaces. Write `->`, `--`, `...`, `"`, `'`.

Why this is a rule and not a preference: non-ASCII characters survive copy-paste badly, break in
terminals and diff tools with the wrong locale, make `grep` unreliable, and hide homoglyph
substitution - a security problem, not a style one.

The narrow exception is **user-facing display text** (i18n message catalogues, seeded content),
where the correct character is the correct character. Such text belongs in data or a message
file, never inline in a component template or a string literal in logic.

Enforce it: an ESLint rule, plus a `pre-commit` grep for `[^\x00-\x7F]` across
`**/*.{ts,html,scss,sql,md,yml}`.

## 5. Documentation renders on GitHub

**GitHub is the review and audit interface for this project.** Plans, decisions, issue threads and
diffs are all read in a browser, on github.com, by people who will not clone the repository. A
document that only reads correctly in a local editor has not been delivered.

Two consequences:

### Prefer UML to ASCII art

**Structure and behaviour are drawn as UML in Mermaid fences, never as hand-drawn ASCII boxes.**
GitHub renders ```` ```mermaid ```` blocks natively, so the diagram is a first-class part of the
document rather than a picture of one.

| What you are showing | Use |
|---|---|
| A state machine, its transitions and guards | `stateDiagram-v2` |
| Tables and their relationships | `erDiagram` |
| A request crossing process boundaries | `sequenceDiagram` |
| Package or module dependency direction | `graph TD` |
| Types and their relationships | `classDiagram` |

ASCII art was the wrong tool for all of these: it cannot be diffed meaningfully, it breaks the
moment a label changes length, it carries no semantics an auditor or a tool can read, and it
silently misaligns under proportional fonts. Mermaid source is still plain ASCII (section 4), so
this rule and that one do not conflict.

Two things are **not** ASCII art and stay as they are: a directory listing, and a fenced block of
real code or SQL.

The one genuine exception is a **UI wireframe**, which has no UML equivalent. Prefer linking a
rendered image that is generated from real design tokens - see `design/preview.py` - and fall back
to a small fenced sketch only when no such image exists.

### Verify before pushing

A diagram that does not parse renders on GitHub as a raw error block, in the one place the
reviewer will see it. Check every Mermaid block renders before committing:

```bash
echo '{"args":["--no-sandbox"]}' > /tmp/pptr.json
npx --yes @mermaid-js/mermaid-cli@11 -p /tmp/pptr.json -i diagram.mmd -o /tmp/out.svg
```

The same standard applies to anything else the browser has to render: relative image paths must
resolve from the file that references them, and GitHub strips CSS from Markdown, so a document
that needs colour must supply a committed image rather than styled markup.

Choose layout for a narrow column. A wide `direction LR` diagram is unreadable once GitHub scales
it to the content width; default top-to-bottom usually wins for anything with more than about six
nodes.

## 6. Test-driven development

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

## 7. Layered design

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

## 8. No duplication

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

## 9. Security baseline

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

## 10. Style

- TypeScript `strict`, plus `noUncheckedIndexedAccess`. No `any` - use `unknown` and narrow.
- No non-null assertions (`!`) outside tests. If a value can be absent, handle it.
- Name things for what they mean in the domain: `availableCredit`, not `amt2`.
- Comments explain **why**. A comment restating the code is noise; delete it. A comment explaining
  a tolerance, a policy choice, or a non-obvious constraint is valuable - write that one.
- Prefer a named function to a clever expression. Prefer explicit to implicit.
- Files stay small enough to hold in your head. When a file needs a table of contents, split it.
