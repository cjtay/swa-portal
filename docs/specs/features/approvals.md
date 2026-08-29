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
| `POST /api/approvals` | POST | Item creator | Multipart create: fields, ≤10 files, comparison rows. ≥1 file required when `approvalRequired` resolves true (400 otherwise) |
| `GET /api/approvals/:id` | GET | — | Detail with attachments + parsed comparison |
| `GET /api/approvals/:id/attachment/:attId` | GET | — | Stream attachment (`?download=1`); nosniff + sanitised filename |
| `POST /api/approvals/:id/approve` | POST | Purchase approver | Atomic pending → purchase_approved; emails creator |
| `POST /api/approvals/:id/reject` | POST | Purchase approver | Reason required; resubmission returns to pending |
| `POST /api/approvals/:id/edit` | POST | Item creator | Edit fields, add attachments, comparison rebuild, AI summary/recommendation text edits, resubmit |
| `POST /api/approvals/:id/remind` | POST | Item creator | Re-send the waiting stage's email (pending or finance_check) |
| `POST /api/approvals/:id/voucher` | POST | Item creator | Submit/resubmit voucher; assigns PV number; → finance_check |
| `POST /api/approvals/:id/finance-approve` | POST | Finance approver only | Atomic finance_check → finance_approved; emails creator |
| `POST /api/approvals/:id/finance-reject` | POST | Finance approver only | Reason required; resubmission returns to finance_check |
| `POST /api/approvals/:id/paid` | POST | Item creator | Records who/date/method/reference; → paid |
| `POST /api/approvals/analyse-preview` | POST | Item creator | Form-time AI comparison of the ticked quotation files (multipart). Stores nothing; the result is replayed to `POST /api/approvals` as `aiComparison`. Guards: kill-switch 503, daily cap 429, ≥2 files, same MIME allowlist |
| `POST /api/approvals/:id/analyse` | POST | Item creator | Regenerates the AI comparison from the item's ticked comparison attachments (R2), stores it in `ai_comparison`, writes an `ai_comparison_generated` audit row. Reached only from the edit form (owner decision 26-08-2026 — the drawer Regenerate button was removed); refuses non-editable items with 409, matching the fields-freeze rule. Same guards |
| `GET /api/approvals/audit/export?from=YYYY-MM-DD&to=YYYY-MM-DD` | GET | IT admin only (owner decision 24-08-2026) | Audit CSV for the required date range (both days inclusive, UTC; oldest first, ≤5000 rows, injection-guarded). Missing/inverted ranges → 400. Reached from the Settings page card — no approvals-page UI |

Rate limits (per email): approve/reject at both stages 20/hour; create/edit/voucher 10 per 15 min; remind 5/hour; AI analyse (both endpoints) 10/hour plus a portal-wide cap of 50 analyses/day (KV counter, resets 00:00 UTC with the free Workers AI allowance); read endpoints (board list, item detail, attachment streaming, audit CSV) 60 per minute.

AI comparison kill-switch: IT admins toggle it in Settings (`swa:ai_config`, served by `POST /api/admin/settings`). Missing key = enabled. Both analyse endpoints return 503 `FEATURE_DISABLED` while off, and `/api/session` reports `ai_comparison_enabled: false` so the page hides the Analyse buttons and shows a "disabled by IT admin" note. Creating a request never calls AI, so submission works while the feature is off.

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
- **Rejection is never final**: purchase-stage rejection returns the item to `pending` for an edit + resubmit; finance-stage rejection returns it to `finance_check` through the **voucher** resubmit only — never back to a decision already made.
- **Fields freeze at purchase approval**: once purchase has approved an item, its title, payee, amount and attachments are locked. Corrections after a finance rejection go through the voucher editor, not the item edit form.
- **Decisions are atomic** (`UPDATE … WHERE status = …`): two approvers clicking at once cannot both decide; the loser gets a 409. The audit row is written only when the state change wins, so a lost race never records a false decision.
- **Voucher numbering** `PV<YY>-<MM><NN>` from the voucher's own month (e.g. `PV26-0801`), assigned at first submission, survives rejection unchanged; UNIQUE-index retry on races; two digits cap at 99/month. Lines may carry negative amounts (deposits) and note-only rows (bank details).
- **Documents**: PDF/JPG/PNG/WebP/HEIC/HEIF, 10 MB each, 10 files per item; HTML and SVG always rejected. **At least one document is required whenever approval is required** (owner decision 29-08-2026 — approvers decide remotely from the uploaded files; enforced client-side and by a 400 from the create endpoint). Recurring items (`approval_required = 0`) may be paperless: payroll, standing vendor payments and GIRO deductions often have no quotation or invoice. Files accumulate across multiple picker visits; viewed inline (iframe for PDFs). A create/edit request is one POST, so `wrangler.jsonc` caps the whole body at 110 MB (raised from 20 MB on 2026-08-28 — the old cap 413-rejected legitimate multi-file uploads before the per-file limits could run; effective ceiling is also the plan's ~100 MB free-plan body limit).
- **Comparison table**: rows typed by the creator, each linking to one attached document.
- **AI quotation comparison** (2026-08-26, `docs/plans/AI-Quotation-Comparison-Plan.md`): Workers AI reads the ticked quotations (PDF text via `toMarkdown`, photos via a vision model), extracts vendor/item/prices/currency/GST/validity/lead time per document, converts prices to S$ **in code** from a daily KV-cached FX table (open.er-api.com), then a text model writes a 3–4 sentence summary and a one-line value-based recommendation. Unreadable files (scanned PDFs, unsupported types) get per-file notes, never silent skips; Cloudflare reader edge failures (e.g. error 1031) surface as a friendly "usually temporary — run Analyse again" note (2026-08-27). HEIC photos are converted to JPEG in the browser at pick time. Every result carries the label "AI-generated — verify against the original documents". Single-attempt AI calls with 30 s timeouts; no automatic retries anywhere.
- **AI texts are editable fields** (owner decision 26-08-2026): the summary and recommendation render as textareas in the create-form preview and in the edit form, so the admin can correct the AI wording before approval. They ride the same UPDATE as every other field, so they freeze at purchase approval like title/payee/amount, and the create endpoint stores whatever edited values the form replays.
- **Export**: standalone `/approvals/voucher?id=` renders the June-sample voucher layout for browser "Save as PDF" — no PDF library. "Prepared by" / "Payment approved by" print session names.

## 5. UI rules (`/approvals`)

| Element | Visible When |
|---------|-------------|
| Page itself + Approvals nav item | `is_admin` OR either approver flag (else redirect `/`) |
| Status tabs with count badges | Always (For approval, Approved, In finance check, Finance approved, Rejected, Paid, All). Default tab: **All** |
| "New request" button | `is_admin` only. The board table leads the page; the form opens on demand and collapses on Cancel or successful submit (owner decision 25-08-2026) |
| Column sorting | Every data column header clicks to sort (again to reverse; dates start newest-first, text A→Z). Browser-side; empty values always sink last |
| Pagination | Browser-side, 20 rows per page, under the table; resets to page 1 on tab or sort change |
| Approve / Reject | Item `pending` AND `is_purchase_approver` |
| Approve voucher / Reject voucher | Item `finance_check` AND `is_finance_approver` |
| Prepare voucher / Edit voucher & resubmit | `is_admin` AND (`purchase_approved`, or `rejected` at finance stage) |
| Edit (fields) + resubmit | `is_admin` AND (`pending`, or `rejected` at the purchase stage) |
| Send reminder | `is_admin` AND (`pending` or `finance_check`) |
| Record payment | `is_admin` AND `finance_approved` |
| View voucher link | `finance_approved` or `paid` AND voucher exists |
| Analyse with AI (form) | Comparison builder visible AND ≥2 ticked quotations AND `ai_comparison_enabled`. Button locks while a run is in flight; any change to the chosen files or ticks invalidates the preview |
| AI comparison block (drawer) | Stored analysis exists — read-only for every role |
| Analyse with AI (edit form, the only regeneration path) | `is_admin` AND item editable (pending, or rejected at purchase stage) AND ≥2 comparison rows AND `ai_comparison_enabled` |
| AI toggle card (Settings) | IT admin only |
| User guide page `/approvals/guide` + "user guide" link in the board intro | Same audience as the board (admin or either approver flag; others redirect `/`). Role chapters with screenshots from `public/guide/approval/`; print-friendly |

`?item=<id>` deep link opens the drawer (the emails' target). The drawer shows "Purchase approved by / Approved at (SG)" whenever an approval decision exists, or "Purchase decision by / Decided at (SG)" when the purchase decision was a rejection (fixed 2026-08-28 — the approved label previously showed on rejected items too). This makes approvers visible from `finance_check` onwards. The voucher export page is standalone — no AdminLayout, own noindex meta, print button hides when printing.

**Senior-friendly UI conventions** (2026-08-28, CSS-only pass, browser-verified at 1200 px and 375 px across admin and both approver roles):
- Field labels render as quiet grey small-caps captions (12 px) against 16 px weight-600 dark values, in the detail list and every form; a hairline divider closes each label/value pair.
- Tap targets are at least 40 px tall (pagination, View, Remove, drawer close ×, all form buttons); checkboxes are 20 px with `flex-shrink: 0` so long labels cannot squeeze them.
- Form inputs render at 16 px, so Safari on iPhone does not auto-zoom the page when a field is tapped.
- The board table keeps body text at 14.4 px on phones (page-level override of the shared admin.css shrink); a scrolling-shadow fade hints at more columns and disappears when fully scrolled; `contain: paint` stops the table's sideways overflow from panning the whole page (measured 633 px of phantom page width before the fix).
- Drawer tables (voucher, comparison, AI) use the responsive-table pattern (`display: block` + `overflow-x`): a wide table pans inside its own border box, so the AI summary and nearby cards never slide, and the drawer itself cannot be dragged sideways leaving an empty band.
- Small grey text uses #4b5563; focus-visible rings cover the Remove buttons and checkboxes.

## 6. Data model (migrations 009 + 010 + 011, backported into `schema.sql`)

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
| `ai_comparison` | TEXT | Nullable JSON: the AI analysis (version, generated at/by, models, FX date, per-file status notes, extracted quotations with S$ conversions, summary, recommendation). Added migration 011 |

**`approval_attachments`** — `item_id` FK, UNIQUE `r2_key` under `approvals/<itemId>/`, filename/mime/size. Add-only in v1; caps 10 files × 10 MB.

**`approval_audit_log`** — insert-only (no UPDATE/DELETE path exists). `item_id`, `action`, `actor_email`, `actor_name`, `note`. Actions: item_created, purchase_approved/rejected, item_edited, item_resubmitted, attachments_added, voucher_submitted, finance_approved/rejected, paid_recorded, reminder_sent, ai_comparison_generated.

## 7. Emails (`src/worker/lib/email-approval.ts`, Resend, non-blocking)

- New / resubmitted request + reminders → purchase approvers (description truncated to 500 chars).
- Voucher submitted / resubmitted / reminder → finance approvers.
- Every decision → the creator (rejections include the reason).
- Recipients are the named lists only — the IT-admin union grants authority, not mailbox traffic.

## 8. Tests

`src/worker/api/__tests__/approvals.test.ts` (integration: role gates, create validation — including the ≥1-document rule for approval-required items — comparison mapping, numbering + 99-cap, race 409s, resubmit routing, IT-admin-excluded-from-finance proof, paid step, CSV with date-range filter + 400 guards, AI-analysis replay at create) and `src/worker/lib/__tests__/ai-comparison.test.ts` (pipeline against a fake AI binding — JSON extraction, S$ conversion maths, kill-switch default, daily breaker, per-file skip/error notes, endpoint guards that return before any AI call). The csv-guard tripwire watches the audit exporter.
