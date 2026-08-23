# Public Forms — Functional Spec

> **Status**: live (volunteer form currently closed via config)
> **Detailed specs**: membership `features/membership-form/`, volunteer `features/volunteer-form/`
> **How to add another**: `docs/how-to-add-a-form.md`

## 1. Purpose

Three public registration forms sharing one shape: a public page, a config endpoint, a submit endpoint (Turnstile-verified), an admin viewer with CSV export, and a notification email.

| Form | Public page | State |
|------|-------------|-------|
| Membership application | `/reg/membership/register` | Open |
| Laughter yoga (CLYL training, 24–25 Oct 2026) | `/reg/laughter-yoga/register` | Open |
| Volunteer sign-up | `/reg/volunteer/register` | Closed since 04-08-2026 via config |

## 2. Shared behaviour

- **Turnstile** (Cloudflare's privacy-friendly anti-bot check) guards every submission. In local dev the Worker returns an empty site key so the widget never loads.
- **Open/close state is configuration**, read from the `SWA_CONFIG` KV per event; the handler answers `FORM_CLOSED` when config says stop.
- **Uploads go to R2** where the form needs them (membership: PayNow screenshot + signature, 10 MB each).
- **Notification emails** go to recipient lists in `portal.ts`, overridable per event in KV.
- **CSV exports are injection-safe**: every cell passes the shared guard in `src/worker/lib/csv.ts`; a tripwire test and pre-commit hook stop private copies from shipping again.
- **IP rate limiting** on public submission endpoints (10 per 15 min).

## 3. Admin viewers

Submission viewers live under `/admin/forms/<form>` (visible to admin and committee): list with date filters and search, detail drawer (the membership viewer includes approve/reject with the full payment workflow — see the membership spec folder), CSV export.

| Endpoint group | Method | Auth |
|----------------|--------|------|
| `GET /api/admin/forms/{volunteer,laughter-yoga,membership}` | GET | admin or committee |
| `GET /api/admin/forms/…/export` | GET | admin or committee |
| `GET /api/admin/forms/membership/image/:id/:kind` | GET | admin or committee |
| `POST /api/admin/forms/membership/:id/{approve,reject}` | POST | `isMembershipApprover()` (list ∪ IT admins) |

## 4. Data model

One table per form: `volunteer_registrations`, `laughter_yoga_registrations`, `membership_applications` (plus approval-gate columns: `status`, `reviewed_by/at`, `member_id`). See each form's detailed spec and `schema.sql`.

## 5. Adding a fourth form

Follow `docs/how-to-add-a-form.md`. The three existing handlers are near-copies; the checklist exists so the next one does not add a fourth copy. New form = one row in the core spec's feature matrix + a spec folder here.
