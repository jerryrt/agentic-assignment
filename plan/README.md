# Plan

Implementation plans for the Landjourney agentic assignment, building **all three options** as
one loan lifecycle rather than picking one. Read `00-overview.md` first - it carries the argument
and the scope honesty.

| File | Contents |
|---|---|
| `00-overview.md` | Thesis, why all three, scope honesty, plan index |
| `01-architecture.md` | Monorepo layout, Turborepo pipeline, changed-only Vercel builds |
| `02-domain-model.md` | Postgres schema, roles, RLS, two-truths projections |
| `03-workflow-engine.md` | State machines, guards, event log, durability, concurrency |
| `04-option1-documents.md` | Document pack, extraction seam, completeness and consistency |
| `05-option2-application.md` | Multi-step form, draft durability, eligibility matching |
| `06-option3-servicing.md` | Loans, balances, credit release workflow, dual-role views |
| `07-frontend.md` | Angular 22 structure, signals, forms, component library choice |
| `08-cicd.md` | GitHub Actions to Vercel, migrations, remote cache |
| `09-build-order.md` | Phased execution with four submittable checkpoints |
| `10-scope-and-risks.md` | Cut list, risks, and what goes in the submission README |

Engineering conventions for this repo live in `../CLAUDE.md`.

Start at `09-build-order.md` Phase 0 when writing code.

Visual design lives in `../design/`. The theme is Fieldwork; read `../design/00-foundations.md`
before building any screen.
