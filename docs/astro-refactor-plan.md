# Astro Refactor Plan — Adopt Component Model & Typed Scripts

**Status:** Drafted 2026-06-27
**Scope:** Phases 0–3 (no new dependencies)
**Execution order:** Foundations + public pages first, then admin pages by duplication/payoff

## Context

Analysis of `src/` found that while every page carries the `.astro` extension, Astro is being used largely as a static file router:

- `src/components/` does not exist. `src/layouts/` contains only `AdminLayout.astro`.
- 5 public pages ship a full `<!DOCTYPE html>` document (login, buyer/closed, buyer/index, volunteer/register, volunteer/checkin). The head/font/meta boilerplate is duplicated 5×.
- All 19 pages use inline `<script>` with raw `document.getElementById` / `innerHTML` string interpolation — untyped vs `src/worker/types.ts`, with a repeated `esc()` helper and an XSS-smell (e.g. `reg/buyer/index.astro:132`).
- Repeated markup primitives in `admin.css` (`.card`, `.btn`, `.form-input`, `.data-table`, `.badge`, `.form-error`, modal overlay) are re-typed per page.

The Hono worker (`src/worker/**`) is intentionally not Astro — correct per AGENTS.md architecture rules. Out of scope for this refactor.

## Goals

1. Remove duplicated HTML/CSS boilerplate via `.astro` components (no new deps).
2. Move inline page scripts into typed `src/scripts/` modules (no new deps).
3. Centralise XSS-safe DOM rendering and `fetch` helpers.
4. Keep all behaviour, routes, and styling identical — pure structural refactor.
5. Respect constraints: no SSR adapter, no Node APIs in worker, Cloudflare static build, no emoji, British English.

## Confirmed decisions

- **Script architecture:** Typed modules + `html` tagged-template helper. No UI framework / islands (Phase 4 declined).
- **Execution order:** Foundations + public pages first, then admin pages by duplication/payoff.

---

## Phase 0 — Foundations (create only, no page changes)

### Create `src/components/` (all slot-based `.astro`, zero JS)

| File | Wraps | Props |
|---|---|---|
| `Card.astro` | `<div class="card">` | `class?` |
| `Button.astro` | `<button class="btn">` | `variant: 'primary'\|'secondary'`, `size?`, `type?`, `id?` |
| `FormField.astro` | `.form-group` + `.form-label` + `.form-input` | `label`, `id`, `type`, `value?`, `placeholder?`, `required?` |
| `Badge.astro` | `<span class="badge">` | `variant: 'approved'\|'cancelled'\|'pending'`, text slot |
| `DataTable.astro` | `<table class="data-table">` | `columns: string[]`, slot for `<tbody>` |
| `Modal.astro` | Overlay + card + title + close | `id`, `title`; open/close via `data-open` attribute (CSS-driven, no JS in component) |
| `SearchToolbar.astro` | Search input + slot for filters | `inputId`, `placeholder?` |

### Create `src/layouts/PublicLayout.astro`

Minimal HTML doc (DOCTYPE, lang, charset, viewport, noindex meta, favicon, Google Fonts preconnect/link) with **no sidebar and no auth gate** — preserves the login-page redirect-loop safety called out in AGENTS.md gotcha #2. Props: `title`, `robotsMeta?`, `viewportMeta?`, slots for `<style>` and `<body>`.

### Create `src/scripts/utils/`

| File | Exports |
|---|---|
| `dom.ts` | `esc(s)`, `el(id)`, `show(el)`, `hide(el)` — replaces per-page `esc()` copies |
| `api.ts` | `apiFetch(path, init)` returning typed `{ success, ... }`, centralised error handling |
| `render.ts` | `html` tagged-template with auto-escaping — kills `innerHTML` XSS-smell without a framework |

### Edit `AGENTS.md`

Add rule under "Core Rules": new pages must use `PublicLayout` or `AdminLayout`, no raw `<!DOCTYPE>`.

---

## Phase 1 — Migrate 5 public pages

Per page: swap hand-written `<head>`/`<style>` for `<PublicLayout>`, move inline `<script>` to `src/scripts/pages/<name>.ts`, replace `innerHTML` strings with `html` helper, adopt `Card`/`Button`/`FormField`.

| Edit | Create (script) |
|---|---|
| `src/pages/login.astro` | `src/scripts/pages/login.ts` |
| `src/pages/reg/buyer/index.astro` | `src/scripts/pages/buyer-form.ts` |
| `src/pages/reg/volunteer/register.astro` | `src/scripts/pages/volunteer-register.ts` |
| `src/pages/reg/volunteer/checkin.astro` | `src/scripts/pages/volunteer-checkin.ts` |
| `src/pages/reg/buyer/closed.astro` | *(none — static page, no script)* |

---

## Phase 2 — Migrate 14 admin pages (ordered by duplication/payoff)

Same per-page treatment: extract inline `<script>` → `src/scripts/pages/<name>.ts`, adopt components, use `html` helper. `AdminLayout` stays unchanged (already correct).

| Edit | Create (script) |
|---|---|
| `src/pages/members.astro` | `src/scripts/pages/members.ts` |
| `src/pages/namecards.astro` | `src/scripts/pages/namecards.ts` |
| `src/pages/office-booking.astro` | `src/scripts/pages/office-booking.ts` |
| `src/pages/admin/forms/index.astro` | `src/scripts/pages/admin-forms-index.ts` |
| `src/pages/admin/forms/volunteer.astro` | `src/scripts/pages/admin-forms-volunteer.ts` |
| `src/pages/admin/settings/tables.astro` | `src/scripts/pages/admin-settings-tables.ts` |
| `src/pages/admin/settings/roles.astro` | `src/scripts/pages/admin-settings-roles.ts` |
| `src/pages/admin/settings/index.astro` | `src/scripts/pages/admin-settings-index.ts` |
| `src/pages/reg/dashboard.astro` | `src/scripts/pages/reg-dashboard.ts` |
| `src/pages/reg/admin/bookings.astro` | `src/scripts/pages/reg-admin-bookings.ts` |
| `src/pages/reg/admin/booking-detail.astro` | `src/scripts/pages/reg-admin-booking-detail.ts` |
| `src/pages/reg/volunteer/search.astro` | `src/scripts/pages/reg-volunteer-search.ts` |
| `src/pages/reg/volunteer/add-walkin.astro` | `src/scripts/pages/reg-volunteer-add-walkin.ts` |
| `src/pages/index.astro` | *(none — static dashboard, component adoption only)* |

---

## Per-phase verification (no behaviour change)

- `npm run build` must pass after each phase.
- `npm run dev` smoke-test each migrated page: auth flow, data render, modal, form submit, noindex meta present.
- Worker routes untouched; `wrangler types` unchanged.
- Diff is structural only — page output should match pre-refactor in dev.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Project is mid-Phase-1; refactor conflicts with feature work | Phase pages incrementally; each page is independent |
| Public pages must stay layout-free for login redirect safety | `PublicLayout` has no auth gate/sidebar — safe by construction |
| `innerHTML` removal could break rendering of trusted server data | `html` helper auto-escapes; verify each page's output matches in dev |
| Cloudflare static build rejects dynamic code | All components are build-time rendered; no islands, no hydration — compatible |

## Out of scope (deliberately)

- No UI framework / islands (Phase 4 declined).
- No changes to `src/worker/**`, `wrangler.jsonc`, `astro.config.mjs`, or CSS files.
- No new npm dependencies.

## File change summary (for confirmation gate per AGENTS.md safety)

- **Phase 0:** ~11 new files (7 components, 1 layout, 3 util modules) + 1 `AGENTS.md` edit
- **Phase 1:** 4 page scripts + 5 page edits
- **Phase 2:** 13 page scripts + 14 page edits

Each phase will re-list its exact create/edit set and wait for confirmation before writing.

## Estimated effort

- Phase 0: foundations (~1 session)
- Phase 1: 5 public pages (~1 session)
- Phase 2: 14 admin pages (~2–3 sessions)
