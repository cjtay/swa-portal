# SWA Portal — Progress Log

A running log of work completed each session, plus the immediate next steps.
Append a new dated entry at the top; keep it short and skimmable.

This file is gitignored — it's a private working scratchpad, not committed.

For the full phase tracker see `docs/SWAPortal-Implementation-Plan.md`.
For role access, API permissions, and feature specs see
`docs/SWAPortal-Functional-Specs.md`.

---

## 2026-07-05

### Done
- **Fixed drawer panel always visible on `/admin/forms/membership`** — the detail
  drawer's `.drawer-overlay { display: flex }` was overriding the `hidden`
  attribute, so the empty panel rendered in front of the page on load. Added
  `.drawer-overlay[hidden] { display: none; }` in
  `src/pages/admin/forms/membership.astro` (matches the existing pattern in
  `src/styles/admin.css` for `.new-booking-form[hidden]` and
  `.mobile-drawer:not([hidden])`). Build verified.

### Notes
- The membership admin page (`src/pages/admin/forms/membership.astro`) and its
  API (`src/worker/api/membership-reg.ts`) shipped in commit `5684268` and look
  feature-complete: list view, detail drawer, approve/reject workflow, PayNow QR,
  signature pad, image rendering, CSV export. No known issues beyond the drawer
  bug fixed today.
- The public membership registration form lives at
  `/reg/membership/register` (`src/pages/reg/membership/register.astro`), styled
  via `src/styles/membership-form.css`.

### Next steps (pick up here)
- **Phase 1D** — Office booking calendar UI
  (see `docs/SWAPortal-Implementation-Plan.md`).
- **Phase 1E** — Namecard management UI + photo upload.
- **Phase 1F** — Member directory with search/filter/pagination.
- Domain transfer: configure `admin.singaporewomenassociation.org` custom domain.
- Smoke-test the membership drawer fix in `npm run dev` (close button, backdrop,
  Escape) since today's verification was build-only.

### Untested changes this session
- The drawer fix was confirmed by `npm run build` (22 pages built cleanly) but
  not by manual browser click-through.

---

## Previously completed (carried over from earlier sessions)

### Volunteer registration form — COMPLETE
- Public form at `/reg/volunteer/register` (`src/pages/reg/volunteer/register.astro`,
  themed via `src/styles/volunteer-form.css`), backed by
  `src/worker/api/volunteer-reg.ts` (config GET + register POST), Turnstile
  required, D1 storage in `volunteer_registrations` table.
- Admin viewer at `src/pages/admin/forms/volunteer.astro` with date filters
  (All / 1 Aug / 8 Aug), client-side sorting, vertical scroll, CSV export.
- UI polish pass done (Inter-only typography, mobile stacking, static submit bar).
- Remote D1 schema migration may still be pending — verify before deploy.
