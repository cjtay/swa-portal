# Membership Lifecycle — Testing Strategy

> **Status**: Strategy confirmed 13-07-2026. Ready to execute.
> **Companion to**: `docs/membership-lifecycle-plan.md` (the implementation plan this strategy validates).
> **Goal**: Test the membership lifecycle — especially the Phase 2 cron-driven email reminders — without risking production data, and in a way that lets SWA team members (Angela Wong, Roxanne Zhang) participate in UAT without access to the developer's laptop.

---

## 1. The two problems this strategy solves

1. **Cron triggers don't fire in `wrangler dev` by default.** They only fire on *deployed* Workers in Cloudflare's infrastructure. Local dev lets you fire the scheduled handler *manually* with `--test-scheduled` (via the `/__scheduled` endpoint), but you can't validate the actual schedule, daily-run behaviour, or edge cases like year rollover.
2. **Local dev is private to the developer's laptop.** Angela and Roxanne cannot reach `localhost:8787` to log in via OTP, view the members page, or watch the reminders dashboard. Preview URLs from `wrangler deploy` don't help either — cron triggers fire on the *active production deployment*, not on version previews.

## 2. Architecture: dedicated staging environment

Add a named environment (`env.staging`) to `wrangler.jsonc` so the staging deploy is a *separate* Worker with its *own* resources:

```
swa-portal            prod Worker, prod D1, NO cron until go-live
swa-portal-staging    staging Worker, staging D1, hourly cron, fakeToday + recipient override
```

The staging URL `swa-portal-staging.cjtay-4e0.workers.dev` is reachable by the SWA team. Staging gets its **own** D1 / KV / R2 — production data is never at risk and the staging cron can fire freely.

### One-time resource creation (via wrangler CLI)

```bash
wrangler d1 create swa-portal-staging
wrangler kv namespace create SWA_SESSION_STAGING
wrangler kv namespace create SWA_CONFIG_STAGING
wrangler r2 bucket create swa-portal-staging-uploads
```

### `wrangler.jsonc` sketch (do NOT edit until execution time)

```jsonc
{
  "name": "swa-portal",
  // ... existing top-level = production, NO triggers.cron until S9
  "env": {
    "staging": {
      "name": "swa-portal-staging",
      "triggers": { "cron": ["0 * * * *"] },     // hourly for testing
      "d1_databases": [
        { "binding": "DB", "database_name": "swa-portal-staging", "database_id": "<NEW>" }
      ],
      "kv_namespaces": [
        { "binding": "SWA_SESSION", "id": "<NEW STAGING>" },
        { "binding": "SWA_CONFIG",  "id": "<NEW STAGING>" }
      ],
      "r2_buckets": [
        { "binding": "R2_BUCKET", "bucket_name": "swa-portal-staging-uploads" }
      ],
      "vars": {
        "SWA_ADMIN_DOMAIN": "swa-portal-staging.cjtay-4e0.workers.dev",
        "TURNSTILE_SITE_KEY": "<separate staging key or reuse>"
      }
    }
  }
}
```

Secrets are set per-environment:
```bash
wrangler secret put OTP_SECRET      --env staging
wrangler secret put SESSION_SECRET  --env staging
wrangler secret put RESEND_API_KEY  --env staging
```

## 3. Layered test strategy

| Layer | Where | What it proves | Who needs it |
|---|---|---|---|
| **1. Pure unit tests** | Local (Vitest) | Date math: given `fee_due_date` + today + offsets, which reminder (if any) fires; auto-inactivate boundary at `inactiveAfterDays`. Extract cron logic into a pure `runReminders(env, today)` function so it's testable without Hono. | Developer |
| **2. Local wrangler dev** | `npm run dev:worker -- --test-scheduled` | Scheduled handler is wired correctly; manual `curl 'http://localhost:8787/__scheduled?cron=0+0+*+*+*'` runs it against dummy seed data. | Developer |
| **3. Staging Worker** | `wrangler deploy --env staging` | Real cron schedule fires on a stable URL the team can log into. DB seeded with realistic dummy data. **This is where Angela/Roxanne do UAT.** | Developer + SWA team |
| **4. Pre-prod dry-run** | Prod Worker, feature flag off | Apply migration to prod D1, deploy code with `membershipRemindersEnabled=false` in `SWA_CONFIG`. Hit a new admin endpoint `POST /api/admin/membership/reminders/dry-run` to see what *would* be sent. No emails go out. | Developer + approver sign-off |
| **5. Go-live** | Prod Worker, flag on | Flip the KV flag, redeploy. Cron takes over. | — |

## 4. Staging data: fabricated dummy seed only

Per the decision 13-07-2026: staging uses **fabricated dummy seed only**. No production data is exported, copied, or leaves the production D1. This is the safest option — it means a data breach of staging leaks nothing real, and there is no PII to scrub.

### New seed file: `seed-membership-staging.sql`

Coverage matrix (~12 rows) designed so that a single cron run with a chosen `fakeToday` exercises every branch:

| # | category | membership_status | fee_waived | fee_due_date (relative to chosen fakeToday) | Tests |
|---|---|---|---|---|---|
| 1 | member | active | 0 | fakeToday + 30d | Reminder #1 (1 month before) |
| 2 | member | active | 0 | fakeToday + 15d | Reminder #2 (half month before) |
| 3 | exco | active | 0 | fakeToday (00:00) | Reminder #3 "Due today" |
| 4 | member | active | 0 | fakeToday − 15d | Overdue email (half month after) |
| 5 | member | active | 0 | fakeToday − 30d | Auto-inactivate boundary |
| 6 | member | inactive | 0 | fakeToday − 60d | Inactive member still receives reminders (per decision 13-07-2026) |
| 7 | advisor | active | 1 | null | Skipped entirely (waived) |
| 8 | admin | active | 1 | null | Skipped (waived) |
| 9 | volunteer | active | 1 | null | Skipped (waived) |
| 10 | exco | active | 0 | fakeToday + 100d | Not in any window — no email |
| 11 | member | active | 0 | fakeToday + 1d | Between Reminder #2 and #3 — no email |
| 12 | member | inactive | 0 | fakeToday + 30d | Inactive member in Reminder #1 window — still gets it |

Plus real rows for the actual human testers (Angela Wong, Roxanne Zhang, the developer) with their **real** emails so OTP login works. The approve/reject flow is gated by `isMembershipApprover(email)` in `src/constants/portal.ts`, which checks `MEMBERSHIP_APPROVER_EMAILS ∪ IT_ADMIN_EMAILS` — so Angela (in both lists), Roxanne, and the developer (via `IT_ADMIN_EMAILS`) can all exercise the flow in staging.

## 5. Email safety: recipient override

Decision 13-07-2026: staging sends **real emails to a single shared test inbox** so the team can visually verify formatting, content, and Resend deliverability.

### New `SWA_CONFIG` keys (staging only)

```json
{
  "reminderRecipientOverride": "swa-test@singaporewomenassociation.org",
  "membershipRemindersEnabled": true,
  "fakeToday": "2027-01-16"
}
```

### Implementation rule

The email-sending library (`src/worker/lib/email-membership-reminder.ts`, to be built in Phase 2C of the implementation plan) must check `reminderRecipientOverride` and rewrite **every** `To:` header to that single address before calling Resend. Set the catch-all up on the SWA mailbox provider so multiple `To:` lines all land in one inbox the team can read.

In **production**, the `reminderRecipientOverride` key is **absent** → no rewriting → real recipients receive real emails.

### Resend prerequisites

- Confirm the `from` address you intend to use is already verified in Resend (likely the same domain prod uses). If not, that domain verification is a prerequisite for step S4 below.
- Staging uses the same `RESEND_API_KEY` as prod (set as a staging-env secret), so the verified sending identity carries over.

## 6. Time travel: `fakeToday`

Decision 13-07-2026: cron reads an overrideable "today" from `SWA_CONFIG`.

### Implementation rule

The cron's first line reads:
```ts
const today = config.fakeToday ?? new Date().toISOString().slice(0, 10);
```

All date-math (offsets, inactivation boundary, year rollover) uses this `today` value.

### Suggested walk-through progression

Edit one KV value, wait for the next hourly cron, verify:

1. `fakeToday: "2027-01-01"` → row #1 gets Reminder #1
2. `fakeToday: "2027-01-16"` → row #2 gets Reminder #2
3. `fakeToday: "2027-01-31"` → row #3 gets Reminder #3 ("due today")
4. `fakeToday: "2027-02-15"` → row #4 gets Overdue
5. `fakeToday: "2027-03-01"` → row #5 flips to `inactive`, gets "Now inactive" notice; row #6 still gets reminders

Verify each step via:
- `wrangler tail --env staging` (live handler logs)
- The shared test inbox (email content)
- The `membership_reminders` log table (what was sent, to whom, when)

## 7. Staging cron cadence

`triggers: { cron: ["0 * * * *"] }` in the `env.staging` block — fires at minute 0 of every hour, UTC. Production top-level keeps **no** `triggers` block until the go-live step (S9), at which point it becomes `"0 0 * * *"` (= 08:00 SGT, per gotcha #6 in the implementation plan).

## 8. Cloudflare cron testing mechanics

- `wrangler tail --env staging` — watch the scheduled handler logs live as the cron fires.
- For staging only, the hourly schedule lets you iterate quickly and see same-day results.
- Cron triggers are **per-environment**, so the staging cron has no effect on prod and vice-versa.
- Cron fires on the *latest deployment* of that environment — re-deploy to pick up handler changes.
- Cloudflare has no UI button to manually fire a cron trigger; the only manual trigger path is `wrangler dev --test-scheduled` + `curl` locally.

## 9. Step-by-step execution plan

| Step | Action | Risk to prod |
|---|---|---|
| **S0** | Create staging D1 + KV namespaces + R2 bucket. Apply `schema.sql` + migration `005_membership_lifecycle.sql` to staging D1. Run the `committee → exco` rename on staging. | None |
| **S1** | Seed staging D1 with `seed-members.sql` + new `seed-membership-staging.sql`. Confirm `isMembershipApprover()` covers Angela, Roxanne, and the developer (via `MEMBERSHIP_APPROVER_EMAILS ∪ IT_ADMIN_EMAILS`). | None |
| **S2** | Build Phase 1 features (members page UI, payment endpoints, simplified approve flow). Deploy to staging. Angela/Roxanne do UAT on the members page. **No cron yet.** | None |
| **S3** | Add `scheduled()` handler + `runReminders(env, today)` pure function. Unit-test the date math with Vitest (no Cloudflare needed). | None |
| **S4** | Add `env.staging` block with hourly cron. Deploy `--env staging`. Set `fakeToday`, `reminderRecipientOverride`, `membershipRemindersEnabled=true` in staging `SWA_CONFIG`. | None |
| **S5** | Walk `fakeToday` through all 5 stages (§6). Verify each email in the shared inbox. Verify auto-inactivation. Verify inactive members still receive reminders. Fix bugs. | None |
| **S6** | Angela/Roxanne sign off on the staging reminders dashboard (`/admin/membership/reminders`). | None |
| **S7 — pre-prod** | Backup prod D1: `wrangler d1 export swa-portal --remote --output=backup-DD-MM-YYYY.sql`. Apply migration `005` to a fresh local D1 first to verify, then to prod. Run `committee → exco` rename on prod. Deploy code to prod with `membershipRemindersEnabled: false` in prod `SWA_CONFIG`. Add `triggers.cron: ["0 0 * * *"]` (08:00 SGT) to top-level `wrangler.jsonc`. Cron now fires daily but does nothing. | Migration only (additive + 1 reviewed rename) |
| **S8 — dry-run on prod** | Hit `POST /api/admin/membership/reminders/dry-run` on prod. Review the would-send list with Angela. | None — endpoint returns but does not send |
| **S9 — go-live** | Set `membershipRemindersEnabled: true` in prod `SWA_CONFIG`. Watch first cron via `wrangler tail`. | Live — emails go to real members |

## 10. Open items to confirm before S0

1. **`fakeToday` key location** — placing it under `swa:membership:config` (alongside offsets) is simplest. Alternatively, a separate KV key if the team prefers to keep reminder config immutable-ish. **Default**: same key.
2. **Shared inbox address** — `swa-test@singaporewomenassociation.org` requires that mailbox to exist (or a catch-all on the SWA domain). Confirm the SWA domain's mail provider supports catch-all, and that the mailbox is created.
3. **Resend verified sending domain** — confirm the `from` address intended for reminder emails is already verified in Resend. If not, that verification is a prerequisite for S4.
4. **Local D1 emulator test of the migration** — Phase 1A of the implementation plan calls for testing the migration locally first. Do this even before S0, since the staging D1 also needs the migration applied and any errors will surface identically in both places.
5. **Roxanne's onboarding** (open question from implementation plan §11) — she still needs a `members` row with `category='exco'`, `can_login=1`, `deleted_at IS NULL` to log in to staging at all. Adding her email to `MEMBERSHIP_APPROVER_EMAILS` alone is not sufficient because the D1-based auth in `verify-otp.ts` requires the members row to exist. Add her to the seed file alongside the 12 dummy rows.
6. **Turnstile on staging** — the existing site key is authorised for production hostnames only. Staging on `*.workers.dev` may need its own site key, or the dev-bypass path needs to be widened (currently `isDevBypassHost` already allows `*.workers.dev`, but `DEV_BYPASS_AUTH` is set via `.dev.vars` which is local-only — staging secrets would need to set it explicitly).

## 11. Files this strategy will create or touch (reference)

| File | Step | Purpose |
|---|---|---|
| `wrangler.jsonc` | S4, S7, S9 | Add `env.staging` block; later add top-level `triggers.cron` |
| `seed-membership-staging.sql` | S1 | New dummy seed for staging UAT |
| `src/worker/lib/email-membership-reminder.ts` | S3 | New email lib; honours `reminderRecipientOverride` |
| `src/worker/lib/membership-cron.ts` | S3 | Pure `runReminders(env, today)` function (unit-testable) |
| `src/worker/index.ts` | S3 | Change `export default app` → `export default { fetch: app.fetch, scheduled }` |
| `src/worker/api/membership-reg.ts` | S8 | Add `POST /api/admin/membership/reminders/dry-run` endpoint |
| `src/pages/admin/membership/reminders.astro` | S6 | New reminders dashboard (admin view) |
| `SWA_CONFIG` KV (staging) | S4 | `fakeToday`, `reminderRecipientOverride`, `membershipRemindersEnabled` |
| `SWA_CONFIG` KV (prod) | S7, S9 | `membershipRemindersEnabled: false` → `true` |

---

*This document is the testing companion to `docs/membership-lifecycle-plan.md`. Update the step checkboxes as work progresses.*
