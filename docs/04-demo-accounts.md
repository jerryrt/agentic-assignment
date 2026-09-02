# Demo accounts

Three accounts exist so the demo can be walked by someone who was given nothing but a URL.
They are created by [`../supabase/migrations/0004_demo_data.sql`](../supabase/migrations/0004_demo_data.sql),
which is a migration rather than a seed for exactly that reason: `supabase db push` applies
migrations only, so a seed never reaches the deployed project.

**Password, identical for all three:** `demo-only-not-a-secret`

| Email | Password | Role | Name | Organisation |
|---|---|---|---|---|
| `lender@example.test` | `demo-only-not-a-secret` | lender | Rowan Ellis | Meadowbank Agricultural Credit |
| `borrower@example.test` | `demo-only-not-a-secret` | borrower | Ada Fenwick | - |
| `grower@example.test` | `demo-only-not-a-secret` | borrower | Beau Marchand | - |

Where to sign in:

- **Deployed:** https://lj-web-jerryca.vercel.app/signin
- **Local:** `http://127.0.0.1:4200/signin`, after `supabase start` and `pnpm db:reset`

## These credentials are public on purpose

Anyone holding the URL can sign in as the borrower or the lender. That is a deliberate trade for
an assignment demo that has to be walkable by an assessor who was issued no account, and it is
acceptable only because of what is behind the login:

- every row is invented and every address is `@example.test`;
- **row-level security still governs what each account sees** -- the demo lender cannot read
  another organisation's files, and a borrower cannot read the lender's private decision note,
  which is the property the browser and database suites exist to prove;
- the service role key is not in the browser bundle, so a signed-in visitor holds exactly the
  authority their role carries.

It stops being acceptable the moment a real borrower's data exists in this project. At that point
the accounts are **removed**, not given a better password -- a shared login with a strong password
is still a shared login.

## Registration is closed, and why

The sign-up page works and will refuse to sign you in afterwards, so it says so before you try.

The deployed Supabase project confirms email addresses (`mailer_autoconfirm: false`) and the
project has no mail service, so a new account is created unconfirmed and can never authenticate.
Supabase answers the login with `invalid_credentials` rather than "not confirmed" -- deliberately,
so it cannot be used to discover which addresses exist -- which is why the failure gives no clue
to its cause.

The local stack is different: `supabase/config.toml` ships with `enable_confirmations = false`, so
signup there logs you straight in. That divergence is the reason this was found on the deployed
site rather than during development.

## What each account is there to show

The demo data seeds the *interesting* states rather than empty tables, because empty tables
demonstrate nothing.

| Account | Sees | Why it is interesting |
|---|---|---|
| `borrower@example.test` | a `draft` application stopped at the financials step, and an `approved` one | the draft demonstrates resume-where-you-left-off; the approved one has a decision attached that this borrower **cannot** read |
| `grower@example.test` | one application `under_review` | a second borrower, so "borrower A cannot see borrower B" is demonstrable with two real logins |
| `lender@example.test` | both borrowers' applications for their organisation, plus the decision note and risk grade | the two-roles-two-truths projection: the same rows, read differently |

Two loan products are seeded with genuinely different criteria -- an operating line with a debt
service coverage floor, and an equipment loan with a loan-to-value cap -- so eligibility diverges
visibly rather than passing or failing everything at once.

The sharpest thing to try with two windows: sign in as the borrower in one and the lender in the
other, and look at the same approved application. The lender sees `risk_grade B+` and the note
beginning "Coverage comfortable at 1.79x"; the borrower sees neither, and not because a template
hides them -- the database refuses to return them.

## Resetting

Local, from a clean database:

```bash
supabase start
pnpm db:reset     # runs the migrations, demo data included
```

The browser suite re-applies the demo data between spec files. Doing so invalidates every saved
session -- recreating `auth.users` cascades to `auth.sessions`, so a token still parses while the
auth service answers 403 -- which is why the harness re-issues its sessions after every reset.

The deployed project is migrated by CI on a push to `main`; the accounts arrive with the migration
and are not reset afterwards.
