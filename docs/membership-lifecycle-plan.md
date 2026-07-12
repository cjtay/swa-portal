# Membership Lifecycle — Implementation Plan

> **Status**: Planning complete. Awaiting Phase 1 build. Phased, additive rollout — no destructive changes to production data.
> **Date planned**: 06-07-2026
> **Last updated**: 07-07-2026
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
| `amount` | How much (e.g. 30.00, 20.00) |
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
| Fee cycle for new members | **Based on approval date.** Fee due date = approval date + 12 months. Stays on that anniversary forever. | Per requirement: "Newly registered members based on the date of approval to become active member." |
| Fee cycle for existing board | **End of January each year.** Default set to **31-01-2027**. | Per requirement: "Existing board members default fee due date 31-01-2027." |
| Fee due date | **Editable by admin at any time.** | Per requirement: "Due date can be edited." |
| Member role | **Editable by admin at any time** — member ↔ exco ↔ advisor. | Per requirement: "Role of each member can be updated/edited." |
| Role taxonomy | **Replace `committee` with `exco`** in `category`. Values: `member`, `exco`, `advisor`, `admin`, `volunteer`. | Per requirement: "They fall into category of member or exco (replace committee with exco)." |
| Registration form | **Simplify to essentials.** | Reduces friction; data not currently used. |
| Build approach | **Phased, safe rollout.** | Protects production data. |
| Who pays | `member` and `exco` pay. `advisor` is waived. `admin`/`volunteer` waived. | Per business rule. |
| Fee amounts | $30 first year, $20 subsequent year (in config, not hardcoded). | Configurable without redeploy. |
| Auto-inactivation | 1 month after due date if unpaid → `inactive`. | Per business rule. |
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

---

## 4. What we keep vs replace

| Today | New plan |
|---|---|
| `memberships` table | **Retire (dormant).** Leave the table in place — harmless. Live state moves onto `members`. |
| `membership_types` table | **Retire (dormant).** Fees move to KV config. |
| `membership_applications` table | **Keep.** Working intake record. Approve flow simplified. |
| `category='committee'` (17 board rows) | **Rename to `exco`.** One-time data update + login logic update. |
| Public registration form (~20 fields) | **Simplify** to essentials (see §7). |
| Approve → members row + memberships row | Approve → members row + set `fee_due_date` (approval + 12 months) + log payment. |
| Renewals / reminders / overdue / auto-inactivate | **New** in Phase 2. |

---

## 5. Data model changes

All additive. Nothing dropped, no data transformed destructively (the `committee` → `exco` rename is a controlled, reviewed update — see §8).

### Migration `005_membership_lifecycle.sql` (Phase 1)

```sql
-- Additive columns on members (role uses existing `category`, repurposed)
ALTER TABLE members ADD COLUMN membership_status TEXT DEFAULT 'active';
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
  "firstYearFee": 30,
  "renewalFee": 20,
  "currency": "SGD",
  "reminderOffsetsDays": { "first": -30, "second": -15, "third": 0, "overdue": 15 },
  "inactiveAfterDays": 30,
  "annualAnchorMonth": 1,
  "annualAnchorDay": 31
}
```

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
  - [ ] Existing `category='member'` rows → `fee_due_date` set per their approval date + 12 months
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
- [ ] **1G. Simplify approve flow**
  - [ ] On approval: set `fee_due_date = approval date + 12 months`, `category='member'`, `membership_status='active'`
  - [ ] Log the initial PayNow payment in `membership_payments`
  - [ ] Stop writing to the old `memberships` table
- [ ] **1H. Simplify public registration form** (see §7)
- [ ] **1I. Retire old table writes** — confirm no code writes `memberships` / `membership_types` (tables left dormant in DB)
- [ ] **1J. Verify** — build, typecheck, test locally, smoke-test prod after deploy

**Phase 1 deliverable**: A clean members list where each person has a clear role (editable), status, and editable fee due date. You can record payments manually. The public form is simpler. The old confusing tables are dormant. **Nothing automatic has run.**

### Phase 2 — Automated email reminders

**Goal**: the daily check sends the right email at the right time. Overdue members flagged. Auto-inactivation works.

- [ ] **2A. Add `scheduled()` cron handler to the worker**
  - [ ] `wrangler.jsonc`: add `triggers: { cron: ["0 8 * * *"] }` (8am daily UTC = 4pm SGT; adjust to desired SGT time — see gotcha §10)
  - [ ] Change `export default app` → `export default { fetch: app.fetch, scheduled }` (standard Hono pattern)
- [ ] **2B. Daily job logic**
  - [ ] Query non-waived members; compute days to/since `fee_due_date`
  - [ ] Match against configured offsets; send the appropriate reminder email
  - [ ] When `inactiveAfterDays` past due and unpaid → set `membership_status='inactive'`
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

| Field | Keep / Remove | Notes |
|---|---|---|
| Full name | **Keep** | Required |
| NRIC (last 4) | **Keep** | Required, 3 digits + letter |
| Email | **Keep** | Required |
| Mobile (handphone) | **Keep** | Required |
| Address line 1 | **Keep** | Required |
| Postal code | **Keep** | Required, 6 digits |
| Referrer (recommended by) | **Keep** | Required |
| PayNow screenshot | **Keep** | Optional image upload |
| Signature (draw/upload) | **Keep** | Required |
| Declaration checkbox | **Keep** | Required |
| Turnstile security check | **Keep** | Required |
| Membership intent (radio) | **Remove** | Not used downstream |
| Date of birth | **Remove** | Column stays in DB, not on form |
| Place of birth | **Remove** | Column stays in DB |
| Citizenship | **Remove** | Column stays in DB |
| Occupation | **Remove** | Column stays in DB |
| Hobbies / skills / associations | **Remove** | Columns stay in DB |
| Phone (home/office) | **Remove** | Columns stay in DB |
| Address line 2 | **Remove** | Column stays in DB |

**Principle**: removed fields stay as DB columns (harmless, reversible) — we just stop collecting them on the form.

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

- [x] **Default fee due date for existing board members** — **31-01-2027** (confirmed).
- [ ] **Which current board members are genuinely advisors** (should be `category='advisor'`, `fee_waived=1`)? The seed data has one member with "Advisor" in their `role` text — confirm who is an advisor vs. a paying exco member before the one-time rename.

---

## 12. Reference: files this plan will touch

| File | Phase | Purpose |
|---|---|---|
| `migrations/005_membership_lifecycle.sql` | 1A | Additive columns + payments table |
| `src/worker/api/verify-otp.ts` | 1B | Map `category='exco'` → committee login tier |
| `src/worker/api/members.ts` | 1E, 1F | Membership fields + payment endpoints + role editing |
| `src/worker/api/membership-reg.ts` | 1G | Simplify approve flow (fee_due_date = approval + 12 months) |
| `src/pages/members.astro` | 1B, 1E | Rename committee→exco in dropdown; membership UI + role/date editing |
| `src/pages/reg/membership/register.astro` | 1H | Simplify form |
| `src/pages/admin/forms/membership.astro` | 1G | Approve flow tweaks |
| `src/pages/admin/membership/reminders.astro` | 2E | New reminders dashboard |
| `src/worker/lib/email-membership-reminder.ts` | 2C | New reminder email templates |
| `src/worker/index.ts` | 2A | Add `scheduled` export |
| `wrangler.jsonc` | 2A | Add `triggers.cron` |
| `schema.sql` | 1A | Keep in sync with migration (documentation) |

---

*This plan is the single source of truth for the membership redesign. Update the checkboxes as work progresses.*
