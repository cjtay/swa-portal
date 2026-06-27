# Volunteer Registration Form — Functional Specification

**Status:** Live. Form available at `/reg/volunteer/register`.
**Last updated:** 2026-06-27.

## 1. Purpose

The volunteer registration form allows members of the public to register their interest in volunteering for a specific SWA event (currently: NDP 2026 befriender sessions at Ren Ci Community Hospital and Bukit Batok). The form is public — no login is required. Submissions are stored in D1 and an email notification is sent to a configurable admin recipient list.

## 2. User roles

| Role | How they interact with the form | Authentication |
|------|--------------------------------|----------------|
| **Public visitor** | Fills out and submits the form at `/reg/volunteer/register` | None — Turnstile only |
| **Admin / Committee** | Views submissions and exports CSV from `/admin/forms/volunteer` | OTP login via the SWA Portal |
| **IT Admin** | Configures the form via KV (`swa:volunteer_event_config`) and deploys | IT Admin tier |

## 3. Form lifecycle from the visitor's perspective

1. **Page load.** The page fetches `GET /api/volunteer/config` and renders the event title, intro HTML, date options, role options, consent and declaration statements, enquiry contact, and a Turnstile widget. If the config cannot be loaded, an error message is shown and the form does not render.
2. **Form fill.** The visitor fills personal particulars (name, email, contact, NRIC last 4, emergency contact), selects availability (one or more dates), confirms 18+ status, declares medical conditions, selects roles of interest, selects affiliation, optionally fills corporate company / referral fields, and ticks consent + declaration.
3. **Client-side validation** runs on every field before the submit button is enabled. Live error clearing on edit. ARIA-invalid attributes and per-field inline error messages guide the visitor.
4. **Submit.** The visitor completes Turnstile, then clicks "Submit Registration". The button enters a loading state.
5. **Outcomes:**
   - **Success** → confirmation screen with reference number (`VOL-#####`), enquiry contact, and a "Register another volunteer" button.
   - **Validation error** → inline field errors + top banner "Please correct the highlighted fields." Form remains populated.
   - **Form closed** (admin toggled `isActive=false` or `formCutoffTime` has passed) → closed screen with enquiry contact.
   - **D1 transient 503** → friendly banner: *"We couldn't save your registration this time. Please click Submit again — your details are kept."* Form remains populated, submit button re-enabled, Turnstile reset. The visitor re-clicks Submit manually.
   - **Network error / other server error** → top banner with the server message or "Submission failed. Please try again."

## 4. Form fields

| Field | Required | Validation | Max length |
|-------|----------|------------|------------|
| Full Name | Yes | Non-empty | 120 |
| Email | Yes | Email regex | 160 |
| Contact number | Yes | `^[0-9+\-\s()]{6,}$` | 30 |
| NRIC / FIN (last 4) | Yes | `^[0-9]{3}[A-Z]$` (auto-upper, auto-filter to alnum) | 4 |
| Emergency contact person | Yes | Non-empty | 300 |
| Availability (dates) | Yes | At least one selected | — |
| 18 years and above | Yes | Radio Yes/No | — |
| Medical conditions | Yes | Radio No/Yes/Other (free text if Other, max 500) | 500 |
| Roles of interest | Yes | At least one selected | — |
| Affiliation | Yes | Radio: SWA member / Laughter Yoga member / New Volunteer / Other (free text if Other, max 200) | 200 |
| Corporate Volunteer (company name) | No | Free text | 200 |
| Referral | No | Free text | 200 |
| Consent | Yes | Single checkbox (radio implementation) | — |
| Declaration | Yes | Single checkbox (radio implementation) | — |
| Turnstile token | Yes (if secret configured) | Cloudflare siteverify | — |

## 5. Admin / committee view

- **List page:** `/admin/forms/volunteer` — table of submissions (newest first), searchable by name / email / contact, filterable by `event_key`.
- **CSV export:** `/admin/forms/volunteer/export` — UTF-8 BOM CSV, one column per event date (Yes/No), all other fields included, `created_at` converted to Asia/Singapore time.
- **Access:** admin or committee role required ( enforced in `middleware.ts`). Reads from `volunteer_registrations` D1 table (`LIMIT 500` for list, `LIMIT 2000` for export).

## 6. Configuration model

All form content is driven by a single configuration object sourced from KV (`swa:volunteer_event_config`), with a complete fallback `DEFAULT_CONFIG` hardcoded in `src/worker/api/volunteer-reg.ts:20-53`. The fallback fires when:
- The KV key does not exist (current state — verified 2026-06-27; the key is not set on either local or remote `SWA_CONFIG`).
- The KV value is malformed JSON.
- The KV value is missing a given field (partial override via spread merge).

### Configurable fields

| Field | Type | Effect |
|-------|------|--------|
| `eventTitle` | string | Heading shown on page + stored as `event_key` in D1 |
| `introHtml` | string (HTML) | Intro section rendered before the form |
| `dates[]` | `[{label, date, venue}]` | Availability checkboxes; `date` is `YYYY-MM-DD` |
| `timeText` | string | Optional time line under each date checkbox |
| `roles[]` | string[] | Roles of interest checkboxes |
| `enquiry` | `{name, email, phone}` | "For enquiries" block on closed / success screens |
| `consentStatement` | string | Consent radio label text |
| `declarationStatement` | string | Declaration radio label text |
| `isActive` | boolean | `false` closes the form immediately |
| `formCutoffTime` | ISO string \| null | Closes the form at this timestamp if set |
| `notifyEmail` | string (single email) | Overrides `VOLUNTEER_NOTIFY_EMAILS` for postal recipients |

### Applying a configuration change

Edit `DEFAULT_CONFIG` in `src/worker/api/volunteer-reg.ts:20-53` and redeploy, **or** set the KV key:

```bash
npx wrangler kv key put swa:volunteer_event_config \
  '{"eventTitle":"...","dates":[...],"roles":[...],"isActive":true}' \
  --binding SWA_CONFIG --remote
```

Note: the KV `notifyEmail` override accepts a single string, not an array. If you need multiple recipients via KV, the override branch at `volunteer-reg.ts:629-633` needs extending; today the array case falls back to `VOLUNTEER_NOTIFY_EMAILS`.

## 7. Notification behaviour

On a successful submission, an HTML email is sent to the configured recipients:

| Property | Value |
|----------|-------|
| From | `SWA Portal <contactus@singaporewomenassociation.org>` |
| To | `VOLUNTEER_NOTIFY_EMAILS` (default: cjtay, jolene.lim, angela.wong) **or** KV `notifyEmail` (single string override) |
| Subject | `New Volunteer Registration — VOL-#####` |
| Body | Branded SWA Portal template with all submission fields in a table + link to the admin portal |
| Provider | Resend (`https://api.resend.com/emails`) |

**Limitation:** the submitter is not BCC'd. Only the admin recipients hear about the submission. (See Technical Spec §Known limitations — Low.)

## 8. Privacy & data handling

- **PII captured:** full name, email, contact number, NRIC last 4, emergency contact, medical conditions (optional free text), IP, User-Agent.
- **PII transmitted:** IP and UA are stored in D1 (audit) and included in the admin email body. NRIC last 4, email, and phone are in the email body. No PII is sent to Turnstile beyond the IP (for `remoteip`).
- **PII retained indefinitely in D1** unless manually purged. No automated retention policy.
- **Consent & declaration** are mandatory checkboxes — submission is gated on both.
- **No third-party analytics** on the form page.

## 9. Accessibility & UX notes

- ARIA-invalid attributes on fields with errors; error text toggled via `.is-open` class.
- Auto-uppercase + character filter on NRIC last 4.
- Char counter on medical "Other" field (limit 500).
- Mobile-first CSS (single stylesheet: `src/styles/volunteer-form.css`, ~577 lines).
- Embed mode (`?embed=1`) hides the brand bar, event band, and footer for iframe use.
- Gallery strip with lazy-loaded images from last year's event.
- NDP 2026 logo displayed in the event band (hardcoded in page HTML, not config-driven).