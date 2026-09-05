# Approvals: Additional Requirements from the Owner Discussion

> **Date**: 2026-08-29. Handwritten notes from the owner, transcribed and
> confirmed point by point the same day.
> **Context**: the approvals feature (`docs/specs/features/approvals.md`) and
> the pending compliance plan
> (`docs/plans/approvals-finance-compliance-implementation-plan.md`, which
> records the build placement in its §17).
> **Status**: Batches A and B shipped 2026-09-05 — **R1, R4, R5, R6, R7 and
> R8 are built** (R7's column in Batch A, its checkbox UI in Batch B; R8's
> matrix printed in the feature spec and user guide). Remaining: R2, R3
> (Batch C).

## R1 to R8

| # | Requirement | What it means | Settled decisions |
|---|-------------|---------------|-------------------|
| R1 | Audit trail records every field | Every field change on an approval item is captured: field name, old value, new value, who, when. Covers create and edit | Attachments are excluded, they already have their own `attachments_added` audit rows. The audit CSV keeps its shape, the note column carries the detail |
| R2 | New view-only auditor role | A new role can open `/approvals`, see the board list, filter by the status tabs, and open the drawer and its documents | Cannot create, edit, prepare vouchers, approve, reject, pay, remind, or export. Designated by email list in `src/constants/portal.ts`, the same pattern as the approver lists. Not a new member category |
| R3 | Export the approval list, filtered by status | A new CSV export of the board list itself: one row per item with voucher number, title, payee, category, amount, status, dates and decision makers | Exports the currently open status tab. Admin and IT admin only; the auditor cannot export. Separate from the existing audit CSV, which stays as it is |
| R4 | Payment Record: remove Cheque, add GIRO | The record-payment method list (filled in after finance approval, before the status becomes paid) becomes PayNow / Bank transfer / GIRO / Cash / Other | Approvals only. The members fee-payment page keeps its current options. Nothing has shipped, so no old data needs converting |
| R5 | All payment voucher fields on the printable voucher | The voucher print (`/approvals/voucher`) shows every field captured at the voucher and payment steps | Payment method, payment reference, paid by and paid date, printed whenever present, since the voucher is printable before payment. The handwritten note wrote "payment method" above "fields" to make this explicit. Merges with the Batch A invoice line |
| R6 | Recurring categories remember the payment method | Recording payment on a payroll, vendor payment or office maintenance item pre-selects the method used on the most recent paid item in that category | Remembered by category, not by payee. The admin can still override |
| R7 | Tax Invoice marked by checkbox, always displayed first | Instead of move up and move down controls, each attached document gets a simple checkbox: "This is the Tax Invoice". The display always puts the ticked document first, then the rest | One document per item can be ticked; ticking one clears the other. One `is_tax_invoice` column on `approval_attachments`; today the order is upload order (`ORDER BY id`) |
| R8 | Approval matrix follows the SWA finance policy | The portal's approval matrix (amount bands, approval stages, who signs at each level) must match the authorisation matrix in the SWA Finance Policy, Accounting and Procedure Manual, version 2, 15 December 2024 | The pending compliance plan already implements the manual's matrix: quotations and declarations from S$1,000, both approval stages forced at S$5,000, board approval with attached evidence above S$10,000, formal tender reminder above S$90,000. R8 makes the mapping explicit: the matrix is verified against the manual, printed in the feature spec and the user guide, and the threshold constants in `src/constants/portal.ts` stay the single place the numbers live, so a future policy change is a one-file edit |

## Dropped during confirmation

- The Tax Invoice and Delivery Order upload labels at the voucher step.
- The whole "no quotation → go direct → display above the quotations" thread.

The owner confirmed the current optional upload behaviour is good enough, so
no change is needed for either.

## Build placement

Five items fold into the pending compliance Batches A and B as code changes,
R8 is a documentation rule across both batches, and two form a new Batch C.
The plan records the full detail:
`docs/plans/approvals-finance-compliance-implementation-plan.md` §17.

| Items | Where they land |
|-------|-----------------|
| R1, R6 | Batch B (create, edit and paid-form work) |
| R4, R5, R7 | Batch A (constants, paid handler, voucher print, migration 012), with the R7 checkbox UI in Batch B |
| R8 | Batches A and B documentation (matrix verified against the manual, printed in the feature spec and user guide); no new code |
| R2, R3 | Batch C (auditor role, list export) |
