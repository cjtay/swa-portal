# Approvals: Finance Policy Compliance

> **Status**: gap analysis complete; all seven owner decisions settled
> 2026-08-29 (§12.1). Not implemented — detailed build plan is the next step.
> **Source**: "Finance Policy, Accounting and Procedure Manual", Singapore Women's
> Association, version 2, 15 December 2024. This document calls it the manual.
> **Related**: `docs/specs/features/approvals.md` (feature spec),
> `docs/plans/Approval-Workflow-Implementation-Plan.md` (original build plan)

## 1. Purpose

The manual sets rules for how SWA approves and pays for purchases. The portal's
Approvals feature already follows the same overall path: one person raises a
request with documents, a purchase approver decides, a voucher is prepared, a
finance approver checks it, and payment is recorded. Every step lands in an
append-only audit log.

This document compares the manual with the feature rule by rule. For each gap it
explains what the manual requires, what the portal does today, and the change we
propose. Eight changes are proposed. Sections 3 to 10 describe them one by one.

## 2. Rules the feature already meets

No work is needed for these. Listed so future readers know they were checked.

- **Segregation of duties** (manual 2.1, Policy section 7): the person who raises
  a request is the office admin. The approvers are different people on separate
  email lists (`src/constants/portal.ts:156` and `:167`). IT admin accounts are
  barred from finance approval by design.
- **Serially numbered, unique vouchers** (manual 4.1.3): voucher numbers follow
  `PV<YY>-<MM><NN>` and are unique in the database.
- **Supporting documents** (manual 4.1.2): invoices, receipts, quotations and
  reports attach to every request, up to 10 files of 10 MB.
- **Documentation trail** (Policy section 7): the audit log cannot be edited or
  deleted, and exports to CSV.
- **Reasons recorded** (manual 4.1.4): every rejection requires a written reason,
  stored with the decision.
- **Payment matching** (manual 4.1.5): the finance approver checks the voucher
  against the attached documents before approving.
- **Record keeping behaviour** (manual 1.1): nothing in the portal deletes
  approvals records today.

## 3. Change 1: Record the office each approver holds

### What the manual says

Approval power belongs to offices, not to people: Treasurer, Assistant
Treasurer, President, Vice President, Secretary. The purchase matrix (3.2) names
offices. The payment matrix (4.1.1) names offices. The Purchase Requisition Form
(Annex A, Section D) asks the approving officer to write their designation and
the date of approval.

### What the portal does today

The portal stores two lists of email addresses (`src/constants/portal.ts:156`
and `:167`). Decisions record the person's name and the time, but not the office
they hold. The printed voucher shows a name only.

### The change

Add an office label beside each email in the two lists. Store the office in new
columns on the approval item when a decision happens. Show name and office
together on the board, in the drawer, in emails and on the printed voucher, for
example "Approved by (name), Treasurer".

### Why this way

Every amount rule in the manual works by office. Changes 3 and 4 need to know
which office approved. The printed voucher then answers the audit question "who
signed this, in what role?" without a paper form. Annex A Section D becomes the
voucher print page.

## 4. Change 2: Nobody approves their own request

### What the manual says

"If the approving officer is the claimant, he/she should not approve his/her own
claims" (4.1.4). For digital payments, the maker should not be able to approve,
and the approver should not be able to create (4.4.2, 4.4.3).

### What the portal does today

The purchase approve handler (`src/worker/api/approvals.ts:1021`) only checks
that the signer holds the purchase approver flag. It never compares the signer
with the creator. Today an IT admin who creates an item is also a purchase
approver (IT admins join the purchase list automatically), so they could approve
their own request.

### The change

All four decision endpoints refuse the action when the signed-in email equals
the item's `created_by`: approve, reject, finance-approve, finance-reject. The
error message says clearly that a requestor cannot decide on their own request.

### Why this way

It is one small guard in each handler. It removes the only path in the portal
where one person could raise and approve the same money.

## 5. Change 3: Board approval for purchases above S$10,000

### What the manual says

The purchase matrix (3.2): below S$1,000 the Treasurer or Secretary approves;
S$1,000 to S$10,000 the President; above S$10,000 the Board. Annex A Section D
asks to attach or reference board minutes or email approvals where relevant.

### What the portal does today

The same two purchase approvers decide every amount. There is no board step and
nothing asks for board evidence, so a S$25,000 purchase could be approved today
with the same clicks as a S$500 one.

### The change

- Below S$10,000: keep the current behaviour. The two purchase approvers are the
  President and the 1st Vice President, so their approval already satisfies both
  lower tiers of the matrix. Blocking the Treasurer tier would add logins for no
  protection.
- Above S$10,000: the purchase approve handler refuses the click until the
  request carries a "board approval reference" (a short text such as "Board
  meeting 12 Aug 2026, item 4") and the minutes or approval email are attached.
  The form shows the rule so the admin knows before submitting.

### Why this way

The board decides outside the portal, in meetings. The portal cannot convene a
board, but it can refuse to move forward without proof. Amounts are compared
before GST, because the manual's matrices say "before GST".

## 6. Change 4: Two signatures at S$5,000 and above

### What the manual says

The payment matrix (4.1.1): below S$5,000 one signature from the Treasurer or
Assistant Treasurer is enough. S$5,000 and above needs one signer from the
President or Vice President plus one from the Treasurer or Assistant Treasurer.
Bank signatories work in the same two groups (4.3.1).

### What the portal does today

One finance approver can approve any voucher. Recurring categories (payroll,
vendor payments, office maintenance) skip the purchase stage entirely, whatever
the amount, because their items start with `approval_required = 0`
(`src/constants/portal.ts:214`, `src/worker/api/approvals.ts:504`).

### The change

Treat the two existing stages as the two signatures. The purchase stage gives
the President or Vice President signature. The finance stage gives the Treasurer
or Assistant Treasurer signature. Two rules follow:

1. At create and edit, when the amount is S$5,000 or more, `approval_required`
   switches on even for recurring categories, so both stages always run.
2. The printed voucher shows both signers with their offices when the amount is
   S$5,000 or more.

### Why this way

The portal then proves the two-group rule from its own records, with no new
stage to build. The check uses the voucher total, because the payment matrix
governs payments. The manual also allows two Group B signers when no Treasurer
is available; that fallback is a bank-level arrangement and stays out of the
portal.

## 7. Change 5: Quotation rules by amount

### What the manual says

- **Bands** (3.3 e): up to S$1,000 no quotation; S$1,000 to S$6,000 two written
  quotations; S$6,000 to S$90,000 two invitations to quote; above S$90,000 a
  tender.
- **Waiver** (3.3 j): a purchase without open quotation needs written approval
  from the approving authority, and the decision must be recorded.
- **Lowest quote** (3.3 k): the lowest quote is chosen in most cases; a dearer
  one needs a written justification in the purchase requisition form.
- **Freshness** (3.3 d): quotations must not be used after one year; a fresh
  quotation must be obtained.
- **Annex A Section B**: if no competition was obtained, provide a justification.

### What the portal does today

The comparison table is free-form. Nothing counts quotations against the amount.
The AI comparison tool needs two ticked files to run, but that is a tool limit,
not a compliance rule. Nothing captures a quotation's date.

### The change

1. At create and edit, when the amount is S$1,000 or more, the request must
   carry at least two attached quotations before it can be submitted. If two are
   genuinely not available, a required "waiver reason" box must be filled
   instead. Both paths satisfy the manual: the two-quote path directly, the
   waiver path as the recorded decision the manual asks for.
2. For S$6,000 to S$90,000 and above S$90,000, the form shows a reminder of the
   higher rule and asks for the invitations or tender as attachments. The portal
   does not block, because invitations and tenders arrive as documents rather
   than as form answers.
3. A required "why this supplier" box appears when the chosen supplier is not
   the cheapest in the comparison table.
4. Each comparison row gains an optional quotation date. When a quotation is
   older than 12 months, the board and drawer show a warning.

### Why this way

Hard blocks only where the manual is absolute (two quotes or a recorded waiver;
justification for a dearer quote). Warnings where the evidence is a document.
The quotation date rides inside the existing comparison JSON, so no new database
column is needed for it.

## 8. Change 6: Budget, conflict-of-interest and no-splitting declarations

### What the manual says

The Purchase Requisition Form (Annex A, required above S$1,000) carries:

- **Section A**: budget available for the purchase (amount), name of approving
  officer, date, plus attached minutes or emails for a pre-approved budget. And
  "ensure that there is a budget available for the purchase and be approved
  according to the Charity's authority limit before the purchase" (3.3 b).
- **Section C**: a conflict-of-interest declaration by the requestor and the
  approvers: no personal interest in any supplier, and no influence on the
  decision. Anyone with an interest must not take part (3.3 l).
- **No splitting** (3.3 c): a purchase must not be split into smaller purchases
  to stay under approval limits.

### What the portal does today

The create form has none of these three. The budget question, the conflict
declaration and the no-splitting promise exist only if the office admin prints a
paper PRF separately.

### The change

Three additions to the create and edit form, shown only when the amount is above
S$1,000:

1. A "budget approved" tick plus three small fields: budget amount, approving
   officer name, date. These are typed as text because budget approvers are not
   portal users. Attach the minutes or email for pre-approved budgets.
2. A conflict-of-interest tick: "I confirm no one raising or approving this
   request has a personal interest in any supplier."
3. A no-splitting tick: "I confirm this purchase is not part of a larger
   purchase split into smaller ones to stay under approval limits."

All three print on the voucher page.

### Why this way

Ticks and short text keep the form senior-friendly. The S$1,000 switch keeps
small purchases light, exactly as the manual's Annex A does.

## 9. Change 7: Invoice number and duplicate payment warning

### What the manual says

For e-payment, "the system should require entry of invoice/receipt number and
attachment of supporting documents ... to prevent duplicate payments" (4.1.6).

### What the portal does today

Voucher lines are free text. The payment step records method and reference, but
no invoice number, and nothing checks for repeats.

### The change

Add a required "invoice or receipt number" field at voucher submission. When the
same number already exists on another item, the API returns a clear warning and
the audit log notes the possible duplicate. The office admin sees the warning at
the payment step.

### Why this way

The manual says the number is required, so the portal requires it. The duplicate
check warns rather than blocks because some suppliers reuse numbers every month;
a human look decides. If real duplicates appear later, the check can tighten to
a block.

## 10. Change 8: Keep records for seven years

### What the manual says

The finance policy says financial records are kept a minimum of seven years. The
manual says at least five years or statutory, whichever is longer. The longest
rule wins: seven years, unless statute says more.

### What the portal does today

Nothing deletes approval items, attachments or audit rows. That behaviour is
correct.

### The change

No code. Write the seven-year rule into the feature spec and the user guide, so
a future cleanup job does not remove approvals data early. Storage grows slowly:
attachments are capped at 10 files of 10 MB per item.

## 11. What we are deliberately leaving out

- **Bank signatories and the S$100,000 per-transaction cap** (4.3, 4.4.4):
  these live on the bank's platform.
- **Bank reconciliation approval** (4.5), **journal entry approval** (6.1),
  **bad debt write-off** (2.7 d), **disposal of owned equipment** (5.5):
  accounting work with no portal feature today. Each could become a separate
  feature if SWA asks.
- **Preferred supplier list** (3.3 f): reviewed yearly by the board, outside the
  portal.

## 12. Decisions needed before building

| # | Decision | Recommendation |
|---|----------|----------------|
| 1 | Office mapping: who holds President, 1st VP, Treasurer, Assistant Treasurer | **Settled 2026-08-29**: Roxanne = President, Angela = 1st VP, YS = Treasurer, Joyce = Assistant Treasurer (detail in §12.1) |
| 2 | Above S$10,000: evidence box or a third portal stage | **Settled 2026-08-29**: evidence box plus attached minutes (detail in §12.1) |
| 3 | Two signatures: two stages count, or two finance clicks | **Settled 2026-08-29**: two stages count (detail in §12.1) |
| 4 | Quotation minimum: block without two quotes or waiver, or warn | **Settled 2026-08-29**: block (detail in §12.1) |
| 5 | Duplicate invoice number: warn or block | **Settled 2026-08-29**: warn (detail in §12.1) |
| 6 | Old quotation: warn or block | **Settled 2026-08-29**: warn (detail in §12.1) |
| 7 | Grandfathering: feature not yet in production, so no old items | **Settled 2026-08-29**: confirmed — rules apply to everything (detail in §12.1) |

Implementation runs in two batches. Batch A covers changes 1, 2, 4, 7 and 8
(rules and records; migration 012). Batch B covers changes 3, 5 and 6 (form and
evidence; migration 013). All decisions below are now settled (§12.1).

### 12.1 Settled decisions

**Decision 1 — office mapping (settled 2026-08-29).** Roxanne = President,
Angela = 1st Vice President; both sit on the purchase list. YS = Treasurer,
Joyce = Assistant Treasurer; both sit on the finance list. Production
addresses are owner-swapped at ship time, following the pattern already
commented in `src/constants/portal.ts`; this doc deliberately lists none of
them. Angela joins the purchase stage through `IT_ADMIN_EMAILS` as well as
the purchase list, so the office map covers her address once.

Local dev maps each office onto one of the five owner-controlled test
addresses (`cjtay@`, `internal@`, `system@`, `approval@`, `finance@`, all
under `singaporewomenassociation.org`). No real office-holder addresses
appear in local dev:

| Office | Local dev address | Exists today? |
|--------|-------------------|---------------|
| President | `approval@singaporewomenassociation.org` | Yes (shared test inbox, purchase list) |
| 1st Vice President | `cjtay@singaporewomenassociation.org` | Yes (IT admin, so already a purchase approver; Change 2's self-approval guard stops this identity approving its own requests) |
| Treasurer | `finance@singaporewomenassociation.org` | Yes (shared test inbox, finance list) |
| Assistant Treasurer | `internal@singaporewomenassociation.org` | Seed row exists and is login-capable; the build plan adds the address to the finance list, dev only |

No new seed rows are needed. Every office maps to an address that already
appears in the dev quick-login picker, and `internal@` lets local testing
show that either Treasurer-side office may sign the finance stage.

**Decision 2 — board approval above S$10,000 (settled 2026-08-29).** Evidence
box plus attached minutes; no third portal stage. The board evidence is
simply an uploaded PDF of the minutes (or the approval email), sitting in the
request's attachments like any other supporting document. The purchase
approve handler refuses the click until both parts are present: the short
board reference in the evidence box, and the minutes PDF among the
attachments.

**Decision 3 — two signatures at S$5,000 and above (settled 2026-08-29).**
The two existing stages count as the two signatures: the purchase stage
supplies the President/Vice President signature, the finance stage supplies
the Treasurer/Assistant Treasurer signature. No extra click. What changes:
at create and edit, amounts of S$5,000 or more switch `approval_required` on
even for recurring categories, and the printed voucher shows both signers
with their offices.

**Decision 4 — quotation minimum (settled 2026-08-29).** Block. At create
and edit, when the amount is S$1,000 or more, the API refuses the submission
until either two quotations are attached or the required waiver-reason box is
filled. One of the two must always be present; the waiver text becomes the
recorded decision the manual asks for (3.3 j).

**Decision 5 — duplicate invoice number (settled 2026-08-29).** Warn. When
the invoice or receipt number already exists on another item, the API returns
a clear warning, the audit log notes the possible duplicate, and the office
admin sees the warning at the payment step. The payment can still be
recorded, because some suppliers reuse numbers monthly. If real duplicates
appear later, the check can tighten to a block.

**Decision 6 — old quotation (settled 2026-08-29).** Warn. Each comparison
row gains an optional quotation date. When a date shows the quotation is
older than 12 months, the board and drawer display a warning that a fresh
quotation is needed (manual 3.3 d). The date is optional and typed by hand,
so a warning keeps a typo from wrongly blocking a request; the approvers
decide whether to send it back.

**Decision 7 — grandfathering (settled 2026-08-29).** Confirmed: the
approvals feature has not shipped to the board, so every item in the database
is local test data. All eight changes apply to every item from day one, with
no old-format rows to accommodate.

## 13. Next step

All seven decisions are settled (see §12.1). The detailed build plan now
exists: `docs/plans/approvals-finance-compliance-implementation-plan.md`
(Batch A: changes 1, 2, 4, 7, 8 — migration 012; Batch B: changes 3, 5, 6 —
migration 013).
