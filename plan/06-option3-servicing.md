# Plan 06 -- Option 3: Servicing Portal with Credit Release Requests

> The interesting part: two roles seeing different truths from the same data, and a request that
> must survive a page refresh at any stage.

## Schema

```sql
create table loan (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references application(id),
  borrower_id    uuid not null references profile(id),
  org_id         uuid not null references organisation(id),
  product_id     uuid not null references loan_product(id),
  approved_limit numeric(14,2) not null,
  rate_bps       integer not null,
  opened_at      date not null default current_date,
  status         text not null default 'active'   -- active | closed | delinquent
);

create table ledger_entry (
  id          bigserial primary key,
  loan_id     uuid not null references loan(id),
  kind        text not null,          -- 'draw' | 'repayment' | 'interest' | 'fee'
  amount      numeric(14,2) not null, -- signed: draws +, repayments -
  effective   date not null,
  release_id  uuid references credit_release(id),   -- provenance
  memo        text,
  created_at  timestamptz not null default now()
);

create table credit_release (
  id            uuid primary key default gen_random_uuid(),
  loan_id       uuid not null references loan(id),
  amount        numeric(14,2) not null,
  purpose       text not null,
  state         text not null default 'draft',
  revision      integer not null default 0,
  requested_by  uuid not null references profile(id),
  decided_by    uuid references profile(id),
  decline_reason text,                 -- LENDER-AUTHORED, shared with borrower
  internal_note  text,                 -- LENDER ONLY
  created_at    timestamptz not null default now()
);
```

**The balance is derived, never stored.**

```sql
create view loan_balance_v as
select l.id as loan_id,
       l.approved_limit,
       coalesce(sum(e.amount), 0)                                as outstanding,
       coalesce((select sum(amount) from credit_release r
                  where r.loan_id = l.id
                    and r.state in ('submitted','under_review','approved')), 0) as pending,
       l.approved_limit - coalesce(sum(e.amount),0)
                        - coalesce((select sum(amount) from credit_release r
                             where r.loan_id = l.id
                               and r.state in ('submitted','under_review','approved')),0)
                                                                  as available
from loan l left join ledger_entry e on e.loan_id = l.id
group by l.id;
```

A stored balance is a cache with no invalidation strategy, and every reconciliation bug in
lending starts there. Deriving it also makes the two-truths story concrete -- see below.

## Two roles, two truths -- made literal

Same `loan_balance_v` row, two legitimate readings:

|  | Borrower sees | Lender sees |
|---|---|---|
| Available credit | `available` -- **net of pending requests**, because they must not spend it twice | `approved_limit - outstanding` as exposure, with `pending` shown as a separate at-risk column |
| A `submitted` release | "Submitted -- with your lender" | "New request -- awaiting triage" in a work queue |
| A declined release | reason text + what to change | reason text + `internal_note` + who decided |
| Timeline | their own actions, plain language | every event, with actor names |

This is the option's core and it should be **demonstrated side by side in the interview**: two
browser windows, borrower left, lender right, one request moving through states in both at once.
Supabase Realtime on `credit_release` makes that live; it is a few lines and it is the whole demo.

The projections are views (`credit_release_borrower_v` omits `internal_note`), not template
conditionals. Per `02`: hiding a column in HTML is not hiding it.

## The credit release workflow

Machine defined in `03`. What matters here are the guards and effects:

```ts
{ from: 'draft', event: 'submit', to: 'submitted', actor: ['borrower'],
  guard: ctx => requireAll(ctx, [
    amountAtLeast(ctx.release.amount, 1000),
    amountWithinAvailable(ctx.release.amount, ctx.balance.available),
    loanIsActive(ctx.loan),
    noOtherPendingRelease(ctx.releases),      // one at a time -- a real policy choice
  ]) },

{ from: 'approved', event: 'disburse', to: 'funded', actor: ['lender'],
  effects: [{ kind: 'post_ledger_entry', entry: { kind: 'draw', from: 'release.amount' } }] },
```

`amountWithinAvailable` uses `available` (net of pending), which is why the borrower's number is
the one net of pending -- the guard and the displayed figure are the same quantity. If they
differed, a borrower could submit a request the UI told them was fine. That coherence is the
answer to "two truths without two bugs."

The `disburse` effect posts the ledger entry **in the same transaction** as the state change
(`03`). A funded release with no ledger entry, or a draw with no release, must be unrepresentable.

## Surviving a refresh "at any stage"

The brief says *at any stage*, so cover all three:

1. **Mid-compose** (typing the request, before submit). `credit_release` rows are created in
   `draft` on first keystroke, so the URL becomes `/loans/:loanId/release/:releaseId` and the
   draft autosaves exactly like Option 2's form (`05`). Refresh mid-compose loses nothing.
2. **Mid-flight** (submitted -> funded). State lives server-side; the page is a projection.
   Refresh re-reads. There is no client-held progress to lose *by construction* -- say it that
   way in the interview, because "it can't lose its place" beats "we restore its place."
3. **Mid-decision** (lender has typed a decline reason but not submitted). Same draft treatment
   on `internal_note` / `decline_reason`, debounced to the row. Lenders lose work too.

Plus the 409/`revision` path from `03`: two lender tabs, one already approved, second gets a
conflict and refetches rather than double-approving.

## Screens

| Route | Role | Contents |
|---|---|---|
| `/loans` | borrower | Loan cards: limit, outstanding, available, next payment |
| `/loans/:id` | borrower | Balance detail, ledger table, release history, **Request credit** |
| `/loans/:id/release/:rid` | borrower | Compose / status + timeline |
| `/lender/queue` | lender | Requests grouped by state, sorted by age; SLA colouring on `submitted` age |
| `/lender/release/:rid` | lender | Full context, borrower's file, approve / decline / request info |

The lender queue is where "a loan officer could move through it quickly" (criterion #1) is judged:
keyboard-navigable rows, decision without leaving the list for the simple cases, oldest-first
default. Build it as a real work queue, not a table dump.

## Build notes

- Ledger and balance are read direct from Supabase under RLS (fast, realtime). Writes go through
  `/api/transition` only.
- Seed a loan with ~8 ledger entries and 2 historical releases (one funded, one declined) so both
  the timeline and the decline-reason path are visible without any clicking (`02`).
- Money as `numeric(14,2)` in Postgres, **integer minor units in TypeScript**. No floats anywhere.
  Format once, in one pipe, in `packages/ui`.
