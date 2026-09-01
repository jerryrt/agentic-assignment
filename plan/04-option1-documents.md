# Plan 04 -- Option 1: Document Collection with Validation

> The interesting part: deciding what *complete* and *inconsistent* mean, and showing the
> borrower a live, honest picture of where they stand.

The brief is explicit that the definitions are the deliverable. So define them, in code, as data.

## Schema

```sql
create table document_slot (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references application(id) on delete cascade,
  code            text not null,        -- 'tax_return_2024', 'deed', 'crop_insurance'
  label           text not null,
  required        boolean not null default true,
  state           text not null default 'required',
  valid_until     date,                 -- from extraction; drives derived expiry
  created_at      timestamptz not null default now(),
  unique (application_id, code)
);

create table document_upload (
  id               uuid primary key default gen_random_uuid(),
  slot_id          uuid not null references document_slot(id) on delete cascade,
  storage_path     text not null,       -- Supabase Storage, private bucket
  filename         text not null,
  bytes            integer not null,
  mime             text not null,
  extracted        jsonb,               -- { field: { value, confidence, page } }
  extraction_state text not null default 'pending',
  uploaded_at      timestamptz not null default now()
);
```

Slots are **generated from `loan_product.required_docs`** when the application enters
`docs_pending`. The required set is therefore product-dependent -- an equipment loan asks for an
invoice and a lien search; an operating line does not. That single fact makes the checklist feel
like a real lending product rather than a fixed list.

## "Complete" -- the definition

A pack is complete when, for every slot where `required = true`:

1. `state = 'accepted'`, **and**
2. it is not derived-expired (`valid_until is null or valid_until >= today`), **and**
3. every field the slot declares as `extractRequired` is present with `confidence >= 0.7`.

Three separate failure modes, deliberately: *missing*, *stale*, *unreadable*. The UI must
distinguish them because the borrower's next action differs in each case -- upload something,
upload a newer one, upload a clearer scan. Collapsing them into one red dot is the lazy version.

Completeness is a **guard** on `application: docs_pending -> under_review` (`03`), so the
definition is enforced, not decorative.

## "Inconsistent" -- the definition

Inconsistency is **cross-document**, otherwise it is just field validation. Rules compare a value
extracted from one document against the same value elsewhere -- another document, or what the
borrower typed in Option 2's form.

```ts
// packages/rules/src/documents/consistency.ts
export const consistencyRules: Rule<DocContext>[] = [
  numericAgreement({
    id: 'acreage-matches-application',
    label: 'Acreage on the deed matches the application',
    left:  ctx => ctx.field('deed', 'total_acres'),
    right: ctx => ctx.application.farm.totalAcres,
    tolerance: { kind: 'percent', value: 2 },
    severity: 'error',
  }),
  numericAgreement({
    id: 'income-matches-financials',
    label: 'Net farm income agrees across tax return and financial statement',
    left:  ctx => ctx.field('tax_return_2024', 'net_farm_income'),
    right: ctx => ctx.field('financial_statement', 'net_income'),
    tolerance: { kind: 'percent', value: 5 },
    severity: 'warning',
  }),
  exactAgreement({
    id: 'entity-name-matches',
    label: 'Legal entity name is the same on every document',
    fields: ['deed.owner_name', 'tax_return_2024.taxpayer_name'],
    normalise: normaliseEntityName,       // strips "LLC", ",", case, extra whitespace
    severity: 'error',
  }),
];
```

Two design points to defend:

- **Tolerance, not equality.** Real documents disagree slightly and always will. A rule with no
  tolerance produces noise, the borrower learns to ignore red, and the system is worse than
  nothing. Tolerance is per-rule and visible in the explanation text.
- **`severity` splits blocking from advisory.** `error` blocks the completeness guard; `warning`
  is surfaced to both parties and to the lender's queue but does not stop progress. Deciding
  which is which is the actual credit-policy judgment the brief is asking about.

## Extraction -- the honest seam

Real OCR is out of scope at this budget, and pretending otherwise would be the wrong call. The
seam is explicit and swappable:

```ts
export interface Extractor {
  extract(file: FileRef, slot: SlotDefinition): Promise<ExtractedFields>;
}
```

- `StubExtractor` (shipped) -- reads a sidecar convention: PDFs seeded in `supabase/seed.sql` have
  known values; uploaded files get a deterministic pseudo-extraction derived from the filename
  (`deed_1240ac_smith-farms.pdf` -> `{ total_acres: 1240, owner_name: "Smith Farms" }`), plus a
  **manual correction panel** so any value can be typed in.
- The correction panel is not a cop-out -- it is how these products actually ship: extraction
  proposes, a human confirms, `confidence` drops out of the completeness rule once a field is
  human-verified. Model that: `extracted.field.source = 'ocr' | 'human'`.

Say this plainly in the submission README. A stated stub at a named interface reads as scoping
judgment (criterion #7); an undisclosed one reads as a gap.

## "Live and honest" -- the UI

Route: `/apply/:id/documents`.

```
+--------------------------------------------------------------+
|  Your file is 3 of 5 complete            [######....]  60%   |
|  2 things need your attention                                |
+--------------------------------------------------------------+
| [+] 2024 tax return        accepted                          |
| [+] Deed                   accepted                          |
| [!] Crop insurance         expired 12 Mar - upload current   |
| [?] Financial statement    could not read net income   [fix] |
| [ ] Lien search            not uploaded             [upload] |
+--------------------------------------------------------------+
|  Cross-checks                                                |
|  [+] Acreage on deed matches your application (1,240 ac)     |
|  [!] Net income differs: tax return $184,200 vs statement    |
|      $171,500 - 6.9% apart, we allow 5%.          [explain]  |
+--------------------------------------------------------------+
```

Honesty rules for this screen, which are the whole point of the option:

- The percentage counts **accepted-and-valid** slots, never uploaded ones. Uploading a document
  that then fails must not move the bar forward and then back -- that is the dishonest version.
- Every failure names the *next action*, not the problem: "upload current", not "expired".
- Every cross-check shows **both values and the tolerance**. `[explain]` opens the rule's inputs.
  A borrower who cannot see why is a borrower who phones the loan officer.
- Live means **realtime**: subscribe to `document_slot` via Supabase Realtime, so a lender
  accepting a document updates the borrower's screen without a refresh. Cheap, and it demos well.

## Build notes

- Upload direct to Supabase Storage from the browser with a signed URL; the API never proxies
  bytes. Private bucket, RLS keyed on `application.borrower_id` and lender org.
- Extraction runs in `apps/api` on an `upload` transition effect, writes `extracted`, fires
  `extract` on the slot machine. Slot goes `uploaded -> extracted` even on partial reads; missing
  fields surface as completeness failures, not as an error state.
- Accept 10 MB, `application/pdf` and images only, validated server-side too.
