# Digital Namecard — Implementation Plan

> **STATUS 23-08-2026: EXECUTED, THEN RESTORED UNDER NEW RULES.** All six phases shipped in
> July 2026. The feature was hidden on 22-08-2026 after the security audit, then restored
> on 23-08-2026 as board-only (committee + advisor), auto-generated, with the SWA office
> address on every card. For how namecards work today read [`docs/specs/features/namecards.md`](../specs/features/namecards.md)
> v2.2; this plan is the historical build record and does not describe the current rules.

> **Source spec**: [`docs/specs/features/namecards.md`](../specs/features/namecards.md) (v2.1, 2026-07-25)
> **Plan date**: 2026-07-25
> **Author**: SWA digital infrastructure
> **Status**: Approved, ready for execution
> **Testing approach**: Vitest + `@cloudflare/vitest-pool-workers` (Miniflare emulates D1/KV/R2)

This plan breaks the namecard spec into six independently testable, independently reversible phases. It honours the project rules: British English, SWA palette, no emoji, **all production/remote Cloudflare ops are owner-only**, destructive local scripts are user-invoked only, and package-safety confirmation is required for every install.

The design adds **zero** new Cloudflare resources (no new D1/KV/R2/Worker/DNS). Public cards live at `admin.singaporewomenassociation.org/c/:slug` on the existing `swa-portal` Worker.

---

## Phases at a glance

| Phase | Scope                                                    | Outcome                                                       |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------- |
| 0     | Test harness                                             | `npm test` works; Miniflare bindings wired                    |
| 1     | Migration + pure libs (no UI)                            | `namecards` table + tested slug/sanitize/vcard/svg/qr helpers |
| 2     | Public `/c/*` routes                                     | Public surface live but empty                                 |
| 3     | Admin `/api/namecards/*` + `pages/namecards.astro` + nav | Admins can populate cards                                     |
| 4     | Atomic member soft-delete → card dark                    | Transaction enforced                                          |
| 5     | `swa2024` cleanup PR                                     | Old namecard code removed                                     |
| 6     | Owner-run go-live + manual smoke                         | Cards visible in production                                   |

---

## Phase 0 — Test infrastructure

The repo has no test framework today (verified at planning time: zero `*.test.*` files, no vitest/jest config). Miniflare ships transitively with `wrangler ^4.107.0`, so D1/KV/R2-backed integration tests are achievable with one new devDependency pair.

**Package-safety confirmation required before install** (per `AGENTS.md`):

- `vitest` — test runner, dev-only, no runtime footprint
- `@cloudflare/vitest-pool-workers` — Vitest pool that runs each test inside a Miniflare isolate with real `env.DB` / `env.SWA_SESSION` / `env.R2_BUCKET` bindings; Miniflare already in `package-lock.json` transitively via `wrangler`

**Files**:

- **edit** `package.json` — add devDeps + `"test": "vitest"`, `"test:run": "vitest run"` scripts
- **create** `vitest.config.ts` — `workers` pool, `miniflare` block binding `DB`/`SWA_SESSION`/`SWA_CONFIG`/`R2_BUCKET` from `wrangler.jsonc`, `compatibilityDate` + `scriptPath` pointed at the Hono entry
- **create** `src/worker/lib/__tests__/` and `src/worker/api/__tests__/` test roots
- **create** `test/db-helpers.ts` — shared `applyMigrations()` + `seedFixture()` helpers using `schema.sql` + `migrations/NNN_*.sql`

**Phase 0 tests**: a smoke test that boots the pool, runs `SELECT 1` on `c.env.DB`, and writes/reads a key in `c.env.SWA_SESSION` to prove bindings are wired.

---

## Phase 1 — Migration + pure libraries

**No UI, no routes in this phase.** This is the highest test-value-per-line work in the project because the helpers are pure and exhaustively testable.

### 1.1 `migrations/007_namecards.sql`

- Follows the existing `NNN_snake_case.sql` convention (mind the existing `005` numbering collision; `007` is the next free number).
- Header comment block matches `migrations/006` style: filename, date `2026-07-25`, purpose prose, idempotency notes, local + remote apply commands with a "backup first" preface.
- Body verbatim from spec §4.1: `CREATE TABLE namecards (...)`, `UNIQUE INDEX idx_namecards_slug`, `UNIQUE INDEX idx_namecards_member_id`, partial `idx_namecards_visible WHERE has_namecard = 1`.
- Local-only apply: `npx wrangler d1 execute swa-portal --local --file=migrations/007_namecards.sql`. **Owner applies the `--remote` counterpart manually after a D1 export** — never scripted.

### 1.2 Pure helper libraries (`src/worker/lib/`)

Each file is one cohesive unit, fully unit-tested:

| File                   | Responsibility                                                                                                                                                                                                                             | Key tests                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `namecard-slug.ts`     | `deriveSlug(name)` (lowercase, kebab-case, ASCII-fold accents), `validateSlug(slug)` (regex), `suggestAlternatives(slug, taken)` (`slug-2`, `-3`, …)                                                                                       | Multi-word names; mononyms; non-ASCII; collisions produce next-free suggestion                                                           |
| `namecard-sanitize.ts` | `isSafeUrl(url)` (scheme ∈ `http:`,`https:` only; rejects `javascript:`/`data:`/`vbscript:`/`file:`); `normalizeWhatsApp(input)`; `escapeVcard(value)` (RFC 2426 escaping)                                                                 | Each rejected scheme; WhatsApp variants (`+65 9123 4567`, `65-9123-4567`, `+6591234567`) normalise identically; escape round-trips       |
| `namecard-vcard.ts`    | `buildVcard({member, namecard, photoBytes?})` — vCard 3.0, CRLF line endings, 75-octet folding, `N:` from overrides else last-whitespace split, folded `PHOTO;ENCODING=b`, `REV:` from `updated_at`, `X-SOCIALPROFILE` per social          | Round-trip vs fixture; comma/semicolon/newline names don't break structure; base64 folds at 75 octets; CRLF confirmed by byte inspection |
| `namecard-svg.ts`      | `renderCardSvg({member, namecard, photoDataUri?})` — 1050×600 template per the §1.3 design spec, inlined SWA badge logo (inline `<svg>` paths, **no `<img>`**), all resources inlined (required for untainted canvas export per §7.3/§8.2) | Snapshot/stable-string test on a fixture; assert no external refs in output; valid SVG                                                   |
| `namecard-qr.ts`       | `qrPayload(host, slug, variant)` — `vcf` or `page` URL per `namecards.qr_variant`                                                                                                                                                          | Both variants; respects `host` (dev vs prod)                                                                                             |

The SWA badge logo lives in a shared `src/worker/lib/swa-monogram.ts` constant (inline `<svg>` paths / data URI), used by both the SVG card renderer and the client QR overlay — **never** loaded from `/swa-logo.webp`. The badge is more detailed than a simple monogram (see §1.3 "Asset gap").

**Phase 1 tests**: one `*.test.ts` per file (5 files); all unit tests, no Miniflare bindings needed.

### 1.3 Card design spec — `Lee Li Hua` reference card

The visual contract for `namecard-svg.ts`. Source: Lee Li Hua namecard (Advisor / Immediate Past President). This **supersedes** the generic layout sketch in [`docs/specs/features/namecards.md` §8.1](../specs/features/namecards.md) — where the two conflict, this spec wins. Conflicts and gaps are called out at the end of this section.

#### Canvas

- **1050 × 600 px** (3.5 in × 2 in @ 300 DPI, standard landscape business card). Matches the dimension already cited in spec §8.1.
- Square corners, solid fill, **no border**.

#### Colours

```css
:root {
	--bg-purple: #7a0381; /* solid background, entire card */
	--text-white: #ffffff; /* name, title, phone, email */
	--divider: rgba(
		255,
		255,
		255,
		0.8
	); /* renders as pale pink-lilac over the purple */
	--logo-bg: #ffffff; /* logo badge circle */
	--logo-ink: #6b196e; /* purple line-art/text inside logo badge */
}
```

**Note**: `--bg-purple #7A0381` and `--logo-ink #6B196E` are **not** in the existing SWA palette (`swa-1 #70308c`, `swa-2 #450a5e`, `swa-3 #874ba1`, `swa-4 #f3d2ff`). The card's colours are the design's own; the surrounding portal/admin UI continues to use the SWA palette. Do not collapse these onto the `swa-*` variables — they are intentionally distinct.

#### Photo (top-left)

- Position: ~97 px from left, ~59 px from top.
- Size: ~230 × 220 px (roughly square).
- Rounded corners, radius ~8–10 px.
- The source photo carries its own light pink-to-white gradient studio backdrop — **not** a frame added on top.

#### Logo badge (top-right)

- White circle, ~190 px diameter.
- Position: ~95 px from the right edge, ~55 px from the top (mirrors the photo's top margin).
- Purple ring text around the inside edge: `SINGAPORE WOMEN'S ASSOCIATION`.
- Central icon: stylised woman / Venus symbol motif.
- Bottom ribbon / banner shape across the circle reading `S W A`.
- Ink colour: purple, close to the background purple but slightly darker/richer (`--logo-ink #6B196E`).

#### Typography

Left margin for all text block content: ~94–97 px (aligned with the photo's left edge).

| Element                                           | Weight        | Approx size | Colour | Notes                                                               |
| ------------------------------------------------- | ------------- | ----------- | ------ | ------------------------------------------------------------------- |
| Name                                              | Bold          | ~40 px      | white  | large, first line under photo                                       |
| Title (e.g. "Advisor / Immediate Past President") | Regular/Light | ~20–22 px   | white  | sits with a noticeably large gap below the name (not tight leading) |
| Phone                                             | Regular       | ~16–18 px   | white  | directly below divider                                              |
| Email                                             | Regular       | ~16–18 px   | white  | directly below phone                                                |

Font: a geometric, rounded-terminal sans-serif (single-storey `a`, circular `o`/`e`). Best visual match: **Poppins** (Bold for name; Regular/Light for title, phone, email). Acceptable alternates: Quicksand, Nunito Sans, Comfortaa.

#### Divider

- Thin horizontal rule, ~5 px thick.
- Spans nearly the full card width, same left/right margins as the text block (~92–95 px each side).
- Sits between the title and the phone number.
- Colour: white at ~80% opacity (blends with the purple to a soft pink-lilac line).

#### Vertical rhythm (from top of card)

1. Photo + logo row
2. Name
3. Title (large gap after name, roughly double a normal line-gap)
4. Divider (small gap after title)
5. Phone (small gap after divider)
6. Email (small gap after phone)

#### Layout summary

- Two-column feel **only** at the top (photo left, logo right); everything else is a single left-aligned text column.
- Generous negative space, especially the gap between title and divider.
- **No website URL appears on this card.**

#### Conflicts with `docs/specs/features/namecards.md` §8.1 — this design spec wins

| Item                                     | Spec §8.1 (generic sketch)                                                                                           | This design (chosen)                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card URL footer                          | "Footer: card URL `admin.singaporewomenassociation.org/c/{slug}` and a small SWA logo (inline)"                      | **No URL on the card.** The footer is dropped. The URL is conveyed by the QR code, the public `/c/:slug` HTML page, and the vCard — never the card image itself.                         |
| Social icon strip                        | "Social icon strip: filled glyphs for each populated platform (inline SVG), with the platform handle or URL beneath" | **Not on the card.** Socials live on the public HTML page and the vCard `X-SOCIALPROFILE` fields, not on the card image. The card carries only name, title, phone, email.                |
| Header band                              | "SWA gradient header band (`#70308c` -> `#450a5e`)"                                                                  | Solid `--bg-purple #7A0381` fill, no gradient, no separate header band.                                                                                                                  |
| Logo                                     | "SWA monogram top-left, inlined as `<svg>` paths (not `<img>`)"                                                      | The badge logo is top-right (see §1.3 "Logo badge"), not top-left, and is the full circular SWA badge with ring text + central motif + `S W A` ribbon — more detailed than a "monogram". |
| "Singapore Women's Association" subtitle | "Name (large) ... `job_title` (medium purple), 'Singapore Women's Association' (muted)"                              | No standalone "Singapore Women's Association" subtitle on the card — the org name appears inside the logo badge ring. The card body shows only name + title + phone + email.             |

#### Implementation notes for `namecard-svg.ts`

Three points must be resolved during Phase 1 implementation; flagged now so they are not discovered late.

1. **Asset gap — logo badge.** The badge is a specific piece of brand artwork (ring text, woman/Venus motif, `S W A` ribbon), not a generic monogram. It cannot be reliably reproduced by hand-coded SVG paths without the source artwork. **Action**: confirm with the SWA owner whether a vector source (SVG/Illustrator/PDF) of the badge exists. If yes, embed its paths inline in `src/worker/lib/swa-monogram.ts` (after stripping any raster/fonts). If no, the owner must supply a high-resolution PNG (≥600 px square, transparent background) and we inline it as a base64 data URI in the SVG. Either way, the badge is **inlined**, never `<img src=…>`, to keep canvas export untainted (spec §7.3). Add this as an explicit item on the §17 open-decisions list.

2. **Font inlining.** Poppins (or whichever approved alternate) is not a Workers runtime asset and is not embedded in any OS by default. SVG text rendered with a missing font falls back to the platform default, breaking the design. Three options to evaluate in Phase 1:
   - **Embed the font as a base64 data URI inside `<style>@font-face { … }</style>` within the SVG** — fully self-contained, preserves the canvas-untainted guarantee, but adds ~30–60 KB per weight to every card SVG (3 weights ⇒ ~150 KB). Licence check required: Poppins is OFL, embeddable.
   - Use a system-safe fallback stack (`Poppins, 'Segoe UI', Roboto, sans-serif`) — smallest payload, but design degrades off-platform (Linux servers, older Android), and `toDataURL` rasterisation happens on the client's browser, so the _viewer's_ installed fonts are what matters, not the server's. Acceptable for the PNG export only if the member downloading is on a mainstream OS; risky for screen-reader/edge cases.
   - Draw the title text as a path outline (pre-converted) — exact, but non-editable and heavier than option 1 for long names.

   **Recommended**: option 1 (base64-embed Poppins Bold + Regular). Revisit if SVG payload becomes a concern. Licence (SIL OFL 1.1) permits embedding.

3. **Title length.** Long titles like "Advisor / Immediate Past President" already approach the 1050 px width at ~22 px regular. `renderCardSvg` should cap the title to one line and truncate gracefully (or shrink-to-fit by ~2 px) — multi-line titles break the vertical rhythm. The vCard `TITLE:` field and the public HTML page carry the full title untruncated; only the card image truncates.

---

## Phase 2 — Public `/c/*` routes

Routes register on `app` without auth middleware — `authMiddleware` is scoped to `/api/*` only (`src/worker/index.ts:36`). Public routes never sit under `/api/*`.

### 2.1 `src/worker/lib/namecard-rate-limit.ts`

- IP-keyed sliding-window limiter (cannot reuse `checkApiRateLimit`, which is email-keyed; confirmed at `src/worker/lib/rate-limit.ts:9-29`).
- KV key `swa:rl:card:ip:{ip}` in `SWA_SESSION`; IP from `CF-Connecting-IP` header.
- Constants added to `src/constants/portal.ts`: `NAMECARD_PUBLIC_RATE_LIMIT_WINDOW_SECONDS = 60`, `NAMECARD_PUBLIC_RATE_LIMIT_MAX_REQUESTS = 60`, `NAMECARD_PHOTO_MAX_BYTES = 2*1024*1024`, following the `MEMBERSHIP_RATE_LIMIT_*` precedent.
- Tests: 60th request within window allowed, 61st rejected; window slides correctly.

### 2.2 `src/worker/lib/namecard-photo.ts`

- `streamPhoto(env, slug)` — reads the join, enforces `has_namecard = 1 AND m.deleted_at IS NULL`, fetches the R2 object by `photo_r2_key`, returns `{ body, contentType }` or `null`.
- R2 read mirrors `handleMembershipImage` (`src/worker/api/membership-reg.ts:486-531`) but **cache headers differ**: `Cache-Control: public, max-age=86400, s-maxage=2592000` (spec §8.3). The membership image uses `private, max-age=3600` because it sits behind an authenticated drawer — not reusable here.
- Tests: visible card streams with correct content-type; hidden card (`has_namecard=0`) returns null; soft-deleted member returns null.

### 2.3 `src/worker/api/namecard-public.ts`

- Handlers: `GET /c/:slug` (HTML), `GET /c/:slug/contact.vcf`, `GET /c/:slug/card.svg`, `GET /c/:slug/photo.{ext}`.
- HTML rendered as a Hono `Response` (string HTML) — **no Astro SSR**, no `@astrojs/cloudflare` adapter (per `AGENTS.md` Cloudflare Edge rule).
- vCard response headers verbatim from spec §9.1: `Content-Type: text/vcard; charset=utf-8`, `Content-Disposition: attachment; filename="{Name}_SWA.vcf"`, `Cache-Control: public, max-age=300, s-maxage=600`, **`X-Content-Type-Options: nosniff` mandatory** (iOS Safari renders `.vcf` inline as text without it).
- Branded not-available HTML for missing/hidden/soft-deleted slugs (spec §6.6) — 404 (or 410 for explicitly disabled).
- Cache headers per asset from spec §8.5.
- IP limiter applied to `.vcf`, `.svg`, `photo.*` (high-cost endpoints); HTML page exempt to keep QR-scan → page load snappy.
- Tests via Miniflare: visible slug returns HTML with name + OG tags; hidden slug returns branded 404; vcf has `nosniff` + `attachment`; svg has no external refs; photo streams with `public` cache header; 61st vcf from one IP returns 429.

### 2.4 `src/styles/namecard-public.css`

- Single self-contained stylesheet for the `/c/:slug` page. **No Tailwind on the public page** (spec §6.3) — small payload, clean canvas export. SWA palette hardcoded (the public page doesn't load `admin.css`).

### 2.5 `src/scripts/namecard-qr.ts`

- Client-side QR + SWA-monogram overlay + PNG download, reused from the proven `src/pages/reg/membership/register.astro:142-205` pattern.
- **Critical divergence from the membership pattern**: the logo must be **inlined** (data URI or inline SVG), not `<img src="/swa-logo.webp">`. The existing form gets away with `<img>` because it only displays the QR; the namecard must `toDataURL('image/png')` export, which a tainted canvas silently breaks (spec §7.3).
- `errorCorrectionLevel: 'H'` mandatory (centre logo reduces scan area); logo ≤15% of QR width with white circular backdrop.
- Loads `/js/qrcode.min.js` (already shipped via the `copy:qrcode` prebuild hook at `package.json:9-11`).

### 2.6 `wrangler.jsonc`

- One-line edit: `run_worker_first` from `["/api/*"]` to `["/api/*", "/c/*"]` (spec §11.2). Without this, `/c/*` 404s from the static asset handler. **Owner applies on the next manual deploy** — never scripted.

**Phase 2 deliverable**: public surface live but empty (no rows yet). Verify by inserting a fixture row and hitting `localhost:8787/c/{slug}`.

---

## Phase 3 — Admin CRUD + UI

### 3.1 Middleware changes (`src/worker/middleware.ts`)

- Add `'/api/namecards'` to `ADMIN_WRITE_API` (`:24-26`) — primary gate, makes POST/PATCH/DELETE admin-only while GET stays open to any authenticated role (matches gate behaviour at `:139-143`).
- Extend the `getEndpointKey` switch in `src/worker/lib/rate-limit.ts:35-56` to recognise `/api/namecards` writes so admin writes inherit the existing email-keyed limiter.
- In-handler `session.role === 'admin'` checks as defence-in-depth (matches `members.ts:162-165, 216-218` pattern).
- No new gate for Phase 3 reads — left open to all authenticated roles per spec §17.5 (revisit only if SWA requests committee-or-above reads).

### 3.2 `src/worker/api/namecards.ts`

- Method-dispatch handlers mirroring the `members.ts` shape (`AppContext` alias, `c.env.DB.prepare(...).bind(...).run()/.first()/.all()`).
- Endpoints per spec §9.2: `GET /api/namecards`, `GET /api/namecards/:id`, `POST /api/namecards` (auto-derives slug unless supplied), `POST /api/namecards/bulk`, `PATCH /api/namecards/:id`, `PATCH /api/namecards/:id/slug` (409 + suggestion on collision), `POST /api/namecards/:id/photo` (≤2 MB; image/jpeg|png|webp only — server-enforced per §4.2), `DELETE /api/namecards/:id/photo`, `PATCH /api/namecards/:id/toggle`, `DELETE /api/namecards/:id`, `GET /api/namecards/me`.
- Slug uniqueness via the `UNIQUE` index — caught at write time, surfaced as 409 with a `suggestAlternatives()` payload.
- Photo upload enforces: 2 MB cap (`NAMECARD_PHOTO_MAX_BYTES` constant added to `portal.ts`, parallel to `MEMBERSHIP_MAX_FILE_BYTES`), allowed content-types, R2 key `namecards/{member_id}/photo.{ext}`, records `httpMetadata.contentType` for the public stream (pattern from `membership-reg.ts:225-249`).
- Hard delete also removes the R2 object (best-effort; don't fail the DELETE if R2 already gone).
- Errors via the existing `handleApiError` (`src/worker/lib/error-handler.ts:5-29`).
- Tests via Miniflare: full CRUD happy path; non-admin POST → 403 (middleware gate); slug collision → 409 + suggestion; photo upload > 2 MB → 413; photo upload with `image/gif` → 400; `GET /api/namecards/me` returns caller's own row only.

### 3.3 `src/pages/namecards.astro`

- Pattern mirrors `src/pages/members.astro`: `<AdminLayout currentPath="/namecards">`, `.card` toolbar (search + visibility filter + "Add namecard" + "Bulk create"), `.data-table` with `#namecards-list` populated by `innerHTML`, edit modal following the same `style="display:none/flex"` pattern.
- Row actions: copy-link (slug), preview (`/c/{slug}` new tab), edit, toggle visibility, delete.
- Edit drawer fields per spec §10.2: socials (website, facebook, linkedin, instagram, tiktok, youtube), whatsapp, bio, photo_alt, template, qr_variant, name_family/name_given overrides, slug, photo upload/replace/remove.
- Photo upload reuses the client-side canvas-resize pattern from `register.astro:307-327` (`createImageBitmap` → canvas → `toBlob`), retargeted to ~800×800 square crop before POST. Server still enforces the 2 MB cap regardless of client.
- Auth gate via `requireAuth({ onAuthenticated(data) { ... } })` from `src/scripts/auth-gate.ts`; admin-only actions gated by toggling `display` based on `data.is_admin`.

### 3.4 Nav entry (`src/layouts/AdminLayout.astro`)

- Add to `navItems` (`:27-39`): `{ href: '/namecards', label: 'Namecards', matchPrefix: ['/namecards'] }`. One entry populates both desktop and mobile nav (both render from the same array). No per-item role attribute needed — gating happens per-page.

### 3.5 Self-service panel

- Lives on the existing members/profile page (or a section of `namecards.astro` for the logged-in user). Visible to any authenticated role.
- Shows: live QR preview (`src/scripts/namecard-qr.ts`), public URL with copy button, "Download QR image", "Download card image" (canvas from inlined SVG), "Download vCard".
- Data source: `GET /api/namecards/me`.

**Phase 3 deliverable**: an admin can fully populate cards end-to-end. Tests cover the middleware gate and handler logic.

---

## Phase 4 — Atomic soft-delete refactor

Spec §9.4. `DELETE /api/members/:id` (`src/worker/api/members.ts:124-154`) currently issues a single `.run()` UPDATE. Refactor to `c.env.DB.batch([...])` so the member soft-delete and the `namecards.has_namecard = 0` update land in one transaction (D1 executes `batch()` as a single transaction). Pre-existing `DB.batch` precedent at `members.ts:245-254`.

- The existing pre-checks (member exists, can't delete self, IT-admin emails protected) and the post-batch KV OTP-kill (`c.env.SWA_SESSION.delete(\`swa:otp:${email}\`)`at`:150`) stay as-is.
- Tests: soft-deleting a member with a namecard row atomically sets both `members.deleted_at` and `namecards.has_namecard = 0`; the public `/c/{slug}` route immediately returns the branded 404; a member without a namecard row still soft-deletes cleanly (the second UPDATE is a no-op).

---

## Phase 5 — `swa2024` cleanup PR

Spec §14. **Separate PR after the new surface is live and smoke-tested.** The `swa2024` sibling repo exists at `~/Documents/Projects/swa2024/` with all §14.1 files present (confirmed at planning time).

### 5.1 Verify before delete

Run from the `swa2024` root: `rg -n "NameCard|namecard|hasNamecard|MemberBioModal|StandaloneLayout|vcard" src/`. Two pre-identified caveats from exploration:

- **`src/layouts/StandaloneLayout.astro` is NOT namecard-only** — referenced by `src/layouts/Layout.astro`. The spec's "only if confirmed unused elsewhere" caveat (`§14.1`) applies. Decision needed at execution time: keep it, or refactor `Layout.astro` first.
- **`src/utils/vcard.js` appears to have zero importers** — likely dead code already. Confirm with a `swa2024` build before deleting.

### 5.2 Files to delete

Per spec §14.1: `NameCardLayout.astro`, `NameCardActions.astro`, `MemberBioModal.astro`, the `src/pages/namecard/` directory, `namecard-urls.txt`, `namecard-urls-table.txt`, `utils/vcard.js` (after a build confirms unused), possibly `StandaloneLayout.astro` (after the `Layout.astro` question is resolved).

### 5.3 Files to edit

- `src/content.config.ts`: strip namecard-only schema fields (`hasNamecard`, `jobTitle`, `whatsapp`, `address`, `facebook`, `linkedIn`, `ig`, `tiktok`, `yt`); keep `name`, `role`, `description`, `sortOrder`, `photo`, `photoAlt` if still used by the public members listing.
- ~22 member markdown files under `src/content/members/*.md`: strip the same frontmatter keys (body biography text stays if still rendered).
- Grep-clean any remaining `NameCard` / `namecard` references.
- `swa2024/docs/NAMECARD.md`: replace with a short pointer to `swa-portal/docs/specs/features/namecards.md` so old links still resolve.
- **Redirect decision (owner)**: 301 `/namecard/*` → `https://admin.singaporewomenassociation.org/c/:slug`, or let them 404? Spec §17.2 flags this as owner-decides.

### 5.4 Verification

- `swa2024` site builds clean.
- No dangling references (re-run the §5.1 `rg` — should return only the docs pointer).
- Redirect/404 policy applied.

---

## Phase 6 — Owner-run go-live

All production steps are **owner-run, manual** per spec §0. No automation, no agent-run `--remote` commands.

1. **Backup**: `wrangler d1 export swa-portal --remote --output=backup.sql`
2. **Apply migration**: `wrangler d1 execute swa-portal --remote --file=migrations/007_namecards.sql`
3. **Edit + deploy**: extend `wrangler.jsonc` `run_worker_first` to `["/api/*", "/c/*"]`; `npm run build && npm run deploy`
4. **Seed**: admin creates namecard rows for current board (bulk create available), uploads photos
5. **Smoke** the spec §16 checklist on real iOS Safari + Android Chrome — focus on the `.vcf` download → import flow, QR scan both variants, canvas-not-tainted PNG export, OG image fallback (static PNG until Phase 2.1)
6. **swa2024 cleanup** (Phase 5 PR) once the new surface is confirmed

---

## Testing strategy summary

| Layer                                              | Tool                                | Coverage                                                                                                   |
| -------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Pure libs (slug, sanitize, vcard, svg, qr payload) | Vitest unit                         | Exhaustive — every branch and edge case                                                                    |
| Rate limiter (IP-keyed)                            | Vitest + Miniflare KV               | Window math, sliding eviction, 60/min boundary                                                             |
| Public `/c/*` routes                               | Vitest + Miniflare (D1 + R2)        | HTML render, branded 404, vcf headers, svg no-external-refs, photo stream cache headers, 429 on rate limit |
| Admin `/api/namecards/*`                           | Vitest + Miniflare (D1 + R2 + auth) | CRUD happy path, middleware 403 gate, slug collision 409, photo size/type rejection, `/me` scoping         |
| Soft-delete atomicity                              | Vitest + Miniflare D1 batch         | Both rows flip together; public route immediately darks                                                    |
| Cross-device vCard/QR import                       | Manual (spec §16)                   | iOS Safari, Android Chrome — cannot be automated                                                           |
| Lighthouse mobile ≥ 90                             | Manual                              | `/c/:slug`                                                                                                 |

Test files live alongside source under `src/worker/lib/__tests__/` and `src/worker/api/__tests__/`, matching the conventional Vitest layout.

---

## Open decisions flagged (spec §17, not blocking Phase 0–1)

1. Slug source — auto-derive from `members.name`, editable, with `name_family`/`name_given` overrides. **Proposed: yes.**
2. `/namecard/*` redirects from `swa2024` — 301 vs 404. **Owner decides (Phase 5).**
3. Public directory page `/c/` — closed for v2.0 (cards shared individually). **Proposed: closed; revisit Phase 2.2.**
4. Bio rendering — plain text `<details>` default; markdown only if later requested.
5. Committee-vs-volunteer read gating on `/api/namecards` — MVP leaves reads open to all authenticated roles.
6. Photo-in-vCard — included by default (high UX value). **Owner to confirm.**
7. **Card badge logo source** (from §1.3 implementation note 1) — does a vector source (SVG/Illustrator/PDF) of the SWA badge logo exist? If not, the owner must supply a high-resolution transparent PNG (≥600 px square) for embedding. Without one of these, the card cannot reproduce the §1.3 design. **Owner to confirm before Phase 1 implementation of `namecard-svg.ts` begins.**

---

## Rollback (spec §13.2, every step owner-reversible)

| Change                        | Rollback                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| Bad namecard code             | Revert + redeploy `swa-portal`; cards go dark, admin data untouched        |
| Bad migration                 | `DROP TABLE namecards` (no inbound FKs from other tables)                  |
| `run_worker_first` regression | Remove `/c/*` from array + redeploy; `/c/*` returns 404 from asset handler |

---

## Out of scope (spec §1.1, §15)

- Phase 2.1 server-side PNG endpoints (`/c/:slug/qr.png`, `/card.png`, `/og.png`) via `@resvg/resvg-wasm` — requires separate package-safety approval
- Phase 2.2 public directory page `/c/`
- Phase 3.0 member self-edit at `/c/:slug/edit` (which also closes the §5.3 stale-role gap with per-write `members.category`/`can_login`/`deleted_at` re-checks)
- Any new Cloudflare resource, DNS record, subdomain, or secret
