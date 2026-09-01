# Plan 08 - CI/CD

Assessment criterion #4. The brief's floor is "install, lint, build, deploy on push to main."
We meet it and add the two things that make it useful: changed-only work, and migrations.

## GitHub Actions

`.github/workflows/ci.yml`

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }        # turbo needs history to diff
      - uses: pnpm/action-setup@v6      # version comes from packageManager
      - uses: actions/setup-node@v7
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo lint typecheck test build --filter=...[origin/main^]
      - name: generated artefacts still match their sources
        run: |
          pnpm workflow:check   # generated SQL still matches the TS machines
          pnpm tokens:check     # generated CSS/SCSS still matches tokens.json

  migrate:
    needs: verify
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    env:
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
    steps:
      - uses: actions/checkout@v7
      - uses: supabase/setup-cli@v3
        with: { version: 2.116.0 }
      - run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
      - run: supabase db push
```

`SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` are not optional. The CLI authenticates to the
platform API with the former and opens the direct Postgres connection with the latter; on a runner
there is no keyring and no prompt to fall back to, so omitting either fails `link` rather than
`push`, and the error names the missing keyring instead of the missing secret.

Deployment itself stays on **Vercel's Git integration** rather than a `vercel deploy` step. It
gives preview URLs per PR for free, and re-implementing that in Actions is work with no payoff at
this size. The Actions pipeline is the quality gate; Vercel is the deployer. State that choice in
the README so it reads as a decision, not an omission.

Runtime and tool versions come from the pinned toolchain table in `01-architecture.md`; do not set
them independently here. Each is read from the one file that already holds it: `setup-node` takes
`node-version-file: .node-version` rather than a literal, and `pnpm/action-setup` reads
`packageManager` in the root `package.json`. A literal `node-version: 24` would float across patch
releases and drift from the committed pin without anything reporting it.

Action tag versions - `actions/checkout@v7`, `pnpm/action-setup@v6`, `actions/setup-node@v7` - are
the exception: they are not in the toolchain table and live only here.

Three details worth defending:

- `--filter=...[origin/main^]` - only packages whose dependency subgraph changed are linted,
  typechecked, tested and built. A README-only PR touches no package and so runs nothing.
- `fetch-depth: 0` - without full history the filter silently degrades to "everything." A common
  and invisible misconfiguration.
- `workflow:check` and `tokens:check` - regenerate the transition SQL and the token stylesheets,
  and fail if either differs from what is committed. These are what keep the TS machine and the
  Postgres trigger from drifting ([`03-workflow-engine.md`](03-workflow-engine.md)), and the
  palette from drifting out of the swatches
  ([`../design/02-implementation.md`](../design/02-implementation.md)). A generated file is only
  trustworthy if something checks it.

## Vercel

Two projects, both with Root Directory set and Ignored Build Step
`npx turbo-ignore --fallback=HEAD^1`
(see `01`). Environment variables:

| Variable | Scope | Notes |
|---|---|---|
| `SUPABASE_URL` | web + api | public |
| `SUPABASE_ANON_KEY` | web + api | public, RLS-protected |
| `SUPABASE_SERVICE_ROLE_KEY` | **api only** | never in the browser bundle |

The service role key must not exist in `apps/web`'s environment at all - not merely unused. The
API needs it because transitions bypass RLS after the engine has adjudicated them (`03`).

## Branch protection

`main` requires the `verify` job green. Even solo, it demonstrates the pipeline is load-bearing
rather than decorative, which is what criterion #4 is actually asking.

## Proving it works

CI that nobody can see is CI that does not count. In the submission README include:

1. A link to a green Actions run.
2. A link to a run where `turbo-ignore` skipped a build, with the log line quoted.
3. The live Vercel URL and the two demo logins (`07`).
