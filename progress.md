# SWA Portal — Progress Log

A running log of work completed each session, plus the immediate next steps.
Append a new dated entry at the top; keep it short and skimmable.

This file is gitignored — it's a private working scratchpad, not committed.

For the full phase tracker see `docs/plans/SWAPortal-Implementation-Plan.md`.
For role access, API permissions, and feature specs see
`docs/specs/SWAPortal-Functional-Specs.md`.

---

## 2026-07-25 — Namecard feature (Phases 0–4 done, 1 bug outstanding)

**Spec**: `docs/NAMECARD.md`. **Plan**: `docs/plans/Namecard-Implementation-Plan.md`.
**Continued in opencode** (zcode session has no browser MCP — can't see the rendered canvas, which made the QR debugging cycle painful).

### What's implemented & working
- **Migration 007** (`migrations/007_namecards.sql`) — namecards table + UNIQUE indexes. ⚠️ **Owner must run `wrangler d1 execute swa-portal --remote --file=migrations/007_namecards.sql` before the deployed code works** (it's not auto-applied by `db:setup` either — see "Local-dev gotcha" below).
- **Pure libs** (`src/worker/lib/namecard-{slug,sanitize,vcard,svg,qr,rate-limit,photo}.ts`) — all unit-tested.
- **Public routes** (`/c/:slug`, `/c/:slug/contact.vcf`, `/c/:slug/card.svg`, `/c/:slug/photo`) in `src/worker/api/namecard-public.ts`. IP rate-limited. Branded 404 for hidden/soft-deleted cards.
- **Admin CRUD** (`/api/namecards/*`, 11 endpoints) in `src/worker/api/namecards.ts`. Writes admin-gated via `ADMIN_WRITE_API` in `src/worker/middleware.ts`. Slug collisions → 409 with suggestion. Photo upload ≤2 MB, JPEG/PNG/WebP server-enforced.
- **Admin UI** `src/pages/namecards.astro` — table, edit drawer, bulk create, photo upload (client-side canvas crop), self-service panel showing the logged-in user's own card.
- **Nav entry** added to `src/layouts/AdminLayout.astro`.
- **Phase 4** atomic soft-delete — `DELETE /api/members/:id` now `DB.batch`-es the member soft-delete + `namecards.has_namecard=0` in one transaction.
- **Test harness**: vitest + `@cloudflare/vitest-pool-workers` (Miniflare emulates D1/KV/R2). `npm test` → **113 passing**. Config: `vitest.config.ts`, helpers: `test/db-helpers.ts`. Tests run serially (`fileParallelism: false`) because they share a D1 isolate.

### 🔴 OUTSTANDING BUG — pick up here
**The QR code on the public preview page (`/c/{slug}`) renders cut off on the left and right — not a full square.** The downloaded QR PNG is fine and scans; only the on-page canvas is broken.

What I know:
- `<canvas class="nc-qr-canvas" width="660" height="660">` (was 512, bumped to 660 trying to fix a scan-quality bug — that may or may not have helped; the cut-off issue is separate).
- `.nc-qr-canvas { width: 220px; height: 220px; }` in `public/namecard-public.css:259` — CSS is square, so the cut-off isn't an aspect-ratio issue at that rule.
- Parent `.nc-qr` is the QR section; the card container `.nc-card` has `overflow: hidden` (line 53 of namecard-public.css) — **likely culprit**: something is wider than its container and getting clipped. Worth checking `.nc-qr-actions`, the `.nc-card` max-width, and any padding/flex on `.nc-qr` itself.
- The QR is drawn by `public/js/namecard-qr.js` via `window.QRCode.toCanvas(canvas, payload, { width: canvas.width, ... })`. The library reads `canvas.width` (660) so the QR should fill the backing store.

**To debug** (zcode couldn't do this):
- Open `/c/{slug}` in a browser, DevTools → inspect `<canvas class="nc-qr-canvas">`.
- Computed tab: `width`, `height`, `box-sizing`, `padding`, `margin`, `border`. Look for non-zero horizontal padding/margin on the canvas or a parent that's narrower than 220px.
- Right-click canvas → Save image as. If the saved PNG is square and complete, it's a CSS clipping issue (probably `overflow: hidden` somewhere + canvas wider than parent). If the saved PNG is also cut off, the QRCode library is drawing with a margin/width mismatch.
- Most likely fix candidates: drop `overflow: hidden` on `.nc-card` (or scope it to just the header), or check the canvas has `box-sizing: border-box` and no implicit padding.

### Over-engineering I added that the user pushed back on (don't repeat these mistakes)
- `scripts/generate-swalogo-ts.mjs` generates `src/worker/lib/swalogo-generated.ts` from `public/swa-logo.webp`. It exists because the **server-rendered** card SVG needs the logo inlined as a data URI (external `<img src="/swa-logo.webp">` would taint the canvas PNG export). The **client-side** QR overlay does NOT use the generated file — it loads `/swa-logo.webp` directly via `new Image()` (matches the proven PayNow QR pattern in `src/pages/reg/membership/register.astro:142-205`).
- I briefly tried `acorn` / `node:vm` / a prebuild syntax-check script to catch a JS typo. **Removed.** `node --check public/js/namecard-qr.js` is enough if you suspect a parse error.
- I shipped a stray `}` in `public/js/namecard-qr.js` that broke the whole script. The 113 worker-side tests passed because they don't load that file. **Lesson: if you edit hand-written browser JS in `public/js/`, run `node --check` on it before claiming it works.**

### Local-dev gotcha
`npm run db:setup` rebuilds from `schema.sql` only — it does NOT apply `migrations/007_namecards.sql`. After running `db:setup`, you must also run:
```
node ./node_modules/wrangler/bin/wrangler.js d1 execute swa-portal --local --file=migrations/007_namecards.sql
```
Otherwise `/namecards` and `/c/*` all 500 with "no such table: namecards". (The shell's `wrangler` shim is intercepted by something — call the binary directly from `node_modules`.)

The cleaner fix is to backport the `namecards` table into `schema.sql` (the rolled-up baseline), matching how migration 003's `deleted_at` column was backported. That would let `db:setup` pick it up automatically. **Not done** — open question for next session.

### Not done (by design — owner-gated, manual)
- **Phase 5**: swa2024 cleanup PR — remove old namecard code from the sibling `~/Documents/Projects/swa2024` repo. Separate PR after smoke.
- **Phase 6**: production go-live — owner runs `wrangler d1 export` (backup), `wrangler d1 execute --remote --file=migrations/007_namecards.sql`, `npm run deploy`. Per `AGENTS.md` §0 + the project's `AGENTS.md` "Safety Standards", no agent runs `--remote` commands.

### Open design decisions (plan §17)
- Badge logo: currently uses `/swa-logo.webp` (same as admin nav + PayNow QR). Working.
- Font inlining: card SVG uses system fallback stack (`Poppins, 'Segoe UI', Roboto, sans-serif`). Pixel-perfect Poppins would require base64-embedding ~150KB into each card SVG. Deferred.
- `swa2024` `/namecard/*` redirects (301 vs 404) — owner decides.

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
  (see `docs/plans/SWAPortal-Implementation-Plan.md`).
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
