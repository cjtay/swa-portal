# Approvals: Finance Policy Compliance — Implementation Plan

> **Status**: **built** — Batches A, B and C all landed 2026-09-05. A: migration 012, self-approval guard, decision offices, S$5,000 two-stage force, invoice number + duplicate warning, R4 (GIRO), R5 (voucher print), R7 column, R8 matrix printed. B: migration 013, S$1,000 declarations + quotations-or-waiver, quotation dates + 12-month warning, S$10,000 board guard, R1 field-level audit, R6 remembered payment method, R7 checkbox UI. C: R2 view-only auditor role, R3 board-list CSV export. Tests + docs landed with each batch; migrations applied to local D1 only (§14 ship steps remain owner-gated). Change-request document: `docs/plans/approvals-additional-requirements-2026-08-29.md`.
> **Source**: `docs/plans/approvals-finance-policy-compliance.md` (gap analysis,
> settled decisions in its §12.1), `docs/specs/features/approvals.md` (feature
> spec), `docs/plans/Approval-Workflow-Implementation-Plan.md` (original build).
> **Manual**: "Finance Policy, Accounting and Procedure Manual", SWA, version 2,
> 15 December 2024.

## 1. What we are building, in plain words

The approvals feature is built and working. The finance manual sets money rules
the portal does not yet enforce. This plan adds them in two batches:

- **Batch A (rules and records, migration 012)**: the office each approver
  holds, a ban on approving your own request, both stages forced on at
  S$5,000 and above, the invoice number with a duplicate warning, and the
  seven-year retention note.
- **Batch B (form and evidence, migration 013)**: declarations and quotation
  rules at S$1,000 and above, the board evidence box above S$10,000, and
  quotation dates with a twelve-month warning.

The feature has not shipped to the board (settled decision 7), so every rule
applies to every item from day one. No old rows need converting.

## 2. Decisions this plan builds on

The seven owner decisions are recorded in the gap analysis §12.1. Two further
design choices were settled with the owner on 2026-08-29:

1. **Two quotations are counted as comparison rows.** Each comparison row
   already links to one attached document. At S$1,000 and above the server
   counts comparison rows; fewer than two needs a waiver reason instead. No
   new file-tagging UI.
2. **Cheapest supplier is a Yes/No declaration.** The admin answers "Is the
   chosen supplier the cheapest of the quotations?". Answering No reveals a
   required reason box. The AI analysis helps the admin answer (its preview
   sits beside the question) but never auto-fills or bypasses it. The manual
   (3.3 k) asks the requestor for a recorded justification, which is exactly
   what this captures.

## 3. The rules in one table

All amounts are the requested amount, which the manual measures before GST.
The form carries a hint: "Enter the amount before GST." The voucher print
rule uses the voucher total, because the payment matrix governs payments.

| Moment | Rule | Batch |
|--------|------|-------|
| Every decision | The signer's office is recorded and shown beside their name (board, drawer, emails, voucher) | A |
| Every decision | A requestor cannot approve or reject their own request (all four decision endpoints, 403) | A |
| Every voucher | Invoice or receipt number required at submission (400 if missing) | A |
| Every voucher | A repeated invoice number warns, never blocks: response flag, audit row, warning at the payment step | A |
| S$1,000 and above | Two comparison rows (quotations) or a recorded waiver reason, else 400 | B |
| S$1,000 and above | Budget tick plus budget amount, approving officer and date (typed text; budget approvers are not portal users) | B |
| S$1,000 and above | Conflict-of-interest tick and no-splitting tick, required | B |
| S$1,000 and above | Cheapest-supplier Yes/No; No requires a written reason | B |
| S$5,000 and above | `approval_required` forced on at create and edit, even for recurring categories | A |
| S$5,000 and above (voucher total) | Printed voucher shows both signers with their offices | A |
| S$6,000 to S$90,000 | Form reminder: obtain two written invitations to quote and attach them | B |
| Above S$10,000 | Purchase approve refuses (409) until a board reference exists and at least one document is attached | B |
| Above S$90,000 | Form reminder: a formal tender is required, attach the tender documents | B |
| Always | Records are kept for at least seven years; nothing deletes approvals data | A (docs only) |

Quotation dates are optional per comparison row. A date older than twelve
months shows an amber warning in the drawer (settled decision 6: warn, never
block).

## 4. Database

### 4.1 Migration 012 (Batch A)

`migrations/012_approvals_compliance_rules.sql`:

```sql
ALTER TABLE approval_items ADD COLUMN purchase_decision_office TEXT;
ALTER TABLE approval_items ADD COLUMN finance_decision_office TEXT;
ALTER TABLE approval_items ADD COLUMN invoice_no TEXT;
CREATE INDEX IF NOT EXISTS idx_approval_items_invoice_no ON approval_items(invoice_no);
```

- `purchase_decision_office` / `finance_decision_office`: the office label of
  whoever decided, written in the same UPDATE as the existing decision
  columns. Null when the signer holds no mapped office (for example the
  system account); display then falls back to the name alone, which is the
  current behaviour.
- `invoice_no`: required at voucher submission. Indexed but **not** UNIQUE,
  because a repeated number warns rather than blocks (settled decision 5).
- The three columns are backported into `schema.sql` in the same commit, and
  the index added beside the existing approval indexes (009 convention, so
  fresh local databases never need this file).

### 4.2 Migration 013 (Batch B)

`migrations/013_approvals_compliance_evidence.sql` — ten nullable columns:

```sql
ALTER TABLE approval_items ADD COLUMN board_approval_ref TEXT;        -- <=500 chars
ALTER TABLE approval_items ADD COLUMN quotation_waiver_reason TEXT;   -- <=1000 chars
ALTER TABLE approval_items ADD COLUMN supplier_is_cheapest INTEGER;   -- 0/1, required >=1000
ALTER TABLE approval_items ADD COLUMN supplier_choice_reason TEXT;    -- <=1000 chars
ALTER TABLE approval_items ADD COLUMN budget_approved INTEGER;        -- 0/1 tick
ALTER TABLE approval_items ADD COLUMN budget_amount TEXT;             -- text, <=50 chars
ALTER TABLE approval_items ADD COLUMN budget_officer TEXT;            -- <=200 chars
ALTER TABLE approval_items ADD COLUMN budget_date TEXT;               -- YYYY-MM-DD
ALTER TABLE approval_items ADD COLUMN coi_declared INTEGER;           -- 0/1 tick
ALTER TABLE approval_items ADD COLUMN no_split_declared INTEGER;      -- 0/1 tick
```

`budget_amount` is text on purpose: budget approvers are not portal users, so
there is nothing to validate the figure against. All ten backport into
`schema.sql` in the same commit.

### 4.3 Comparison JSON: quotation dates

Each comparison row gains an optional `quoteDate` (YYYY-MM-DD). Stored shape
becomes `{ attachmentId, description, quoteDate? }`. No migration, no new
column; the date rides the existing JSON exactly as the gap analysis proposed.

## 5. Constants and the office map (`src/constants/portal.ts`)

New constants beside the existing approver lists:

```ts
// Money-rule thresholds from the finance manual (amounts before GST).
export const APPROVAL_QUOTE_RULE_THRESHOLD = 1_000;    // declarations + quotes/waiver
export const APPROVAL_TWO_STAGE_THRESHOLD = 5_000;     // both stages forced on
export const APPROVAL_BOARD_APPROVAL_THRESHOLD = 10_000;
export const APPROVAL_INVITATION_REMINDER_THRESHOLD = 6_000;   // form reminder only
export const APPROVAL_TENDER_REMINDER_THRESHOLD = 90_000;      // form reminder only

// Office held by each approver address. Local dev uses the five test
// addresses only; production addresses are owner-swapped at ship time.
export const APPROVAL_OFFICE_LABELS: Record<string, string> = {
  'approval@singaporewomenassociation.org': 'President',
  'cjtay@singaporewomenassociation.org': '1st Vice President',
  'finance@singaporewomenassociation.org': 'Treasurer',
  'internal@singaporewomenassociation.org': 'Assistant Treasurer',
  // Production (owner swaps in at ship time):
  // 'roxanne…': 'President',
  // 'angela…': '1st Vice President',
  // 'ys…': 'Treasurer',
  // 'joyce…': 'Assistant Treasurer',
};

/** The office label for an approver email, or null when none is mapped. */
export function approvalOfficeFor(email: string): string | null;
```

One list change: `internal@singaporewomenassociation.org` joins
`APPROVAL_FINANCE_APPROVER_EMAILS` as a dev-only entry (the Assistant
Treasurer stand-in, settled decision 1). Production finance addresses stay
commented as today.

`system@` holds no office and stays unmapped on purpose.

## 6. Batch A changes

All handler references are to `src/worker/api/approvals.ts`.

### 6.1 Self-approval guard (Change 2)

In all four decision handlers, after the item row loads and before the
UPDATE: if the signed-in email equals `item.created_by` (case-insensitive),
return 403 with the message "You raised this request, so you cannot approve
or reject it. Another approver must decide."

- `handleApprovalPurchaseApprove`
- `handleApprovalPurchaseReject`
- `handleFinanceApprove`
- `handleFinanceReject`

This closes the one open path today: an IT admin who creates an item is also
a purchase approver through the IT-admin union.

### 6.2 Office capture (Change 1)

- The four decision UPDATEs gain the office column:
  `purchase_decision_office = ?` / `finance_decision_office = ?`, bound to
  `approvalOfficeFor(email)` (null when unmapped).
- The decision audit rows append `; office=<label>` to the note when an
  office exists, so the CSV export answers "who signed, in what role".
- `handleApprovalDetail` selects the two office columns and returns them.

### 6.3 Both stages at S$5,000 and above (Change 4)

- `handleApprovalsCreate`: after the `approvalRequired` parsing, force it on
  when `requestedAmount >= APPROVAL_TWO_STAGE_THRESHOLD`. The item then
  starts at `pending` even for recurring categories, and the purchase
  approvers are emailed as usual.
- `handleApprovalEdit`: when the effective requested amount is S$5,000 or
  more, the SET clauses include `approval_required = 1`.
- Note: recurring items skip the purchase stage by starting at
  `purchase_approved`, which is not an editable status. So the create-time
  force covers every case; there is no later window where a recurring item
  above S$5,000 could dodge the purchase stage (and no old items exist,
  settled decision 7).

### 6.4 Invoice number and duplicate warning (Change 7)

`handleApprovalVoucher`:

- New body field `invoiceNo` (trimmed, 1–100 chars). Required on first
  submission (400 when missing). On resubmission after a finance rejection it
  is optional: provided and non-empty updates the stored value, omitted keeps
  it. The UPDATE writes `invoice_no`.
- Before the UPDATE, the duplicate check runs:
  `SELECT id, voucher_no FROM approval_items WHERE invoice_no = ? COLLATE NOCASE AND id != ?`.
  When a match is found the response still succeeds but carries
  `duplicateInvoice: { id, voucherNo }`, and a `possible_duplicate_invoice`
  audit row is written with note `invoice_no=<n>; matches item <id> (<voucher_no>)`.

`handleApprovalDetail`: when the item has an `invoice_no`, the same duplicate
query runs and the response gains `duplicate_invoice` (or null), so the
drawer and the payment step can warn without extra calls.

Warning, never block (settled decision 5): suppliers legitimately reuse
invoice numbers monthly, so a human decides.

### 6.5 Voucher print page (`src/pages/approvals/voucher.astro`)

- Meta block gains an "Invoice/Receipt No" line when `invoice_no` is present.
- Signature block rules, using the computed voucher total:
  - `approval_required = 1` **and** total ≥ S$5,000: two lines, each with
    office and date. "Purchase approved by: `<name>, <office>` (`<date>`)"
    and "Payment approved by: `<name>, <office>` (`<date>`)".
  - `approval_required = 1` **and** total < S$5,000: current single
    "Payment approved by" line (one Treasurer-side signature is enough,
    manual 4.1.1).
  - `approval_required = 0`: unchanged "No approval required".
- Batch B adds the declarations block to this page (§7.4).

### 6.6 Emails show the office

`src/worker/lib/email-approval.ts`: the decision payloads gain an optional
`decidedByOffice`. The "Decided by" row renders `Name (Office)` when an
office exists. The four decision handlers pass `approvalOfficeFor(email)`.

### 6.7 Retention note (Change 8, no code)

- Feature spec §4 gains the rule: approval items, attachments and audit rows
  are kept for a minimum of seven years; no portal code path deletes them;
  any future cleanup job must respect the seven-year minimum.
- The user guide (`src/pages/approvals/guide.astro`) states the same in its
  FAQ section.

## 7. Batch B changes

### 7.1 Create and edit validation at S$1,000 and above (Changes 5 + 6)

Both handlers apply the same block, only when the effective requested amount
is `>= APPROVAL_QUOTE_RULE_THRESHOLD` (a null amount triggers nothing):

1. **Quotes or waiver**: at least two comparison rows (at create: rows parsed
   from the form; at edit: the comparison JSON after this edit, stored or
   rebuilt) **or** a non-empty `quotationWaiverReason` (≤1,000 chars). Else
   400: "Attach at least two quotations in the comparison table, or give a
   waiver reason."
2. **Declarations**, all required, else 400 naming the missing field:
   - `budgetApproved` tick (true)
   - `budgetAmount` (1–50 chars), `budgetOfficer` (1–200 chars),
     `budgetDate` (valid YYYY-MM-DD, checked with the existing `isRealDate`)
   - `coiDeclared` tick (true)
   - `noSplitDeclared` tick (true)
3. **Supplier choice**: `supplierIsCheapest` must be answered (true/false);
   false requires `supplierChoiceReason` (1–1,000 chars).

`boardApprovalRef` (≤500 chars) is accepted and stored at create and edit but
not required there; the teeth are at the purchase approve step (§7.3).

At edit, "effective" means the form value when provided, otherwise the stored
value. Edit only runs while the item is pending or purchase-rejected, so
these fields cannot change after a decision, matching the existing
fields-freeze rule.

### 7.2 Quotation dates and the twelve-month warning (Change 5)

- Create accepts an optional `quoteDate` per comparison row (validated,
  sane-year bounds as today). Edit validates the same on rebuilt tables.
- The drawer renders each row's quotation date. When
  `today − quoteDate > 365 days`, an amber "older than 12 months, a fresh
  quotation is needed" chip appears (manual 3.3 d, settled decision 6: warn).
- The warning lives in the drawer only, not as a board table badge. The list
  query stays unchanged; comparison JSON loads with the detail, and the
  drawer is where approvers decide. Recorded in §15 as a small deviation
  from the gap analysis wording.

### 7.3 Board approval above S$10,000 (Change 3)

`handleApprovalPurchaseApprove` gains, after the self-approval guard and
before the UPDATE, when `requested_amount >= APPROVAL_BOARD_APPROVAL_THRESHOLD`:

1. `board_approval_ref` must be non-empty, else 409: "This purchase is
   S$10,000 or more. Record the board approval reference (for example
   'Board meeting 12 Aug 2026, item 4') on the request first."
2. The item must have at least one attachment, else 409: "Attach the board
   minutes or the approval email before approving."

The evidence is an uploaded PDF of the minutes sitting in the request's
attachments like any other document (settled decision 2). The reference text
points the approver to it. Which attachment is the minutes stays a human
judgement; the audit row records the decision.

### 7.4 Form changes (`src/pages/approvals.astro`)

Create and edit forms share the new conditional blocks, shown live by the
typed amount:

- Amount field hint: "Enter the amount before GST."
- **≥ S$1,000** — "Declarations" card: budget tick plus the three small
  fields, the conflict-of-interest tick, the no-splitting tick (wording from
  the gap analysis §8), the waiver-reason box (revealed when fewer than two
  comparison rows exist), and the supplier Yes/No with its reason box.
- **≥ S$6,000** (and below S$90,000): reminder line "S$6,000 and above:
  obtain two written invitations to quote and attach them."
- **> S$90,000**: reminder line "Above S$90,000: a formal tender is required.
  Attach the tender documents."
- **≥ S$10,000**: "Board approval" box with the reference text field and the
  note "Attach the board minutes or approval email PDF".
- Comparison builder rows gain an optional date input (quotation date).
- The voucher form gains the required invoice/receipt number field.

The server re-validates everything; the conditional UI is help, not the
enforcement.

### 7.5 Drawer changes

- Decision lines show the office: "Purchase approved by `<name>`,
  `<office>`" and the finance equivalent.
- New evidence card: declarations (budget fields, both ticks), board
  reference, waiver reason, supplier choice and reason, invoice number, and
  the duplicate-invoice warning when `duplicate_invoice` is present.
- The paid form shows the duplicate warning above its fields; recording the
  payment stays possible (warn, never block).

## 8. Pages touched

| Page | Batch | Change |
|------|-------|--------|
| `src/pages/approvals.astro` | A | Voucher form invoice field; drawer office labels; paid-form duplicate warning |
| `src/pages/approvals.astro` | B | Conditional declaration/evidence blocks; quotation dates; drawer evidence card |
| `src/pages/approvals/voucher.astro` | A | Invoice line; two-signature block at S$5,000+ |
| `src/pages/approvals/voucher.astro` | B | Declarations print under the signature block (gap analysis §8) |
| `src/pages/approvals/guide.astro` | A + B | New fields in the walkthrough; seven-year retention FAQ |

## 9. Emails

Only the decision emails change (office beside the decider's name, §6.6).
Request and voucher emails are unchanged. Recipients stay the named lists.

## 10. Documentation updated in the same commits

- `docs/specs/features/approvals.md`: new rules in §4, new columns in §6, new
  audit action `possible_duplicate_invoice` in §6, office map and thresholds,
  self-approval rule in §3, retention rule.
- `docs/ARCHITECTURE.md`: the three plus ten new `approval_items` columns in
  the tables section (same commit as the structural change, per AGENTS.md).
- `src/pages/approvals/guide.astro`: user-facing wording for the new fields
  and the seven-year rule.
- `progress.md`: dated session entry per batch.

## 11. Tests

New file `src/worker/api/__tests__/approvals-compliance.test.ts`, following
the existing pattern in `approvals.test.ts`: `SELF.fetch()` against Miniflare
bindings, HMAC-minted session cookies, `applyMigrations` + `seedMember`, and
its own rotating admin-email list (each test file owns its rate-limit
buckets).

Batch A cases:

1. Self-approval: an IT admin creates an item and posts `/approve` on it,
   expects 403.
2. A second approver (`approval@`) approves; detail returns
   `purchase_decision_office: 'President'`.
3. `finance@` finance-approves; detail returns
   `finance_decision_office: 'Treasurer'`.
4. Finance self-approval: an item row seeded with `created_by =
   finance@`; `finance@` posting `/finance-approve` expects 403.
5. Two-stage force: a payroll item at S$6,000 creates at `pending` with
   `approval_required = 1`; at S$4,999.99 payroll still starts at
   `purchase_approved`.
6. Voucher without `invoiceNo` expects 400.
7. Two items sharing an invoice number: the second voucher submit succeeds
   with `duplicateInvoice` set, and the `possible_duplicate_invoice` audit
   row exists.
8. Detail on the second item returns `duplicate_invoice`.

Batch B cases:

9. Create at S$1,500 with one comparison row and no waiver expects 400; with
   a waiver reason expects 201 and the stored field.
10. Create at S$1,500 missing each declaration in turn expects 400; with all
    present expects 201.
11. Create at S$999 with no declarations expects 201.
12. `supplierIsCheapest = false` without a reason expects 400; with a reason
    expects 201.
13. Purchase approve at S$12,000 without a board reference expects 409; with
    the reference and an attachment expects 200.
14. Editing a pending S$900 item up to S$6,000 flips `approval_required` to 1.

Existing tests keep passing: the new fields are optional in the API (the
thresholds do the gating), and the voucher tests gain an `invoiceNo` in their
payloads.

## 12. Local testing walk

Dev quick-login identities (settled decision 1): `cjtay@` is the office admin
(1st VP office label, but signs nothing because of the self-approval guard),
`approval@` is the President, `finance@` is the Treasurer, `internal@` is the
Assistant Treasurer.

1. Apply locally: `node ./node_modules/wrangler/bin/wrangler.js d1 execute
   swa-portal --local --file=migrations/012_approvals_compliance_rules.sql`
   (013 the same way in Batch B).
2. `npm run dev:worker`, open `localhost:8787/approvals`.
3. As `cjtay@`: create a S$500 item, no declarations appear. Create a
   S$1,500 item with one quote plus a waiver, declarations appear. Create a
   S$12,000 item, the board box appears.
4. As `approval@` (President): the S$12,000 item refuses to approve while the
   reference is missing; after filling it, approval lands and the drawer
   shows "President".
5. As `cjtay@`: try to approve an item you raised, expect the refusal
   message.
6. As `cjtay@`: submit the voucher; the invoice number is required. Reuse an
   invoice number from another item and see the warning at the payment step.
7. As `finance@` (Treasurer): approve the voucher. Print the voucher: both
   signers with offices appear for a S$5,000+ total.
8. As `internal@` (Assistant Treasurer): the board is readable and the
   finance buttons work on another voucher.

## 13. Build phases and verification

- **Phase A1**: migration 012 + `schema.sql` backport + constants (office
  map, thresholds, `internal@` finance entry).
- **Phase A2**: handlers (guard, office capture, two-stage force, invoice
  number + duplicate warning) + email office labels.
- **Phase A3**: pages (voucher print, drawer labels, voucher form, paid-form
  warning).
- **Phase A4**: tests + documentation. Run `npm run typecheck`,
  `npm run typecheck:worker`, `npm run test:run`.
- **Phase B1**: migration 013 + `schema.sql` backport.
- **Phase B2**: create/edit validation, comparison quote dates, board-ref
  approve guard.
- **Phase B3**: form and drawer UI.
- **Phase B4**: tests + documentation, same three commands.

Each batch lands as its own commit and can ship independently. Batch B builds
on Batch A (the board box and the declarations share the office work), so the
order is fixed. Batch C (§17) carries the auditor role and the approval list
export. It builds on Batch A and can ship with or after Batch B.

## 14. Ship steps (owner-gated, per batch)

1. `wrangler d1 export swa-portal --remote --output=backup.sql` (backup
   first, the 009 convention).
2. `wrangler d1 execute swa-portal --remote --file=migrations/012_…sql`
   (013 for Batch B).
3. Swap production addresses: the office map entries and the approver list
   comments in `src/constants/portal.ts` (owner decision 1; owner hands
   only).
4. `npm run deploy`.
5. Verify on production: create, decide, voucher, print, pay once through.

## 15. Deviations and design choices recorded

1. **Comparison rows count as quotations** (settled with the owner,
   2026-08-29): the gap analysis said "two attached quotations"; the portal
   counts comparison rows because they are the only marker of which attached
   documents are quotations.
2. **Cheapest supplier by declaration** (settled with the owner,
   2026-08-29): a Yes/No plus reason, never auto-computed. The AI preview
   informs but does not answer.
3. **Old-quotation warning in the drawer only**: the gap analysis said "the
   board and drawer show a warning". The board table shows no badge, because
   the list query would have to pull comparison JSON for every row. The
   drawer, where decisions happen, shows it.
4. **Board minutes check is reference text plus any attachment**: the portal
   cannot tell which PDF is the minutes. The reference text points the
   approver to it; the approver's eyes confirm.
5. **Invoice number is required at voucher submission, not at payment** (one
   step earlier than the manual's e-payment wording): the voucher is the
   payment document, and the warning is then visible at the payment step.

## 16. Files changed

Batch A:

| File | Operation |
|------|-----------|
| `migrations/012_approvals_compliance_rules.sql` | create |
| `schema.sql` | edit (backport columns + index) |
| `src/constants/portal.ts` | edit (office map, helper, thresholds, `internal@` finance entry) |
| `src/worker/api/approvals.ts` | edit (§6.1–6.4, §7.3 guard in B) |
| `src/worker/lib/email-approval.ts` | edit (office in decision rows) |
| `src/pages/approvals.astro` | edit (voucher form, drawer, paid warning) |
| `src/pages/approvals/voucher.astro` | edit (invoice line, signatures) |
| `src/worker/api/__tests__/approvals-compliance.test.ts` | create |
| `docs/specs/features/approvals.md` | edit |
| `src/pages/approvals/guide.astro` | edit |
| `docs/ARCHITECTURE.md` | edit |
| `progress.md` | edit (session entry) |

Batch B:

| File | Operation |
|------|-----------|
| `migrations/013_approvals_compliance_evidence.sql` | create |
| `schema.sql` | edit (backport columns) |
| `src/worker/api/approvals.ts` | edit (§7.1–7.3) |
| `src/pages/approvals.astro` | edit (forms, drawer) |
| `src/pages/approvals/voucher.astro` | edit (declarations print) |
| `src/worker/api/__tests__/approvals-compliance.test.ts` | edit (extend) |
| `docs/specs/features/approvals.md` | edit |
| `src/pages/approvals/guide.astro` | edit |
| `docs/ARCHITECTURE.md` | edit |
| `progress.md` | edit (session entry) |

## 17. Additions from the owner discussion (2026-08-29)

After this plan was settled, the owner raised eight further requirements in a
handwritten discussion. The notes were transcribed and every ambiguous point
was confirmed with the owner the same day. The standalone change request is
`docs/plans/approvals-additional-requirements-2026-08-29.md`.

| # | Requirement | Settled decisions | Lands in |
|---|-------------|-------------------|----------|
| R1 | Audit trail records every field change | Field name, old value, new value, who, when. Attachments excluded, they already have their own audit rows. CSV shape unchanged | Batch B (create and edit handlers) |
| R2 | New view-only auditor role | Can see the board, status tabs, drawer and documents. Cannot create, edit, voucher, approve, reject, pay, remind or export. Chosen by email list, not a member category | Batch C |
| R3 | Export the approval list as CSV, filtered by status | Exports the currently open tab. Admin and IT admin only, the auditor cannot export. Separate from the audit CSV | Batch C |
| R4 | Payment method: remove Cheque, add GIRO | Approvals paid step only. The members fee-payment page keeps Cheque. Nothing has shipped, so no old rows to convert | Batch A |
| R5 | All payment voucher fields print on the voucher | Payment method, reference, paid by and paid date, printed when present. Merges with the §6.5 voucher work | Batch A |
| R6 | Recurring categories remember the payment method | The paid form pre-selects the method from the most recent paid item in the same category. The admin can override | Batch B |
| R7 | Tax Invoice marked by checkbox, always displayed first | Instead of reorder controls, each attached document gets a simple checkbox: "This is the Tax Invoice". One document per item can be ticked; ticking one clears the other. The display always puts the ticked document first, then the rest in upload order | One `is_tax_invoice` column on `approval_attachments` (Batch A); the checkbox rides the create, edit and voucher forms (Batch B) |
| R8 | Approval matrix follows the SWA finance policy | The portal's amount bands and approval stages must match the authorisation matrix in the finance manual (version 2, 15 December 2024): quotations and declarations from S$1,000, both stages forced at S$5,000, board approval with evidence above S$10,000, formal tender above S$90,000 | The §3 rules table already implements the manual's matrix. Batches A and B documentation adds the matrix to the feature spec and the user guide, and the §5 threshold constants stay the single place the numbers live |

Dropped during confirmation: the Tax Invoice and Delivery Order upload labels
and the whole "no quotation → go direct" thread. The owner confirmed the
current optional upload is good enough.

### 17.1 What each addition needs

- **R1**: the create and edit handlers write the changed fields into the
  audit note, as `field: old → new` pairs. Documents and attachments stay
  excluded.
- **R2**: an `APPROVAL_AUDITOR_EMAILS` list in `src/constants/portal.ts`, an
  `is_approvals_viewer` session flag through `/api/session`, middleware that
  admits viewers to GET approval endpoints only, action buttons hidden for
  viewers, the nav item visible, and a new access-matrix row in
  `docs/specs/SWAPortal-Functional-Specs.md` plus a feature spec update.
- **R3**: a new `GET /api/approvals/export?status=…` CSV endpoint (admin and
  IT admin), an Export button that exports the open tab, and tests.
- **R4**: `PAYMENT_METHODS` loses `cheque` and gains `giro`, with the label
  map and dropdown in `approvals.astro` updated to match.
- **R5**: the voucher print page gains payment method, payment reference,
  paid by and paid date lines whenever the fields exist (folds into §6.5).
- **R6**: the detail response returns the category's last paid method, and
  the paid form pre-selects it.
- **R7**: an `is_tax_invoice INTEGER` (0/1) column joins migration 012, the
  detail query orders by `is_tax_invoice DESC, id`, and the create, edit and
  voucher forms get one checkbox per document: "This is the Tax Invoice".
  Ticking one unticks the other, so at most one document is marked, and it
  always renders first in the drawer, the voucher print and the document
  lists.
- **R8**: a documentation rule, no new code. The §3 rules table is checked
  line by line against the manual's authorisation matrix, the matrix is
  printed in the feature spec (§4) and the user guide, and the threshold
  constants in `src/constants/portal.ts` (§5) remain the only place the
  amounts are defined, so any future policy change is a one-file edit.

### 17.2 Files for Batch C

| File | Operation |
|------|-----------|
| `src/constants/portal.ts` | edit (auditor email list) |
| `src/worker/middleware.ts` | edit (viewer entry on GET approvals endpoints) |
| `src/worker/api/session.ts` | edit (expose `is_approvals_viewer`) |
| `src/worker/api/approvals.ts` | edit (list export endpoint) |
| `src/pages/approvals.astro` | edit (nav and action visibility for viewers, Export button) |
| `src/worker/api/__tests__/approvals-compliance.test.ts` | edit (extend) |
| `docs/specs/features/approvals.md` | edit (auditor role, export) |
| `docs/specs/SWAPortal-Functional-Specs.md` | edit (access-matrix row) |
| `docs/ARCHITECTURE.md` | edit |
| `progress.md` | edit (session entry) |
