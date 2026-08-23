# Volunteer Registration Form — Technical Specification

**Status:** Live. Form at `/reg/volunteer/register` (Astro static), API at `/api/volunteer/*` + `/api/admin/forms/volunteer[?…]`.
**Last updated:** 2026-06-27.

## 1. Architecture

```
  Visitor
    │
    │  GET /reg/volunteer/register (Astro static page)
    ▼
  register.astro  ── fetch ──▶  GET /api/volunteer/config
    │                              │
    │  submit (form)               ├─ KV read: swa:volunteer_event_config (optional)
    │                              └─ merges with hardcoded DEFAULT_CONFIG
    ▼
  POST /api/volunteer/register
    │
    ├─ IP rate limit check (KV)
    ├─ Turnstile siteverify
    ├─ Load event config (KV)
    ├─ Server-side validation
    ├─ INSERT INTO volunteer_registrations (D1)
    ├─ POST to Resend (admin notification email)
    └─ Return {success, reference}

  Admin / Committee
    │
    ├─ GET /api/admin/forms/volunteer?search=…&event_key=…
    │     └─ SELECT FROM volunteer_registrations (D1) — LIMIT 500
    │
    └─ GET /api/admin/forms/volunteer/export
          └─ SELECT FROM volunteer_registrations (D1) — LIMIT 2000 → CSV
```

Astro builds the form page as a static HTML file at build time. All interactivity (config fetch, validation, submit) is client-side JS embedded inline in the page. The Hono worker serves only the API endpoints.

## 2. Route table

| Method | Path | Handler | Auth tier | Rate limit | File |
|--------|------|---------|-----------|------------|------|
| GET | `/api/volunteer/config` | `handleVolunteerConfig` | Public (no auth) | None | `volunteer-reg.ts:62` |
| POST | `/api/volunteer/register` | `handleVolunteerRegister` | Public (Turnstile) | 8 req / 15 min / IP | `volunteer-reg.ts:89` |
| GET | `/api/admin/forms/volunteer` | `handleVolunteerSubmissions` | Admin / Committee | Auth API RL (10/15min) | `volunteer-reg.ts:225` |
| GET | `/api/admin/forms/volunteer/export` | `handleVolunteerExport` | Admin / Committee | Auth API RL (10/15min) | `volunteer-reg.ts:266` |

**Middleware path:**
- `VOLUNTEER_API` set (`/api/volunteer`) **bypasses session auth** entirely (`middleware.ts:28-30, 77-79`). Turnstile is the gate.
- `ONLINE_FORMS_API` set (`/api/admin/forms`) requires `session.role === 'admin' || 'committee'` (`middleware.ts:40-42, 124-128`).
- Public paths in `PUBLIC_PATHS` bypass auth (`middleware.ts:7-13`).

## 3. Schema

### `volunteer_registrations` (`schema.sql:94-117`)

```sql
CREATE TABLE IF NOT EXISTS volunteer_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  contact_number TEXT NOT NULL,
  nric_last4 TEXT NOT NULL,
  emergency_contact TEXT NOT NULL,
  availability TEXT NOT NULL,        -- JSON array of date labels
  is_18_plus INTEGER NOT NULL,        -- 0 / 1
  medical_conditions TEXT NOT NULL,  -- 'none' | 'yes' | free text
  roles_interest TEXT NOT NULL,       -- JSON array of role strings
  affiliation TEXT NOT NULL,
  corporate_company TEXT,
  referral TEXT,
  consent INTEGER NOT NULL,           -- 0 / 1
  declaration INTEGER NOT NULL,       -- 0 / 1
  submitted_ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_volreg_event ON volunteer_registrations(event_key);
CREATE INDEX IF NOT EXISTS idx_volreg_email ON volunteer_registrations(email);
```

**Notable:** no UNIQUE constraint, no idempotency key, no natural key for dedup search. `availability` and `roles_interest` stored as JSON strings — parsed on read. `reference` shown to the visitor is `VOL-` + zero-padded `id` from the INSERT's `last_row_id`.

### `error_log` (`schema.sql:77-85`)

```sql
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at TEXT DEFAULT (datetime('now')),
  endpoint TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  http_status INTEGER,
  user_email TEXT
);
```

**Caveat:** during local smoke test on 2026-06-27, `error_log` did not exist in the local D1 (schema.sql not applied locally). `logError` swallows the "no such table" error silently and falls back to `console.error`. To apply: `npx wrangler d1 execute swa-portal --remote --file=schema.sql` (idempotent).

## 4. Request / response contracts (POST /api/volunteer/register)

**Request body:**
```json
{
  "fullName": "...", "email": "...", "contactNumber": "...",
  "nricLast4": "123A", "emergencyContact": "...",
  "availability": ["1st August (Saturday)"],
  "is18Plus": true,
  "medicalChoice": "no" | "yes" | "other",
  "medicalOther": "..." (if other),
  "rolesInterest": ["Befriender"],
  "affiliationChoice": "member_swa" | "laughter_yoga" | "new_volunteer" | "other",
  "affiliationOther": "..." (if other),
  "corporateCompany": "...", "referral": "...",
  "consent": true, "declaration": true,
  "turnstileToken": "..."
}
```

**Response matrix:**

| HTTP | `error_code` | Trigger | Body |
|------|-------------|---------|------|
| 200 | — | Successful INSERT | `{success:true, reference:'VOL-#####'}` |
| 400 | `VALIDATION_ERROR` | Body parse fail or field validation fail | `{success:false, errors:{field:"msg"}}` |
| 400 | `TURNSTILE_MISSING` | Token empty | `{...message:"Security verification required."}` |
| 500 | `CONFIG_ERROR` | `TURNSTILE_SECRET` env unset | `{...message:"Server configuration error."}` |
| 403 | `TURNSTILE_FAILED` | siteverify rejected | `{...message:"Security verification failed..."}` |
| 403 | `FORM_CLOSED` | `config.isActive===false` OR cutoff passed | `{...message:"Registrations are closed."}` |
| 429 | `RATE_LIMITED` | IP exceeds 8 / 15min | `{...message:"Too many submissions..."}` |
| **503** | **`D1_WRITE_FAILED`** | D1 transient retryable error (see §6.2) | `{...message:"We couldn't save your registration this time. Please click Submit again — your details are kept."}` |
| 500 | `UNEXPECTED_ERROR` | Any other uncaught error | `{...message:"Could not save your registration. Please try again."}` |

## 5. Validation rules

Client-side validation lives in `register.astro:411-481` (`collectForm`). Server-side validation lives in `volunteer-reg.ts:462-559` (`validateSubmission`). The rules mirror each other — see Functional Spec §4 for the field-by-field list. Server is the source of truth.

## 6. Security measures in place

### 6.1 Turnstile (anti-bot)
- Client loads `https://challenges.cloudflare.com/turnstile/v0/api.js` async.
- Site key exposed via `GET /api/turnstile-config` (safe — site keys are public).
- Secret verified server-side via POST to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `remoteip` (`volunteer-reg.ts:376-388`).
- Submissions without a valid token are rejected 400 / 403.
- In local dev without `TURNSTILE_SECRET`, the client logic gracefully disables the gate but the server still rejects — required for prod parity.

### 6.2 Rate limiting (IP-based, abuse guard)
- Key: `swa:rl:vol:<IP>` in `SWA_SESSION` KV.
- Window: 15 minutes. Max: 8 submissions (`volunteer-reg.ts:12-13`).
- Pattern: get → filter by window → push new timestamp → put. Writes to KV **on every allowed request** (anti-pattern — see Known limitations).
- Bucket: timestamp array, not a simple counter.

### 6.3 Input validation
All fields validated server-side (§5). HTML escape on every rendered field (`escapeHtml` in `register.astro:112` and `email-volunteer-notification.ts:23`). Length caps enforced both client (HTML maxlength) and server (validate strings).

### 6.4 No auth surface to attack
The public path bypasses session middleware entirely (`middleware.ts:77-79`). There is no cookie, no HMAC, no session verification on the submit path — Turnstile is the only gate. The admin/read paths require auth via the portal-wide OTP flow.

### 6.5 NRIC last-4 handling
- Server validates the format `^[0-9]{3}[A-Z]$` — i.e. requires 3 numeric + 1 alpha. This matches Singapore NRIC/FIN last-4 convention but also rules out some valid FIN patterns — accept this as a deliberate constraint.
- Client filters input to alnum and auto-uppercases.
- Stored in plaintext in D1 and included in the admin email body.

### 6.6 Email / IP capture
- `submitted_ip` and `user_agent` captured and stored in D1, also included in the admin notification email. This is audit data; privacy trade-off is acknowledged in the Functional Spec §8.

## 7. Resilience & observability measures in place

### 7.1 Error logging (`logError`)
Any server-side error path writes a row to `error_log`:

| Error case | `error_type` | `http_status` | Logged at |
|------------|--------------|---------------|-----------|
| D1 transient 503 | `D1_WRITE_FAILED` | 503 | `volunteer-reg.ts:215-224` (new, 2026-06-27) |
| Other server error | `UNEXPECTED_ERROR` (via `handleApiError`) | 500 | `error-handler.ts:18-24` |
| Resend email failure | `RESEND_NOTIFY` | 502 | `volunteer-reg.ts:659` |

**Best-effort:** `logError`'s own INSERT is wrapped in try/catch and falls back to `console.error` if it fails (e.g. when D1 itself is the outage — exactly the object-reset scenario). The more severe the D1 outage, the less likely the row lands.

### 7.2 D1 transient 503 handling (2026-06-27)

The Cloudflare D1 platform has a documented transient error class:
- `"storage caused object to be reset"`
- `"reset because its code was updated"`
- `"Internal error while starting up D1 DB storage"`
- `"Network connection lost"`

D1 **auto-retries read-only queries up to 2 more times**, but **does not auto-retry writes**. The volunteer registration handler catches the INSERT, matches against these substrings (`volunteer-reg.ts:243-251`), and returns HTTP 503 with `error_code:'D1_WRITE_FAILED'` and a user-friendly message. Non-matching errors keep the existing 500 / `UNEXPECTED_ERROR` path.

Client-side (`register.astro:509-513`), a new branch checks `res.status===503 && data.error_code==='D1_WRITE_FAILED'` before the existing validation/closed/generic branches. On match, it shows the friendly banner, **falls through** (no early return) to the shared cleanup that re-enables the submit button and resets Turnstile, leaving the form data populated. The visitor re-clicks Submit manually.

**Reference:** matcher and behaviour patterned after the GTW D1 Incident Report 2026-06-20 §4.0 (`gtw2026/docs/GTW-D1-Incident-Report-2026-06-20.md`).

### 7.3 Email failure non-blocking
The Resend send is awaited inline (`volunteer-reg.ts:188`) but wrapped in `.catch(()=>{})` — if Resend fails, the D1 row is already committed and the visitor still sees the success screen. The Resend failure is logged to `error_log` (`RESEND_NOTIFY`).

### 7.4 Form closed guard
Both `config.isActive===false` and `formCutoffTime < now` short-circuit the handler before the INSERT is attempted (`volunteer-reg.ts:136-141`). Closes via code edit or KV override (§6 of Functional Spec).

### 7.5 Workers Logs observability (2026-06-27)
`wrangler.jsonc` now includes an `observability` block enabling Workers Logs with 100% head sampling. `logError`'s `console.error` fallback (when the D1 log write fails) is now captured and retained in the Cloudflare dashboard.

## 8. Known limitations (risk-ranked)

### Critical
None.

### High
| # | Limitation | Risk | Future fix |
|---|------------|------|------------|
| L1 | **No idempotency key.** `volunteer_registrations` has no UNIQUE natural key; `VOL-#####` is derived from auto-increment ID after the INSERT. | A transient D1 503 whose write actually committed (the GTW scenario) will, on the visitor's manual retry, create a **duplicate row** — no dedup path exists. Today's 503 handler signals the visitor to retry; the retry is not safe against duplicates. | Add a client-generated `submission_ref` column with UNIQUE index (D1 ALTER + CREATE UNIQUE INDEX) and a duplicate-detection path that returns the existing reference on `UNIQUE constraint failed`. |
| L2 | **No server-side D1 retry wrapper.** Cloudflare's own published recommendation (Retry queries best-practices page) is to retry write-path transient errors with exp backoff + jitter. The 503 handler signals the visitor but does not retry writes. | Visitor sees a 503 for a transient error that could have been auto-recovered server-side. Higher friction than necessary. | Inline `shouldRetry` matcher + retry loop (~20 lines, mirroring `@cloudflare/actors`'s `tryWhile`) before falling through to the 503 response. Safe only after L1 is in place. |

### Medium
| # | Limitation | Risk | Future fix |
|---|------------|------|------------|
| L3 | **Inline `await sendNotification`.** Resend is awaited in the request-response cycle (`volunteer-reg.ts:188`), not deferred via `c.executionCtx.waitUntil`. | Response to the visitor is blocked on Resend's latency. If the worker hits CPU/wall-clock limits before Resend returns, the admin notification is silently lost while the D1 row is already saved. | Replace `await sendNotification(env, …).catch(()=>{})` with `c.executionCtx.waitUntil(sendNotification(env, …).catch(()=>{}))`. |
| L4 | **Submitter not BCC'd.** Only admin recipients receive the notification; the visitor does not receive a confirmation email. | Visitor has no email record of their submission. Relies on the on-screen reference number being captured. | Add `bcc: d.email` to the Resend request, or send a separate confirmation email to the visitor. Depends on Resend's verified-domain policy. |
| L5 | **KV rate-limit write-on-every-call.** `checkRateLimit` does `get → filter → push → put` on every allowed submission, consuming one KV write per request. | Same anti-pattern that triggered the GTW 2026 KV operation-limit warning during a 2-hour live event (50% of daily write quota). For volunteer-form volumes this is well within limits, but the pattern scales poorly and is against KV best-practice guidance. | Move to a counter bucket that increments via KV atomic semantics, or to a deferred token-bucket design that writes only when the limit is being approached. |

### Low
| # | Limitation | Risk | Future fix |
|---|------------|------|------------|
| L6 | **KV `notifyEmail` override accepts a single string, not an array.** Today the override branch (`volunteer-reg.ts:629-633`) replaces `VOLUNTEER_NOTIFY_EMAILS` entirely with one email. | If multiple admin recipients are needed per-event via KV, today the array case is silently dropped to the hardcoded defaults. | Change the KV schema to `notifyEmails: string[]` and extend the parser. Today this is a code edit of `VOLUNTEER_NOTIFY_EMAILS` per release. |
| L7 | **No automated tests.** No `*.spec.ts` or `*.test.ts` found. No Playwright config in the repo. | Regression risk on any future edit. The 503 handler was verified by manual smoke test with a temporary throwaway injection hook (now removed). | Add Vitest + Miniflare unit tests for `validateSubmission` and `isRetryableD1Error`. Add Playwright smoke test for the form's submit → success / submit → 503 paths. |
| L8 | **`error_log` table not confirmed in remote D1.** Schema declares the table; operational state unverified. | If the table is missing in prod, every `logError` call silently fails and errors only land in `console.error` (now captured by Workers Logs, so still visible). | Run `npx wrangler d1 execute swa-portal --remote --file=schema.sql` (idempotent), then verify with a `SELECT count(*)`. |
| L9 | **`is_18_plus`, `consent`, `declaration` stored as 0/1 INTEGER.** Reads need to coerce to boolean. Minor code friction. | Negligible — handlers do `row.is_18_plus ? 'Yes' : 'No'` on export. | Could move to BOOLEAN if a future schema migration warrants; not currently worth the churn. |

## 9. Configuration & deployment

### Local dev
```bash
npm install
npm run dev:worker    # wrangler dev on :8787 — static + API in one process
```

### Production
```bash
npm run deploy       # Astro build + wrangler deploy
```

### Required secrets & bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 `swa-portal` | All volunteer registrations + error_log |
| `SWA_SESSION` | KV | IP rate-limit cache (`swa:rl:vol:<IP>`) |
| `SWA_CONFIG` | KV | Optional `swa:volunteer_event_config` override (today: absent) |
| `R2_BUCKET` | R2 | Not used by the volunteer form |
| `RESEND_API_KEY` | secret | Admin notification email sending |
| `TURNSTILE_SECRET` | secret | Turnstile siteverify (POST path) |
| `TURNSTILE_SITE_KEY` | var | Turnstile widget site key (exposed via `/api/turnstile-config`) |
| `OTP_SECRET`, `SESSION_SECRET` | secrets | Used by the admin-login path, not the public form |

### Schema apply
```bash
npx wrangler d1 execute swa-portal --remote --file=schema.sql
npx wrangler d1 execute swa-portal --local  --file=schema.sql   # for local dev
```

### KV config update
```bash
npx wrangler kv key put swa:volunteer_event_config \
  '{"eventTitle":"…","dates":[…],"roles":[…],"isActive":true}' \
  --binding SWA_CONFIG --remote
```

### Querying error_log
```bash
npx wrangler d1 execute swa-portal --remote \
  --command "SELECT logged_at, endpoint, error_type, http_status FROM error_log ORDER BY id DESC LIMIT 50"
```

### Live log streaming (post-observability deploy)
```bash
npx wrangler tail swa-portal
```
Or dashboard → Workers & Pages → `swa-portal` → Observability.

## 10. Release history (most recent first)

| Date | Change | Files |
|------|--------|-------|
| 2026-06-27 | Friendly D1 transient 503 handling (server: matcher + 503; client: banner + fall-through cleanup) | `src/worker/api/volunteer-reg.ts`, `src/pages/reg/volunteer/register.astro` |
| 2026-06-27 | Workers Logs observability enabled (`logs.enabled=true`, `head_sampling_rate=1`, `persist=true`, `invocation_logs=true`; `traces.enabled=false`) | `wrangler.jsonc` |
| 2026-05-11 | Initial volunteer form (schema, API, page, CSS) | `schema.sql`, `src/worker/api/volunteer-reg.ts`, `src/pages/reg/volunteer/register.astro`, `src/styles/volunteer-form.css`, `src/worker/lib/email-volunteer-notification.ts` |