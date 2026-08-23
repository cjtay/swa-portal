# Membership Registration — Functional Specification

**Status:** Live (form + admin views + approve flow). Lifecycle management (members page UI + payment API) code complete 2026-07-14, pending D1 migration apply. Phase 2 (cron reminders, auto-inactivation) not yet built.
**Last updated:** 2026-07-14.

## 1. Purpose

The membership registration system allows members of the public to apply for SWA membership online. The applicant fills a simplified form, pays the first-year fee via PayNow (scanning a QR code generated on the page), uploads a payment screenshot and signature, and submits. An authorised approver then reviews the application in the admin portal and approves or rejects it. On approval, a member record is created with a fee due date anchored to 31 January, and the initial payment is logged.

The system also supports the ongoing membership lifecycle: admins can edit each member's role, fee due date, waived status, and record subsequent payments (including renewals and reactivations).

## 2. User roles

| Role | How they interact | Authentication |
|------|-------------------|----------------|
| **Public visitor** | Fills out and submits the form at `/reg/membership/register` | None — Turnstile only |
| **Approver** (Angela Wong, Roxanne Zhang, IT admins) | Reviews submissions, approves or rejects applications at `/admin/forms/membership` | OTP login via the SWA Portal + email in `isMembershipApprover()` allowlist |
| **Admin / Committee** | Views submissions, exports CSV, views PayNow screenshots and signatures. Manages member lifecycle (role, fee due date, payments) at `/members` | OTP login via the SWA Portal |
| **IT Admin** | Everything approvers and admins can do, plus delete members, configure infrastructure | OTP login + email in `IT_ADMIN_EMAILS` |

**Approver authority:** The approve/reject endpoints are gated by `isMembershipApprover(email)` — a helper that checks membership in `MEMBERSHIP_APPROVER_EMAILS ∪ IT_ADMIN_EMAILS`. Other admins retain member/booking CRUD but cannot approve or reject applications. Per 14-07-2026 SWA review, IT admins are included in the approver set.

## 3. Registration lifecycle from the visitor's perspective

1. **Page load.** The page fetches `GET /api/membership/config` and renders the form with the correct fee tier (Jan–Jun: S$20; Jul–Dec: S$10), PayNow merchant details, and a Turnstile widget. If config cannot be loaded, an error message is shown.
2. **Eligibility callout.** A callout box at the top states: membership is open to Singapore Citizens and PRs only; the fee tier depends on the month of submission; all memberships renew on 31 January at S$20.
3. **Form fill.** The visitor enters their full name, email, mobile number, and the name of the SWA board member who recommended them.
4. **PayNow QR generation.** As soon as the visitor has entered at least 2 characters of their name, a PayNow QR code is rendered on a `<canvas>`. The QR encodes the SWA UEN, the tier-resolved fee amount (locked — not editable by the payer), and a unique reference of the form `MEM-<NAME-SLUG>-<XXXX>`. The visitor scans this with their bank's PayNow feature to pay.
5. **Payment screenshot upload.** After paying, the visitor photographs or screenshots the successful transfer and uploads it. The image is auto-resized client-side if over 1 MB (capped at 1600px, JPEG quality 0.7).
6. **Signature.** The visitor draws their signature on a canvas (finger/stylus on touch, mouse on desktop) or uploads a signature image.
7. **PDPA consent.** The visitor ticks a mandatory PDPA consent checkbox acknowledging that their personal data will be used for processing and administering their membership application.
8. **Submit.** The visitor completes the Turnstile security check and clicks "Submit Application". The button enters a loading state.
9. **Outcomes:**
   - **Success** → confirmation screen with reference number (`MEM-<slug>-<XXXX>`), enquiry contact, and a "Submit another application" button.
   - **Validation error** → inline field errors + top banner "Please correct the highlighted fields." Form remains populated.
   - **D1 transient 503** → friendly banner: *"We couldn't save your application this time. Please click Submit again — your details are kept."* Form remains populated, submit button re-enabled, Turnstile reset. The visitor re-clicks Submit manually. If the original submission actually committed (race), the retry returns success with `is_duplicate: true` — the visitor sees the normal success screen.
   - **Network error / other server error** → top banner with the server message or "Submission failed. Please try again."

## 4. Form fields

| Field | Required | Validation | Max length | Notes |
|-------|----------|------------|------------|-------|
| Full Name | Yes | Non-empty, min 2 chars | — | Drives the PayNow QR reference slug |
| Email Address | Yes | Email regex | — | Lowercased before storage |
| Mobile No. | Yes | Non-empty | — | |
| Recommended By | Yes | Non-empty | — | Placeholder: "SWA Board Member" |
| PayNow screenshot | No (recommended) | JPG/PNG/WebP/HEIC, max 10 MB | — | Auto-resized if > 1 MB. Stored in R2. |
| Signature | Yes | Drawn on canvas OR uploaded image | — | PNG (drawn) or JPG/PNG (uploaded). Stored in R2. |
| PDPA Consent | Yes | Checkbox must be ticked | — | Stored as `pdpa_consent INTEGER` (0/1) in D1. |
| Turnstile token | Yes (prod) | Cloudflare siteverify | — | Skipped in local dev via `DEV_BYPASS_AUTH`. |

**Removed fields** (per 2026-07-13 simplification): NRIC, address (line 1/2/postal), date of birth, place of birth, citizenship, occupation, hobbies, skills/experiences, other associations, membership intent, home/office telephone. These columns remain in the D1 table (harmless, reversible) but are no longer collected on the form. The server-side INSERT binds `null` for unused columns.

## 5. Fee model

### First-year fee (tiered by submission month)

| Form submitted | Fee |
|----------------|-----|
| January – June | S$20 |
| July – December | S$10 |

The tier is resolved at two points:
1. **Form load** — the client reads `config.fee` (tier-resolved by current month) to render the PayNow QR with the correct amount.
2. **Approval time** — the server re-reads `membership_applications.created_at` month and re-resolves the tier. This is authoritative, covering the edge case where the applicant loaded the form in June but submitted in July.

### Renewal fee

S$20 per year, every year. All memberships renew on **31 January**.

### Fee due date

All members' `fee_due_date` is anchored to **31 January** each year:
- New members approved on or before 31 January of year Y → `fee_due_date = Y-01-31`.
- New members approved after 31 January of year Y → `fee_due_date = (Y+1)-01-31`.
- On payment recording, `fee_due_date` advances to the next 31 January.

### Who pays

| Category | Pays fees? | Can log in? |
|----------|-----------|-------------|
| `member` | Yes | No (unless individually enabled) |
| `committee` | Yes | Yes (if `can_login=1`) |
| `advisor` | No (`fee_waived=1` permanently) | Yes (if `can_login=1`) |
| `admin` | No (`fee_waived=1`) | Yes |
| `volunteer` | No (`fee_waived=1`) | Limited |

### Reactivation

Recording any payment flips `membership_status` from `inactive` → `active` and advances `fee_due_date` to the next 31 January. Per 13-07-2026 SWA review: "If it is paid anytime later, will change back from inactive to active."

### Fee storage

Per 14-07-2026 SWA review: fees are **hardcoded in `src/constants/portal.ts`** — not in KV or D1. The registration form reads them via `/api/membership/config`. The legacy `membership_types` D1 table is dormant and no longer read.

## 6. PayNow QR

The QR code is generated **entirely client-side** — no server round-trip is needed to render it. The implementation follows the EMVCo Merchant-Presented QR Specification v1.1 with the SG.PAYNOW extension.

### What the visitor sees

- A 240×240 px QR code rendered on a `<canvas>` (internal resolution 540×540 for print quality).
- The SWA logo overlaid in the centre (possible because the QR uses error correction level H — 30% recoverability).
- The payment reference (`MEM-<NAME-SLUG>-<XXXX>`) displayed below the QR.
- The amount (`S$20.00` or `S$10.00`) displayed below the reference.
- A "Download QR image" button that saves the canvas as a PNG file.

### QR payload contents

| Field | Value | Purpose |
|-------|-------|---------|
| Payload format | `01` | EMVCo standard |
| QR type | `12` | Dynamic (one-time) |
| Merchant account info | SG.PAYNOW, proxy type = UEN, proxy value = `S54SS0010L` | SWA's registered PayNow UEN |
| Amount editability | `0` (NOT editable) | The payer cannot change the amount |
| Currency | `702` (SGD) | |
| Amount | Tier-resolved (e.g. `20.00`) | Locked in the QR |
| Merchant name | `SWA` | Shown by the banking app |
| Bill reference | `MEM-<NAME-SLUG>-<XXXX>` (max 25 chars) | Appears on SWA's bank statement |
| CRC | CRC-16/CCITT-FALSE | Integrity check (last 4 hex digits) |

### Reference generation

The reference is `MEM-` + the applicant's name slugified (A–Z0–9 only, uppercased, max 12 chars) + `-` + 4 random base36 characters from `crypto.getRandomValues()`. Example: `MEM-JOHNDOE-A3F2`. Total length ≤ 25 chars to fit PayNow's reference field. The reference regenerates live as the visitor types their name.

## 7. Approval workflow

### Approver authority

Only `isMembershipApprover(email)` can approve or reject applications. This helper checks:
- `IT_ADMIN_EMAILS` — cjtay, angela.wong, system
- `MEMBERSHIP_APPROVER_EMAILS` — angela.wong, roxanne.zhang

Other admins and committee members can view submissions and export CSV but cannot transition `pending → approved` or `pending → rejected`.

### On approval (`POST /api/admin/forms/membership/:id/approve`)

1. The approver clicks "Approve" in the admin submissions view.
2. The server creates a new `members` row with:
   - `category='member'`, `can_login=0` (no portal access by default)
   - `membership_status='active'`
   - `fee_due_date` = next 31 January after today
   - `fee_waived=0`
3. The server logs the initial PayNow payment in `membership_payments` with the tier-resolved fee amount (re-checked by `membership_applications.created_at` month).
4. The server marks the application as `status='approved'` and captures the reviewer's email + timestamp. Steps 2–4 are an **atomic D1 batch** — all-or-nothing.
5. A welcome email is sent to the applicant (non-blocking via `waitUntil`).
6. The approver sees the member ID and fee due date in the response.

**Idempotency:** If the approver re-clicks "Approve" on an already-approved application, the server returns the existing `member_id` with `already_approved: true` — no duplicate row is created.

### On rejection (`POST /api/admin/forms/membership/:id/reject`)

1. The approver clicks "Reject" in the admin submissions view.
2. The server performs an atomic conditional `UPDATE … WHERE status='pending'`. If another approver raced (status already changed), returns 409 `CONFLICT`.
3. No member row is created. No payment is logged. No email is sent.

### Admin submissions view (`/admin/forms/membership`)

- **List page:** table of all submissions (newest first), searchable by name/email/reference/NRIC, sortable by columns (Ref, Full Name, Email, Submitted date).
- **Detail drawer:** click any row to open a side drawer showing the full application details, including the PayNow screenshot and signature image (streamed from R2 via `/api/admin/forms/membership/image/:id/:kind`).
- **CSV export:** `/api/admin/forms/membership/export` — UTF-8 BOM CSV with all fields, dates converted to Asia/Singapore time.
- **Access:** admin or committee role required (enforced in `middleware.ts` via `ONLINE_FORMS_API` set).

## 8. Members page lifecycle management

The members page at `/members` has been extended with membership lifecycle fields:

### Table columns (added)

| Column | Display | Source |
|--------|---------|--------|
| Status | Green "Active" / red "Inactive" badge | `members.membership_status` |
| Fee Due | DD-MM-YYYY format | `members.fee_due_date` (stored ISO YYYY-MM-DD) |
| Waived | "Yes" badge or dash | `members.fee_waived` |

### Edit modal (added fields)

- **Fee Due Date** — date picker (displays DD-MM-YYYY, sends ISO to server)
- **Membership Status** — dropdown (Active / Inactive)
- **Fee waived** — checkbox (auto-checked when category is changed to `advisor`, `admin`, or `volunteer`)

### Record Payment

Each non-waived member row has a "Payment" button that opens a modal with:
- Amount (SGD) — defaults to 20
- Method — PayNow / Cash / Cheque / Other
- Reference — free text (PayNow ref / receipt no.)
- Paid Date — defaults to today

On submit, the server:
1. Inserts a row into `membership_payments`.
2. Updates the member's `fee_due_date` to the next 31 January and sets `membership_status='active'` (covers reactivation).
3. Both operations are an atomic D1 batch.

### Payment history

`GET /api/members/:id/payments` returns the full payment history for a member, ordered by `paid_date DESC`. (API endpoint available; a UI view in the detail drawer is a future enhancement.)

## 9. Notification behaviour

### On submission (public form → admin)

| Property | Value |
|----------|-------|
| From | `SWA Portal <contactus@singaporewomenassociation.org>` |
| To | `MEMBERSHIP_NOTIFY_EMAILS` (cjtay, jolene.lim, angela.wong) |
| Subject | `New Membership Application: MEM-<slug>-<XXXX>` |
| Body | Branded HTML email with all submission fields + link to admin portal |
| Provider | Resend (`https://api.resend.com/emails`) |
| Blocking? | No — sent via `c.executionCtx.waitUntil()`. If Resend fails, the submission still succeeds. |

### On approval (admin → applicant)

| Property | Value |
|----------|-------|
| From | `SWA Portal <contactus@singaporewomenassociation.org>` |
| To | The applicant's email |
| Subject | `Welcome to the Singapore Women's Association` |
| Body | Branded HTML email with Member ID, next fee due date (DD-MM-YYYY), and annual fee amount |
| Provider | Resend |
| Blocking? | No — sent via `c.executionCtx.waitUntil()`. If Resend fails, the approval still succeeds. |

## 10. Privacy & data handling

- **PII captured:** full name, email, mobile number, referrer name, PayNow screenshot (image), signature (image), IP address, User-Agent. PDPA consent explicitly captured and stored.
- **PII stored in R2:** PayNow screenshots at `membership/paynow/<reference>.<ext>`, signature images at `membership/signature/<reference>.<ext>`. Accessible only via authenticated admin endpoints.
- **PII in D1:** all form fields stored in `membership_applications`. On approval, name/email/mobile are copied to the `members` table. Payment records in `membership_payments` contain amount, method, and reference (no additional PII).
- **PDPA consent:** mandatory checkbox. Submission is blocked unless ticked. Stored as `pdpa_consent INTEGER` (0/1) on the `membership_applications` row.
- **IP and User-Agent** captured and stored in D1 for audit. Included in the admin notification email body. No PII is sent to Turnstile beyond the IP (for `remoteip`).
- **Soft delete:** members can be soft-deleted (sets `deleted_at`, `can_login=0`). Records are retained for referential integrity. Hard delete is IT-admin only.
- **No automated retention policy.** Data is retained indefinitely unless manually purged.

## 11. Accessibility & UX notes

- ARIA-invalid attributes on fields with errors; error text toggled via `.is-open` class.
- Live error clearing on input — any user activity clears form-level alerts.
- Submit button shakes briefly on form-level error (mobile-friendly haptic cue).
- Mobile-first CSS (single stylesheet: `src/styles/membership-form.css`).
- Embed mode (`?embed=1`) hides the brand bar, event band, and footer for iframe use.
- Signature canvas supports both touch (pointer events) and mouse input.
- PayNow QR has a download button for applicants who prefer to scan from a saved image.
- PayNow screenshot upload auto-resizes large images before upload (reduces data usage on mobile).
- Turnstile uses an invisible widget with state-aware messaging ("loading", "error", "expired", "unavailable") instead of a generic "please complete security check".
