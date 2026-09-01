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

env:
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ vars.TURBO_TEAM }}

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }        # turbo needs history to diff
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo lint typecheck test build --filter=...[origin/main^]
      - name: workflow definition parity
        run: pnpm workflow:check    # generated SQL still matches the TS machines

  migrate:
    needs: verify
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
      - run: supabase db push
```

Deployment itself stays on **Vercel's Git integration** rather than a `vercel deploy` step. It
gives preview URLs per PR for free, and re-implementing that in Actions is work with no payoff at
this size. The Actions pipeline is the quality gate; Vercel is the deployer. State that choice in
the README so it reads as a decision, not an omission.

Three details worth defending:

- `--filter=...[origin/main^]` - only packages whose dependency subgraph changed are linted,
  typechecked, tested and built. Combined with remote cache, a README-only PR finishes in seconds.
- `fetch-depth: 0` - without full history the filter silently degrades to "everything." A common
  and invisible misconfiguration.
- `workflow:check` - regenerates the transition SQL and fails if it differs from what is checked
  in. This is the CI job that keeps the TS machine and the Postgres trigger from drifting (`03`).

## Vercel

Two projects, both with Root Directory set and Ignored Build Step `npx turbo-ignore --fallback=HEAD^1`
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
