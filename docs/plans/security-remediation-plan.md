# Security Remediation Plan — SWA Portal

**Date:** 2026-08-21
**Status:** Not started
**Source:** Full security audit (worker API + frontend) conducted 2026-08-21
**Scope:** All Critical, High, and Medium findings. Low/informational items listed
under "Out of scope".

## Audit Summary

No secrets or API keys are exposed (git history scanned clean; `.dev.vars`
gitignored; secrets held as Cloudflare Worker secrets). No SQL injection — all
queries parameterised. Session crypto solid (HMAC-SHA256, constant-time compare,
correct cookie flags). Server-side authorisation consistently enforced.

Issues found: 1 critical, 2 high, 7 medium. Details per phase below.

---

## Phase 1 — CRITICAL: Stale-session privilege escalation

**Problem:** Role (`role`, `regRole`) is resolved once at login and baked into
the HMAC session cookie (`src/worker/api/verify-otp.ts:102-109`). Middleware
trusts the cookie for every request (`src/worker/middleware.ts:145-179`). No
handler re-reads D1. A demoted or soft-deleted member keeps full old privileges
until cookie expiry — up to 12h, or **30 days** with "remember me"
(`SESSION_EXTENDED_EXPIRY_MS`, `src/constants/portal.ts:15`). No way to force
logout (stateless sessions).

**Fix:**
1. In `authMiddleware` (`src/worker/middleware.ts`), after HMAC verification,
   re-fetch the member from D1 by session email:
   ```sql
   SELECT category, reg_role, can_login, deleted_at FROM members WHERE email = ?
   ```
2. Reject (401) + clear `swa_session` cookie when:
   - row missing, OR `can_login = 0`, OR `deleted_at IS NOT NULL`
3. On role mismatch (cookie role ≠ freshly derived role), re-sign the cookie
   with fresh roles using `resolveSessionRole` (`src/worker/lib/session-role.ts`)
   so the downgrade takes effect immediately.
4. Performance tradeoff: adds one D1 read per authenticated request. Acceptable
   at this scale; optional micro-optimisation later via short-TTL KV cache
   (60s) keyed by email — do NOT implement now unless latency is observed.
5. Apply the same revalidation inside `getSession()` consumers where relevant
   (`src/worker/api/session.ts:113-146`) so `/api/session` reflects reality.

**Tests:**
- Demote admin → committee mid-session → next request acts as committee,
  cookie refreshed.
- Soft-delete member mid-session → next request 401 + cookie cleared.
- Deleted member's OTP login blocked (already works — regression check).

---

## Phase 2 — HIGH: Hide namecard feature (no deletion)

**Problem:** Public `/c/:slug` pages (`src/worker/api/namecard-public.ts`)
expose member email, mobile, home address unauthenticated; slugs guessable.
AGENTS.md says feature was removed 19-07-2026 but it is fully live. Decision:
**hide, do not delete** — keep all code restorable.

**Fix:**
1. **Disable Astro page generation:** rename
   `src/pages/namecards.astro` → `src/pages/_namecards.astro`.
   Astro ignores `_`-prefixed files under `src/pages` — no page emitted at
   build time. File remains in repo.
2. **Disable worker public routes:** comment out the entire
   "Public namecard surface (/c/*)" registration block in
   `src/worker/index.ts:54-66` with a marker comment:
   ```ts
   // ── DISABLED 2026-08: public namecard surface hidden (security audit).
   // Restore by uncommenting + renaming _namecards.astro back. ──
   ```
   After this, `/c/*` returns 404 from the worker.
3. Remove `"/c/*"` from `run_worker_first` in `wrangler.jsonc:9` (optional but
   tidy — no worker handling needed while disabled).
4. Hide the admin nav link to `/namecards` in `src/layouts/AdminLayout.astro`
   (locate nav entries; comment out with same marker).
5. Leave untouched (documented): `src/worker/api/namecards.ts` (authenticated
   admin CRUD API — harmless), `public/js/namecard-qr.js` (inert static asset),
   DB columns/migrations, `namecard-rate-limit.ts`.

**Tests:** `npm run build` → no `/namecards/index.html` in dist;
`GET /c/<slug>` → 404; admin nav shows no Namecards link; authenticated
`/api/namecards` still responds (unused but intact).

---

## Phase 3 — HIGH: Stored XSS via membership fullName → members.astro

**Problem:** Public application form validates `fullName` only for length ≥ 2
(`src/worker/api/membership-reg.ts:911-913`). On approval the raw value lands
in `members.name`. `src/pages/members.astro:190-210` interpolates member fields
into `innerHTML` unescaped → attacker-supplied `<img src=x onerror=...>` runs
in every admin/committee browser viewing /members.

**Fix:**
1. Add an `escapeHtml` helper to `members.astro` (mirror the pattern already
   used in `src/pages/admin/forms/*.astro`) and escape every interpolated
   field in the table render (name, role, email, category, etc.).
2. Server-side allowlist validation of `fullName` at submission
   (`membership-reg.ts`): Unicode letters, spaces, hyphen, apostrophe, period;
   reject `<>&"'` and control chars; cap length (e.g. 100).
3. Fix secondary unescaped sinks (admin→volunteer stored XSS, low practical
   risk but trivial):
   - `src/pages/reg/volunteer/search.astro:175`
   - `src/pages/reg/admin/bookings.astro:177-178`
   - `src/pages/reg/volunteer/add-walkin.astro:53`

**Tests:** Submit application with `<img src=x onerror=alert(1)>` as name →
rejected server-side; manually insert such a name in local D1 → members table
renders it inert (escaped).

---

## Phase 4 — MEDIUM batch

### 4a. PII column filtering in member APIs
Files: `src/worker/api/members.ts:17,87`

**Decision (2026-08-21): NRIC is not displayed anywhere today — exclude it from
ALL API responses. Revisit only if a genuine workflow need appears.**

- Replace `SELECT *` with an explicit column list excluding `nric` for both
  `GET /api/members` (line 17) and `GET /api/members/:id` (line 87).
- Add `AND deleted_at IS NULL` to the `GET /api/members/:id` query (line 87).
- If a future feature needs NRIC, add a dedicated admin-only endpoint rather
  than reintroducing `SELECT *`.

### 4b. Rate limits on unthrottled authenticated writes
File: `src/worker/lib/rate-limit.ts:35-64` (`getEndpointKey`)
Add limits for:
- `POST /api/reg/admin/send-magic-link/:bookingId` (e.g. 5/hour)
- `POST /api/reg/volunteer/walkin|arrive/:id|guest/:id` (e.g. 30/15min)
- `POST /api/namecards/:id/photo` (e.g. 10/hour)
- `POST /api/admin/forms/membership/:id/approve|reject` (e.g. 20/hour)

### 4c. CSV formula injection
Files: `csvEscape()` in `src/worker/api/membership-reg.ts:857-863`,
`volunteer-reg.ts:473-479`, `reg/admin-export.ts:54-60`
Neutralise leading `=` `+` `-` `@` (and tab/CR) by prefixing `'`.
Consider extracting one shared `csvEscape` into `src/worker/lib/` and
importing everywhere (three divergent copies exist).

### 4d. JSON-LD escaping on namecard HTML
File: `src/worker/api/namecard-public.ts:349-366`
Escape `<` as `\u003c` in the JSON.stringify serializer. (Feature currently
hidden per Phase 2, but fix anyway so restore is safe.)

### 4e. Dev-bypass host allowlist hardening
File: `src/worker/api/session.ts:24-31`
Restrict `isDevBypassHost` to localhost/127.0.0.1 only — remove production
custom domain and `*.workers.dev` matches so an accidental
`DEV_BYPASS_AUTH=true` var leak fails closed instead of disabling auth.

### 4f. Bookings input validation
File: `src/worker/api/bookings.ts:72-123`
- Reject NaN attendees: `if (!Number.isInteger(attendees) || attendees < 1)`
- Validate `booker_email` format before use as Resend recipient.

---

## Phase 5 — Housekeeping

1. Delete `prod-dump.sql` from the repo folder (real member PII on disk;
   gitignored but one `git add -f` away from leakage). Move outside workspace
   if retention needed. **User-invoked action — confirm before deleting.**
2. Consider `workers_dev: false` after `admin.singaporewomenassociation.org`
   cutover (removes bypass origin for domain-scoped WAF rules). Decision
   deferred — requires workers.dev access until domain transfer completes.

---

## Verification (after each phase)

```bash
npm run cf-typegen && npm run build   # typecheck + build
npm run dev                            # manual matrix below
```

Regression matrix:
- Local dev quick-login picker still works (dev-login paths)
- Login → OTP → session flow end-to-end
- Members page renders, approve/reject membership flow
- Booking create/cancel (committee + admin)
- Registration forms submit (membership/volunteer/laughter-yoga)
- `GET /c/x` → 404; `/namecards` → 404

## Out of scope (noted, not planned)

- KV rate limiter non-atomicity (needs Workers Rate Limiting binding or
  Durable Objects — architectural change)
- CSP nonce/hash work to drop `'unsafe-inline'`; HSTS; Permissions-Policy
- OTP modulo bias (~0.04%, negligible given existing attempt caps)
- Session revocation infrastructure beyond Phase 1 revalidation
- Magic-link token returned in API response body (admin-only surface)
