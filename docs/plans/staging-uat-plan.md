# Staging UAT — Approval workflow (2026-09-06)

> **Status**: prepared 2026-09-06 for the staging UAT round covering the
> finance-policy compliance batches (A/B/C) and the 2026-09-06 owner policy
> updates (small-purchase authority, declarations offline, board-document
> upload, voucher stage stamp). Email draft, test matrix and pre-deploy
> action items for owner review.

## 1. Feature snapshot (what testers will see)

- **Two-stage workflow**: Request → **Purchase stage** (Roxanne/Angela) →
  office admin prepares the payment voucher → **Finance stage** (YS/Joyce) →
  record payment. Statuses: For approval → Approved → In finance check →
  Approved — awaiting payment / Paid / Rejected (voucher print carries a
  stage stamp so two printouts from different stages are never confused).
- **Money rules** (Finance Policy manual, thresholds live only in
  `src/constants/portal.ts`):
  - **< S$1,000** — finance approvers (Treasurer/Assistant Treasurer) may
    also sign the purchase stage (policy §3.2 "Below $1000").
  - **≥ S$5,000** — two-stage approval forced on; the checkbox locks with a
    hint.
  - **≥ S$10,000** — board approval reference **plus a flagged board
    document upload** (minutes or approval email) required before the
    purchase stage can be approved.
  - S$6,000 / S$90,000 — form reminders to invite committee review / tender.
- **Documents**: at least one file when approval is required; caps 10 files
  × 10 MB; PDF/JPG/PNG/WebP/HEIC/HEIF. One file can be ticked as *the* Tax
  Invoice (renders first); the board document renders last (owner request
  2026-09-06). Optional comparison table with quotation dates and a
  12-month staleness warning.
- **Guards**: self-approval ban, IT admins can never finance-approve,
  field-level audit trail (R1), remembered payment method (R6), CSV export
  (R3), view-only auditor role (R2).
- **Categories**: Quotation / Invoice / Reimbursement / Event expense /
  Other (approval required by default); Office maintenance / Vendor payment
  / Payroll (approval off by default — no approver emails).
- **Declarations offline**: budget, cheapest supplier, quotation waiver,
  conflict of interest and no-splitting evidence stay on the paper Purchase
  Requisition Form (manual Annex A) — not in the portal.

## 2. Draft email to testers

> **To:** Roxanne.Zhang@singaporewomenassociation.org,
> Angela.Wong@singaporewomenassociation.org,
> Wong.YS@singaporewomenassociation.org,
> Joyce.Yeo@singaporewomenassociation.org,
> Jolene.Lim@singaporewomenassociation.org
> **Subject:** Payment approval feature — ready for your testing on staging
>
> Hi all,
>
> The new payment approval workflow is ready for testing on our staging
> server:
> **https://swa-portal-staging.cjtay-4e0.workers.dev**
>
> Log in with your @singaporewomenassociation.org email — you'll receive a
> one-time passcode by email (check spam if it doesn't arrive).
>
> **Your role in the flow:**
> - **Roxanne & Angela** — purchase approvers: approve or reject requests
>   (all amounts)
> - **YS & Joyce** — finance approvers: final check on payment vouchers;
>   for requests **under S$1,000** either of you may also sign the purchase
>   stage directly
> - **Jolene** — office admin: create requests, prepare the payment voucher
>   after approval, record payment *(please confirm this is right)*
>
> **Key rules to try:** under S$1,000 (Treasurer can sign alone), S$5,000+
> (two signatures forced), S$10,000+ (board minutes upload + reference
> required). One file must be ticked as the Tax Invoice. Declarations now
> stay on the paper Purchase Requisition Form (Annex A) — not in the portal.
>
> A short test checklist is attached — please walk through the scenarios for
> your role and reply with anything that looks wrong by **[date]**.
>
> Many thanks,
> CJ

## 3. Basic UAT test matrix

| # | Scenario | Amount | Creator | Purchase decision | Finance decision | Expected result |
|---|----------|--------|---------|-------------------|------------------|-----------------|
| 1 | Happy path, small purchase | S$100 | Jolene (1 receipt, tick Tax Invoice) | Roxanne **or** YS can Approve | Other finance signer approves voucher; Jolene records payment | Status ends **Paid**; voucher stamp updates each stage |
| 2 | Self-approval ban | S$800 | Roxanne creates | Roxanne tries to approve own | — | No Approve/Reject buttons for the creator; request waits for Angela |
| 3 | Mid amount | S$2,500 | Jolene (2 quotes + comparison) | Roxanne/Angela only — **YS/Joyce see no buttons at this stage** | YS/Joyce approve voucher | Finance pair excluded from the purchase stage at S$1,000+ |
| 4 | Two-stage forced | S$6,000 | Jolene | "Approval required" checkbox locked on with hint | Both-stage flow as normal | Cannot un-tick approval at ≥ S$5,000 |
| 5 | Board guard + display order | S$12,000 | Jolene (2 quotes + board minutes) | Approve **fails (409)** until reference + flagged board doc entered; board doc renders **last** in drawer, Tax Invoice first | Normal | Guard message mentions the board approval document |
| 6 | No-approval item | S$3,000 payroll | Jolene, approval un-ticked | — (nobody emailed) | — | Lands directly in the **Approved** tab |
| 7 | Purchase rejection | any pending | Jolene | Angela rejects with reason | — | Jolene gets the email; edits & resubmits; back to For approval |
| 8 | Voucher rejection | after voucher | — | — | YS rejects voucher with reason | Jolene edits voucher & resubmits |
| 9 | Reminder | any pending | — | Admin clicks Send reminder | — | Approver(s) receive the reminder email |
| 10 | Attachment limits | — | try an 11th file, a >10 MB file, a .docx | — | — | Each rejected with a clear message |
| 11 | View-only / export | — | — | — | — | Auditor sees the board read-only; CSV export opens |

## 4. Action items before sending / deploying to staging

1. **Revert the uncommitted `portal.ts` email toggles** — the production
   approver addresses (Roxanne, Angela, YS, Joyce) are currently commented
   out, so none of the five testers would have decision rights on staging.
   Reverting also turns the 5 failing `notify-recipients` tests green; the
   full suite must pass before `npm run deploy:staging`.
2. **Deploy current code to staging** — staging still runs the 2026-09-05
   morning build and is missing Batches A–C plus the 2026-09-06 policy
   changes. (`npm run deploy:staging`; staging D1 migrations 012–014
   applied 2026-09-06 ✓)
3. **Verify staging secrets** — `RESEND_API_KEY`, `OTP_SECRET`,
   `SESSION_SECRET` set on the staging worker; `SESSION_SECRET` must NOT
   start with `local-dev-` or all notification emails are redirected to
   safe inboxes instead of reaching the testers.
4. **Seed the five testers in staging D1** with `can_login=1` (staging DB
   is separate from production), plus decide Jolene's role (admin =
   voucher preparation).
5. **Add office labels** for the real addresses in `APPROVAL_OFFICE_LABELS`
   (currently only the dev addresses are mapped — Roxanne = President?
   Angela = Secretary? YS = Treasurer? Joyce = Assistant Treasurer?). These
   appear beside names in drawers, emails and the voucher print.
6. **Confirm the category list** and which categories default to
   approval-required (§1 above).
7. **Confirm the three thresholds** (S$1,000 / S$5,000 / S$10,000) against
   the Finance Policy manual v15 Dec 2024.
8. **Confirm Jolene's role line** in the email before sending.
