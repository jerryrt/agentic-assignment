# Plan 00 - Overview & Thesis

## The decision

The brief says "pick one of three." We are building **all three**, because they are not three
products. They are **three stages of one loan file**, and the brief's own framing gives that away:

| Option | Lifecycle stage | The "interesting part" per the brief |
|---|---|---|
| 2 - Application + eligibility | **Origination** | long form state + rules that change what the user sees |
| 1 - Documents + validation | **Underwriting** | what *complete* and *inconsistent* mean, shown live |
| 3 - Servicing + credit release | **Post-close** | two roles, two truths, survives refresh |

One borrower, one application, one lender. The application originates (Opt 2), collects its
document pack (Opt 1), funds, and enters servicing where the borrower draws credit (Opt 3).

## Why this is affordable rather than 3x the work

Three shared engines do the heavy lifting in all three surfaces:

1. **One workflow engine** (`packages/workflow`) - every option is "a process that moves through
   states and must not lose its place." Three machine *definitions*, one engine, one transition
   API, one event log, one durability story. See `03-workflow-engine.md`.
2. **One rules engine** (`packages/rules`) - eligibility criteria (Opt 2), document
   completeness/consistency (Opt 1), and credit availability (Opt 3) are all
   `evaluate(context) -> RuleResult[]`. One evaluator, one `<lj-rule-list>` component renders the
   live "here is where you stand and why" panel in all three. See `05`, `04`, `06`.
3. **One role model** - borrower vs. lender projections over the same rows. Opt 3 demands it;
   Opts 1 and 2 get it free. See `02-domain-model.md`.

The marginal cost of option two and three is mostly *screens*, not *systems*.

## Scope honesty - read this before starting

The brief budgets **2-3 hours for one option** and says explicitly: do not exceed it, and good
scoping judgment beats a lost weekend. Three options do not fit in three hours. Anyone reading
this plan should hold both facts at once:

- The **shared core** - skeleton, contracts and RLS, the two engines, the design system and the
  delivery spine - is **8.75 of 16.75 hours, about half**, and every hour of it is required for
  *any single option*. Counting the browser suite and the submission, **64% of the work is not
  option-specific**. It is not overhead: it is the thing being assessed (front-end craft, repo
  structure, workflow modelling, CI/CD).
- The three options themselves are 6.0 hours between them. Their surface is comparatively thin.

[`09-build-order.md`](09-build-order.md) owns the breakdown and sequences the work so that
**the build is submittable at four checkpoints**.
If time runs out at checkpoint 2, you submit a complete Option 2 with a core that visibly
generalises, and the README says so. That is a better outcome than three half-built options, and
the brief rewards saying it out loud.

[`10-scope-and-risks.md`](10-scope-and-risks.md) holds the cut list, in cut order.

## Non-goals (stated, per the brief's "not assessing" list)

- Visual polish beyond "a loan officer can move through it quickly."
- Test coverage as a percentage. Tests exist where they defend a rule or a transition --
  the rules engine and the workflow engine are pure functions and get unit tests. Nothing else does.
- Exhaustive edge cases. Real OCR, real credit bureau, real ACH are all stubbed at a seam.

## Plan index

| File | Contents |
|---|---|
| `01-architecture.md` | Monorepo layout, Turborepo pipeline, changed-only Vercel builds |
| `02-domain-model.md` | Postgres schema, roles, RLS, two-truths projections |
| `03-workflow-engine.md` | The state machine: definition, guards, event log, durability, concurrency |
| `04-option1-documents.md` | Document pack, extraction seam, completeness & consistency rules |
| `05-option2-application.md` | Multi-step form, draft durability, eligibility matching |
| `06-option3-servicing.md` | Loans, balances, credit release sub-workflow, dual-role views |
| `07-frontend.md` | Angular 22 structure, signals, forms, component library choice |
| `08-cicd.md` | GitHub Actions -> Vercel, migrations, branch protection |
| `09-build-order.md` | Phased execution with submittable checkpoints |
| `10-scope-and-risks.md` | Cut list, risks, what goes in the submission README |

Two sibling folders carry the rest: [`../design/`](../design/) holds the theme and the token
contract, and [`../docs/`](../docs/) holds the local development loop, the browser test plan, and
the agent scopes that parallelise this build order.
