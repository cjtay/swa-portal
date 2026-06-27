# Volunteer Registration Form — Documentation

This subfolder documents the **public volunteer registration form** at `/reg/volunteer/register` and its supporting admin views and API endpoints. It is scoped to the volunteer form only; for portal-wide concerns (auth, members, bookings, gala registration) see the parent `docs/` folder.

## Files in this subfolder

| File | Audience | Contents |
|------|----------|----------|
| `README.md` (this file) | Everyone | Index and navigation |
| `Volunteer-Form-Functional-Spec.md` | Product owners, admins, support | What the form does from the user's perspective |
| `Volunteer-Form-Technical-Spec.md` | Developers, operators | How it is built, security/resilience posture, known gaps |

## When to read which

- **You are configuring an event** (dates, roles, recipients, consent wording) → start with the Functional Spec §Configurable items, then Technical Spec §Configuration & deployment for the KV key.
- **You are debugging a failed submission** → Technical Spec §Resilience & observability, then `error_log` query examples in §Configuration & deployment.
- **You are adding a field or changing validation** → Functional Spec §Form fields, Technical Spec §Request/response contracts and §Validation rules.
- **You are reviewing security posture** → Technical Spec §Security measures in place and §Known limitations (risk-ranked).

## Related docs elsewhere in `docs/`

- `docs/SWAPortal-Functional-Specs.md` — portal-wide role access matrix (the volunteer form's admin views inherit the admin/committee tier from here).
- `docs/checklist/email-otp-security-checklist.md` — OTP flow (note: the volunteer form does NOT use OTP; it is Turnstile-gated and public).
- `docs/SWAPortal-Implementation-Plan.md` — tracker entry for the original volunteer_registrations build.
- Outside this repo: `~/Documents/Projects/gtw2026/docs/GTW-D1-Incident-Report-2026-06-20.md` — the source for the D1 retryable-error matcher used by the form's 503 handler. Linked, not reproduced.

## Release history (most recent first)

| Date | Change | Files touched |
|------|--------|---------------|
| 2026-06-27 | Friendly D1 transient 503 handling (server + client) | `src/worker/api/volunteer-reg.ts`, `src/pages/reg/volunteer/register.astro` |
| 2026-06-27 | Workers Logs observability enabled | `wrangler.jsonc` |
| 2026-05-11 | `volunteer_registrations` table + initial form build | `schema.sql`, `src/worker/api/volunteer-reg.ts`, `src/pages/reg/volunteer/register.astro`, `src/styles/volunteer-form.css` |