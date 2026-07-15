# Membership Lifecycle — Implementation Plan

> **Status**: Phase 1 **code complete** (14-07-2026) — build passes, typecheck clean. Migration written but **not yet applied to D1** (local or prod). The planned `committee→exco` rename was **dropped on 15-07-2026** — `committee` is retained. Awaiting migration apply + prod deploy. Phased, additive rollout — no destructive changes to production data.
> **Date planned**: 06-07-2026
> **Last updated**: 14-07-2026 (Phase 1 build executed: migration 005 written, approve-flow rewritten with gtw2026 patterns, members UI + payment API shipped, all docs swept)
> **Replaces**: The half-built membership feature (commits `5684268`, `2f49cd0`) — 3 confusing tables, only first-year intake wired up, no renewals, no reminders.
> **Repo**: `swa-portal`

> **Date format note**: Dates in this document are shown in **Singapore format (DD-MM-YYYY)**. The database stores dates in ISO format (YYYY-MM-DD) so SQLite date functions work correctly; the UI displays them as DD-MM-YYYY.

---

## 1. The simple idea (plain English)

The current membership system uses 3 tables and 14+ columns but only first-year intake works. Renewals, reminders, overdue tracking, and auto-inactivation are **not built** — they're aspirational comments in the schema.

This plan replaces that tangle with **3 clear fields on each member's own record**, plus a simple payment log. Everything else (reminders, overdue logic, status changes) is derived from one field: the **fee due date**.

### Per-member fields

The member's **role** uses the existing `category` column (no new field needed). The `committee` value is retained as-is. A member's role is editable at any time (member ↔ committee ↔ advisor).

| Field | Meaning | Values | Editable? |
|---|---|---|---|
| `category` (existing, repurposed) | Their role — who pays, who can log in | `member`, `committee`, `advisor`, `admin`, `volunteer` | **Yes** — admin can change anytime |
| `membership_status` (new) | Are they currently a member? | `active`, `inactive` | Yes (manual + auto) |
| `fee_due_date` (new) | The single date they next need to pay by | e.g. `31-01-2027` | **Yes** — admin can change anytime |
| `fee_waived` (new) | Skip fees entirely (advisors) | `0`, `1` | Yes |

**Role changes a member can go through**: `member` → `committee` → `advisor`, or any direction. When a role changes, fee logic adjusts automatically (advisor = waived; member/committee = pays).

### New table: `membership_payments`

A simple append-only log of every payment. One row per payment.

| Column | Purpose |
|---|---|
| `id` | Primary key |
| `member_id` | → `members(id)` |
| `paid_date` | When they paid |
| `amount` | How much (e.g. 20.00, 10.00, 20.00 renewal) |
| `method` | `paynow`, `cash`, `cheque`, `other` |
| `reference` | PayNow reference / receipt no. |
| `recorded_by` | Admin email who logged it |
| `created_at` | Row timestamp |

**Nothing more.** No complex status machines, no per-period rows, no reminder-count columns on the member.

### Why this is simpler

- **One source of truth per member**: their `fee_due_date`. All logic reads this.
- **Role and fee are linked but not tangled**: `category` holds the role (member/committee/advisor). Advisors are auto-waived; everyone else pays. No second "class" field.
- **Advisors handled cleanly**: `category='advisor'` → `fee_waived=1` automatically. No special-case logic scattered around.
- **Payment history** is a plain list you can read top-to-bottom, not a relational maze.

---

## 2. Current state (what exists today — and why we're changing)

Based on a full audit of the codebase (06-07-2026):

| Component | Status today |
|---|---|
| `memberships` table (14 columns) | **Only 1 column effectively used.** Approval flow writes one "paid" row, then it's never touched again. `reminder_count`, `last_reminder_sent`, `payment_status` (beyond 'paid') are never read or written. |
| `membership_types` table | Holds 2 fee rows ($30 first year, $20 renewal). Read by the form and approve flow. Never edited. |
| `membership_applications` table | **Working.** Stores public intake submissions. Approve/reject flow functional. |
| Public registration form | **Over-built.** ~20 fields including DOB, place of birth, citizenship, occupation, hobbies, skills. |
| Approve flow | Creates a `members` row + a `memberships` row. Works, but writes to the soon-retired table. |
| Renewal flow | **Not implemented.** No renewal form, no second-year row creation. Welcome email promises a reminder that never sends. |
| Reminder infrastructure | **Does not exist.** No cron/scheduled handler in the worker. No reminder emails. No WhatsApp. |
| Overdue / auto-inactivate | **Not implemented.** |
| Roles / categories | `category` (admin/committee/member/volunteer) controls **login**. "Advisor" exists only as free text in `members.role`. No real `advisor` or `exco` tag. |

**The 500 errors** encountered during the Astro upgrade were symptoms of this half-built state: migrations were added to `schema.sql` but never applied to local/prod D1.

---

## 3. Design decisions (locked in from requirements discussion)

| Decision | Choice | Rationale |
|---|---|---|
| Reminder channels | **Email only first** (Resend, already wired, free). WhatsApp deferred to Phase 3. | Avoids a new paid vendor until the core is proven. |
| Fee cycle (all members) | **Aligned to 31 January each year for everyone** — existing board AND new joins. New-join `fee_due_date` = next 31 January after approval (not approval + 12 months). | Per 13-07-2026 review: "All members fee due by end Jan every year." Replaces the earlier approval-anniversary model. |
| Fee due date | **Editable by admin at any time.** | Per requirement: "Due date can be edited." |
| Member role | **Editable by admin at any time** — member ↔ committee ↔ advisor. | Per requirement: "Role of each member can be updated/edited." |
| Role taxonomy | **Retain `committee`** in `category`. Values: `member`, `committee`, `advisor`, `admin`, `volunteer`. (A `committee→exco` rename was planned and later **dropped on 15-07-2026** — see decisions log.) | Per requirement, later revised: keep `committee` as the category value. |
| Registration form | **Simplify to essentials.** | Reduces friction; data not currently used. |
| Build approach | **Phased, safe rollout.** | Protects production data. |
| Who pays | `member` and `committee` pay. `advisor` is waived. `admin`/`volunteer` waived. | Per business rule. |
| First-year fee tier | **$20 if form submitted Jan–Jun; $10 if form submitted Jul–Dec.** Tier resolved from `membership_applications.created_at` (submission date), NOT from approval date or activation date. | Per 13-07-2026 review: "based on date of membership form submission date, not based on date of membership status become active." |
| Renewal fee | **$20 per year, every year.** | Per 13-07-2026 review. |
| Application default status | **`pending`** on every form submission (already the DB default on `membership_applications.status`). Stays pending until an approver acts. | Per 13-07-2026 review: "Upon submission of form, default status is Pending." |
| Approver authority | **Application approve/reject restricted to `isMembershipApprover(email)`** — the union of `MEMBERSHIP_APPROVER_EMAILS` (Angela Wong, Roxanne Zhang) **and `IT_ADMIN_EMAILS`** (cjtay, angela.wong, system), all hardcoded in `src/constants/portal.ts`. Other admins retain member/booking CRUD but cannot approve or reject applications. | Per 13-07-2026 review + 14-07-2026 update: "IT admin to be able to approve or reject membership." |
| Hard-delete authority | **IT admin can delete members at any time** (already implemented as soft-delete in `members.ts:117-147`, admin-gated via middleware). Inactive members are not auto-purged. | Per 13-07-2026 review: "IT admin can delete members anytime." |
| Auto-inactivation | After the 31-01 deadline + configurable grace window (default 30 days) if unpaid → `inactive`. | Per business rule. |
| Reactivation | Recording any payment flips `membership_status` from `inactive` → `active` and advances `fee_due_date` to the next 31 January. | Per 13-07-2026 review: "If it is paid anytime later, will change back from inactive to active." |
| Reminder targeting | **All non-waived members receive reminders, regardless of `active`/`inactive` status.** Inactive members continue to receive the same cadence as active members until they pay, get waived, or are deleted by IT admin. | Per 13-07-2026 review: "Inactive members will still be sent the same reminders as active members." |
| Date display | **Singapore format (DD-MM-YYYY)** in all UI and docs. Stored as ISO in DB. | Per requirement. |

### Reminder schedule (concrete, offsets configurable)

For a member whose fee is due **31-01-2027**:

| Date | Action |
|---|---|
| 01-01-2027 (1 month before) | Reminder email #1 |
| 16-01-2027 (~half month before) | Reminder email #2 |
| 31-01-2027 (due date) | Reminder email #3: "Due today" |
| 15-02-2027 (half month after) | Overdue email |
| 28-02-2027 (~1 month after) | **Status → `inactive` automatically** |

The 4 offsets (−1 month / −half month / 0 / +half month) and the inactivation window (+1 month) are stored in `SWA_CONFIG` KV so they can be tuned without a code release.

> **Note (13-07-2026)**: The cron loop queries **all non-waived members regardless of `membership_status`**. Once a member is auto-inactivated they do NOT drop off the reminder list — they continue to receive Reminder #1 / #2 / #3 / Overdue on the same cadence each year until they pay (which flips them back to `active`), get `fee_waived=1`, or are deleted by IT admin.

---

## 4. What we keep vs replace

| Today | New plan |
|---|---|
| `memberships` table | **Retire (dormant).** Leave the table in place — harmless. Live state moves onto `members`. |
| `membership_types` table | **Retire (dormant).** Fees hardcoded in `portal.ts` constants — no KV, no D1 lookup. |
| `membership_applications` table | **Keep.** Working intake record. Approve flow simplified. |
| `category='committee'` (17 board rows) | **Keep `committee`.** No data change. (A rename to `exco` was planned and dropped on 15-07-2026.) |
| Public registration form (~20 fields) | **Simplify** to essentials (see §7). |
| Approve → members row + memberships row | Approve → members row + set `fee_due_date` (next 31 January) + log payment (tier-resolved by submission month) |
| Renewals / reminders / overdue / auto-inactivate | **New** in Phase 2. |

---

## 5. Data model changes

All additive. Nothing dropped, no data transformed destructively. (The planned `committee` → `exco` rename was the only non-additive step; it has been dropped — see §8.)

### Migration `005_membership_lifecycle.sql` (Phase 1)

```sql
-- Additive columns on members (role uses existing `category`, repurposed)
ALTER TABLE members ADD COLUMN membership_status TEXT DEFAULT 'active';  -- values: 'active' | 'inactive' only. 'pending' lives on membership_applications.status, NOT here.
ALTER TABLE members ADD COLUMN fee_due_date TEXT;             -- stored ISO YYYY-MM-DD
ALTER TABLE members ADD COLUMN fee_waived INTEGER DEFAULT 0;

-- Append-only payment log
CREATE TABLE IF NOT EXISTS membership_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  paid_date TEXT NOT NULL,                                    -- stored ISO YYYY-MM-DD
  amount REAL NOT NULL,
  method TEXT DEFAULT 'paynow',
  reference TEXT,
  recorded_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mempay_member ON membership_payments(member_id);
CREATE INDEX IF NOT EXISTS idx_mempay_date ON membership_payments(paid_date);
```

### One-time data update: `committee` → `exco` — **DROPPED (15-07-2026)**

The planned `committee → exco` rename is no longer happening. `committee` is retained as the category value. **No data UPDATE is required** — production and seed data already use `committee`.

### Login logic (`src/worker/api/verify-otp.ts`)

The role derivation maps `category='committee'` → login role `committee` (the catch-all `else` branch, lines 115-122). Advisors (`category='advisor'`) get the same session tier, with login only if `can_login=1`. No code change was needed to retain `committee` — the login logic was never dependent on the rename.

### Config in `SWA_CONFIG` KV (key `swa:membership:config`)

> **Per 14-07-2026 SWA review**: fee amounts are **hardcoded in `src/constants/portal.ts`** — not in KV. The form reads them via `/api/membership/config`. The KV key below stores **only Phase 2 cron tuning** (reminder offsets, anchor date, inactivation window). Phase 1 does not need it.

```json
{
  "reminderOffsetsDays": { "first": -30, "second": -15, "third": 0, "overdue": 15 },
  "inactiveAfterDays": 0,
  "annualAnchorMonth": 1,
  "annualAnchorDay": 31
}
```

> **`inactiveAfterDays: 0`** — per 14-07-2026 SWA review: zero grace. Members flip to `inactive` on 01-February (the day after the 31-January deadline).

> **Tier resolution**: at approval time, the worker inspects `MONTH(membership_applications.created_at)`. Months 1–6 → charge `firstYearFeeBeforeJuly` ($20). Months 7–12 → charge `firstYearFeeFromJuly` ($10). The PayNow QR shown on the public form must render the correct tier based on the **current** month at form load (so the applicant sees the right amount before deciding when to apply).

### Approver allowlist in `src/constants/portal.ts`

A helper function that checks the union of two hardcoded lists:

```ts
export const MEMBERSHIP_APPROVER_EMAILS = [
  'angela.wong@singaporewomenassociation.org',
  'roxanne.zhang@singaporewomenassociation.org',
] as const;

export function isMembershipApprover(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    (IT_ADMIN_EMAILS as readonly string[]).includes(lower) ||
    (MEMBERSHIP_APPROVER_EMAILS as readonly string[]).includes(lower)
  );
}
```

The approve/reject handlers in `src/worker/api/membership-reg.ts` swap their `session.role === 'admin'` check for `isMembershipApprover(sessionEmail)`. Per 14-07-2026: IT admins are in the union, so they can also approve/reject.

> **Roxanne's portal access**: to log in at all she also needs a `members` row with `category='committee'`, `can_login=1`, and `deleted_at IS NULL`. Adding her email to `MEMBERSHIP_APPROVER_EMAILS` alone is not sufficient — the D1-based auth in `verify-otp.ts` requires the members row to exist. Onboarding specific individuals is an operational task outside this plan's scope.

---

## 6. Phased plan

### Phase 1 — Clean data model + manual tracking (no automation)

**Goal**: a correct, simple foundation you can see and touch. Nothing automatic runs.

- [ ] **1A. Migration `005_membership_lifecycle.sql`**
  - [x] Write migration (additive columns + payments table — see §5)
  - [x] Test on local D1 *(applied 15-07-2026 — 7 statements OK; verified columns, payments table, GET/POST/PATCH endpoints all return HTTP 200)*
  - [ ] Back up production D1 (`wrangler d1 export swa-portal --remote --output=backup.sql`)
  - [ ] Show migration to user for explicit approval
  - [ ] Apply to production D1
- [x] **1B. Retain `committee` (rename dropped)** — *15-07-2026*
  - [x] Revert dropdown/defaults/comments from `exco` back to `committee` (members.astro, members.ts, verify-otp.ts, schema.sql)
  - [x] No data UPDATE needed — production and seed data already use `committee`
  - [x] Login logic unchanged: `category='committee'` → committee session tier (catch-all in verify-otp.ts)
  - [x] *(Originally this item was a `committee→exco` rename; superseded — see decisions log 15-07-2026)*
- [ ] **1C. Seed `SWA_CONFIG` KV** with reminder **offsets + anchor date only** (Phase 2 prerequisite). **Fees are hardcoded in `portal.ts` — no KV.**
- [ ] **1D. Seed existing members' status/fee_due_date/fee_waived**
  - [ ] Board members (`committee`) → `fee_due_date='2027-01-31'` (stored ISO), `membership_status='active'`
  - [ ] Advisors → `fee_waived=1`
  - [ ] Admin/IT accounts → `fee_waived=1`
  - [ ] Existing `category='member'` rows → `fee_due_date` set to the next 31 January (aligned with the all-members anchor)
  - [ ] **User reviews and adjusts in the UI** (not a blind bulk update) — *UI is now available (1E shipped)*
- [x] **1E. Members page UI — membership fields** — *shipped 14-07-2026*
  - [x] Show `category` (role), `membership_status`, `fee_due_date` (DD-MM-YYYY), `fee_waived` per member
  - [x] **Role editable**: dropdown (member / committee / advisor) — changing to advisor auto-sets `fee_waived=1`
  - [x] **Fee due date editable**: date picker (DD-MM-YYYY display, ISO storage)
  - [x] `fee_waived` toggle
  - [x] "Record payment" button → opens small form (amount, method, reference)
- [x] **1F. Record-payment API** — *shipped 14-07-2026*
  - [x] `POST /api/members/:id/payments` → inserts `membership_payments` row, advances `fee_due_date` to next 31 Jan, sets `membership_status='active'`
  - [x] `GET /api/members/:id/payments` → list payment history
- [x] **1G. Simplify approve flow** — *rewritten 14-07-2026*
  - [x] `MEMBERSHIP_APPROVER_EMAILS` constant added to `src/constants/portal.ts`. Wired into `isMembershipApprover(email)` helper (14-07-2026) which checks `IT_ADMIN_EMAILS ∪ MEMBERSHIP_APPROVER_EMAILS`.
  - [x] On approval: set `fee_due_date` = **next 31 January after approval** (not approval + 12 months), `category='member'`, `membership_status='active'`
  - [x] Resolve first-year fee by **submission month** (`MONTH(membership_applications.created_at)`): 1–6 → `firstYearFeeBeforeJuly` ($20); 7–12 → `firstYearFeeFromJuly` ($10)
  - [x] Replace `if (getSessionRole(c) !== 'admin')` gates in `handleMembershipApprove` and `handleMembershipReject` with `isMembershipApprover(sessionEmail)` — the union of `MEMBERSHIP_APPROVER_EMAILS` and `IT_ADMIN_EMAILS` can transition `pending → approved` or `pending → rejected`
  - [x] Log the initial PayNow payment in `membership_payments` with the tier-resolved amount
  - [x] Stop writing to the old `memberships` table
- [x] **1H. Simplify public registration form** (see §7) — *form UI + tiered fees wired 2026-07-13; server-side hardening (idempotent retry, waitUntil, request_body in error_log) added 14-07-2026*
  - [x] Remove address/NRIC/citizenship/place of birth/DOB/occupation/hobbies/skills/associations/telephone/Intent from the public form
  - [x] Referrer placeholder → "SWA Board Member"
  - [x] Replace Declaration checkbox with **PDPA consent** (also stored in D1 — migration `005_pdpa_consent.sql`, column `membership_applications.pdpa_consent`)
  - [x] Add eligibility + tiered-fee callout at top of form
  - [x] `/api/membership/config` returns tiered fees (`firstYearFeeBeforeJuly`, `firstYearFeeFromJuly`, `renewalFee`); form's QR uses the tier-resolved `fee`
  - [x] `payment_amount` tier-resolved at **submission time** (server reads current month via `resolveFirstYearFee(new Date().getMonth())`)
  - [x] `payment_amount` tier re-check at **approval time** — server re-reads `membership_applications.created_at` month in `handleMembershipApprove`
  - [x] Idempotent retry on UNIQUE constraint failure (gtw2026 pattern)
  - [x] Non-blocking notification email via `c.executionCtx.waitUntil()` (gtw2026 pattern)
  - [x] `request_body` captured in `error_log` for post-incident forensics
- [x] **1I. Retire old table writes** — confirmed no code writes `memberships` / `membership_types` (tables left dormant in DB). Verified via grep 14-07-2026.
- [ ] **1J. Verify** — build ✅, typecheck ✅, test locally, smoke-test prod after deploy

**Phase 1 deliverable**: A clean members list where each person has a clear role (editable), status, and editable fee due date. You can record payments manually. The public form is simpler. The old confusing tables are dormant. **Nothing automatic has run.**

> **15-07-2026 progress**: Migration `005` applied to **local D1** and verified (columns present, payments table created, GET/POST/PATCH endpoints return HTTP 200 — no 500s). The `committee→exco` rename was **dropped** (item 1B rewritten); `committee` retained. Items 1B, 1E, 1F, 1G, 1H, 1I remain **code-complete**. Remaining: **1A** (back up prod → apply migration to prod), **1C** (Phase 2 KV seed), **1D** (seed members via UI), **1J** (smoke-test). No data UPDATE on prod is needed anymore (rename dropped).

> **14-07-2026 progress**: All Phase 1 code is written and builds clean. Items 1B (code), 1E, 1F, 1G, 1H (incl. server hardening), and 1I are **complete**. Remaining: **1A** (apply migration to D1), **1B** (run data rename on prod), **1C** (Phase 2 KV seed), **1D** (seed members via UI), **1J** (smoke-test). The gtw2026 patterns (atomic DB.batch, idempotent retry, waitUntil for emails, request_body in error_log) were adopted throughout.

### Phase 2 — Automated email reminders

**Goal**: the daily check sends the right email at the right time. Overdue members flagged. Auto-inactivation works.

- [ ] **2A. Add `scheduled()` cron handler to the worker**
  - [ ] `wrangler.jsonc`: add `triggers: { cron: ["0 8 * * *"] }` (8am daily UTC = 4pm SGT; adjust to desired SGT time — see gotcha §10)
  - [ ] Change `export default app` → `export default { fetch: app.fetch, scheduled }` (standard Hono pattern)
- [ ] **2B. Daily job logic**
  - [ ] Query **all non-waived members regardless of `membership_status`** (active AND inactive); compute days to/since `fee_due_date`
  - [ ] Match against configured offsets; send the appropriate reminder email
  - [ ] When `inactiveAfterDays` past due and unpaid → set `membership_status='inactive'` (but do NOT drop them from future reminder runs)
  - [ ] Record sends in a lightweight `membership_reminders` log table
- [ ] **2C. Email templates** (via Resend, already wired)
  - [ ] Reminder #1 (1 month before)
  - [ ] Reminder #2 (half month before)
  - [ ] Reminder #3 (due date)
  - [ ] Overdue (half month after)
  - [ ] "Now inactive" notice (at inactivation)
- [ ] **2D. Config offsets read from KV** — tuneable without redeploy
- [ ] **2E. Admin "Reminders" page**
  - [ ] See who's due/overdue in the next 30/60/90 days
  - [ ] See what reminders were sent
  - [ ] Manually trigger a reminder for a member
- [ ] **2F. Verify** — test cron locally with `wrangler dev --test-scheduled`, monitor first prod runs

**Phase 2 deliverable**: Members get the right email reminder at the right time automatically. Overdue members are flagged. Members 1 month overdue go inactive automatically.

### Phase 3 — WhatsApp (optional, later)

Not built until explicitly requested.

- [ ] **3A. Choose provider** — Twilio vs Meta WhatsApp Business API (decision deferred)
- [ ] **3B. Wire WhatsApp send** into the same reminder hooks (alongside email)
- [ ] **3C. Template approval** with the provider (WhatsApp requires pre-approved message templates)

---

## 7. Simplified registration form spec

**File**: `src/pages/reg/membership/register.astro`

### Fields on the simplified form

| Field | Status | Notes |
|---|---|---|
| Full name | **Keep** | Required |
| Email | **Keep** | Required |
| Mobile (handphone) | **Keep** | Required |
| Recommended By | **Keep** | Required. **Placeholder changed from "Name of an existing SWA member" to "SWA Board Member".** |
| PayNow screenshot | **Keep** | Optional image upload |
| Signature (draw/upload) | **Keep** | Required |
| PDPA consent checkbox | **New** | Required. Replaces the old "Declaration" checkbox. See text below. |
| Turnstile security check | **Keep** | Required |
| NRIC (last 4) | **Remove** | Column stays in DB; validation in `register.astro` and `membership-reg.ts` removed |
| Citizenship | **Remove** | Column stays in DB |
| Place of birth | **Remove** | Column stays in DB |
| Date of birth | **Remove** | Column stays in DB |
| Occupation | **Remove** | Column stays in DB |
| Hobbies / skills / associations | **Remove** | Columns stay in DB |
| Phone (home/office) | **Remove** | Columns stay in DB |
| Address line 1 | **Remove** | Column stays in DB |
| Address line 2 | **Remove** | Column stays in DB |
| Postal code | **Remove** | Column stays in DB |
| Membership intent (radio) | **Remove** | Not used downstream |

**Principle**: removed fields stay as DB columns (harmless, reversible) — we just stop collecting them on the form. The `INSERT INTO membership_applications` statement in `membership-reg.ts` continues to bind `null` for the unused columns.

### Top-of-form instruction block (new)

Rendered above the Personal Particulars section, as a callout box (reuse the existing `.mf-fee-callout` style or a sibling `.mf-eligibility-callout`):

> **Eligibility**: This membership is open to **Singapore Citizens and Singapore Permanent Residents** only.
>
> **Annual fee**: **S$20** if you apply between **January and June**; **S$10** if you apply between **July and December**. All memberships renew on **31 January** each year at **S$20**. You may wish to time your application accordingly.

The fee figure rendered in the PayNow QR card must reflect the **current month at form load** — i.e. the form checks `new Date().getMonth()` client-side and picks `firstYearFeeBeforeJuly` (months 0–5) or `firstYearFeeFromJuly` (months 6–11) from the `/api/membership/config` response. The server re-checks `MONTH(membership_applications.created_at)` at approval time as the authoritative tier (in case the applicant loaded the form in June but submitted in July).

### PDPA consent checkbox (replaces Declaration)

The previous "Declaration" checkbox (binding to the constitution) is removed. In its place, immediately before the Submit button:

> **PDPA Consent** *(required)*
>
> ☐ I consent to the Singapore Women's Association collecting, using and disclosing the personal data provided in this form for the purpose of processing and administering my membership application, in accordance with the Personal Data Protection Act (PDPA).

Form validation: submission is blocked unless this checkbox is ticked. The existing `consentChecked` state variable and `err-consent` error slot can be reused — only the label text and the surrounding section title change.

---

## 8. Production data safety (the main constraint)

This plan never deletes anything. With the `committee → exco` rename dropped (15-07-2026), **every change is now strictly additive** — no non-additive data writes remain.

- **All schema changes are additive** — `ADD COLUMN`, `CREATE TABLE`. Nothing dropped.
- **No data `UPDATE` on existing rows.** The `committee` category value is retained as-is in production and seed data. (The planned rename was the only non-additive step; it has been removed.)
- **Old tables (`memberships`, `membership_types`) stay in the database**, dormant. Nothing lost.
- **No `DROP TABLE`, no `DELETE FROM`** anywhere in this plan.
- **Before applying any migration to production**:
  1. Back up prod D1: `wrangler d1 export swa-portal --remote --output=backup-DD-MM-YYYY.sql`
  2. Apply to **local** D1 first; test there.
  3. Show the user the exact SQL statements before running on prod.
  4. Apply to prod only after explicit "go".
- **Seeding existing members' role/status/fee_due_date** happens in the admin UI (Phase 1) with the user's eyes on it — not via a blind bulk SQL update.

---

## 9. Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 06-07-2026 | Email reminders first; WhatsApp deferred to Phase 3 | Avoid new paid vendor until core is proven; Resend already wired |
| 06-07-2026 | New members' fee due date = approval date + 12 months | Per requirement: based on date of approval |
| 06-07-2026 | Existing board default fee due date = 31-01-2027 | Per requirement |
| 06-07-2026 | Fee due date editable by admin anytime | Per requirement |
| 06-07-2026 | Member role editable anytime (member ↔ committee ↔ advisor) | Per requirement |
| 06-07-2026 | Replace `committee` with `exco` in `category` | Per requirement; merges role into existing field, no separate class field. **SUPERSEDED 15-07-2026** — see below. |
| 06-07-2026 | All dates displayed Singapore format (DD-MM-YYYY) | Per requirement; stored ISO in DB for query correctness |
| 06-07-2026 | Simplify registration form to essentials | ~10 fields instead of ~20; removed fields not currently used |
| 06-07-2026 | Phased rollout, each phase reviewed before next | User caution about production data; safe by default |
| 06-07-2026 | Advisors tagged `fee_waived=1` automatically | Per business rule: "Advisor role no need to pay" |
| 06-07-2026 | Auto-inactivate 1 month after due date | Per business rule |
| 06-07-2026 | Retire `memberships`/`membership_types` as dormant (not drop) | Zero data loss; reversible if redesign needed |
| 06-07-2026 | Fee amounts + reminder offsets in KV config | Tuneable without redeploy |
| 06-07-2026 | Append-only `membership_payments` log | Simple audit trail; one row per payment |
| 13-07-2026 | First-year fee tier based on **submission date** (Jan–Jun → $20, Jul–Dec → $10), not approval/activation date | Per SWA review: applicants can choose when to apply based on the half-year pricing |
| 13-07-2026 | All members (existing board + new joins) anchored to **31 January** each year; new-join `fee_due_date` = next 31 Jan after approval | Per SWA review. **Supersedes** the 06-07-2026 "approval + 12 months" decision |
| 13-07-2026 | Renewal fee locked at **$20/year** | Per SWA review |
| 13-07-2026 | Application status defaults to `pending` on every form submission (already the DB default) | Per SWA review: "Upon submission of form, default status is Pending" |
| 13-07-2026 | Approve/reject authority restricted to **`MEMBERSHIP_APPROVER_EMAILS`** (Angela Wong, Roxanne Zhang), hardcoded in `portal.ts` | Per SWA review. Other admins retain member/booking CRUD. **Supersedes** the implicit "any admin can approve" behaviour in current code. **Updated 14-07-2026**: union expanded to include `IT_ADMIN_EMAILS` — see below. |
| 14-07-2026 | **IT admins can also approve/reject membership applications** — approver set = `isMembershipApprover(email)` = `MEMBERSHIP_APPROVER_EMAILS ∪ IT_ADMIN_EMAILS` | Per SWA review: "IT admin to be able to approve or reject membership." `isMembershipApprover()` helper added to `portal.ts`. |
| 14-07-2026 | **Fees hardcoded in `portal.ts` constants — no KV storage** | Per SWA review: "controlled by the registration form." Drops plan item 1C's fee-seeding portion. The legacy `membership_types` D1 table is dormant and no longer read. Reminder offsets (Phase 2) still go in KV. |
| 14-07-2026 | **Advisor session role = `'committee'`** (same as committee). The only difference: `fee_waived=1` permanently. | Per SWA review: "Advisor role is the same as committee role — the only difference is advisor does not need to pay." No new session tier needed. |
| 14-07-2026 | **Auto-inactivation: zero grace** — `inactiveAfterDays: 0`. Members flip to `inactive` on 01-February (day after 31-January deadline). | Per SWA review: "Option B - zero grace." |
| 14-07-2026 | **Phase 1 code build executed**: migration 005 written; `committee→exco` code changes (verify-otp, members.ts, members.astro, 9 docs); approve flow rewritten with gtw2026 patterns (atomic batch, isMembershipApprover gate, tier-resolve by submission month, next-31-Jan fee_due_date, stop writing memberships); members UI shipped (status/fee_due/waived columns, record-payment modal, edit fields); payment API endpoints; server hardening (idempotent retry, waitUntil, request_body in error_log). Build ✅ typecheck ✅. **Not yet applied to D1 or deployed.** | gtw2026 production-tested patterns adopted throughout. 19 files changed. |
| **15-07-2026** | **Keep `committee`; drop the `committee→exco` rename.** Reverted the 14-07-2026 code/doc changes that renamed the category value to `exco`. Code defaults, dropdowns, schema default, and comments now use `committee` again. **No data UPDATE needed** — prod and seed data already use `committee`. This removes the only non-additive/risky step from Phase 1 (the data `UPDATE` and its lockout hazard). | Per user decision: simpler and safer. The rename added risk (17 board members could lose login if ordered wrong) for no functional benefit. `advisor` category and `fee_waived` logic are unchanged. 18 files edited (5 code/schema + 13 docs). |
| 13-07-2026 | IT admin may delete members at any time (already implemented) | Per SWA review: "IT admin can delete members anytime" |
| 13-07-2026 | Recording any payment flips `inactive` → `active` and advances `fee_due_date` to next 31 Jan | Per SWA review: "If it is paid anytime later, will change back from inactive to active" |
| 13-07-2026 | Reminder cron targets **all non-waived members regardless of active/inactive status** | Per SWA review: "Inactive members will still be sent the same reminders as active members" |
| 13-07-2026 | Registration form: remove address (line 1/2/postal), NRIC, citizenship, place of birth, home/office telephone entirely | Per SWA review. Supersedes the 06-07-2026 form table that kept address + NRIC |
| 13-07-2026 | Registration form: "Recommended By" placeholder changed to **"SWA Board Member"** | Per SWA review |
| 13-07-2026 | Registration form: replace "Declaration" checkbox with a **PDPA consent** checkbox | Per SWA review: standard data-use disclaimer for processing/administering membership |
| 13-07-2026 | Registration form: add top-of-form instruction block — Singaporean/PR eligibility + fee-tier explanation | Per SWA review: "so they can decide when to apply" |
| 13-07-2026 | **Form cleanup batch (Q1–Q6) executed**: removed NRIC/address/DOB/citizenship/occupation/hobbies/skills/associations/intent/telephone from the public registration form; replaced Constitution Declaration with PDPA consent (stored in new `pdpa_consent` column via migration 005); referrer placeholder → "SWA Board Member"; added eligibility + tiered-fee callout; added `MEMBERSHIP_APPROVER_EMAILS` constant (not yet wired); extended `/api/membership/config` to return tiered fees; `payment_amount` now tier-resolved at submission by month. Tiered fees hardcoded in `portal.ts`. | Pre-Phase-1 form hygiene per §7. No destructive schema change; removed fields stay as columns (harmless, reversible). Approver-email wiring and `exco` rename deferred (D1, D2). Tier re-check at approval time deferred to 1G. |

---

## 10. Critical gotchas

1. **`npx wrangler` is broken in the user's shell** — a zsh function intercepts it and calls a non-existent `_destructive_wrangler_check`. Work around with `./node_modules/.bin/wrangler` until the function is removed from `~/.zshrc`. (Found during Astro upgrade debugging.)
2. **Local D1 does not auto-apply migrations.** Every new migration must be applied to the local sqlite file at `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/…` manually. This caused three 500s in one session.
3. **Production D1 also drifted** — migration 003 (`deleted_at`) was never applied to prod despite shipping in commit `2f49cd0`. Treat "commit landed" ≠ "migration applied" — always verify against the target DB.
4. **~~The `committee` → `exco` rename must update login logic FIRST.~~** *(Gotcha retired 15-07-2026 — the rename was dropped. `committee` is retained, so there is no ordering hazard.)*
5. **`category` drives BOTH login and fees.** Map: `admin`/`committee` → can log in; `member` → no login by default (can_login=0); `advisor` → login only if can_login=1; `volunteer` → limited login. Fee: `member`/`committee` pay; `advisor`/`admin`/`volunteer` waived.
6. **Cloudflare Workers cron runs UTC.** `"0 8 * * *"` = 08:00 UTC = 16:00 SGT. To run at 08:00 SGT, use `"0 0 * * *"` (00:00 UTC = 08:00 SGT). Verify the cron expression fires at the intended Singapore time before relying on it.
7. **The worker has no `scheduled` handler yet.** Phase 2 changes `export default app` → `export default { fetch: app.fetch, scheduled }`. Standard Hono pattern but must be tested carefully — the cron runs in prod.

---

## 11. Open questions (to confirm before Phase 1)

- [x] **Default fee due date for existing board members** — **31-01-2027** (confirmed). Extended 13-07-2026: this anchor now applies to **all members**, not just existing board.
- [x] **Fee cycle basis** — submission date for tier resolution; 31 January each year for the due date (confirmed 13-07-2026).
- [x] **Approver authority** — Angela Wong + Roxanne Zhang via `MEMBERSHIP_APPROVER_EMAILS`, **plus IT admins via `IT_ADMIN_EMAILS`** (confirmed 14-07-2026). `isMembershipApprover()` helper checks the union.
- [x] **Renewal fee** — $20/year (confirmed 13-07-2026).
- [x] **Form fields** — address, NRIC, citizenship, place of birth, home/office telephone removed; referrer placeholder → "SWA Board Member"; PDPA checkbox replaces Declaration (confirmed 13-07-2026).
- [ ] **Which current board members are genuinely advisors** (should be `category='advisor'`, `fee_waived=1`)? The seed data has one member with "Advisor" in their `role` text — confirm who is an advisor vs. a paying committee member.
- [x] **Roxanne Zhang's email** — confirmed `roxanne.zhang@singaporewomenassociation.org` (14-07-2026). Onboarding specific individuals (creating their `members` row) is an operational task outside this plan's scope.
- [x] **Auto-inactivation grace period** — **zero grace** (`inactiveAfterDays: 0`). Members flip to inactive on 01-February (confirmed 14-07-2026).
- [x] **Advisor session role** — same as committee (`role='committee'`); the only difference is `fee_waived=1` permanently (confirmed 14-07-2026).
- [x] **Fee storage** — hardcoded in `portal.ts` constants; **no KV** (confirmed 14-07-2026).

---

## 12. Reference: files this plan will touch

| File | Phase | Purpose |
|---|---|---|
| `migrations/005_membership_lifecycle.sql` | 1A | Additive columns + payments table |
| `src/constants/portal.ts` | 1G | `MEMBERSHIP_APPROVER_EMAILS` constant + `isMembershipApprover()` helper (Angela Wong, Roxanne Zhang + IT_ADMIN_EMAILS union) |
| `src/worker/api/verify-otp.ts` | 1B | Catch-all maps `category='committee'` (and `advisor`, `member`) → committee login tier. *(No rename — committee retained.)* |
| `src/worker/api/members.ts` | 1E, 1F | Membership fields + payment endpoints + role editing |
| `src/worker/api/membership-reg.ts` | 1G | Approve flow: tier-resolved fee by submission month; `fee_due_date` = next 31 Jan; gate approve/reject by `MEMBERSHIP_APPROVER_EMAILS`; update `/api/membership/config` to return `firstYearFeeBeforeJuly` + `firstYearFeeFromJuly` |
| `src/pages/members.astro` | 1B, 1E | Membership UI + role/date editing. Dropdown uses `committee` (retained). |
| `src/pages/reg/membership/register.astro` | 1H | Simplify form: remove address/NRIC/citizenship/etc.; add eligibility callout + PDPA checkbox; referrer placeholder → "SWA Board Member"; render fee tier by current month |
| `src/pages/admin/forms/membership.astro` | 1G | Approve flow tweaks |
| `src/pages/admin/membership/reminders.astro` | 2E | New reminders dashboard |
| `src/worker/lib/email-membership-reminder.ts` | 2C | New reminder email templates |
| `src/worker/index.ts` | 2A | Add `scheduled` export |
| `wrangler.jsonc` | 2A | Add `triggers.cron` |
| `schema.sql` | 1A | Keep in sync with migration (documentation) |

---

*This plan is the single source of truth for the membership redesign. Update the checkboxes as work progresses.*
