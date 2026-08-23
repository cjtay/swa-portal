# Approval Workflow — Implementation Plan (v2)

> **Status: planned, not yet implemented.** This version replaces the earlier
> draft of 23 August 2026. It reflects the owner's confirmed decisions from
> 23-24 August 2026: a two-stage approval (purchase, then finance), no
> signature pads, Jolene as office admin, a built-in comparison table, a
> full audit log, and "Save as PDF" through the browser print dialog.
> Session-by-session history lives in `progress.md`; the living architecture
> reference is `docs/ARCHITECTURE.md`.

## 1. What we are building, in plain words

Jolene (office admin) raises a request in the portal when SWA needs to buy
something: a quotation, an invoice, a reimbursement, or a recurring cost such
as office maintenance. She attaches the PDFs or photos and, when there is more
than one quotation, fills in a comparison table that links to each document.

Roxanne or Angela approves or rejects the request on the approvals board.
Recurring costs skip this stage automatically. When a request is approved,
Jolene prepares the payment voucher as an online form, pre-filled from the
request. She submits it to the finance pair, YS and Joyce.

YS or Joyce opens one screen that shows the voucher, every attachment opened
out on the page, and the comparison table. They approve or reject. A rejection
goes back to Jolene with the reason; she edits and resubmits, and it returns
to the same stage it was rejected at.

After finance approval, Jolene opens the finished voucher as a clean page and
saves it as a PDF through her browser. Lastly she records the payment: who
paid, when, and how.

Every action along the way lands in an audit log that nobody can edit or
delete. An admin can download the whole log as a CSV file for auditors.

No signatures are drawn anywhere. Names fill in automatically from whoever is
logged in, matching the June 2026 sample voucher where "Payment approved by"
shows a printed name.

## 2. Decisions confirmed by the owner

| # | Decision | Choice |
|---|---|---|
| 1 | Two approval stages | Purchase (Roxanne, Angela), then finance (YS, Joyce) |
| 2 | Office admin | Jolene raises items, prepares vouchers, exports PDF, records payment |
| 3 | Signatures | None. Login names auto-populate "Prepared by" and "Payment approved by" |
| 4 | Rejection | Never final. Jolene edits and resubmits; the item returns to the stage that rejected it |
| 5 | Comparison table | Real data Jolene types, each row linking to an attached file (not an attachment itself) |
| 6 | Voucher output | Printable page + browser "Save as PDF". No PDF library, keeping the two-dependency rule |
| 7 | Approver lists | Hardcoded in `src/constants/portal.ts`, following the membership-approver pattern. Production addresses are swapped in before go-live (owner does this) |
| 8 | Local test logins | Shared inboxes the owner controls: `approval@singaporewomenassociation.org` (Roxanne + Angela), `finance@singaporewomenassociation.org` (YS + Joyce), plus Jolene as admin |
| 9 | Audit log | Every action recorded, insert-only, CSV export |
| 10 | Approvals board | Tabs with counts, so approvers see outstanding items at a glance instead of combing email |
| 11 | Scope | Approvals flow plus the paid step ship first. Month-to-month payment view for Cecilia and Joyce is deferred until they confirm |

## 3. Roles and access

Three permission groups. All follow the existing email-list pattern from
`MEMBERSHIP_APPROVER_EMAILS` in `src/constants/portal.ts`.

- **Purchase approvers** — `APPROVAL_PURCHASE_APPROVER_EMAILS`, checked by
  `isPurchaseApprover(email)`. The union with `IT_ADMIN_EMAILS` also counts,
  so Angela (already an IT admin) is a purchase approver automatically.
- **Finance approvers** — `APPROVAL_FINANCE_APPROVER_EMAILS`, checked by
  `isFinanceApprover(email)`. IT admins are deliberately **not** added here.
  Finance approval stays with YS and Joyce only, so an IT account can never
  approve a payment voucher.
- **Item creators** — today this is the admin tier only (Jolene). The check
  lives in one helper, `canRaiseApprovalItem(session)`, because the owner may
  widen this to other members later. Widening then means changing one
  function, not hunting through handlers.

During development both lists hold the shared test addresses from §13, so
test emails reach only inboxes the owner controls.

Access rules for `/api/approvals`:

- Reads (list, detail, attachments, audit): admin, purchase approver, or
  finance approver. Ordinary committee members see nothing — this is
  financial data.
- Create, edit, voucher, record-paid, attachments: `canRaiseApprovalItem`.
- Purchase approve/reject: purchase approvers only, re-checked inside the
  handler (the membership pattern).
- Finance approve/reject: finance approvers only, re-checked inside the
  handler.
- Audit CSV export: admin only.

`GET /api/session` gains two flags, `is_purchase_approver` and
`is_finance_approver`, so the top bar can show the Approvals link to the
right people. The flags must be added to **all three** reply branches in
`session.ts` (logged-in, dev-bypass, logged-out) plus the logged-out default,
and to `SessionResponse` in `src/scripts/auth-gate.ts`. `AdminLayout.astro`
gains one nav item, "Approvals", visible when the session is admin or either
approver flag is true.

## 4. Workflow and statuses

Statuses, in order of travel:

| Status | Meaning | Who acts next |
|---|---|---|
| `pending` | Raised, waiting for purchase approval | Roxanne / Angela |
| `rejected` | Rejected at some stage. `rejected_stage` remembers which | Jolene (edit + resubmit) |
| `purchase_approved` | Purchase approved, voucher not prepared yet | Jolene |
| `finance_check` | Voucher submitted, waiting for finance | YS / Joyce |
| `finance_approved` | Voucher approved by finance | Jolene (export PDF, record payment) |
| `paid` | Payment recorded | nobody; end state |

Recurring items (office maintenance, vendor payments, payroll) start at
`purchase_approved` with `approval_required = 0`. They never email the
purchase approvers. The exported voucher shows "No approval required", as
sample voucher PV26-0611 does.

Resubmission routing: when Jolene resubmits a rejected item, the portal reads
`rejected_stage`. A purchase-stage rejection returns to `pending`; a
finance-stage rejection returns to `finance_check` with the voucher still
attached and editable. It never goes back to Roxanne for a decision she
already made.

Approve and reject use the atomic `UPDATE ... WHERE id = ? AND status = ?`
pattern from the membership handlers, so two approvers clicking at once
cannot both decide the same item.

## 5. Database

One migration, `migrations/009_approvals.sql` (next free number), backported
into `schema.sql` in the same commit so fresh local databases match
production. This follows the namecard convention from 23-08-2026.

### `approval_items`

| Column | Purpose |
|---|---|
| `id`, `created_at`, `updated_at` | Standard keys and timestamps |
| `category` | Key from `APPROVAL_CATEGORIES` in `portal.ts` |
| `title` | What the item is for, e.g. "49th SWA Charity Gala Dinner 2026" |
| `payee` | "Payable to" on the voucher |
| `requested_amount` | Optional S$ estimate, shown on the board and in email |
| `approval_required` | 1 or 0; defaults from the category, flippable per item |
| `status` | CHECK (`pending`, `purchase_approved`, `finance_check`, `finance_approved`, `rejected`, `paid`) |
| `rejected_stage` | NULL, `purchase`, or `finance`; set on rejection, cleared on resubmit |
| `purchase_decision_by`, `purchase_decision_at`, `rejection_reason` | Purchase decision |
| `voucher_no` | UNIQUE, e.g. `PV26-0801`; assigned at first voucher submission |
| `voucher_date` | Date printed on the voucher |
| `voucher_lines` | JSON text: rows of item no / date / description / amount; amounts may be negative (deposits), rows may be note-only (bank details) |
| `voucher_submitted_by`, `voucher_submitted_at` | Who submitted the voucher and when |
| `finance_decision_by`, `finance_decision_at`, `finance_rejection_reason` | Finance decision |
| `paid_by`, `paid_at`, `payment_method`, `payment_reference` | The paid step |
| `created_by` | Email of the creator (Jolene) |
| `comparison` | JSON text for the comparison table, see §6 |

Indexes: `status`, `created_at`, unique `voucher_no`.

### `approval_attachments`

| Column | Purpose |
|---|---|
| `id`, `created_at` | Standard |
| `item_id` | REFERENCES `approval_items(id)` |
| `r2_key` | UNIQUE object key under `approvals/<itemId>/` |
| `filename`, `mime_type`, `size` | For display and download headers |

Cap: 10 files per item, 10 MB per file.

### `approval_audit_log`

Insert-only. No UPDATE or DELETE endpoint exists for it, and no code path
writes anything but INSERT.

| Column | Purpose |
|---|---|
| `id`, `created_at` | Standard |
| `item_id` | REFERENCES `approval_items(id)` |
| `action` | One of the action names in §12 |
| `actor_email`, `actor_name` | Who did it, captured from the session |
| `note` | Free text: rejection reason, payment reference, reminder target |

Indexes: `item_id`, `created_at`.

### Categories

`APPROVAL_CATEGORIES` in `src/constants/portal.ts`, each with a key, label,
and `requires_approval` default: quotation, invoice, reimbursement, event
expense, office maintenance (no approval), vendor payment (no approval),
payroll (no approval), other. The create form shows an "approval required"
checkbox so Jolene can flip the default per item, because the June samples
include a reimbursement that needed no approval.

## 6. Comparison table

When SWA collects more than one quotation, Jolene types a comparison instead
of attaching a separate table. Each row is a description plus a link to one
attached file, so finance can jump straight from "Vendor B — S$1,350/table"
to that vendor's PDF.

Stored as JSON on `approval_items.comparison`:

```json
[
  { "attachmentId": 3, "description": "Grand Copthorne — $1,350/table, 25 tables" },
  { "attachmentId": 5, "description": "Hotel A — $1,480/table, 25 tables" }
]
```

Rows reference existing attachment ids. If a linked attachment is deleted
(not possible in v1 — attachments are add-only), the row renders without its
link. The finance check view shows the table with clickable links next to the
voucher.

## 7. Voucher form and numbering

The voucher mirrors the June 2026 Excel sample:

```
PAYMENT VOUCHER
Voucher No: PV26-0610          Date: 17-Jun-26
Payable to: Grand Copthorne Waterfront Hotel

Item No | Date      | Description                               | Amount
        |           | Event: 49th SWA Charity Gala Dinner 2026 |
1       | 10-Jun-26 | Chinese set dinner 25 tables x $1,350     | $36,772.50
        |           | Less: 1st deposit paid                    | -$12,139.88
        |           | DBS: Account No: 003-XXXXXXX-0            |

TOTAL PAYABLE: $24,632.62
Prepared by: Jolene Lim
Payment approved by: YS (approved 24-Aug-26)
```

Rules the form follows:

- The payee, title and amount carry across from the item; Jolene can change
  or add anything.
- Lines have a date, description and amount. Amounts may be negative ("Less:
  deposit"). Lines may omit the amount entirely (bank account notes, the
  event banner line).
- The total is the sum of all amounts; the form shows a live total so Jolene
  can see the maths before submitting.
- "Prepared by" prints the voucher submitter's session name. "Payment
  approved by" prints the finance approver's name and decision date.

Numbering: `PV<YY>-<MM><NN>`, so `PV26-0801` is the first voucher of August
2026. The portal assigns the number when Jolene first submits the voucher to
finance, using the voucher's own month (`voucher_date`). The number survives
rejection and resubmission unchanged. Two admins saving in the same second
can race for the same number; the UNIQUE index refuses the loser, and the
handler catches that error, takes the next free number and retries, up to
three times. Two digits cap the sequence at 99 per month, which the plan
accepts as sufficient for SWA's volume; the cap is stated in the UI if the
99th is reached.

## 8. API

A new file `src/worker/api/approvals.ts`, registered in
`src/worker/index.ts`. `src/worker/middleware.ts` gains one prefix set,
`/api/approvals`: entry requires admin, purchase approver, or finance
approver for **all** methods. Each handler then enforces its finer rule from
§3. (The earlier draft gated writes to admins only, which would have blocked
Roxanne's approve click at the door. This version fixes that.)

| Route | Purpose |
|---|---|
| `GET /api/approvals?status=` | List for the board tabs, with counts per status |
| `POST /api/approvals` | Multipart create: fields, files, comparison rows |
| `GET /api/approvals/:id` | Detail: lines, attachments, comparison, decisions |
| `POST /api/approvals/:id/edit` | Edit fields / add attachments; also the resubmit action (routes by `rejected_stage`) |
| `POST /api/approvals/:id/approve` | Purchase decision; emails the creator |
| `POST /api/approvals/:id/reject` | Purchase rejection with reason; emails the creator |
| `POST /api/approvals/:id/voucher` | Save and submit voucher; assigns `PV` number; status to `finance_check`; emails finance approvers |
| `POST /api/approvals/:id/finance-approve` | Finance decision; emails the creator |
| `POST /api/approvals/:id/finance-reject` | Finance rejection with reason; emails the creator |
| `POST /api/approvals/:id/paid` | Records paid_by/at, method, reference |
| `POST /api/approvals/:id/remind` | Re-sends the pending-stage email |
| `POST /api/approvals/:id/attachments` | Adds documents after creation |
| `GET /api/approvals/:id/attachment/:attId` | Streams from R2 for in-page viewing; `?download=1` forces download |
| `GET /api/approvals/audit/export` | CSV of the audit log; admin only |

Every state-changing handler writes its audit row in the same D1 batch as
the state change, so the log and the status can never disagree.

`src/worker/lib/rate-limit.ts` gains three endpoint keys (the earlier draft
forgot this file; without it the new buttons have no spam protection):

- `approvals:remind:post` — 5 per hour (emails are externally visible)
- `approvals:review:post` — 20 per hour (approve/reject, matching membership)
- `approvals:write:post` — default 10 per 15 minutes for create/edit/voucher

## 9. Uploads and file safety

The earlier draft said to copy the membership form's file checks. Those
checks accept photos only and would reject every PDF. This plan uses its own
allowlist:

- Accepted: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`,
  `image/heic`, `image/heif`.
- Never accepted: `text/html` and `image/svg+xml` (browsers can run scripts
  inside both when viewed inline), plus anything not on the list.
- Per file: 10 MB. Per item: 10 files, counted across the create and
  add-attachment endpoints.
- The stream route sends `X-Content-Type-Options: nosniff`, sets
  `Content-Disposition: inline` with a sanitised filename for viewing, and
  switches to `attachment` when `?download=1` is present.
- PDFs render in the browser's built-in viewer; images render as `<img>`.
  The finance check view uses these routes directly, so every document opens
  on the page with no downloads.

## 10. Emails

A new `src/worker/lib/email-approval.ts`, copying the structure of
`email-membership-notification.ts`: purple header, summary rows, action
button linking to `/approvals?item=<id>`.

- "New item for approval" goes to the purchase approvers when an item is
  created — only when `approval_required = 1`. Recurring items email nobody.
- "Voucher for finance check" goes to the finance approvers when a voucher
  is submitted or resubmitted after a finance rejection.
- Approve and reject decisions send a short email to the creator.
- The remind button re-sends whichever email the current stage needs. It is
  rate-limited (§8).

All mail goes through Resend from the existing
`SWA Portal <contactus@singaporewomenassociation.org>` sender, sent
non-blocking via `waitUntil` so an email failure never fails the action.

## 11. Pages

- **`src/pages/approvals.astro`** (AdminLayout): the board. Tabs — For
  approval, Approved, In finance check, Finance approved, Rejected, Paid,
  All — each with a count badge, so Roxanne sees "For approval (3)" at a
  glance. A table of voucher no, date, payee, category, amount, status. The
  detail drawer (pattern from `admin/forms/membership.astro`) shows the
  item's fields, every attachment opened out (images inline, PDFs in the
  browser viewer), the comparison table with links, the voucher lines, and
  the stage-appropriate buttons: approve/reject for the stage's approvers,
  edit + resubmit for Jolene, the voucher editor, the paid form, the remind
  button, and the link to the voucher page.
- **`src/pages/approvals/voucher.astro`**: the export page. Standalone, no
  AdminLayout (same reasoning as `login.astro` — AdminLayout would redirect
  loop). Because it stands alone it carries its own `noindex` meta, which
  AdminLayout normally provides. It reads `?id=`, fetches the item, renders
  the voucher exactly like §7, and shows one Print button that calls
  `window.print()`; print CSS hides the button. "Save as PDF" is chosen in
  the browser dialog. No PDF library, keeping the two-dependency rule.

## 12. Audit log

Every state-changing handler writes one row. Action names:

`item_created`, `purchase_approved`, `purchase_rejected`,
`item_edited`, `item_resubmitted`, `attachments_added`,
`voucher_submitted`, `finance_approved`, `finance_rejected`,
`paid_recorded`, `reminder_sent`.

The CSV export reuses the existing CSV builder (`src/worker/lib/csv.ts`)
with headers: timestamp, item id, voucher no, action, actor name, actor
email, note. Sorted oldest first, capped at 5000 rows per export.

## 13. Local testing

Three rows appended to `seed-members.sql` (dummy data, owner's mobile
+65 9323 1688 on every row, matching the existing seed policy):

| Name | Email | Category | Purpose |
|---|---|---|---|
| Purchase Approver (Roxanne/Angela test) | `approval@singaporewomenassociation.org` | committee | Stands in for both purchase approvers |
| Finance Approver (YS/Joyce test) | `finance@singaporewomenassociation.org` | committee | Stands in for both finance approvers |
| Jolene Lim (Office Admin test) | `jolene.lim@singaporewomenassociation.org` | admin | Raises items, prepares vouchers, records payment |

The members table forbids duplicate emails, so locally there is one row per
shared inbox rather than four rows; the audit log therefore reads
`approval@…` instead of naming Roxanne or Angela. Production gives each
person their own address, and the real log names people properly.

All three rows set `can_login = 1`, so the dev quick-login picker lists them
automatically. During development the approver constants hold the two shared
addresses, so test emails only reach inboxes the owner controls.

## 14. Build phases

Each phase ends with `npm run test:run`, `npm run typecheck`,
`npm run typecheck:worker` green, and a quick manual check in
`npm run dev:worker`.

**Phase 1 — Foundation.** Constants (categories, approver lists, helpers,
upload caps), migration 009, `schema.sql` backport, session flags across all
`/api/session` branches, middleware gate, rate-limit keys, seed rows. No
visible feature yet, but the portal boots with the new roles.

**Phase 2 — Items and the board.** Create endpoint with attachments,
attachment stream route, list endpoint with counts, the approvals page with
tabs and the read-only drawer (attachments inline, comparison table). Audit
log writes start here.

**Phase 3 — Purchase stage.** Approve, reject, edit, resubmit (routing by
`rejected_stage`), emails to and from the purchase approvers, remind button.
The board is now usable end to end for stage one.

**Phase 4 — Voucher and finance stage.** Voucher form with pre-fill and
live total, number assignment with retry, finance check view, finance
approve/reject, resubmission back to finance, finance emails.

**Phase 5 — Finish.** Paid step, the standalone voucher export page, audit
CSV export.

**Phase 6 — Verify and ship.** Full test suite, typecheck, build, the
manual smoke walk (§15), then owner-gated deploy steps (§16).

## 15. Manual smoke walk

With `npm run dev:worker` and the dev picker: log in as Jolene, create a
quotation item with two PDFs and a comparison table; check the email to
`approval@`; switch to the purchase login, see "For approval (1)", open the
drawer, view both PDFs on the page, approve; back as Jolene, prepare the
voucher (check negative and note-only lines, check the live total), submit;
switch to the finance login, see the voucher, all attachments and the
comparison table on one screen, approve; as Jolene, open the voucher page
and save it as a PDF, compare against the June sample; record the payment;
download the audit CSV and check every step appears. Then repeat with a
rejection at each stage to confirm resubmission routing, and create a
recurring item to confirm it skips stage one and never emails approvers.

## 16. Ship steps (owner-gated)

1. Swap the shared dev addresses in `src/constants/portal.ts` for the real
   addresses of Roxanne, Angela, YS and Joyce (owner decision; the owner
   also confirms YS's and Joyce's real emails).
2. Apply the migration to production D1:
   `wrangler d1 execute swa-portal --remote --file=migrations/009_approvals.sql`
   — never run by an agent.
3. `npm run deploy`.
4. In production, ensure Jolene has an admin-category member row with
   `can_login = 1`, and give the four approvers `can_login = 1` rows.

## 17. Deferred and open

- **Month-to-month payment view** for Cecilia and Joyce — deferred until
  they confirm they want it. The audit CSV covers part of the need.
- **How Jolene notifies the President and Treasurer about bank payments**
  (DBS app or WhatsApp) — happens outside the portal; Roxanne is still
  confirming.
- **Widening item creation beyond the office admin** — the
  `canRaiseApprovalItem` helper makes this a one-line change when wanted.
- **99-vouchers-per-month cap** — accepted; revisit only if volume grows.

## 18. Files

Create:

- `migrations/009_approvals.sql`
- `src/worker/api/approvals.ts`
- `src/worker/lib/email-approval.ts`
- `src/pages/approvals.astro`
- `src/pages/approvals/voucher.astro`
- `src/worker/api/__tests__/approvals.test.ts`

Edit:

- `schema.sql` (backport three tables)
- `src/constants/portal.ts` (approver lists, categories, upload caps)
- `src/worker/middleware.ts` (the `/api/approvals` gate)
- `src/worker/index.ts` (route registration)
- `src/worker/lib/rate-limit.ts` (three endpoint keys)
- `src/worker/api/session.ts` (both approver flags, all branches)
- `src/scripts/auth-gate.ts` (session type)
- `src/layouts/AdminLayout.astro` (nav item and visibility)
- `seed-members.sql` (three test rows)
- `docs/ARCHITECTURE.md` (same commit as the structural change)
- `progress.md` (dated entry when the work lands)
