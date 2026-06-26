# Volunteer Registration Form — Progress Tracker

Tracks the build of the public volunteer registration form in swa-portal.
See `docs/` for full plan; see this file to resume work across sessions.

## Goal
Generic/reusable public volunteer registration form at `/reg/volunteer/register`,
themed to match swa2024 design language, single-page grouped sections,
Cloudflare Turnstile required, D1 storage. Admin config/view/export come later.

## Source reference
Microsoft Form: "Bringing National Day 2025 to Seniors at Ren Ci Community Hospital".
14 fields carried over (see fields list below).

## Default config (KV `swa:volunteer_event_config` empty fallback)
- eventTitle: "Bringing National Day 2025 to Seniors at Ren Ci Community Hospital"
- timeText: "12:00 PM to 4:00 PM"
- dates:
  - 1st August (Friday) — Ren Ci Community Hospital, Novena
  - 8th August (Friday)  — 31 Bukit Batok Street 52, Singapore 659251
- roles: Befriender, Game Booth Helper, Performance Support Crew, Logistics Helper
- enquiry: Angela Wong · angela.wong@singaporewomenassociation.org · 9674 1022
- consent / declaration: from source form text
- formCutoffTime: null ; isActive: true

## Files
- [x] progress.md (this file)
- [x] schema.sql — added volunteer_registrations table + indexes
- [x] src/styles/volunteer-form.css — self-contained themed CSS (.vf-* namespace)
- [x] src/worker/api/volunteer-reg.ts — handleVolunteerConfig (GET) + handleVolunteerRegister (POST)
- [x] src/worker/index.ts — registered GET/POST routes
- [x] src/worker/middleware.ts — /api/volunteer made public (VOLUNTEER_API prefix set)
- [x] src/pages/reg/volunteer/register.astro — public form page
- [x] verify: npm run build (OK; /reg/volunteer/register built)
- [x] verify: load form in dev (renders default config; both dates correct)
- [x] verify: GET /api/volunteer/config returns 200 with full config JSON
- [x] verify: POST /api/volunteer/register rejects missing/invalid Turnstile (no D1 write)
- [x] verify: tsc clean for volunteer-reg.ts (pre-existing repo errors unrelated)

## Form fields (14; * = required)
1. Full Name* (text, autocomplete=name)
2. Email* (email, autocomplete=email, confirm)
3. Contact number* (tel, inputmode=tel)
4. NRIC/FIN last 4* (pattern, length 4)
5. Emergency Contact person* (textarea: name/relationship/phone)
6. Availability* (checkbox list from config.dates)
7. 18+* (radio Yes/No)
8. Medical conditions* (radio No/Yes + "Other" free text)
9. Roles interested* (checkbox list from config.roles)
10. Are you a* (radio: Member SWA / Laughter Yoga / New Volunteer + "Other")
11. Corporate Volunteer (optional text, contextual)
12. Referral (optional text)
13. Consent* (single radio confirm)
14. Declaration* (single radio confirm)

## Backend behaviour
- Turnstile required (hard block submit; server verifies via TURNSTILE_SECRET)
- IP rate limit (window 15m, mirroring rate-limit.ts)
- Insert into volunteer_registrations; return reference id
- Closed state when isActive=false or past formCutoffTime

## D1 schema (volunteer_registrations)
id, event_key, full_name, email, contact_number, nric_last4,
emergency_contact, availability(JSON), is_18_plus(int), medical_conditions,
roles_interest(JSON), affiliation, corporate_company, referral,
consent(int), declaration(int), submitted_ip, user_agent, created_at
+ idx_volreg_event, idx_volreg_email

## Out of scope (later phases — awaiting user direction)
- Admin settings UI to edit swa:volunteer_event_config (extend admin-settings.ts
  KNOWN_KEYS + new page under /admin/settings/, e.g. /admin/settings/volunteer)
- Admin view/export of volunteer_registrations (/admin/volunteers + API,
  mirroring admin-export.ts; CSV export)
- Confirmation/acknowledgement email to volunteer (Resend) — optional
- Notification email to coordinator on each submission — optional
- Apply D1 schema to REMOTE database (npx wrangler d1 execute --remote) before
  deploy — local D1 already has the table.

## Session resume notes
- Brand colours reuse portal --swa-* CSS vars (swa-1..swa-4). No Tailwind in portal.
- Turnstile site key/secret already configured (used by login.astro).
- Middleware PUBLIC_PATHS pattern: add '/api/volunteer' to a public-prefix set
  (pathStartsWithAny) — do NOT just add to PUBLIC_PATHS set (exact match only).
- Spec: British English; no emojis in professional components.

## Completion log
- Phase 1 COMPLETE — public volunteer registration form built & verified.
  Files: schema.sql, src/styles/volunteer-form.css, src/worker/api/volunteer-reg.ts,
  src/worker/index.ts, src/worker/middleware.ts, src/pages/reg/volunteer/register.astro.
  Build OK; config API 200; submit rejects invalid Turnstile (no D1 write); form renders
  default config (both dates: 1 Aug Ren Ci Novena, 8 Aug Bukit Batok full address).
  Local D1 migrated; remote D1 migration pending before deploy.

- 2026-06-26 UI polish COMPLETE — addressed font + overlap feedback.
  Changed: src/styles/volunteer-form.css, src/pages/reg/volunteer/register.astro.
  - Switched to Inter-only typography to match swa2024 base (removed Playfair Display).
  - Made choice rows stack vertically on mobile; wider flexible wrapping on desktop.
  - Removed inline fixed widths from affiliation/medical "Other" options.
  - Made submit bar static on all screen sizes so it never overlaps form fields.
  - Moved 2-column personal-fields breakpoint from 640px to 768px.
  Verified with mobile (390×844) and desktop (1280×800) screenshots.

  Next session starts here: choose admin config UI and/or admin view/export, OR
  apply remote schema + deploy. See "Out of scope" above.