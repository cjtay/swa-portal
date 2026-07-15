# Membership Registration — Technical Specification

**Status:** Live (form + admin views + approve flow). Lifecycle management (members page UI + payment API) code complete 2026-07-14, pending D1 migration apply. Phase 2 (cron reminders, auto-inactivation) not yet built.
**Last updated:** 2026-07-14.

## 1. Architecture

```
  Visitor
    │
    │  GET /reg/membership/register (Astro static page)
    ▼
  register.astro  ── fetch ──▶  GET /api/membership/config
    │                              │
    │                              └─ Returns tier-resolved fee + PayNow merchant info
    │                                 (reads from hardcoded constants in portal.ts)
    │
    │  Client-side PayNow QR generation (EMVCo + CRC16, no server round-trip)
    │  Client-side image resize (canvas → JPEG if > 1 MB)
    │  Signature canvas (draw) or file upload
    │
    │  submit (multipart FormData: text fields + 2 file blobs)
    ▼
  POST /api/membership/register
    │
    ├─ IP rate limit check (KV, 10 req / 15 min / IP)
    ├─ Turnstile siteverify (skipped in dev bypass)
    ├─ Server-side validation (validateSubmission)
    ├─ Tier-resolve fee by current month
    ├─ R2 uploads: PayNow screenshot + signature image
    ├─ INSERT INTO membership_applications (D1)
    ├─ Idempotent retry on UNIQUE constraint failure
    ├─ Notification email via c.executionCtx.waitUntil() (non-blocking)
    └─ Return {success, reference}

  Approver (Angela / Roxanne / IT admin)
    │
    ├─ GET /api/admin/forms/membership          (list, search — admin/committee)
    ├─ GET /api/admin/forms/membership/export    (CSV — admin/committee)
    ├─ GET /api/admin/forms/membership/image/:id/:kind  (R2 stream — admin/committee)
    │
    ├─ POST /api/admin/forms/membership/:id/approve
    │     ├─ Gate: isMembershipApprover(email)
    │     ├─ Tier-resolve fee by membership_applications.created_at month
    │     ├─ Compute fee_due_date = next 31 January
    │     ├─ Atomic D1 batch: [INSERT member, INSERT payment, UPDATE application]
    │     └─ Welcome email via waitUntil (non-blocking)
    │
    └─ POST /api/admin/forms/membership/:id/reject
          ├─ Gate: isMembershipApprover(email)
          └─ Atomic conditional UPDATE … WHERE status='pending'

  Admin (member lifecycle management)
    │
    ├─ GET /api/members                  (list — any authenticated user)
    ├─ PATCH /api/members/:id            (edit — admin only)
    ├─ GET /api/members/:id/payments     (payment history — admin/committee)
    └─ POST /api/members/:id/payments    (record payment — admin only)
          ├─ Atomic D1 batch: [INSERT payment, UPDATE member fee_due_date/status]
          └─ Reactivates inactive members automatically
```

Astro builds the form page as a static HTML file at build time. All interactivity (config fetch, QR generation, validation, submit) is client-side JS embedded inline in the page. The Hono worker serves only the API endpoints. The `qrcode@1.4.4` library is shipped as a static asset at `/js/qrcode.min.js` (copied via `predev`/`prebuild` scripts, loaded dynamically on first QR render).

## 2. Route table

| Method | Path | Handler | Auth tier | Rate limit | File |
|--------|------|---------|-----------|------------|------|
| GET | `/api/membership/config` | `handleMembershipConfig` | Public (no auth) | None | `membership-reg.ts:71` |
| POST | `/api/membership/register` | `handleMembershipRegister` | Public (Turnstile) | 10 req / 15 min / IP | `membership-reg.ts:110` |
| GET | `/api/admin/forms/membership` | `handleMembershipSubmissions` | Admin / Committee | Auth API RL (10/15min) | `membership-reg.ts:360` |
| GET | `/api/admin/forms/membership/export` | `handleMembershipExport` | Admin / Committee | Auth API RL (10/15min) | `membership-reg.ts:399` |
| GET | `/api/admin/forms/membership/image/:id/:kind` | `handleMembershipImage` | Admin / Committee | Auth API RL (10/15min) | `membership-reg.ts:506` |
| POST | `/api/admin/forms/membership/:id/approve` | `handleMembershipApprove` | `isMembershipApprover(email)` | Auth API RL (10/15min) | `membership-reg.ts:553` |
| POST | `/api/admin/forms/membership/:id/reject` | `handleMembershipReject` | `isMembershipApprover(email)` | Auth API RL (10/15min) | `membership-reg.ts:688` |
| GET | `/api/members/:id/payments` | `handleMemberPayments` | Admin / Committee | Auth API RL (10/15min) | `members.ts:165` |
| POST | `/api/members/:id/payments` | `handleMemberPayments` | Admin only | Auth API RL (10/15min) | `members.ts:165` |

**Middleware path:**
- `MEMBERSHIP_API` set (`/api/membership`) **bypasses session auth** entirely (`middleware.ts:32-34, 86-88`). Turnstile is the gate for POST; GET config is fully open.
- `ONLINE_FORMS_API` set (`/api/admin/forms`) requires `session.role === 'admin' || 'committee'` (`middleware.ts:44-46, 163-167`).
- `/api/members/*` requires authentication. Writes (POST/PATCH/DELETE) require `session.role === 'admin'` (`middleware.ts:20-22, 140-144`).
- The `isMembershipApprover` gate is enforced **inside the handler**, not in middleware. This allows the middleware to pass admin/committee (so they can view submissions) while the handler rejects non-approvers on the approve/reject endpoints.

## 3. Schema

### `membership_applications` (`schema.sql:148-178`)

```sql
CREATE TABLE IF NOT EXISTS membership_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_type TEXT NOT NULL DEFAULT 'new',
  full_name TEXT NOT NULL,
  nric TEXT NOT NULL,                  -- legacy column; binds null for new submissions
  address_line1 TEXT NOT NULL,         -- legacy column; binds null
  address_line2 TEXT,
  address_postal_code TEXT NOT NULL,   -- legacy column; binds null
  phone_home TEXT,                     -- legacy column; binds null
  phone_office TEXT,                   -- legacy column; binds null
  email TEXT NOT NULL,
  handphone TEXT,
  date_of_birth TEXT,                  -- legacy column; binds null
  place_of_birth TEXT,                 -- legacy column; binds null
  citizenship TEXT,                    -- legacy column; binds null
  occupation TEXT,                     -- legacy column; binds null
  hobbies TEXT,                        -- legacy column; binds null
  skills_experiences TEXT,             -- legacy column; binds null
  other_associations TEXT,             -- legacy column; binds null
  membership_intent TEXT NOT NULL,     -- legacy column; binds '' for new submissions
  recommended_by TEXT,
  paynow_r2_key TEXT,                  -- R2 object key for PayNow screenshot
  signature_r2_key TEXT NOT NULL,      -- R2 object key for signature image
  signature_method TEXT NOT NULL,      -- 'draw' | 'upload'
  payment_reference TEXT NOT NULL,     -- MEM-<nameslug>-<rand>; UNIQUE via index
  payment_amount REAL NOT NULL DEFAULT 30,
  submitted_ip TEXT,
  user_agent TEXT,
  pdpa_consent INTEGER NOT NULL DEFAULT 0,  -- added by migration 005_pdpa_consent
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memapp_email ON membership_applications(email);
CREATE INDEX IF NOT EXISTS idx_memapp_ref ON membership_applications(payment_reference);
```

**Notable:** No `UNIQUE` constraint on `payment_reference` in the table definition, but idempotent retry logic catches `UNIQUE constraint failed` errors (the index may enforce uniqueness in practice via D1's internal handling). Legacy columns (NRIC, address, DOB, etc.) remain in the schema for backward compatibility but bind `null`/`''` for new submissions. The `status`, `reviewed_by`, `reviewed_at`, and `member_id` columns are added via `ALTER TABLE` in `schema.sql:175-179`.

### `members` — lifecycle fields (migration 005)

```sql
ALTER TABLE members ADD COLUMN membership_status TEXT DEFAULT 'active';
ALTER TABLE members ADD COLUMN fee_due_date TEXT;             -- ISO YYYY-MM-DD
ALTER TABLE members ADD COLUMN fee_waived INTEGER DEFAULT 0;
```

The `category` column defaults to `'committee'` (retained — the `committee→exco` rename was dropped 15-07-2026). Values: `admin`, `committee`, `advisor`, `member`, `volunteer`.

### `membership_payments` (migration 005)

```sql
CREATE TABLE IF NOT EXISTS membership_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  paid_date TEXT NOT NULL,             -- ISO YYYY-MM-DD
  amount REAL NOT NULL,
  method TEXT DEFAULT 'paynow',        -- 'paynow' | 'cash' | 'cheque' | 'other'
  reference TEXT,
  recorded_by TEXT,                    -- admin email
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mempay_member ON membership_payments(member_id);
CREATE INDEX IF NOT EXISTS idx_mempay_date ON membership_payments(paid_date);
```

### `error_log` — with `request_body` (migration 005)

```sql
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at TEXT DEFAULT (datetime('now')),
  endpoint TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  http_status INTEGER,
  user_email TEXT,
  request_body TEXT                    -- added by migration 005; redacted JSON summary
);
```

### Dormant tables (retained, not read/written)

- `memberships` — the old 14-column fee tracking table. No code writes to it since 2026-07-14. Retained for zero data loss.
- `membership_types` — held 2 fee rows ($30 first year, $20 renewal). No longer read; fees are hardcoded in `portal.ts`.

## 4. Request / response contracts

### POST /api/membership/register (multipart FormData)

**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `fullName` | text | Yes | Drives QR reference slug |
| `email` | text | Yes | Lowercased before storage |
| `handphone` | text | Yes | |
| `recommendedBy` | text | Yes | |
| `pdpaConsent` | text | Yes | `'true'` / `'false'` / `'on'` / `'1'` |
| `signatureMethod` | text | Yes | `'draw'` or `'upload'` |
| `turnstileToken` | text | Yes (prod) | Skipped in dev bypass |
| `paynowScreenshot` | File | No | JPG/PNG/WebP/HEIC, max 10 MB |
| `signature` | File | Yes | PNG (drawn) or JPG/PNG (uploaded) |

**Response matrix:**

| HTTP | `error_code` | Trigger | Body |
|------|-------------|---------|------|
| 200 | — | Successful INSERT | `{success:true, reference:'MEM-…'}` |
| 200 | — | Idempotent retry (UNIQUE on `payment_reference`) | `{success:true, reference:'MEM-…', is_duplicate:true}` |
| 400 | `VALIDATION_ERROR` | Body parse fail or field validation fail | `{success:false, errors:{field:"msg"}}` |
| 400 | `TURNSTILE_MISSING` | Token empty | `{...message:"Security verification required."}` |
| 500 | `CONFIG_ERROR` | `TURNSTILE_SECRET` env unset | `{...message:"Server configuration error."}` |
| 403 | `TURNSTILE_FAILED` | siteverify rejected | `{...message:"Security verification failed..."}` |
| 429 | `RATE_LIMITED` | IP exceeds 10 / 15min | `{...message:"Too many submissions..."}` |
| 503 | `D1_WRITE_FAILED` | D1 transient retryable error | `{...message:"We couldn't save your application..."}` |
| 500 | `UNEXPECTED_ERROR` | Any other uncaught error | `{...message:"Could not save your application..."}` |

### POST /api/admin/forms/membership/:id/approve

**Response:**

| HTTP | `error_code` | Trigger | Body |
|------|-------------|---------|------|
| 200 | — | Success | `{success:true, member_id:N, fee_due_date:'YYYY-MM-DD'}` |
| 200 | — | Already approved (idempotent) | `{success:true, member_id:N, already_approved:true}` |
| 403 | `FORBIDDEN` | Not an approver | `{...message:"You do not have authority..."}` |
| 404 | `NOT_FOUND` | Application id not found | |
| 409 | `CONFLICT` | Application was already rejected | |

### POST /api/admin/forms/membership/:id/reject

| HTTP | `error_code` | Trigger |
|------|-------------|---------|
| 200 | — | Success |
| 403 | `FORBIDDEN` | Not an approver |
| 404 | `NOT_FOUND` | Application not found |
| 409 | `CONFLICT` | Already approved, OR no longer pending (raced) |

### POST /api/members/:id/payments

**Request body:**
```json
{
  "amount": 20,
  "method": "paynow",
  "reference": "MEM-JOHNDOE-A3F2",
  "paid_date": "2026-07-14"
}
```

**Response:**

| HTTP | Body |
|------|------|
| 200 | `{success:true, fee_due_date:'2027-01-31'}` |
| 400 | `{success:false, message:"A valid amount is required."}` |
| 403 | `{success:false, error_code:"FORBIDDEN", message:"Admin access required..."}` |
| 500 | `{success:false, message:"Could not record payment."}` |

## 5. Validation rules

Client-side validation lives in `register.astro:687-709` (`collectErrors`). Server-side validation lives in `membership-reg.ts:872-943` (`validateSubmission`). The rules mirror each other — server is the source of truth.

| Field | Client rule | Server rule |
|-------|-------------|-------------|
| fullName | Non-empty, min 2 chars | Non-empty, min 2 chars |
| email | Email regex | Email regex, lowercased |
| handphone | Non-empty | Non-empty |
| recommendedBy | Non-empty | Non-empty |
| pdpaConsent | Checkbox ticked | `'true'` / `'on'` / `'1'` |
| signature | Canvas has content OR file selected | File present, MIME check, size check |
| paynowScreenshot | File size ≤ 10 MB | MIME in ALLOWED_MIME, size ≤ 10 MB |
| turnstileToken | State-aware messaging | siteverify (skipped in dev bypass) |

**Layered validation pattern:** HTML attributes (where applicable) → client JS (`collectErrors`) → server (`validateSubmission`). Pattern adopted from gtw2026.

## 6. Security measures

### 6.1 Turnstile (anti-bot)

- Invisible widget loaded via `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`.
- Site key exposed via `GET /api/turnstile-config` (safe — site keys are public). Returns empty siteKey in dev bypass.
- Secret verified server-side via POST to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `remoteip` (`membership-reg.ts:142-149`).
- State-aware client messaging: `loading` → `ready` → `error`/`expired`/`unavailable`/`bypassed`.
- In local dev (`DEV_BYPASS_AUTH==='true'`), both the widget and server verification are skipped.

### 6.2 Rate limiting (IP-based)

- Key: `swa:rl:mem:<IP>` in `SWA_SESSION` KV.
- Window: 15 minutes. Max: 10 submissions (`portal.ts:74-75`).
- Pattern: get → filter by window → push new timestamp → put with `expirationTtl`.
- **Limitation:** read-then-write is not atomic — it is a soft guard. Concurrent requests can both pass the check. Acceptable for the use case.

### 6.3 Approver gate (`isMembershipApprover`)

```ts
export function isMembershipApprover(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    (IT_ADMIN_EMAILS as readonly string[]).includes(lower) ||
    (MEMBERSHIP_APPROVER_EMAILS as readonly string[]).includes(lower)
  );
}
```

Defined in `src/constants/portal.ts`. Called in `handleMembershipApprove` and `handleMembershipReject`. This is a **handler-level gate**, not middleware — middleware passes admin/committee for the `ONLINE_FORMS_API` path (so they can view submissions), and the handler enforces the approver subset on the approve/reject verbs.

### 6.4 Input validation

All text fields validated server-side (§5). HTML escape on every rendered field in email templates (`escapeHtml` in `register.astro:678` and `email-membership-notification.ts`). Length caps not explicitly enforced server-side for all fields (the simplified form has few fields and the INSERT binds null for legacy columns) — a future hardening pass could add explicit length checks.

### 6.5 R2 image streaming

PayNow screenshots and signatures are stored in R2 at:
- `membership/paynow/<reference>.<ext>`
- `membership/signature/<reference>.<ext>`

Retrieved via `GET /api/admin/forms/membership/image/:id/:kind` — streams `object.body` with `Cache-Control: private, max-age=3600`. Auth-gated via the `ONLINE_FORMS_API` middleware check (admin/committee only). No presigned URLs (R2 Workers binding does not support them).

### 6.6 PayNow QR integrity

The QR amount is locked (field 03 = `0`, NOT editable by the payer). The CRC-16/CCITT-FALSE checksum (last 4 hex digits) ensures the payload has not been tampered with. Any modification to the payload string by a banking app would fail the CRC check. The UEN (`S54SS0010L`) is SWA's registered PayNow merchant identifier.

### 6.7 Wrangler body size limit

`wrangler.jsonc` includes `"limits": { "max_request_body_size": 20971520 }` (20 MB). This is required for multipart uploads (PayNow screenshot + signature) to succeed. Without it, the Workers default limit silently rejects larger requests.

## 7. Resilience & observability

### 7.1 Idempotent retry on UNIQUE constraint failure

If the `INSERT INTO membership_applications` fails with a `UNIQUE constraint failed` error on `payment_reference` (client timeout + retry scenario), the handler catches it, queries for the existing row by `payment_reference`, and returns `{success:true, reference, is_duplicate:true}`. The visitor sees the normal success screen. Pattern adopted from gtw2026's `submit-tickets.ts:354-390`.

### 7.2 Non-blocking side-effects via `c.executionCtx.waitUntil()`

Both email sends (notification on submission, welcome on approval) are wrapped in `c.executionCtx.waitUntil()` with `.catch()` that logs to `error_log`. The response to the user is never blocked on email latency, and an email failure never fails the submission/approval. Pattern adopted from gtw2026.

### 7.3 D1 transient 503 handling

The handler catches D1 write errors and matches against known transient error substrings (`isRetryableD1Error` at `membership-reg.ts:821`):
- `"storage caused object to be reset"`
- `"reset because its code was updated"`
- `"Internal error while starting up D1 DB storage"`
- `"Network connection lost"`

On match, returns HTTP 503 with `error_code:'D1_WRITE_FAILED'` and a user-friendly message. The client shows the friendly banner and leaves the form populated for manual retry.

### 7.4 Error logging with `request_body`

All error paths write to `error_log` via `logError()`. Since migration 005, the `request_body` column captures a **redacted JSON summary** of the request (reference, name, email, fee — no file bytes, no full PII). This is invaluable for post-incident forensics. Pattern adopted from gtw2026's `gtw_error_log`.

### 7.5 Atomic D1 batch operations

The approve flow and payment recording use `env.DB.batch([...])` for atomic multi-statement execution:
- **Approve:** `[INSERT payment, UPDATE application WHERE status='pending']` (member INSERT is separate because its `last_row_id` is needed for the batch).
- **Record payment:** `[INSERT payment, UPDATE member SET fee_due_date + membership_status]`

If any statement in the batch fails, all are rolled back. Pattern adopted from gtw2026's `submit-tickets.ts:282-456`.

### 7.6 Workers Logs observability

`wrangler.jsonc` includes an `observability` block with `logs.enabled=true`, `head_sampling_rate=1`, `persist=true`. `logError`'s `console.error` fallback (when the D1 log write itself fails) is captured and retained in the Cloudflare dashboard.

## 8. PayNow QR implementation

### 8.1 EMVCo payload builder

The payload is built client-side in `register.astro:95-114`, mirroring the server-side `src/worker/lib/paynow-qr.ts` (which is available for server-side use but not called — the QR is purely client-side rendering of a deterministic string).

**Field structure (TLV — Tag, Length, Value):**

```
00  02  01          Payload format indicator (01 = EMVCo)
01  02  12          QR type (12 = dynamic/one-time)
26  XX  [SG.PAYNOW sub-fields]
52  04  0000        Merchant category code
53  03  702         Currency (702 = SGD)
54  XX  20.00       Amount (2 decimal places)
58  02  SG          Country code
59  XX  SWA         Merchant name (max 25 chars)
60  09  Singapore   Merchant city
62  XX  [01 <reference>]  Additional data (bill reference)
63  04  <CRC>       CRC-16/CCITT-FALSE (4 hex digits)
```

**SG.PAYNOW sub-fields (within field 26):**

```
00  10  SG.PAYNOW   PayNow identifier
01  01  2           Proxy type (2 = UEN)
02  09  S54SS0010L  Proxy value (SWA UEN)
03  01  0           Amount editability (0 = NOT editable)
```

### 8.2 CRC-16/CCITT-FALSE

Poly `0x1021`, init `0xFFFF`, no final XOR, no reflection. Returns 4 uppercase hex digits. Implementation at `register.astro:85-93` and `paynow-qr.ts:24-33`.

### 8.3 Canvas rendering

- Library: `qrcode@1.4.4`, loaded dynamically from `/js/qrcode.min.js` (copied via `predev`/`prebuild` npm scripts).
- Render: `QRCode.toCanvas(canvas, qrStr, { width: 540, margin: 1, errorCorrectionLevel: 'H' })`.
- Display size: 240×240 px (CSS), internal 540×540 (device pixels for print quality).
- SWA logo overlay: drawn at centre after QR render. White circle background (radius = 16% of canvas size) + logo image at 70% of circle radius. Works because error correction level H tolerates 30% data loss.

### 8.4 Reference generation

`buildMembershipReference(fullName, randomSuffix)` in `paynow-qr.ts:91-101`:
- Slug: full name → uppercase → strip non-alphanumerics → max 12 chars.
- Suffix: 4 random base36 chars from `crypto.getRandomValues()`.
- Result: `MEM-<slug>-<suffix>` (max 25 chars total).

The client regenerates the reference live as the visitor types their name (`register.astro:124-128`).

## 9. Known limitations (risk-ranked)

### Critical

None.

### High

| # | Limitation | Risk | Future fix |
|---|------------|------|------------|
| L1 | **No `UNIQUE` constraint on `payment_reference` in schema.** The idempotent retry catches `UNIQUE constraint failed` errors, but the column has no explicit `UNIQUE` index in the table definition. The `idx_memapp_ref` index is non-unique. | If D1 does not enforce uniqueness, duplicate submissions could create duplicate rows. The idempotent retry path may never trigger. | `ALTER TABLE membership_applications ADD CONSTRAINT … UNIQUE (payment_reference)` or `CREATE UNIQUE INDEX … ON membership_applications(payment_reference)`. |
| L2 | **No server-side D1 retry wrapper.** D1 does not auto-retry writes. The 503 handler signals the visitor to retry manually. | Visitor sees a 503 for a transient error that could have been auto-recovered. | Add inline retry with exp backoff before falling through to 503. |

### Medium

| # | Limitation | Risk | Future fix |
|---|------------|------|------------|
| L3 | **Read-then-write rate limit is non-atomic.** Concurrent requests can both pass the check. | Bot could submit multiple forms in a burst. Acceptable for current volume. | Move to atomic counter or deferred token-bucket. |
| L4 | **No server-side pagination on submissions list.** `handleMembershipSubmissions` returns `LIMIT 500`. | At scale, older submissions are not accessible via the UI. | Add `offset` parameter + pagination UI. |
| L5 | **Legacy columns still in INSERT.** The `INSERT INTO membership_applications` binds null/empty for ~12 legacy columns (NRIC, address, DOB, etc.). | Slightly larger D1 writes, noisier schema. Harmless. | Drop the legacy columns from the INSERT statement (keep the table columns for backward compat). |
| L6 | **No automated tests.** No `*.spec.ts` or `*.test.ts` found. | Regression risk on future edits. | Add Vitest + Miniflare unit tests for `validateSubmission`, `resolveFirstYearFee`, `nextFeeDueDate`, `isMembershipApprover`. |

### Low

| # | Limitation | Risk | Future fix |
|---|------------|------|------------|
| L7 | **`error_log.request_body` column not yet applied to prod D1.** Migration 005 is written but not yet applied. `logError` writes will fail silently on the `request_body` column until the migration runs. | Forensic `request_body` data is not captured in prod yet. Falls back to `console.error`. | Apply migration 005 to prod D1. |
| L8 | **No payment history UI in the member edit drawer.** The `GET /api/members/:id/payments` endpoint exists but the admin UI does not yet render a payment history view. | Admins cannot see past payments without querying D1 directly. | Add a "Payment History" tab to the member edit modal. |
| L9 | **Submitter not emailed a copy.** Only admin recipients receive the notification on submission. The applicant gets the on-screen reference but no email confirmation until approval. | Applicant has no email record of their submission. | Add `bcc: d.email` to the Resend request, or send a separate confirmation email. |

## 10. Configuration & deployment

### Local dev

```bash
npm install
npm run dev:worker    # wrangler dev on :8787 — static + API in one process
```

The `predev` script copies `node_modules/qrcode/build/qrcode.min.js` to `public/js/qrcode.min.js`.

### Production

```bash
npm run deploy       # Astro build + wrangler deploy
```

### Required secrets & bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 `swa-portal` | All membership data (applications, members, payments, error_log) |
| `SWA_SESSION` | KV | IP rate-limit cache (`swa:rl:mem:<IP>`) + OTP/session storage |
| `SWA_CONFIG` | KV | Phase 2 reminder config (not used by Phase 1 — fees are hardcoded) |
| `R2_BUCKET` | R2 `swa-portal-uploads` | PayNow screenshots + signature images |
| `RESEND_API_KEY` | secret | Email sending (notification + welcome) |
| `TURNSTILE_SECRET` | secret | Turnstile siteverify (POST path) |
| `TURNSTILE_SITE_KEY` | var | Turnstile widget site key (exposed via `/api/turnstile-config`) |
| `OTP_SECRET`, `SESSION_SECRET` | secrets | Used by the admin-login path, not the public form |
| `SWA_ADMIN_DOMAIN` | var | Admin portal URL (used in notification email links) |

### Wrangler config

```jsonc
"limits": {
  "max_request_body_size": 20971520   // 20 MB — required for multipart uploads
}
```

### Schema apply

```bash
./node_modules/.bin/wrangler d1 execute swa-portal --remote --file=migrations/005_membership_lifecycle.sql
./node_modules/.bin/wrangler d1 execute swa-portal --local  --file=migrations/005_membership_lifecycle.sql
```

**Important:** migration 005 must be applied before deploying the lifecycle code. Without the new columns (`membership_status`, `fee_due_date`, `fee_waived`), the approve flow and payment API will fail.

### One-time data rename (after deploy)

```sql
-- DROPPED 15-07-2026 — committee is retained. Kept here for historical reference only. Do NOT run.
-- UPDATE members SET category = 'exco' WHERE category = 'committee';
```

This data rename is **no longer required**. `verify-otp.ts` maps `category='committee'` → the committee login tier (catch-all). See `docs/membership-lifecycle-plan.md` §8.

### Querying error_log

```bash
./node_modules/.bin/wrangler d1 execute swa-portal --remote \
  --command "SELECT logged_at, endpoint, error_type, http_status, request_body FROM error_log ORDER BY id DESC LIMIT 50"
```

### Live log streaming

```bash
./node_modules/.bin/wrangler tail swa-portal
```
Or dashboard → Workers & Pages → `swa-portal` → Observability.

## 11. Release history (most recent first)

| Date | Change | Files touched |
|------|--------|---------------|
| 2026-07-15 | **Revert `committee→exco` rename** — dropped the planned category rename; `committee` retained. Reverted dropdowns/defaults/comments (members.astro, members.ts, verify-otp.ts, schema.sql) to `committee`. No data UPDATE required. Updated 13 docs to match. | `src/pages/members.astro`, `src/worker/api/members.ts`, `src/worker/api/verify-otp.ts`, `schema.sql`, `migrations/005_membership_lifecycle.sql`, 13 doc files |
| 2026-07-14 | Lifecycle rewrite: approve flow rewritten (atomic batch, `isMembershipApprover`, tier-resolve by submission month, next-31-Jan `fee_due_date`, stop writing `memberships`); members page UI (status/fee_due/waived columns, record-payment modal, role editing); payment API (`GET/POST /api/members/:id/payments`); server hardening (idempotent retry on UNIQUE, `waitUntil` for emails, `request_body` in error_log); `committee → exco` code changes + doc sweep; migration 005 written; `wrangler.jsonc` body-size limit; `isMembershipApprover()` helper | `src/worker/api/membership-reg.ts`, `src/worker/api/members.ts`, `src/worker/index.ts`, `src/pages/members.astro`, `src/constants/portal.ts`, `src/worker/api/verify-otp.ts`, `src/worker/lib/log-error.ts`, `schema.sql`, `migrations/005_membership_lifecycle.sql`, `wrangler.jsonc`, 9 doc files |
| 2026-07-13 | Form simplification: removed NRIC/address/DOB/citizenship/occupation/hobbies/skills/associations/intent/telephone from the public form; replaced Declaration with PDPA consent (migration `005_pdpa_consent.sql`); referrer placeholder → "SWA Board Member"; eligibility + tiered-fee callout; tiered fees hardcoded in `portal.ts`; `MEMBERSHIP_APPROVER_EMAILS` constant added; `payment_amount` tier-resolved at submission; client-side image resize; PayNow QR canvas renderer with SWA logo overlay; `qrcode@1.4.4` dep + copy scripts | `src/pages/reg/membership/register.astro`, `src/worker/api/membership-reg.ts`, `src/constants/portal.ts`, `package.json`, `migrations/005_pdpa_consent.sql` |
| 2026-05-11 | Initial membership application form (schema, API, page, CSS, email notification) | `schema.sql`, `src/worker/api/membership-reg.ts`, `src/pages/reg/membership/register.astro`, `src/styles/membership-form.css`, `src/worker/lib/email-membership-notification.ts` |
