# Membership Lifecycle — Implementation Plan

> **Status**: Phase 1 pre-work in progress. Membership form simplified + tiered fees wired (Q1–Q6, 2026-07-13). Awaiting Phase 1 build (migration 005, role rename, members UI). Phased, additive rollout — no destructive changes to production data.
> **Date planned**: 06-07-2026
> **Last updated**: 13-07-2026 (revised fee schedule, approver allowlist, form simplification per SWA review; executed form-cleanup batch Q1–Q6)
> **Replaces**: The half-built membership feature (commits `5684268`, `2f49cd0`) — 3 confusing tables, only first-year intake wired up, no renewals, no reminders.
> **Repo**: `swa-portal`

> **Date format note**: Dates in this document are shown in **Singapore format (DD-MM-YYYY)**. The database stores dates in ISO format (YYYY-MM-DD) so SQLite date functions work correctly; the UI displays them as DD-MM-YYYY.

---

## 1. The simple idea (plain English)

The current membership system uses 3 tables and 14+ columns but only first-year intake works. Renewals, reminders, overdue tracking, and auto-inactivation are **not built** — they're aspirational comments in the schema.

This plan replaces that tangle with **3 clear fields on each member's own record**, plus a simple payment log. Everything else (reminders, overdue logic, status changes) is derived from one field: the **fee due date**.

### Per-member fields

The member's **role** uses the existing `category` column (no new field needed). The old `committee` value is replaced with `exco`. A member's role is editable at any time (member ↔ exco ↔ advisor).

| Field | Meaning | Values | Editable? |
|---|---|---|---|
| `category` (existing, repurposed) | Their role — who pays, who can log in | `member`, `exco`, `advisor`, `admin`, `volunteer` | **Yes** — admin can change anytime |
| `membership_status` (new) | Are they currently a member? | `active`, `inactive` | Yes (manual + auto) |
| `fee_due_date` (new) | The single date they next need to pay by | e.g. `31-01-2027` | **Yes** — admin can change anytime |
| `fee_waived` (new) | Skip fees entirely (advisors) | `0`, `1` | Yes |

**Role changes a member can go through**: `member` → `exco` → `advisor`, or any direction. When a role changes, fee logic adjusts automatically (advisor = waived; member/exco = pays).

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
- **Role and fee are linked but not tangled**: `category` holds the role (member/exco/advisor). Advisors are auto-waived; everyone else pays. No second "class" field.
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
| Member role | **Editable by admin at any time** — member ↔ exco ↔ advisor. | Per requirement: "Role of each member can be updated/edited." |
| Role taxonomy | **Replace `committee` with `exco`** in `category`. Values: `member`, `exco`, `advisor`, `admin`, `volunteer`. | Per requirement: "They fall into category of member or exco (replace committee with exco)." |
| Registration form | **Simplify to essentials.** | Reduces friction; data not currently used. |
| Build approach | **Phased, safe rollout.** | Protects production data. |
| Who pays | `member` and `exco` pay. `advisor` is waived. `admin`/`volunteer` waived. | Per business rule. |
| First-year fee tier | **$20 if form submitted Jan–Jun; $10 if form submitted Jul–Dec.** Tier resolved from `membership_applications.created_at` (submission date), NOT from approval date or activation date. | Per 13-07-2026 review: "based on date of membership form submission date, not based on date of membership status become active." |
| Renewal fee | **$20 per year, every year.** | Per 13-07-2026 review. |
| Application default status | **`pending`** on every form submission (already the DB default on `membership_applications.status`). Stays pending until an approver acts. | Per 13-07-2026 review: "Upon submission of form, default status is Pending." |
| Approver authority | **Application approve/reject restricted to `MEMBERSHIP_APPROVER_EMAILS`** (hardcoded in `src/constants/portal.ts`, sibling of `IT_ADMIN_EMAILS`). Initial set: `angela.wong@…`, `roxanne.zhange@…`. Other admins retain member/booking CRUD but cannot approve or reject applications. | Per 13-07-2026 review: "Status can only be changed by Angela and Roxanne — configured based on email address by IT admin." |
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
| `membership_types` table | **Retire (dormant).** Fees move to KV config. |
| `membership_applications` table | **Keep.** Working intake record. Approve flow simplified. |
| `category='committee'` (17 board rows) | **Rename to `exco`.** One-time data update + login logic update. |
| Public registration form (~20 fields) | **Simplify** to essentials (see §7). |
| Approve → members row + memberships row | Approve → members row + set `fee_due_date` (next 31 January) + log payment (tier-resolved by submission month) |
| Renewals / reminders / overdue / auto-inactivate | **New** in Phase 2. |

---

## 5. Data model changes

All additive. Nothing dropped, no data transformed destructively (the `committee` → `exco` rename is a controlled, reviewed update — see §8).

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

### One-time data update: `committee` → `exco`

```sql
-- Renames the 17 board members' category. Reviewed and approved before running (see §8).
UPDATE members SET category = 'exco' WHERE category = 'committee';
```

### Login logic update (`src/worker/api/verify-otp.ts`)

The role derivation currently maps `category='committee'` → login role `committee`. Update so `category='exco'` maps to the same login tier. Advisors (`category='advisor'`) get login only if `can_login=1` (configurable per person).

### Config in `SWA_CONFIG` KV (key `swa:membership:config`)

```json
{
  "firstYearFeeBeforeJuly": 20,
  "firstYearFeeFromJuly": 10,
  "renewalFee": 20,
  "currency": "SGD",
  "reminderOffsetsDays": { "first": -30, "second": -15, "third": 0, "overdue": 15 },
  "inactiveAfterDays": 30,
  "annualAnchorMonth": 1,
  "annualAnchorDay": 31
}
```

> **Tier resolution**: at approval time, the worker inspects `MONTH(membership_applications.created_at)`. Months 1–6 → charge `firstYearFeeBeforeJuly` ($20). Months 7–12 → charge `firstYearFeeFromJuly` ($10). The PayNow QR shown on the public form must render the correct tier based on the **current** month at form load (so the applicant sees the right amount before deciding when to apply).

### Approver allowlist in `src/constants/portal.ts`

A new exported constant, sibling of `IT_ADMIN_EMAILS`:

```ts
export const MEMBERSHIP_APPROVER_EMAILS = [
  'angela.wong@singaporewomenassociation.org',
  'roxanne.zhange@singaporewomenassociation.org',
] as const;
```

The approve/reject handlers in `src/worker/api/membership-reg.ts` swap their `session.role === 'admin'` check for `MEMBERSHIP_APPROVER_EMAILS.includes(sessionEmail)`.

> **Roxanne's portal access**: to log in at all she also needs a `members` row with `category='committee'` (or `'exco'` after the §1B rename), `can_login=1`, and `deleted_at IS NULL`. Adding her email to `MEMBERSHIP_APPROVER_EMAILS` alone is not sufficient — the D1-based auth in `verify-otp.ts` requires the members row to exist. Seed her as part of Phase 1B alongside the `committee → exco` rename.

---

## 6. Phased plan

### Phase 1 — Clean data model + manual tracking (no automation)

**Goal**: a correct, simple foundation you can see and touch. Nothing automatic runs.

- [ ] **1A. Migration `005_membership_lifecycle.sql`**
  - [ ] Write migration (additive columns + payments table — see §5)
  - [ ] Test on local D1
  - [ ] Back up production D1 (`wrangler d1 export swa-portal --remote --output=backup.sql`)
  - [ ] Show migration to user for explicit approval
  - [ ] Apply to production D1
- [ ] **1B. Rename `committee` → `exco`**
  - [ ] Update `verify-otp.ts` login mapping (`exco` → committee login tier)
  - [ ] Update members page dropdown/filter (committee → exco)
  - [ ] Run the one-time `UPDATE members SET category='exco' WHERE category='committee'` on prod (after backup + approval)
  - [ ] Verify all 17 board members still log in correctly
- [ ] **1C. Seed `SWA_CONFIG` KV** with membership config (fees, offsets, anchor date)
- [ ] **1D. Seed existing members' status/fee_due_date/fee_waived**
  - [ ] Board members (`exco`) → `fee_due_date='2027-01-31'` (stored ISO), `membership_status='active'`
  - [ ] Advisors → `fee_waived=1`
  - [ ] Admin/IT accounts → `fee_waived=1`
  - [ ] Existing `category='member'` rows → `fee_due_date` set to the next 31 January (aligned with the all-members anchor)
  - [ ] **User reviews and adjusts in the UI** (not a blind bulk update)
- [ ] **1E. Members page UI — membership fields**
  - [ ] Show `category` (role), `membership_status`, `fee_due_date` (DD-MM-YYYY), `fee_waived` per member
  - [ ] **Role editable**: dropdown (member / exco / advisor) — changing to advisor auto-sets `fee_waived=1`
  - [ ] **Fee due date editable**: date picker (DD-MM-YYYY display, ISO storage)
  - [ ] `fee_waived` toggle
  - [ ] "Record payment" button → opens small form (amount, method, reference)
- [ ] **1F. Record-payment API**
  - [ ] `POST /api/members/:id/payments` → inserts `membership_payments` row, advances `fee_due_date` by 1 year, sets `membership_status='active'`
  - [ ] `GET /api/members/:id/payments` → list payment history
- [ ] **1G. Simplify approve flow** — *constant prep done 2026-07-13; handler wiring deferred until Angela/Roxanne seeded (open question §11)*
  - [x] `MEMBERSHIP_APPROVER_EMAILS` constant added to `src/constants/portal.ts` (not yet imported anywhere; includes dev-mode note about widening to cjtay@)
  - [ ] On approval: set `fee_due_date` = **next 31 January after approval** (not approval + 12 months), `category='member'`, `membership_status='active'`
  - [ ] Resolve first-year fee by **submission month** (`MONTH(membership_applications.created_at)`): 1–6 → `firstYearFeeBeforeJuly` ($20); 7–12 → `firstYearFeeFromJuly` ($10)
  - [ ] Replace `if (getSessionRole(c) !== 'admin')` gates in `handleMembershipApprove` and `handleMembershipReject` with `MEMBERSHIP_APPROVER_EMAILS.includes(sessionEmail)` — only Angela and Roxanne can transition `pending → approved` or `pending → rejected`
  - [ ] Log the initial PayNow payment in `membership_payments` with the tier-resolved amount
  - [ ] Stop writing to the old `memberships` table
- [x] **1H. Simplify public registration form** (see §7) — *form UI + tiered fees wired 2026-07-13; approve-flow tier re-check at approval time still pending (1G)*
  - [x] Remove address/NRIC/citizenship/place of birth/DOB/occupation/hobbies/skills/associations/telephone/Intent from the public form
  - [x] Referrer placeholder → "SWA Board Member"
  - [x] Replace Declaration checkbox with **PDPA consent** (also stored in D1 — migration `005_pdpa_consent.sql`, column `membership_applications.pdpa_consent`)
  - [x] Add eligibility + tiered-fee callout at top of form
  - [x] `/api/membership/config` returns tiered fees (`firstYearFeeBeforeJuly`, `firstYearFeeFromJuly`, `renewalFee`); form's QR uses the tier-resolved `fee`
  - [x] `payment_amount` tier-resolved at **submission time** (server reads current month via `resolveFirstYearFee(new Date().getMonth())`)
  - [ ] `payment_amount` tier re-check at **approval time** (deferred to 1G — server re-reads `membership_applications.created_at` month)
- [ ] **1I. Retire old table writes** — confirm no code writes `memberships` / `membership_types` (tables left dormant in DB)
- [ ] **1J. Verify** — build, typecheck, test locally, smoke-test prod after deploy

**Phase 1 deliverable**: A clean members list where each person has a clear role (editable), status, and editable fee due date. You can record payments manually. The public form is simpler. The old confusing tables are dormant. **Nothing automatic has run.**

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

This plan never deletes anything. The only non-additive change is the `committee` → `exco` rename, which is a controlled, reviewed value update.

- **All schema changes are additive** — `ADD COLUMN`, `CREATE TABLE`. Nothing dropped.
- **The `committee` → `exco` rename** is a single `UPDATE` on ~17 rows, run only after:
  1. A production D1 backup.
  2. The login-logic update is deployed (so `exco` maps to the committee login tier).
  3. Explicit approval.
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
| 06-07-2026 | Member role editable anytime (member ↔ exco ↔ advisor) | Per requirement |
| 06-07-2026 | Replace `committee` with `exco` in `category` | Per requirement; merges role into existing field, no separate class field |
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
| 13-07-2026 | Approve/reject authority restricted to **`MEMBERSHIP_APPROVER_EMAILS`** (Angela Wong, Roxanne Zhange), hardcoded in `portal.ts` | Per SWA review. Other admins retain member/booking CRUD. **Supersedes** the implicit "any admin can approve" behaviour in current code |
| 13-07-2026 | IT admin may delete members at any time (already implemented) | Per SWA review: "IT admin can delete members anytime" |
| 13-07-2026 | Recording any payment flips `inactive` → `active` and advances `fee_due_date` to next 31 Jan | Per SWA review: "If it is paid anytime later, will change back from inactive to active" |
| 13-07-2026 | Reminder cron targets **all non-waived members regardless of active/inactive status** | Per SWA review: "Inactive members will still be sent the same reminders as active members" |
| 13-07-2026 | Registration form: remove address (line 1/2/postal), NRIC, citizenship, place of birth, home/office telephone entirely | Per SWA review. Supersedes the 06-07-2026 form table that kept address + NRIC |
| 13-07-2026 | Registration form: "Recommended By" placeholder changed to **"SWA Board Member"** | Per SWA review |
| 13-07-2026 | Registration form: replace "Declaration" checkbox with a **PDPA consent** checkbox | Per SWA review: standard data-use disclaimer for processing/administering membership |
| 13-07-2026 | Registration form: add top-of-form instruction block — Singaporean/PR eligibility + fee-tier explanation | Per SWA review: "so they can decide when to apply" |
| 13-07-2026 | **Form cleanup batch (Q1–Q6) executed**: removed NRIC/address/DOB/citizenship/occupation/hobbies/skills/associations/intent/telephone from the public registration form; replaced Constitution Declaration with PDPA consent (stored in new `pdpa_consent` column via migration 005); referrer placeholder → "SWA Board Member"; added eligibility + tiered-fee callout; added `MEMBERSHIP_APPROVER_EMAILS` constant (not yet wired); extended `/api/membership/config` to return tiered fees; `payment_amount` now tier-resolved at submission by month. Tiered fees hardcoded in `portal.ts` (will migrate to KV in Batch B). | Pre-Phase-1 form hygiene per §7. No destructive schema change; removed fields stay as columns (harmless, reversible). Approver-email wiring and `exco` rename deferred (D1, D2). Tier re-check at approval time deferred to 1G. |

---

## 10. Critical gotchas

1. **`npx wrangler` is broken in the user's shell** — a zsh function intercepts it and calls a non-existent `_destructive_wrangler_check`. Work around with `./node_modules/.bin/wrangler` until the function is removed from `~/.zshrc`. (Found during Astro upgrade debugging.)
2. **Local D1 does not auto-apply migrations.** Every new migration must be applied to the local sqlite file at `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/…` manually. This caused three 500s in one session.
3. **Production D1 also drifted** — migration 003 (`deleted_at`) was never applied to prod despite shipping in commit `2f49cd0`. Treat "commit landed" ≠ "migration applied" — always verify against the target DB.
4. **The `committee` → `exco` rename must update login logic FIRST.** If the data is renamed before `verify-otp.ts` is updated, all 17 board members lose portal access. Deploy order: code first, then data.
5. **`category` now drives BOTH login and fees.** Map: `admin`/`exco` → can log in; `member` → no login by default (can_login=0); `advisor` → login only if can_login=1; `volunteer` → limited login. Fee: `member`/`exco` pay; `advisor`/`admin`/`volunteer` waived.
6. **Cloudflare Workers cron runs UTC.** `"0 8 * * *"` = 08:00 UTC = 16:00 SGT. To run at 08:00 SGT, use `"0 0 * * *"` (00:00 UTC = 08:00 SGT). Verify the cron expression fires at the intended Singapore time before relying on it.
7. **The worker has no `scheduled` handler yet.** Phase 2 changes `export default app` → `export default { fetch: app.fetch, scheduled }`. Standard Hono pattern but must be tested carefully — the cron runs in prod.

---

## 11. Open questions (to confirm before Phase 1)

- [x] **Default fee due date for existing board members** — **31-01-2027** (confirmed). Extended 13-07-2026: this anchor now applies to **all members**, not just existing board.
- [x] **Fee cycle basis** — submission date for tier resolution; 31 January each year for the due date (confirmed 13-07-2026).
- [x] **Approver authority** — Angela Wong + Roxanne Zhange via `MEMBERSHIP_APPROVER_EMAILS` (confirmed 13-07-2026).
- [x] **Renewal fee** — $20/year (confirmed 13-07-2026).
- [x] **Form fields** — address, NRIC, citizenship, place of birth, home/office telephone removed; referrer placeholder → "SWA Board Member"; PDPA checkbox replaces Declaration (confirmed 13-07-2026).
- [ ] **Which current board members are genuinely advisors** (should be `category='advisor'`, `fee_waived=1`)? The seed data has one member with "Advisor" in their `role` text — confirm who is an advisor vs. a paying exco member before the one-time rename.
- [ ] **Roxanne Zhange onboarding** — confirm her email spelling (`roxanne.zhange@…` per SWA review) and seed her as a `members` row with `category='committee'` (→ `'exco'` after §1B rename), `can_login=1`, so she can actually log in to call the approve/reject endpoints. Adding her email to `MEMBERSHIP_APPROVER_EMAILS` alone is not sufficient.
- [ ] **Auto-inactivation grace period** — plan defaults to `inactiveAfterDays: 30` (i.e. ~28-02 inactivation). The 13-07-2026 wording "after Jan" was ambiguous; confirm whether zero grace (inactivate on 01-02) or the existing 30-day grace is intended.

---

## 12. Reference: files this plan will touch

| File | Phase | Purpose |
|---|---|---|
| `migrations/005_membership_lifecycle.sql` | 1A | Additive columns + payments table |
| `src/constants/portal.ts` | 1G | New `MEMBERSHIP_APPROVER_EMAILS` constant (Angela Wong, Roxanne Zhange) |
| `src/worker/api/verify-otp.ts` | 1B | Map `category='exco'` → committee login tier |
| `src/worker/api/members.ts` | 1E, 1F | Membership fields + payment endpoints + role editing |
| `src/worker/api/membership-reg.ts` | 1G | Approve flow: tier-resolved fee by submission month; `fee_due_date` = next 31 Jan; gate approve/reject by `MEMBERSHIP_APPROVER_EMAILS`; update `/api/membership/config` to return `firstYearFeeBeforeJuly` + `firstYearFeeFromJuly` |
| `src/pages/members.astro` | 1B, 1E | Rename committee→exco in dropdown; membership UI + role/date editing |
| `src/pages/reg/membership/register.astro` | 1H | Simplify form: remove address/NRIC/citizenship/etc.; add eligibility callout + PDPA checkbox; referrer placeholder → "SWA Board Member"; render fee tier by current month |
| `src/pages/admin/forms/membership.astro` | 1G | Approve flow tweaks |
| `src/pages/admin/membership/reminders.astro` | 2E | New reminders dashboard |
| `src/worker/lib/email-membership-reminder.ts` | 2C | New reminder email templates |
| `src/worker/index.ts` | 2A | Add `scheduled` export |
| `wrangler.jsonc` | 2A | Add `triggers.cron` |
| `schema.sql` | 1A | Keep in sync with migration (documentation) |

---

*This plan is the single source of truth for the membership redesign. Update the checkboxes as work progresses.*
