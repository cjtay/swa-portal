# SWA Admin Portal — Core Functional Specification

> **Version**: 2.0
> **Date**: 2026-08-23
> **Structure**: This is the **core** spec — roles, access-control conventions, the feature matrix, authentication, and documentation rules. Each feature's detail lives in its own file under `docs/specs/features/`, linked from the matrix in §3.3. Non-technical overview: `docs/specs/SWAPortal-Owner-Guide.md`.
> **Boundary**: `docs/ARCHITECTURE.md` describes how the system is *built* (stack, request flow, tables at a glance). This document and the feature specs describe what it must *do* and *who may do it*. Point-in-time plans and audits live in `docs/plans/`.

---

## 1. Overview

The SWA Admin Portal (`swa-portal`) is the internal management tool for the Singapore Women's Association: member directory, office booking, payment approvals, gala registration, public forms, and board namecards. It runs as one Cloudflare Worker (Hono API + Astro static pages) with D1 (data), KV (sessions/config), and R2 (uploads).

### Target users

| Role | Description |
|------|-------------|
| IT Admin | System administrators with full control including infrastructure features |
| Admin | Office administrators with member management and approval-raising duties |
| Committee | Board members with read access and limited write access |
| Registration roles | `reg_admin` / `reg_volunteer` on top of the base role (gala module) — see `features/gala-registration.md` |
| Approval groups | Purchase / finance approvers by email list — see `features/approvals.md` |

## 2. Roles

### 2.1 How roles are determined

Resolved at login by `src/worker/lib/session-role.ts` (single source of truth), from the D1 `members` row plus the hardcoded `IT_ADMIN_EMAILS` list:

```
email in IT_ADMIN_EMAILS        → role 'admin', is_it_admin true (no members row needed)
members.category = 'admin'      → role 'admin'
members.category = 'committee'  → role 'committee'
members.category = 'advisor'    → role 'committee' (same tier; fee_waived = 1)
```

**Login eligibility**: `members.can_login = 1`. Email domain does not matter. Sessions are revalidated against D1 on every request — demotions, lock-outs and soft-deletes take effect immediately.

**Member categories**: `admin` (can_login 0 by default), `committee` (1), `advisor`, `member` and `volunteer` (no portal access by default).

### 2.2 Session data

The `swa_session` cookie carries an HMAC-signed payload (`email`, `name`, `role`, `regRole`, `exp`). `GET /api/session` returns:

```json
{
  "authenticated": true,
  "email": "user@example.com",
  "name": "Full Name",
  "role": "admin",
  "regRole": null,
  "is_admin": true,
  "is_it_admin": false,
  "is_purchase_approver": false,
  "is_finance_approver": false,
  "ai_comparison_enabled": true,
  "features": { "namecards": false, "office_booking": false, "events": false }
}
```

The approver flags drive the Approvals nav item and board actions. The `features` object carries runtime feature availability (see §3.2) and drives the nav/dashboard/client-side gates.

### 2.3 Permission groups (email-list pattern)

Beyond base roles, specific powers are granted by email lists in `src/constants/portal.ts`:

| Group | List | Grants |
|-------|------|--------|
| Membership approvers | `MEMBERSHIP_APPROVER_EMAILS` ∪ IT admins (`isMembershipApprover()`) | Approve/reject membership applications |
| Purchase approvers | `APPROVAL_PURCHASE_APPROVER_EMAILS` ∪ IT admins (`isPurchaseApprover()`) | Purchase-stage decisions |
| Finance approvers | `APPROVAL_FINANCE_APPROVER_EMAILS` only (`isFinanceApprover()`) | Voucher decisions; **IT admins deliberately excluded**. May also sign purchase-stage decisions for items under S$1,000 (`canDecidePurchaseStage()`) |

## 3. Access control

### 3.1 Conventions

- **Middleware tiers** (`src/worker/middleware.ts`): public paths; authenticated-by-default; IT-admin-only set; admin-write sets (GET open, writes admin); `reg_role` gates for the gala module; gate 7c for `/api/approvals` (admin or either approval group; R2 auditors admitted to GET reads only).
- **Handlers re-check finer rules** (defence in depth) — e.g. finance decisions re-check `isFinanceApprover`; audit export is IT-admin only (middleware set, handler re-checks the admin tier).
- **Writes are rate-limited** per email per endpoint (`src/worker/lib/rate-limit.ts`); public form endpoints are IP rate-limited.
- **New feature rule**: one row in the §3.3 matrix below + one spec file in `docs/specs/features/`.

### 3.2 Feature availability flags

Work-in-progress features are switched off for all users via runtime feature flags (`src/worker/lib/feature-flags.ts`, added 2026-08-29). The §3.3 matrix applies **only when a feature is enabled**.

| Feature key | Covers | Default (production) |
|-------------|--------|----------------------|
| `namecards` | `/namecards`, `/api/namecards/*`, public `/c/*` | Disabled until launch |
| `office_booking` | `/office-booking`, `/api/bookings/*` | Disabled until launch |
| `events` | `/events`, `/reg/*` (admin, dashboard, volunteer, buyer), `/admin/settings/tables`, `/api/reg/*` | Disabled until launch |

Rules:

- **Code defaults are the source of truth**; the KV key `swa:feature_flags` in `SWA_CONFIG` is a per-key override written only from Settings → Feature availability (IT admin). Missing/unparseable KV → code default — fail closed.
- **Local dev sees everything**: when the dev bypass is active, defaults are all-enabled. A local KV override can preview the off state.
- **Enforcement is layered**: middleware returns `503 FEATURE_DISABLED` on gated API prefixes before auth; `/c/*` returns 404; nav items and dashboard cards hide; gated pages redirect to `/` client-side via auth-gate's `feature` option.
- **New features ship behind a flag defaulting to `false`** in `PROD_DEFAULT_FEATURE_FLAGS` (same commit as the feature; TypeScript's `Record` forces the default).

### 3.3 Feature matrix

| Feature | Committee | Admin | IT Admin | Spec |
|---------|-----------|-------|----------|------|
| Dashboard | View | View | View | (no restrictions) |
| Office Booking — view/create/cancel own | Yes | Yes | Yes | `features/office-booking.md` |
| Office Booking — cancel any | No | Yes | Yes | 〃 |
| Member Directory — view | Yes | Yes | Yes | `features/members.md` |
| Member Directory — add/edit/delete | No | Yes | Yes | 〃 |
| Namecards — view list + self-service | Yes | Yes | Yes | `features/namecards.md` |
| Namecards — admin edit | No | Yes | Yes | 〃 |
| Approvals — view board | Approvers only | Yes | Yes | `features/approvals.md` |
| Approvals — view board (auditor, read-only) | Auditor email list only (R2): read + tabs + drawer, no actions | 〃 | 〃 | 〃 |
| Approvals — raise/edit/voucher/paid/remind | No | Yes | Yes | 〃 |
| Approvals — purchase decision | Approvers only; items **under S$1,000** may also be decided by the finance approvers (policy §3.2) | No | Yes | 〃 |
| Approvals — voucher decision | Finance approvers only | No | **No** (by design) | 〃 |
| Approvals — list CSV export (R3) | No | Yes | Yes | 〃 |
| Approvals — audit CSV export | No | No | Yes | 〃 |
| Gala — manage bookings | `reg_admin` only | Yes | Yes | `features/gala-registration.md` |
| Gala — check-in guests | Yes | Yes | Yes | 〃 |
| Public forms — submit | Public (Turnstile + IP limits) | — | — | `features/public-forms.md` |
| Form submissions — view/export | Yes | Yes | Yes | 〃 |
| Membership — approve/reject | No (approver list only) | Approver list | Yes | 〃 + `features/membership-form/` |
| Admin Settings | No | No | Yes | (IT-admin only page group) |

## 4. Authentication

- **OTP login**: email → 6-digit code via Resend (5-minute TTL) → HMAC-signed session cookie. No passwords anywhere. Limits: 5 OTP sends per email / 15 min; 10 verify attempts per IP, 5 per email / 15 min; 5 wrong codes kills the OTP.
- **Sessions**: 12 hours default, 30 days with "remember me". Revalidated against D1 every request (demotion/lock-out/soft-delete effective immediately); role changes re-sign the cookie without extending expiry.
- **Local dev**: `DEV_BYPASS_AUTH=true` in `.dev.vars` shows a quick-login picker on `/login`; every dev-login path 404s in production. See `docs/dev-experience/Local-Dev-Auth-Bypass.md`.

## 5. Documentation conventions

**Feature spec template** (`docs/specs/features/<name>.md`):

1. Status header (live/planned, date, related docs)
2. Purpose — one paragraph
3. Visibility and roles
4. API permissions — endpoint table
5. Feature behaviour / UI rules
6. Data model — feature-owned tables
7. Emails / integrations / tests where relevant

**Where things go**:

| Content | Home |
|---------|------|
| What a feature does + who may use it | `docs/specs/features/<name>.md` |
| Roles, conventions, matrix, error codes | this file |
| How the system is built (stack, flow, route inventory) | `docs/ARCHITECTURE.md` |
| Owner decisions + build phases | `docs/plans/*.md` (point-in-time) |
| Non-technical overview | `docs/specs/SWAPortal-Owner-Guide.md` |

Update the touched spec in the same commit as the code change; `progress.md` records the session.

## 6. Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `UNAUTHORIZED` | 401 | Not logged in |
| `FORBIDDEN` | 403 | Logged in but insufficient role |
| `RATE_LIMITED` | 429 | Too many requests |
| `INVALID_OR_EXPIRED` | 401 | OTP invalid or expired |
| `TOO_MANY_ATTEMPTS` | 429 | Too many OTP failures |
| `TURNSTILE_MISSING` | 400 | Missing Turnstile token |
| `TURNSTILE_FAILED` | 403 | Turnstile verification failed |
| `VALIDATION_ERROR` | 400 | Invalid request body |
| `CONFIG_ERROR` | 500 | Missing server config |
| `TOKEN_INVALID` | 401 | Magic link token invalid or expired |
| `FORM_CLOSED` | 403 | Buyer form past cutoff time |
| `FEATURE_DISABLED` | 503 | Feature switched off via the availability flags (§3.2) |
| `CONFLICT` | 409 | State conflict (e.g. approvals: item already actioned, wrong status for the action) |
