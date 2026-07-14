# SWA Admin Portal (`swa-portal`) — Implementation Plan

> **Status**: Phase 1 mostly complete. Phase 2 (Membership Lifecycle) code complete 14-07-2026 — migration written, approve flow rewritten, members UI + payment API shipped. Awaiting D1 migration apply + prod deploy. Auth, scaffold, office booking, member directory, and namecard base UI done. Pagination, sync-website route, and domain setup still needed.
> **Date planned**: 2026-05-11
> **Last updated**: 2026-07-06
> **Repo**: `swa-portal` (separate from `swa2024` and `gtw2026`)
> **Domain**: `admin.singaporewomenassociation.org` (pending domain transfer, 5-7 days)
> **Dev URL**: `swa-portal.cjtay-4e0.workers.dev` (live, tested)

---

## Architecture Overview

```
singaporewomenassociation.org         → swa-site    (existing, static Astro + Hono contact API)
admin.singaporewomenassociation.org   → swa-portal  (NEW, separate Hono worker)
gtw.singaporewomenassociation.org     → swa-gtw    (existing, migrate from workers.dev subdomain)
```

Three Workers, one Cloudflare account, shared free tier.

### Cloudflare Free Tier (Account-Level, Shared Across All Workers)

| Resource | Free Tier Limit | Notes |
|---|---|---|
| Workers scripts | 10 | More than enough for 3 |
| Workers requests | 100k/day across all workers | Shared pool |
| Workers CPU time | 10ms per invocation | Per-request |
| KV reads | 100k/day per namespace | |
| KV writes | 1k/day per namespace | |
| D1 rows read | 5M/month per database | |
| D1 rows written | 100k/month per database | Tightest constraint (~3.3k submissions/day) |
| R2 storage | 10 GB across all buckets | |
| R2 Class A ops | 1M/month | Writes/uploads |
| R2 Class B ops | 10M/month | Reads |
| Custom domains | Unlimited per worker | Auto-provisioned TLS |

### Cloudflare Resources Provisioned

| Resource | Name | ID | Purpose |
|---|---|---|---|
| D1 database | `swa-portal` | `b8ca063c-6767-445c-a42e-d092daf80fc4` | Member data, bookings, memberships |
| KV namespace | `SWA_SESSION` | `ddb93996417c4476ac0f90ddf1eb332d` | OTP storage, sessions, rate limiting |
| KV namespace | `SWA_CONFIG` | `663295deb2f94800986e3dfe6f8ea230` | Registration tables config |
| R2 bucket | `swa-portal-uploads` | — | Photo uploads, payment receipts |
| Worker | `swa-portal` | — | Hono API + static assets |

Secrets set: `OTP_SECRET`, `SESSION_SECRET`, `RESEND_API_KEY` (set interactively via `wrangler secret put`).

Additional env vars: `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`, `SWA_ADMIN_DOMAIN`.

---

## Phase 1: Foundation + Office Booking + Namecard Admin

### 1A. Project Scaffold ✅

New Git repo `swa-portal/`, mirroring the GTW project structure (Astro static build + Hono worker API):

```
swa-portal/
├── astro.config.mjs           # output: 'static', no adapter
├── wrangler.jsonc              # Hono worker + ASSETS binding + D1 + KV + R2
├── package.json                # astro, hono, @cloudflare/workers-types
├── tsconfig.json               # extends astro/tsconfigs/strict + workers types
├── schema.sql                  # D1 schema (members + bookings + memberships + error_log)
├── seed-members.sql            # 19 members (17 board + 2 IT admin)
├── AGENTS.md                   # AI agent guide
├── docs/
│   └── SWAPortal-Implementation-Plan.md  # This file
├── public/
│   ├── favicon.svg
│   └── _headers                # CSP for admin subdomain
├── src/
│   ├── constants/
│   │   └── portal.ts          # Auth roles, admin emails, session config
│   ├── layouts/
│   │   └── AdminLayout.astro   # Auth-gated layout with nav sidebar
│   ├── pages/
│   │   ├── login.astro          # OTP login page (standalone, no AdminLayout)
│   │   ├── index.astro          # Dashboard / landing after login
│   │   ├── office-booking.astro # Calendar UI + booking form + cancel flow
│   │   ├── namecards.astro     # Basic namecard table with Sync button
│   │   └── members.astro        # Searchable directory + edit modal + add member
│   ├── scripts/
│   │   └── auth-gate.ts         # Client-side auth gate (ported from GTW)
│   ├── styles/
│   │   └── admin.css            # SWA purple theme (swa-1 through swa-5)
│   └── worker/
│       ├── index.ts             # Hono app entry, route registration
│       ├── types.ts             # Env bindings type
│       ├── middleware.ts        # Auth middleware (admin/committee tiers)
│       ├── api/
│       │   ├── send-otp.ts      # Generate + email OTP (D1 can_login check)
│       │   ├── verify-otp.ts    # Verify OTP + create session cookie
│       │   ├── session.ts       # Read current session from cookie
│       │   ├── bookings.ts      # CRUD for office bookings + confirmation email
│       │   └── members.ts       # Member API (CRUD, photo upload, slug, can_login)
│       └── lib/
│           ├── crypto.ts        # HMAC sign/verify, base64url (ported from GTW)
│           ├── email-booking.ts # Booking confirmation email HTML (SWA branded)
│           ├── email-otp.ts     # OTP email HTML builder (SWA purple branded)
│           ├── error-handler.ts # Unified API error responses
│           └── log-error.ts     # D1 error logging
└── dist/                         # Git-ignored, Astro build output
```

### 1B. Cloudflare Resources ✅

All provisioned and configured:

- D1 database `swa-portal` (id: `b8ca063c-6767-445c-a42e-d092daf80fc4`)
- KV namespace `SWA_SESSION` (id: `ddb93996417c4476ac0f90ddf1eb332d`)
- R2 bucket `swa-portal-uploads`
- Secrets: `OTP_SECRET`, `RESEND_API_KEY`
- `wrangler.jsonc` includes `workers_dev: true` (critical — without it, workers.dev returns error 1042)
- CSP in `public/_headers` allows `static.cloudflareinsights.com`

### 1C. D1 Schema (`schema.sql`) ✅

Applied to production D1. Key differences from original plan:

| Table | Notes |
|---|---|
| `members` | Added `slug TEXT UNIQUE`, `can_login INTEGER DEFAULT 0`, `has_namecard`, `show_on_website`, social links, address fields. No `whatsapp` field (removed). |
| `office_bookings` | Simplified to `approved`/`cancelled` only (no `pending`/`rejected`). Added `created_by` column via migration 001. |
| `membership_types` | As planned |
| `memberships` | As planned |
| `error_log` | New table not in original spec — logs API errors to D1 |

Migration `001_add_created_by.sql` recreated `office_bookings` table to add `created_by` column and simplify status constraint.

Indexes: `idx_members_slug` (UNIQUE), `idx_members_email`, `idx_members_can_login`.

19 members seeded via `seed-members.sql` (17 board members + 2 IT admin accounts with `can_login=1`).

### 1D. Auth System ✅

Ported from GTW and adapted, with additional security hardening:

| Component | Status | Changes from GTW |
|---|---|---|
| `crypto.ts` | ✅ Done | No changes needed |
| `send-otp.ts` | ✅ Done | KV prefix `swa:`; D1 query `SELECT id FROM members WHERE email = ? AND can_login = 1` replaces KV allowlist for non-admin emails; OTP rate limiting (5 requests per 15 min) |
| `verify-otp.ts` | ✅ Done | Cookie `swa_session`; D1 query for name lookup; role logic: `@singaporewomenassociation.org` → admin, otherwise → committee; verify rate limiting (10 per IP, 5 per email per 15 min; 5 failures per OTP) |
| `session.ts` | ✅ Done | Cookie name `swa_session` |
| `middleware.ts` | ✅ Done | Adapted role tiers; admin-only and IT-admin-only path restrictions |
| `auth-gate.ts` | ✅ Done | Cookie name `swa_session`, redirect paths updated |
| `email-otp.ts` | ✅ Done | Rebranded: "SWA Portal" with purple theme |
| `error-handler.ts` | ✅ Done | Ported |
| `log-error.ts` | ✅ Done | New — logs errors to D1 `error_log` table |
| `login.astro` | ✅ Done | Standalone layout (no AdminLayout — avoids infinite redirect); Turnstile bot protection |

**Security additions (post-initial auth):**
- Turnstile bot protection on login form (`/api/turnstile-config` endpoint for site key)
- OTP rate limiting: 5 requests per 15 min window
- Verify rate limiting: 10 attempts per IP / 5 per email per 15 min; max 5 failures per OTP

**Role tiers for portal:**

| Role | How determined | Access |
|---|---|---|
| `IT Admin` | Email in `IT_ADMIN_EMAILS` | Everything admin can do + infrastructure features (website sync, etc.) |
| `admin` | D1 `members.category = 'admin'` with `can_login = 1` | Full CRUD on members, namecards, can cancel any booking |
| `committee` | D1 `members.category = 'exco'` (or `'advisor'`) with `can_login = 1` | Read members/namecards, create/cancel own bookings |
| `member` | (Phase 2) Self-registration via OTP | View own membership status, pay fees |

See `docs/SWAPortal-Functional-Specs.md` for the full access matrix.

**IT Admin emails** (hardcoded in `src/constants/portal.ts`):
- `cjtay@singaporewomenassociation.org`
- `angela.wong@singaporewomenassociation.org`
- `system@singaporewomenassociation.org`

**End-to-end auth testing passed:**
- Admin email → OTP sent ✅
- `can_login=1` member → OTP sent ✅
- Unknown email → 403 ✅
- `can_login=0` member → 403 ✅

### 1E. Dashboard + Layout ✅

- `index.astro` — portal dashboard landing page with cards linking to Office Booking, Namecards, Members
- `AdminLayout.astro` — sidebar nav (Dashboard, Office Booking, Namecards, Members) with auth gate, SWA logo, user name from session
- `login.astro` — standalone layout (no AdminLayout to avoid redirect loop), Turnstile-protected
- All pages use SWA purple theme (`swa-1` through `swa-5`)
- `admin.css` includes calendar styles, booking card styles, form styles, responsive layout

### 1F. Office Booking — Complete

- [x] `bookings.ts` API routes (GET list, POST create, GET by id, PATCH cancel) ✅
- [x] Time-conflict validation (server-side in API, client-side in form) ✅
- [x] Booking confirmation email via Resend (`email-booking.ts`, SWA-branded HTML) ✅
- [x] Calendar UI with month navigation, day detail panel, booking dots ✅
- [x] New booking form with session prefill (name, email) ✅
- [x] Cancel own booking flow ✅
- [x] `created_by` tracking on bookings (migration 001) ✅
- [x] Auto-approve all bookings (simplified from pending/approved/rejected to approved/cancelled) ✅
- [x] Admin view: cancel any booking (admins bypass creator-only check) ✅
- [x] Admin view: List View toggle with all bookings table, status filter, cancel controls ✅

**Design decision (2026-05-12):** Simplified booking status from `pending`/`approved`/`rejected`/`cancelled` to just `approved`/`cancelled`. All bookings are auto-approved — no admin approval flow needed for a small office. Admins can still cancel any booking.

### 1G. Namecard Admin — Partial

- [x] `members.ts` API routes (CRUD, includes `slug` and `can_login` fields) ✅
- [x] Photo upload endpoint (`POST /api/members/:id/photo` → R2) ✅
- [x] `namecards.astro` — basic namecard table with has_namecard/show_on_website badges, Sync button ✅
- [ ] `/api/sync-website` route — button exists in UI but route not registered in `index.ts`, will 404
- [ ] GitHub Actions workflow in swa2024 repo for rebuild trigger
- [ ] Bulk-import remaining member data from markdown frontmatter into D1

### 1H. Member Directory — Mostly Complete

- [x] `members.astro` — searchable/filterable table with search input + category filter ✅
- [x] Quick edit modal for contact details (name, role, category, email, mobile, job_title, show_on_website, has_namecard) ✅
- [x] Add Member button with POST API ✅
- [x] Delete member (DELETE /api/members/:id) ✅
- [ ] Pagination (currently loads all members — will break at scale)
- [ ] Photo upload UI in edit modal (API exists at POST /api/members/:id/photo → R2, no form element)

### 1I. Domain + DNS — Blocked

- [ ] Wait for domain transfer to complete (5-7 days)
- [ ] Add `admin.singaporewomenassociation.org` custom domain to swa-portal worker
- [ ] Add `gtw.singaporewomenassociation.org` custom domain to swa-gtw worker
- [ ] Update redirect URLs in swa2024 for GTW links
- [ ] Update CSP headers in swa2024 `public/_headers`
- [ ] Test all subdomains with HTTPS

---

## Phase 2: Membership Lifecycle

> **Redesigned 2026-07-14.** The original Phase 2 (membership types CRUD, old fee tracking) has been replaced by the per-member lifecycle model. See `docs/membership-lifecycle-plan.md` for the full spec.

### 2A. Data Model + Manual Tracking ✅ (code complete 14-07-2026)

- [x] Migration `005_membership_lifecycle.sql` written (per-member fields + `membership_payments` table)
- [x] `committee → exco` category rename (code changes shipped)
- [x] Members page UI — membership status / fee_due_date / fee_waived columns + edit
- [x] Record-payment API (`POST/GET /api/members/:id/payments`)
- [x] Approve flow rewritten (atomic batch, tier-resolved fees, next-31-Jan, stop writing old tables)
- [x] Public form hardening (idempotent retry, waitUntil, request_body in error_log)
- [ ] Apply migration to prod D1 (pending backup + approval)
- [ ] Run one-time `committee → exco` data rename on prod
- [ ] Seed existing members' status/fee_due_date/fee_waived via UI

### 2B. Payment Reminders (Phase 2 of lifecycle plan)

- [ ] Create Resend email templates (reminder #1, #2, #3, overdue, inactive notice)
- [ ] Add `scheduled()` cron handler to worker
- [ ] Add `triggers.cron` to wrangler.jsonc
- [ ] Create daily reminder job (query non-waived members, match offsets, send emails)
- [ ] Auto-inactivate overdue members (zero grace — `inactiveAfterDays: 0`)
- [ ] Admin reminders dashboard (`/admin/membership/reminders`)

### 2C. Member Self-Service (future)

- [ ] Create member-facing dashboard
- [ ] Create profile edit page (limited fields)

---

## Phase 3: CMS + Form Migration

### 3A. Simple CMS for Event Posts

- [ ] Create Markdown editor page in portal
- [ ] Create image upload + Cloudinary integration
- [ ] Create preview before publish
- [ ] Create GitHub Actions webhook integration for publish

### 3B. Microsoft Forms Migration

16 forms to progressively replace, prioritised by business impact:

| Priority | Form | Current URL Pattern | Migration Complexity |
|---|---|---|---|
| 1 | Contact | `/forms/contact` | Low — already has Hono handler |
| 2 | Volunteer registration | `/forms/volunteer-form` | Medium |
| 3 | Office booking | External Microsoft Form | Low (Phase 1) |
| 4 | Table booking (gala) | `/forms/table-form` | Medium |
| 5 | Advertisement booking | `/forms/adv-form` | Medium |
| 6 | Sponsor form | `/forms/sponsor-form` | Medium |
| 7 | In-kind donation | `/forms/in-kind-form` | Low |
| 8 | Activity enrolment (yoga × 4) | `/forms/chair-yoga-form` etc. | Medium (recurring schedule) |
| 9 | IWD SWA form | `/forms/iwd-swa-form` | Medium |
| 10 | Tax exemption | `/forms/tax` | Low |
| 11 | MSPI | `/forms/mspi` | Medium |

Each form follows the same pattern:
1. Define D1 table schema
2. Build Astro form page in portal
3. Add Hono API route(s) for CRUD + CSV export
4. Add portal dashboard for admins to view/export submissions
5. Replace Microsoft Forms iframe on public site with redirect to portal (or embed)

### 3C. CSV Export

- [ ] Create generic CSV export endpoint (`GET /api/export/:table`)
- [ ] Add "Download CSV" button to all data table views

---

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────┐
│  admin.singaporewomenassociation.org (swa-portal)  │
│  ┌──────────┐  ┌───────────┐  ┌────────────────┐  │
│  │ OTP Login │  │ Dashboard │  │ Booking Form   │  │
│  │ (email)   │  │           │  │ + Calendar     │  │
│  └─────┬─────┘  └─────┬─────┘  └───────┬────────┘  │
│        │              │                │            │
│        └──────────────┼────────────────┘            │
│                       │                             │
│              ┌────────┴────────┐                    │
│              │  Hono Worker     │                    │
│              │  + D1 + KV + R2  │                    │
│              └────────┬────────┘                    │
└───────────────────────┼─────────────────────────────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
    ┌────┴────┐   ┌─────┴─────┐  ┌───┴────┐
    │  Resend │   │ GitHub    │  │ Cron   │
    │  (email)│   │ Actions   │  │trigger │
    └─────────┘   │ (rebuild) │  └────────┘
                  └──────┬────┘
                         │
    ┌────────────────────┴────────────────────┐
    │  singaporewomenassociation.org (swa-site)│
    │  Static rebuild → wrangler deploy         │
    └──────────────────────────────────────────┘
```

---

## GTW Worker Domain Migration

As part of this plan, also migrate `swa-gtw` from `swa-gtw.cjtay-4e0.workers.dev` to `gtw.singaporewomenassociation.org`:

- Add custom domain route to GTW's `wrangler.jsonc`
- Update redirect URLs in `swa2024/src/pages/gtw-2026/[...slug].astro`
- Update CSP in `swa2024/public/_headers` to include new subdomain
- This can be done independently of the portal work

---

## Key Reference Files (in swa-portal repo)

| File | Purpose |
|---|---|
| `src/worker/index.ts` | Hono app entry, route registration |
| `src/worker/middleware.ts` | Auth middleware (admin/committee tiers) |
| `src/worker/api/send-otp.ts` | Generate + email OTP (D1 can_login check) |
| `src/worker/api/verify-otp.ts` | Verify OTP + create session cookie (D1 name lookup) |
| `src/worker/api/session.ts` | Read current session from `swa_session` cookie |
| `src/worker/api/members.ts` | Member CRUD API + photo upload (includes `slug`, `can_login` fields) |
| `src/worker/api/bookings.ts` | Office booking CRUD API + confirmation email |
| `src/worker/lib/crypto.ts` | HMAC sign/verify, base64url |
| `src/worker/lib/email-booking.ts` | Booking confirmation email HTML (SWA branded) |
| `src/worker/lib/email-otp.ts` | OTP email HTML builder (SWA purple themed) |
| `src/worker/lib/error-handler.ts` | Unified API error responses |
| `src/worker/lib/log-error.ts` | D1 error logging |
| `src/constants/portal.ts` | `IT_ADMIN_EMAILS`, session config, OTP TTL |
| `src/scripts/auth-gate.ts` | Client-side auth gate + redirect logic |
| `src/layouts/AdminLayout.astro` | Sidebar nav with auth gate |
| `src/pages/login.astro` | Standalone login page (no AdminLayout) |
| `src/styles/admin.css` | SWA purple theme (swa-1 through swa-5) |
| `schema.sql` | D1 schema with `can_login`, `slug`, `error_log` |
| `seed-members.sql` | 19 member seed data |
| `wrangler.jsonc` | Worker config with D1/KV/R2 bindings, `workers_dev: true` |

---

## Progress Tracker

Use this section to track implementation progress across sessions. Update checkboxes as work is completed.

### Phase 1: Foundation + Office Booking + Namecard Admin

- [x] **1A. Project scaffold**
  - [x] Create `swa-portal` Git repo
  - [x] Initialise Astro project with `output: 'static'`
  - [x] Add Hono + Cloudflare Workers types dependencies
  - [x] Create `wrangler.jsonc` with D1, KV, R2 bindings + `workers_dev: true`
  - [x] Create `schema.sql` with members + bookings + memberships + error_log tables
  - [x] Create `tsconfig.json` extending Astro strict + workers types
  - [x] Create `src/worker/` directory structure (index.ts, types.ts, middleware.ts)
  - [x] Create `src/constants/portal.ts` (admin emails, session config)
  - [x] Create `src/layouts/AdminLayout.astro`
  - [x] Add `public/_headers` with CSP for admin subdomain
  - [x] Provision D1, KV, R2 on Cloudflare
  - [x] Set secrets (`OTP_SECRET`, `RESEND_API_KEY`)
  - [x] Deploy skeleton to `swa-portal.cjtay-4e0.workers.dev`
  - [x] Verify `/api/health` endpoint
  - [x] Add `can_login` and `slug` columns to members table
  - [x] Create indexes on `slug`, `email`, `can_login`
  - [x] Seed 19 members into D1

- [x] **1B. Auth system**
  - [x] Port `crypto.ts` from GTW
  - [x] Port `email-otp.ts` from GTW (rebrand to "SWA Portal" with purple theme)
  - [x] Port `send-otp.ts` (update KV key prefix to `swa:`, add D1 `can_login` check for non-admin emails)
  - [x] Port `verify-otp.ts` (update cookie name to `swa_session`, add D1 name lookup, update role logic)
  - [x] Port `session.ts` (update cookie name to `swa_session`)
  - [x] Port `middleware.ts` (adapt role tiers: admin/committee)
  - [x] Port `auth-gate.ts` (update cookie name, redirect paths)
  - [x] Port `error-handler.ts`
  - [x] Create `log-error.ts` for D1 error logging
  - [x] Create `login.astro` page (standalone layout, no AdminLayout)
  - [x] End-to-end auth testing passed

- [x] **1C. Dashboard + layout**
  - [x] Create `index.astro` (portal dashboard landing)
  - [x] Create `AdminLayout.astro` with sidebar nav (Bookings, Members, Namecards)
  - [x] Add auth gate to all protected pages
  - [x] SWA purple theme applied to all pages

- [ ] **1D. Office booking**
  - [x] Create `bookings.ts` API routes (GET list, POST create, GET by id, PATCH cancel)
  - [x] Create `office-booking.astro` with calendar view + day detail panel
  - [x] Create booking form with session prefill + time-conflict validation (client + server)
  - [x] Create booking confirmation email (`email-booking.ts`, sent via Resend on creation)
  - [x] Simplify status to auto-approve (approved/cancelled only — no admin approval flow)
  - [x] Cancel own booking flow (PATCH /api/bookings/:id/cancel)
  - [x] Add `created_by` tracking via migration 001
  - [x] Admin view: allow admins to cancel any booking (backend updated — admins bypass creator check)
  - [x] Admin view: list all bookings with management controls (List View toggle, status filter, cancel button)

- [ ] **1E. Namecard admin**
  - [x] Create `members.ts` API routes (CRUD, includes `slug` and `can_login`)
  - [x] Add photo upload endpoint (`POST /api/members/:id/photo` → R2)
  - [x] Create basic namecard management UI on `namecards.astro` (table with badges, Sync button)
  - [ ] Implement `/api/sync-website` route (button exists but route not registered — will 404)
  - [ ] Set up GitHub Actions workflow in swa2024 repo for rebuild trigger
  - [ ] Bulk-import remaining member data from markdown frontmatter into D1

- [ ] **1F. Member directory**
  - [x] Create searchable/filterable table view (search input + category filter)
  - [x] Add quick edit modal for contact details
  - [x] Add "Add Member" button with POST API
  - [x] Add delete member (DELETE /api/members/:id)
  - [ ] Add pagination (currently loads all members)
  - [ ] Add photo upload UI in edit modal (API exists, no form element)

- [ ] **1G. Domain + DNS**
  - [ ] Wait for domain transfer to complete (5-7 days)
  - [ ] Add `admin.singaporewomenassociation.org` custom domain to swa-portal worker
  - [ ] Add `gtw.singaporewomenassociation.org` custom domain to swa-gtw worker
  - [ ] Update redirect URLs in swa2024 for GTW links
  - [ ] Update CSP headers in swa2024 `public/_headers`
  - [ ] Test all subdomains with HTTPS

### Phase 2: Membership Lifecycle (redesigned — see docs/membership-lifecycle-plan.md)

- [x] **2A. Data model + manual tracking** (code complete 14-07-2026)
  - [x] Migration 005 written (per-member fields + `membership_payments` table)
  - [x] `committee → exco` code changes (verify-otp, members.ts, members.astro, docs)
  - [x] Approve flow rewritten (atomic batch, tier-resolved fees, next-31-Jan, isMembershipApprover gate)
  - [x] Members page UI — status / fee_due / waived columns + edit modal + record-payment
  - [x] Record-payment API (`POST/GET /api/members/:id/payments`)
  - [x] Public form server-side hardening (idempotent retry, waitUntil, request_body in error_log)
  - [ ] Apply migration to prod D1 (pending backup + approval)
  - [ ] Run one-time `committee → exco` data rename on prod
  - [ ] Seed existing members' lifecycle fields via UI

- [ ] **2B. Payment reminders** (lifecycle plan Phase 2)
  - [ ] Create Resend email templates (reminder #1, #2, #3, overdue, inactive notice)
  - [ ] Add `scheduled()` cron handler to worker + `triggers.cron` to wrangler.jsonc
  - [ ] Create daily reminder job (query non-waived members, match offsets, send emails)
  - [ ] Auto-inactivate overdue members (zero grace — `inactiveAfterDays: 0`)
  - [ ] Admin reminders dashboard

- [ ] **2C. Member self-service** (future)
  - [ ] Create member-facing dashboard
  - [ ] Create profile edit page (limited fields)

### Phase 3: CMS + Form Migration

- [ ] **3A. Simple CMS**
  - [ ] Create Markdown editor page in portal
  - [ ] Create image upload + Cloudinary integration
  - [ ] Create preview before publish
  - [ ] Create GitHub Actions webhook integration for publish

- [ ] **3B. Form migration** (track each form)
  - [ ] Contact form
  - [ ] Volunteer registration
  - [ ] Table booking (gala)
  - [ ] Advertisement booking
  - [ ] Sponsor form
  - [ ] In-kind donation
  - [ ] Chair yoga
  - [ ] Laughter yoga (× 4 variants)
  - [ ] IWD SWA form
  - [ ] Tax exemption
  - [ ] MSPI

- [ ] **3C. CSV export**
  - [ ] Create generic CSV export endpoint (`GET /api/export/:table`)
  - [ ] Add "Download CSV" button to all data table views

---

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-11 | Separate repo (not monorepo in swa2024) | Clean separation, independent deploys, easier for AI agents |
| 2026-05-11 | Reminders to ALL outstanding fees | More complete coverage, admin can configure per-type later |
| 2026-05-11 | Static namecards + rebuild trigger | Best for SEO and performance; portal only manages data |
| 2026-05-11 | Separate worker per concern (site/portal/gtw) | Risk isolation, independent scaling, cleaner security boundary |
| 2026-05-11 | D1 + R2 + KV in portal worker | Admin portal needs database, file uploads, session storage |
| 2026-05-11 | D1 `can_login` column instead of KV allowlist | Single source of truth — no sync issues; `members` table is authoritative; free tier generous enough |
| 2026-05-11 | D1 name lookup in verify-otp instead of KV | Avoids stale data; member name comes from same source as auth logic |
| 2026-05-11 | `slug` column on members | URL-safe identifier matching swa2024 member filenames (e.g. `angela`, `kate`) for namecard URLs |
| 2026-05-11 | `workers_dev: true` in wrangler.jsonc | Without it, workers.dev subdomain returns error 1042; needed because `routes` config disables it by default |
| 2026-05-11 | Login page uses standalone layout | AdminLayout calls `requireAuth` which redirects to `/login` — causes infinite redirect loop |
| 2026-05-11 | `RESEND_API_KEY` must be set interactively | Piping empty/placeholder values causes 502 from Resend API; must use `wrangler secret put` interactively |
| 2026-05-11 | `error_log` table in D1 | Centralised error logging for API endpoints; helps debug production issues |
| 2026-05-11 | SWA purple theme (not GTW gold) | Portal is SWA-branded; colours: `swa-1 #70308c`, `swa-2 #450a5e`, `swa-3 #874ba1`, `swa-4 #f3d2ff` |
| 2026-05-12 | Simplify booking status to approved/cancelled only | Small office doesn't need approval flow; auto-approve simplifies UX and removes admin bottleneck; migration 001 recreated table with new CHECK constraint |
| 2026-05-12 | Turnstile bot protection on login | Prevents automated OTP requests; site key served via `/api/turnstile-config` endpoint |
| 2026-05-12 | OTP + verify rate limiting | 5 OTP requests per 15 min; 10 verify attempts per IP, 5 per email per 15 min; 5 failures per OTP max |
| 2026-05-12 | Remove `whatsapp` field from members | Not needed for SWA use case; simplifies schema |
| 2026-05-13 | Method-based API access control | Committee can read members/namecards; admin-only for writes; IT-admin-only for sync |
| 2026-05-13 | Role from D1 `category` field | Removes email domain check; `can_login` determines login eligibility exclusively |
| 2026-05-13 | General-purpose authenticated rate limiting | Per-user per-endpoint: 10 requests / 15 min for all write endpoints (members, bookings, sync) |
| 2026-05-13 | Role-based UI controls | Hide Add/Edit/Sync buttons client-side based on `is_admin` / `is_it_admin` from session |
| 2026-07-06 | Upgrade Astro 6.4.8 → 7.0.6 | Currency/security — stay on a supported, patched line. Rust compiler is stricter (unclosed tags now error; fixed missing `</body></html>` in `AdminLayout.astro`). Hono-Worker architecture unchanged. v7 content/SSR features (Sätteri, `src/fetch.ts`, route caching) not adopted — target enterprise-content platforms, not a 22-page static portal. |

---

## Critical Gotchas

These are non-obvious issues encountered during implementation that would be easy to rediscover:

1. **`workers_dev: true`** — Must be explicitly set in `wrangler.jsonc` when `routes` are specified, otherwise workers.dev returns error 1042
2. **Login page must NOT use AdminLayout** — `AdminLayout` calls `requireAuth` which redirects unauthenticated users to `/login`, causing an infinite redirect loop
3. **`can_login` column** — D1 `ALTER TABLE ADD COLUMN` doesn't support `UNIQUE` constraint; must add column first, then `CREATE UNIQUE INDEX` separately
4. **Session cookie name** — `swa_session` (not `gtw_session`)
5. **KV key prefix** — `swa:` (not `gtw:`)
6. **`RESEND_API_KEY`** — Must be set via interactive `wrangler secret put`; piping values causes 502 errors
7. **D1-based auth** — No KV allowlist needed; `send-otp.ts` queries `SELECT id FROM members WHERE email = ? AND can_login = 1` for all emails. Role is determined by D1 `category` field (`admin` vs `committee`). Email domain does not matter.
8. **Booking status simplified** — Only `approved` and `cancelled` states exist (no `pending`/`rejected`); migration 001 recreated the table to enforce this
9. **`/api/sync-website` not registered** — The namecard page's "Sync to Website" button calls this endpoint, but it's not in `src/worker/index.ts` route registration — will return 404
10. **`SESSION_SECRET` required** — Not listed in original secrets section but is required by the auth system
11. **Committee can read `/api/members`** — GET is allowed for all authenticated users; only POST/PATCH/DELETE require admin role