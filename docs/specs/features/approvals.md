# Approval Workflow — Functional Spec

> **Status**: live (Phases 1–5 complete, 2026-08-23; not yet deployed to production)
> **Plan**: `docs/plans/Approval-Workflow-Implementation-Plan.md` (v2, owner decisions)
> **Owner decisions**: two-stage approval (purchase then finance), no signatures, office admin raises items, built-in comparison table, insert-only audit log, browser "Save as PDF".

## 1. Purpose

SWA's payment approvals in one board: the office admin (Jolene) raises a purchase request with documents; purchase approvers (Roxanne, Angela) decide; the admin prepares a payment voucher; finance approvers (YS, Joyce) check it; the admin records payment. Every action lands in an insert-only audit log exportable as CSV.

## 2. Visibility and roles

Permission groups (email lists in `src/constants/portal.ts`, on top of the base role):

| Group | Determined by | Grants |
|-------|---------------|--------|
| Purchase approvers | `APPROVAL_PURCHASE_APPROVER_EMAILS` **∪** `IT_ADMIN_EMAILS` (`isPurchaseApprover()`) | Read the board; approve/reject at the purchase stage |
| Finance approvers | `APPROVAL_FINANCE_APPROVER_EMAILS` (`isFinanceApprover()`) | Read the board; approve/reject the voucher. IT admins are **excluded by design** — an IT account can never approve a payment voucher (proven by test) |
| Item creators | `canRaiseApprovalItem()` — admin tier today | Create, edit, vouchers, record payment, remind |

Session flags `is_purchase_approver` / `is_finance_approver` reach the browser via `/api/session` and drive the Approvals nav item and board actions. Ordinary committee members have no access — financial data.

**Dev note**: the lists hold shared owner-controlled inboxes (`approval@`, `finance@singaporewomenassociation.org`) until ship time; production addresses are swapped in by the owner.

## 3. API permissions

Entry gate (middleware 7c): all `/api/approvals*` methods require admin, purchase approver, or finance approver. Handlers re-check finer rules.

| Endpoint | Method | Who beyond the entry gate | Purpose |
|----------|--------|---------------------------|---------|
| `GET /api/approvals` | GET | — | Board list + per-status counts |
| `POST /api/approvals` | POST | Item creator | Multipart create: fields, ≤10 files, comparison rows |
| `GET /api/approvals/:id` | GET | — | Detail with attachments + parsed comparison |
| `GET /api/approvals/:id/attachment/:attId` | GET | — | Stream attachment (`?download=1`); nosniff + sanitised filename |
| `POST /api/approvals/:id/approve` | POST | Purchase approver | Atomic pending → purchase_approved; emails creator |
| `POST /api/approvals/:id/reject` | POST | Purchase approver | Reason required; resubmission returns to pending |
| `POST /api/approvals/:id/edit` | POST | Item creator | Edit fields, add attachments, comparison rebuild, resubmit |
| `POST /api/approvals/:id/remind` | POST | Item creator | Re-send the waiting stage's email (pending or finance_check) |
| `POST /api/approvals/:id/voucher` | POST | Item creator | Submit/resubmit voucher; assigns PV number; → finance_check |
| `POST /api/approvals/:id/finance-approve` | POST | Finance approver only | Atomic finance_check → finance_approved; emails creator |
| `POST /api/approvals/:id/finance-reject` | POST | Finance approver only | Reason required; resubmission returns to finance_check |
| `POST /api/approvals/:id/paid` | POST | Item creator | Records who/date/method/reference; → paid |
| `GET /api/approvals/audit/export` | GET | IT admin only (owner decision 24-08-2026) | Audit CSV (oldest first, ≤5000 rows, injection-guarded). Reached from the Settings page card — no approvals-page UI |

Rate limits (per email): approve/reject at both stages 20/hour; create/edit/voucher 10 per 15 min; remind 5/hour.

## 4. Workflow

| Status | Meaning | Who acts next |
|--------|---------|---------------|
| `pending` | Raised, awaiting purchase approval | Purchase approvers |
| `rejected` | Rejected at some stage; `rejected_stage` (`purchase`/`finance`) remembers which | Item creator (edit + resubmit) |
| `purchase_approved` | Purchase approved, voucher not prepared | Item creator (prepare voucher) |
| `finance_check` | Voucher submitted, awaiting finance | Finance approvers |
| `finance_approved` | Voucher approved | Item creator (export PDF, record payment) |
| `paid` | Payment recorded | — end state |

**Rules**:
- **Recurring items** (office maintenance, vendor payment, payroll) start at `purchase_approved` with `approval_required = 0`; they never email or wait for the purchase approvers; the printed voucher shows "No approval required". Any category default can be flipped per item at creation.
- **Rejection is never final**: the creator edits and resubmits; purchase-stage → `pending`, finance-stage → straight to `finance_check` — never back to a decision already made.
- **Decisions are atomic** (`UPDATE … WHERE status = …`): two approvers clicking at once cannot both decide; the loser gets a 409.
- **Voucher numbering** `PV<YY>-<MM><NN>` from the voucher's own month (e.g. `PV26-0801`), assigned at first submission, survives rejection unchanged; UNIQUE-index retry on races; two digits cap at 99/month. Lines may carry negative amounts (deposits) and note-only rows (bank details).
- **Documents**: PDF/JPG/PNG/WebP/HEIC/HEIF, 10 MB each, 10 files per item; HTML and SVG always rejected. Files accumulate across multiple picker visits; viewed inline (iframe for PDFs).
- **Comparison table**: rows typed by the creator, each linking to one attached document.
- **Export**: standalone `/approvals/voucher?id=` renders the June-sample voucher layout for browser "Save as PDF" — no PDF library. "Prepared by" / "Payment approved by" print session names.

## 5. UI rules (`/approvals`)

| Element | Visible When |
|---------|-------------|
| Page itself + Approvals nav item | `is_admin` OR either approver flag (else redirect `/`) |
| Status tabs with count badges | Always (For approval, Approved, In finance check, Finance approved, Rejected, Paid, All) |
| New request form (incl. comparison builder) | `is_admin` only |
| Approve / Reject | Item `pending` AND `is_purchase_approver` |
| Approve voucher / Reject voucher | Item `finance_check` AND `is_finance_approver` |
| Prepare voucher / Edit voucher & resubmit | `is_admin` AND (`purchase_approved`, or `rejected` at finance stage) |
| Edit (fields) + resubmit | `is_admin` AND (`pending` or `rejected`) |
| Send reminder | `is_admin` AND (`pending` or `finance_check`) |
| Record payment | `is_admin` AND `finance_approved` |
| View voucher link | `finance_approved` or `paid` AND voucher exists |

`?item=<id>` deep link opens the drawer (the emails' target). The voucher export page is standalone — no AdminLayout, own noindex meta, print button hides when printing.

## 6. Data model (migrations 009 + 010, backported into `schema.sql`)

**`approval_items`** — one row per request:

| Column | Type | Notes |
|--------|------|-------|
| `id`, `created_at`, `updated_at` | | Standard |
| `category` | TEXT | Key from `APPROVAL_CATEGORIES` (8 categories) |
| `title`, `payee`, `description` | TEXT | Description capped 4,000 chars |
| `requested_amount` | REAL | Optional estimate |
| `approval_required` | INTEGER | Default from category, flippable per item |
| `status` | TEXT | CHECK: the six statuses above |
| `rejected_stage` | TEXT | `purchase`/`finance`; cleared on resubmit |
| `purchase_decision_by/at`, `rejection_reason` | TEXT | Name + timestamp + reason |
| `voucher_no` | TEXT | UNIQUE, `PV<YY>-<MM><NN>` |
| `voucher_date`, `voucher_lines` | TEXT | Date + JSON rows |
| `voucher_submitted_by/at` | TEXT | Name + timestamp |
| `finance_decision_by/at`, `finance_rejection_reason` | TEXT | Finance decision |
| `paid_by`, `paid_at`, `payment_method`, `payment_reference` | TEXT | The paid step |
| `created_by` | TEXT | Creator email |
| `comparison` | TEXT | JSON `[{attachmentId, description}]` |

**`approval_attachments`** — `item_id` FK, UNIQUE `r2_key` under `approvals/<itemId>/`, filename/mime/size. Add-only in v1; caps 10 files × 10 MB.

**`approval_audit_log`** — insert-only (no UPDATE/DELETE path exists). `item_id`, `action`, `actor_email`, `actor_name`, `note`. Actions: item_created, purchase_approved/rejected, item_edited, item_resubmitted, attachments_added, voucher_submitted, finance_approved/rejected, paid_recorded, reminder_sent.

## 7. Emails (`src/worker/lib/email-approval.ts`, Resend, non-blocking)

- New / resubmitted request + reminders → purchase approvers (description truncated to 500 chars).
- Voucher submitted / resubmitted / reminder → finance approvers.
- Every decision → the creator (rejections include the reason).
- Recipients are the named lists only — the IT-admin union grants authority, not mailbox traffic.

## 8. Tests

`src/worker/api/__tests__/approvals.test.ts` (integration: role gates, create validation, comparison mapping, numbering + 99-cap, race 409s, resubmit routing, IT-admin-excluded-from-finance proof, paid step, CSV) and `src/worker/lib/__tests__/email-approval.test.ts` (builders). The csv-guard tripwire watches the audit exporter.
