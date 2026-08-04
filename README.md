# The Agentic Assignment
### Senior Full-Stack Engineer · Landjourney

---

## What this is

We are not going to ask you to invert a binary tree.

Landjourney is an AI-native engineering team. AI tooling is part of how we build every day, and we expect the people we hire to be fluent with it. So this assignment is deliberately designed the way you would actually work: you pick a problem, you use whatever tools you use, and you ship something running.

**Use AI. All of it. As much as you want.** We are not testing whether you can code without assistance. We are testing whether you can direct these tools toward a working product, and whether you understand what came out the other side.

That last part matters, so we will say it plainly: **after you submit, we will spend 45 minutes together in your code.** You will walk us through decisions, and we will ask you to add one thing we have not told you about in advance. Anything you did not read or do not understand will surface quickly. Plan accordingly.

**Time expectation: 2 to 3 hours.** Please do not exceed it. If you find yourself at hour five, stop and submit what you have with a note about what you would do next. We would rather see good judgment about scope than a weekend of your life.

---

## Choose one of three

Each of these is a real capability that exists in the agricultural lending market today. Pick whichever you find most interesting. There is no correct choice and no hidden preference on our side.

### Option 1 - Document collection with validation

A borrower uploads a set of documents to support a loan application. The system assembles them into a complete file, extracts key values, and flags in real time what is missing, expired, or inconsistent with what was submitted elsewhere.

The interesting part: deciding what complete and inconsistent mean, and showing the borrower a live, honest picture of where they stand.

### Option 2 - Loan application with eligibility matching

A multi-step application: borrower details, farm details, financials, loan request. As the applicant progresses, the system matches them against lender-defined eligibility criteria and shows which products they currently qualify for and why.

The interesting part: a form long enough that state management is a real problem, plus rules that change what the user sees as they go.

### Option 3 - Servicing portal with credit release requests

A borrower views their loans, balances and available credit, then requests a credit release. That request moves through states (submitted, under review, approved or declined, funded) with different views for borrower and lender.

The interesting part: two roles seeing different truths from the same data, and a request that must survive a page refresh at any stage.

---

## Technical parameters

These are fixed. Please do not substitute.

| | |
|---|---|
| **Repo** | Monorepo on GitHub. Frontend and backend in one repository. |
| **Monorepo tooling** | **Turborepo.** Configure the pipeline so Vercel builds only what changed. |
| **Frontend** | **Angular 22.** Standalone components. Use signals where they fit. |
| **Auth** | Supabase Auth. Working signup and login, not stubbed. |
| **Database** | Supabase (Postgres). |
| **Hosting** | Vercel. The app must be reachable at a live URL. |
| **CI/CD** | GitHub Actions to Vercel. At minimum: install, lint, build, deploy on push to main. |
| **Workflow** | Modelled in your own code. No workflow engine. |

### On that last row

Every option above has a process that moves through states and must not lose its place. We want to see how you model that: what the states are, what transitions are legal, where the state lives, and what happens if someone closes the tab mid-way and comes back.

Do not reach for Temporal, Inngest or similar. We want your design thinking, not a vendor's quickstart.

---

## What we are assessing

Stating this openly, because you would otherwise reasonably skip half of it.

1. **Front-end craft.** Component structure, state handling, forms at real complexity, and whether the result is something a loan officer could move through quickly. This carries the most weight.
2. **Repo and monorepo structure.** How you organise a codebase someone else has to work in, and how you configure the build pipeline.
3. **Component library choices.** Whether you used one, which, and why. Writing it yourself is a legitimate answer if you can defend it.
4. **CI/CD.** That a pipeline exists, runs, and does something useful.
5. **Workflow modelling.** States, transitions, and durability.
6. **AI-assisted delivery.** How much you got done, and how well you understood it.
7. **Scoping judgment.** What you chose to leave out, and whether you said so.

We are explicitly **not** assessing visual design polish, test coverage percentages, or whether every edge case is handled.

---

## What to submit

1. **The GitHub repo**, public or with access shared.
2. **The live Vercel URL.**
3. **A README** covering, briefly: which option you chose and why, how to run it locally, your workflow model (the states and what moves between them), and what you would do next with another two hours.
4. **A section in that README on how you used AI.** Which tools, what you delegated, what you rejected or rewrote, and anything it produced that looked plausible but was wrong. This is not a formality. It is one of the more useful things you can tell us about yourself.

---

## What happens next

A 45-minute session with our CTO. You share your screen and walk us through what you built. We will ask why you made specific decisions, and we will give you one additional requirement to implement while we watch.

You may use AI in that session too. Obviously.

---

## Questions

If anything here is ambiguous, ask rather than guess. Knowing when to ask is part of the job.
