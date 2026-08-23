# SWA Digital Namecard System - Technical & Functional Specification

> **This is the namecards feature spec** in the per-feature specs structure (moved from `docs/NAMECARD.md`, 2026-08-23). The portal-side `/namecards` admin page and self-service panel are covered in §9; the public `/c/*` surface in §5.
>
> ✅ **FEATURE RESTORED — 23-08-2026, board-only with guardrails.** The
> public `/c/*` card pages are live again, changed as follows from the
> original build:
>
> 1. **Board-only.** Cards are served only for members whose `category` is
>    `committee` or `advisor` (`NAMECARD_BOARD_CATEGORIES` in
>    `src/constants/portal.ts`). The gate is enforced at read time in the
>    SQL, so demoting a member darkens their card instantly.
> 2. **Auto-generated.** Saving a member into a board category (create or
>    category change) creates their card automatically; the admin bulk
>    button ("Auto-generate board cards") backfills the rest.
> 3. **Office address only.** Every card (HTML page, vCard) shows the SWA
>    office address (`SWA_OFFICE_ADDRESS`), never a member's personal
>    address. Personal address columns are not even selected by the public
>    read query.
> 4. **Blocked from indexing and AI crawlers.** `robots.txt` disallows
>    `/c/` explicitly for all listed bots (search + AI), and every `/c/*`
>    response carries `X-Robots-Tag: noindex, nofollow, noarchive,
>    nosnippet, notranslate, noimageindex` plus the matching meta tag.
>
> This spec below describes the feature as originally built; where it
> mentions personal addresses or all-members cards, the four rules above
> win. See `docs/plans/security-remediation-plan.md` (Phase 2) for the
> 2026-08-22 hiding, and `progress.md` (2026-08-23) for the restore.

> **Version**: 2.2 (restored board-only)
> **Date**: 2026-08-23
> **Status**: Live (board-only restore)
> **Scope**: Full redesign of the digital namecard feature. Hosted inside the existing `swa-portal` Worker (no separate subdomain, no separate deployment). Shares auth, data plane, and bindings with the rest of the portal. Decoupled from the public marketing website (`swa2024`).

---

## 0. Deployment & Change-Control Policy

**Production deployments and any change to Cloudflare production resources (D1, KV, R2, Workers, DNS, secrets, custom domains) are performed manually by the project owner only.** No automated pipeline, script, or agent may run `wrangler deploy`, `wrangler d1 execute --remote`, `wrangler secret put`, `wrangler r2 object`, KV writes, or any other command against the production account. The commands in this document are reference material listing the *intended* operation; the owner decides when and whether to run them.

This rule extends the existing `AGENTS.md` clause "Destructive local scripts are user-invoked only" to cover every remote/production Cloudflare operation.

Local-dev equivalents (`--local`, `npm run dev`, `npm run dev:worker`) are fine for any contributor to run.

---

## 1. Goals and Requirements

| # | Requirement | How it is met |
|---|---|---|
| 1 | Host the digital namecard in the existing `swa-portal` Worker (no new subdomain), reusing the SWA staff email OTP login. | Public namecard routes are added to the existing Hono worker at `/c/*`, served from `admin.singaporewomenassociation.org/c/:slug`. `run_worker_first` is extended to include `/c/*` so these routes hit the Worker rather than the static asset handler. No new DNS, no new Worker, no new domain. |
| 2 | **Auto-generate a QR code** that can be downloaded as an image, saved to a phone, and shared. When scanned it must load a `.vcf` that auto-adds to the contact book. | QR encodes the public vCard URL (`/c/{slug}/contact.vcf`). PNG is generated client-side from the member dashboard and the public card page. Scanning opens the URL, the Worker serves the `.vcf` with `text/vcard` + `attachment` + `nosniff` headers, the phone browser downloads it and the OS contact picker imports it. |
| 3 | **Auto-generate a designed namecard image** (downloadable, shareable) containing photo, social links, email, mobile. All fields editable in `swa-portal`. | A branded SVG template is rendered from D1 data; members download it as SVG or, via in-browser canvas, as PNG. Field editing happens in the admin namecards surface. |
| 4 | The **member roster for namecards is maintained separately in `swa-portal`** with **no dependency on `swa2024`**. Existing namecard code in `swa2024` is removed. | Namecard data lives in a new `namecards` table inside the `swa-portal` D1 database. Section 14 lists every file and schema field to delete from `swa2024`. |

### 1.1 Non-goals

- No SSG/build-time generation. Dynamic D1-backed rendering only.
- No public editing surface. Editing is admin-gated. Phase 3 may add member self-edit.
- **No new subdomain.** Public cards live at `admin.singaporewomenassociation.org/c/:slug`. A dedicated `namecard.*` domain was considered (see §2.1) and rejected to keep the production Cloudflare footprint unchanged.
- No dark mode, no multi-language, no calendar booking.

---

## 2. Architectural Decision

### 2.1 Why host inside `swa-portal` (not a separate Worker)

A separate `swa-namecard` Worker on its own subdomain was originally proposed. It is **not** being built. Reasons:

| Concern | Separate Worker (rejected) | Inside `swa-portal` (chosen) |
|---------|----------------------------|------------------------------|
| Production change footprint | Requires new DNS record, new Worker, new wrangler config, new secrets, cross-subdomain cookie scoping. All manual owner work against production. | Zero new Cloudflare resources. Only the existing `swa-portal` Worker is redeployed, and only the owner does so. |
| Cookie sharing | Would require widening `swa_session` to `Domain=.singaporewomenassociation.org` and reconsidering `SameSite=Strict`. Not worth the blast radius — the cookie is currently host-only and stays that way. | Cookie already works on its host-only domain. No attribute changes anywhere. |
| Risk segregation | A viral namecard share cannot starve the admin Worker. | Shared fate. Mitigated: public routes are stateless, edge-cached, and IP-rate-limited (§5.4). |
| Deployment | Owner must deploy and monitor two Workers. | Owner deploys one Worker, one config, one set of secrets. |

**Trade-off accepted**: public namecard URLs sit on the admin hostname. This is a semantic imperfection but matches the explicit project decision to avoid any new production DNS/subdomain.

### 2.2 Why a separate `namecards` table (not columns on `members`)

Migration `006_remove_website_columns.sql` already dropped `slug, photo_url, photo_alt, description, show_on_website, has_namecard`, and the five social columns from `members` to keep auth/identity data clean. Re-adding them as columns would undo that cleanup.

- Core identity (`name`, `email`, `mobile`, `job_title`, `role`, `address_*`) stays the single source of truth on `members`.
- Namecard-only presentation data (`slug`, `photo`, `bio`, socials, visibility, template, and optional `name_family`/`name_given` overrides) lives in a new `namecards` table with a 1:1 relationship to `members(id)`.
- Dropping the namecard feature again is `DROP TABLE namecards` plus deleting the routes; zero impact on login, bookings, or membership.

### 2.3 High-level topology

```
                  +-----------------------------+
                  |  Cloudflare D1 (swa-portal) |
                  |  tables: members, namecards |
                  +--------------+--------------+
                                 |
                  +--------------+--------------+
                  |     swa-portal Worker       |
                  |   admin.singaporewomen-     |
                  |   association.org           |
                  |                             |
                  |   /api/*      -> auth req'd |
                  |   /c/*        -> public     |
                  +-----------------------------+
                                 |
        KV SWA_SESSION, R2 swa-portal-uploads, secrets OTP_SECRET / SESSION_SECRET
```

Single Worker, single domain, single set of bindings. The `/c/*` route prefix is the public surface; everything under `/api/*` keeps the existing auth gating.

---

## 3. Repository and Folder Layout

All new code lives inside the existing `src/` tree. **No monorepo, no `workers/` sub-folder, no npm workspaces** — the repository stays a single package.

```
swa-portal/                       <- existing repo root
+-- src/
|   +-- worker/
|   |   +-- api/
|   |   |   +-- namecards.ts          <- admin CRUD (auth-gated, under /api/namecards/*)
|   |   |   +-- namecard-public.ts    <- public /c/* routes (HTML, vcf, svg, photo)
|   |   +-- lib/
|   |   |   +-- namecard-photo.ts     <- R2 upload + read helpers (no auth on read)
|   |   |   +-- namecard-svg.ts       <- branded SVG template renderer (fully self-contained)
|   |   |   +-- namecard-qr.ts        <- QR payload helper (client does the raster)
|   |   |   +-- namecard-vcard.ts     <- vCard 3.0 builder (CRLF-safe, line-folded, PHOTO field)
|   |   |   +-- namecard-slug.ts      <- slug validation + uniqueness + collision suggestions
|   |   |   +-- namecard-sanitize.ts  <- URL scheme allow-list + text escape
|   |   |   +-- namecard-rate-limit.ts<- IP-keyed limiter for public routes
|   +-- pages/
|   |   +-- namecards.astro           <- admin: list + edit
|   +-- scripts/
|   |   +-- namecard-qr.ts            <- client-side QR + logo overlay + PNG export
|   +-- styles/
|       +-- namecard-public.css       <- styles for the /c/:slug HTML page
+-- migrations/
|   +-- 007_namecards.sql             <- NEW D1 schema
+-- docs/
    +-- NAMECARD.md                   <- this file
```

The Hono entry `src/worker/index.ts` registers both the public `/c/*` routes (before the auth-protected `/api/*` block, no middleware) and the admin `/api/namecards/*` routes (under the existing `authMiddleware`).

**`wrangler.jsonc` change is one line** (owner-applied on the next manual deploy): extend `run_worker_first` from `["/api/*"]` to `["/api/*", "/c/*"]`. This routes public namecard requests to the Hono worker instead of the static asset handler.

---

## 4. Data Model

### 4.1 New table `namecards`

Migration file: `migrations/007_namecards.sql`

```sql
-- 007_namecards.sql
--
-- Namecard presentation data. 1:1 with members(id).
-- Core identity (name, email, mobile, job_title, address_*) is NOT duplicated
-- here; it is read from members at render time. This keeps auth/identity data
-- clean (see migration 006) and lets the feature be dropped without touching
-- login, bookings, or membership.
--
-- Apply (OWNER, MANUAL, after a D1 backup):
--   wrangler d1 export swa-portal --remote --output=backup.sql
--   wrangler d1 execute swa-portal --remote --file=migrations/007_namecards.sql

CREATE TABLE IF NOT EXISTS namecards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL UNIQUE REFERENCES members(id),
  slug            TEXT NOT NULL UNIQUE,              -- URL segment, lowercase, kebab-case
  has_namecard    INTEGER NOT NULL DEFAULT 1,        -- 0 = row exists but card hidden
  template        TEXT NOT NULL DEFAULT 'default',   -- future: alt card designs
  photo_r2_key    TEXT,                              -- R2 object key for headshot
  photo_alt       TEXT,                              -- accessibility text
  bio             TEXT,                              -- plain text (zero-JS <details>)
  name_family     TEXT,                              -- optional override for vCard N: field
  name_given      TEXT,                              -- optional override for vCard N: field
  whatsapp        TEXT,                              -- full international form, e.g. +6591234567
  website         TEXT,
  facebook        TEXT,
  linkedin        TEXT,
  instagram       TEXT,
  tiktok          TEXT,
  youtube         TEXT,
  qr_variant      TEXT NOT NULL DEFAULT 'vcf',       -- 'vcf' | 'page' (what the QR encodes)
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_namecards_slug      ON namecards(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_namecards_member_id ON namecards(member_id);
CREATE INDEX        IF NOT EXISTS idx_namecards_visible   ON namecards(has_namecard) WHERE has_namecard = 1;
```

Notes:

- `member_id` is `UNIQUE`, enforcing the 1:1 relationship. Inserting a namecard row for a member who already has one is an error caught by the admin UI, not by silent overwrite.
- `slug` is `UNIQUE`. Slugs are derived from `members.name` on creation and editable thereafter. Uniqueness and format are validated server-side; collisions return 409 with a suggested alternative (§10.2).
- `has_namecard = 0` keeps the row (preserving photo and edits) while hiding the public card. This is the soft-disable path; hard delete is admin-only and also removes R2 objects.
- Social column names are the full lowercase forms (`linkedin`, `instagram`, `youtube`), matching the convention migration `006` used when it dropped them. The old swa2024 camelCase forms (`linkedIn`, `ig`, `yt`) are **not** reused.
- `whatsapp` is stored separately from `members.mobile` because a member may want a different number for WhatsApp than the official contact, and WhatsApp links require a specific format (§8.4).
- **`name_family` / `name_given`** are optional presentation overrides for the vCard `N:` field and the SVG card. When null, the system falls back to splitting `members.name` on the last whitespace. This fixes the documented vCard `N:` limitation for Malay/Indian/mononym/multi-word-surname names (common in SWA's membership) without touching the identity table.

### 4.2 Server-side upload constraints

The `/api/namecards/:id/photo` handler enforces (not client-trust):

- Maximum body size: **2 MB**. Larger uploads are rejected with 413.
- Allowed content-types: `image/jpeg`, `image/png`, `image/webp` only. Rejected with 400 otherwise.
- The R2 object's `httpMetadata.contentType` is recorded so the public stream sets the right header.

Client-side canvas resize to ~800×800 is recommended for upload efficiency but is **not** the only line of defence. This bounds the SVG card payload when the photo is base64-embedded (§8.3).

### 4.3 Read model (the join)

The public Worker never queries `members` alone; it always joins. The canonical read query:

```sql
SELECT
  m.name, m.email, m.mobile, m.job_title, m.role,
  m.address_line1, m.address_line2, m.address_postal_code, m.address_country,
  n.slug, n.photo_r2_key, n.photo_alt, n.bio,
  n.name_family, n.name_given,
  n.whatsapp, n.website,
  n.facebook, n.linkedin, n.instagram, n.tiktok, n.youtube,
  n.qr_variant, n.template, n.updated_at
FROM namecards n
JOIN members m ON m.id = n.member_id
WHERE n.slug = ?1
  AND n.has_namecard = 1
  AND m.deleted_at IS NULL;
```

A deleted member (`members.deleted_at IS NOT NULL`, confirmed present at `schema.sql:266` via migration `003_soft_delete.sql`) never renders a public card, regardless of the namecard row. The admin Worker mirrors the soft-delete atomically: when a member is soft-deleted, the corresponding `namecards.has_namecard` is set to `0` in the same D1 batch so the card goes dark immediately (see §9.4).

---

## 5. Authentication and Access Control

### 5.1 Three surface types

| Surface | Auth | Where |
|---------|------|-------|
| Public card page + assets (`/c/:slug`, `.vcf`, `.svg`, photo) | **None** (publicly cacheable) | `swa-portal` Worker, `/c/*` routes |
| Admin CRUD (create/edit/disable/delete namecards, upload photo) | **OTP session, admin role** | `swa-portal` Worker, `/api/namecards/*` |
| Member self-service download (download my QR, my card image) | **OTP session, any role** | `swa-portal` Worker, `/api/namecards/me` |

### 5.2 Cookie scope — no changes required

Because there is no new subdomain, `swa_session` continues to work as a host-only cookie on `admin.singaporewomenassociation.org`. **No changes to `src/worker/api/verify-otp.ts:119`, `src/worker/api/dev-login.ts:93`, or `src/worker/api/session.ts:194,206` are required.** The original cross-subdomain concern is moot. Session verification at `src/worker/api/session.ts:113-146` is purely HMAC-based (no KV/D1 lookup, no IP/UA binding), so authenticated `/api/namecards/*` routes work identically to the rest of the admin API.

### 5.3 Stale-role and revocation gap (acknowledged; Phase 3 only)

`resolveSessionRole` (`src/worker/lib/session-role.ts:30-53`) is called only at mint time. `authMiddleware` (`src/worker/middleware.ts:100-103`) uses the cookie's role verbatim with no KV/D1 re-check and no revocation list. For v2.0 this is benign because the only authenticated namecard surfaces are admin (already admin-gated by the cookie) and `/api/namecards/me` (returns the caller's own data).

For Phase 3 member self-edit, the implementation **must** add a server-side re-check of `members.category`, `can_login`, and `deleted_at` on each write (a demoted or removed member must not retain write access until cookie expiry), and should consider a session-version counter in KV. This is flagged now so the Phase 3 design does not inherit the gap silently.

### 5.4 Rate limiting

Two separate limiters:

- **Public vCard, card-image, and photo endpoints**: a new IP-keyed limiter at `swa:rl:card:ip:{ip}` in the `SWA_SESSION` KV namespace, **60 req/min** sliding window. This **cannot reuse `checkApiRateLimit`** (`src/worker/lib/rate-limit.ts:9-29`) because that function is keyed by `email` and assumes an authenticated session. A dedicated `namecard-rate-limit.ts` reads `CF-Connecting-IP`.
- **Admin write endpoints**: inherit the existing `checkApiRateLimit` email-keyed limiter via `getEndpointKey` (extend it to recognise `/api/namecards` writes).

### 5.5 Public-route gating in middleware

`/c/*` is excluded from `authMiddleware` by virtue of the middleware being scoped to `/api/*` (`src/worker/index.ts:36`). Public endpoints live under `/c/*` and never under `/api/*`. Admin endpoints under `/api/namecards/*` inherit the existing auth path.

For the admin/committee/volunteer read distinction on `/api/namecards`:

- **Writes (POST/PATCH/DELETE)** are admin-only. Add `/api/namecards` to the `ADMIN_WRITE_API` set in `src/worker/middleware.ts:24-26`. This is the primary gate. The in-handler `session.role === 'admin'` check is defence-in-depth.
- **Reads (GET)** are open to every authenticated role today (the existing `ADMIN_WRITE_API` set only gates non-GET methods — `middleware.ts:139-143`). The MVP ships with reads open to all authenticated roles. If SWA later requires committee-or-above reads (excluding volunteer), add a new path-specific gate analogous to `ONLINE_FORMS_API` (`middleware.ts:162-166`); this is a §17 open decision, not a v2.0 blocker.

---

## 6. Public Card Page

### 6.1 Route

`GET /c/:slug` -> HTML page, server-rendered as a Hono `Response` (string HTML). No Astro SSR, no static build per member. (Short path `/c/` keeps QR payloads small and reads well on a phone screen.)

### 6.2 Page composition

The page is server-rendered HTML (no client framework) styled to match the SWA brand. Sections:

1. Header: gradient band (`from-swa-1 to-swa-3`), circular photo, name, `job_title`, "Singapore Women's Association".
2. Bio trigger: zero-JS `<details>` element when `bio` is non-empty (no Flowbite on the public page; resilience over animation).
3. Contact rows: mobile (`tel:`), email (`mailto:`), address (`<address>`).
4. Action buttons: "Save contact" (links to `/c/:slug/contact.vcf`), "WhatsApp" (if set), "Share" (Web Share API + clipboard fallback), "Copy link", "Copy vCard text" (fallback for Safari edge cases — see §6.6).
5. Social row: icons for each populated social field, `target="_blank" rel="noopener noreferrer"`, scheme-validated server-side (§6.5).
6. QR panel: client-rendered canvas with "Save QR" and "Save card image" buttons (§7 and §8).
7. Footer: organisation info block, "Visit SWA website" link.

### 6.3 Brand and styling

- Colours come from the SWA palette: `swa-1 #70308c`, `swa-2 #450a5e`, `swa-3 #874ba1`, `swa-4 #f3d2ff`.
- One small inline `<style>` block. **No Tailwind on the public page** — keeps payload small and the page self-contained for canvas export.
- British English in all visible copy ("organisation", "mobile", "programme").

### 6.4 SEO and social preview

Each card page emits:

- `<title>{Name} - Digital Namecard | SWA</title>`, meta description, canonical URL.
- Open Graph tags (`og:type=profile`, `og:image`).
- Twitter card (`summary_large_image`).
- JSON-LD `Person` schema with `worksFor` -> `Organization`, `email`, `telephone`, `image`, `url`, and `sameAs` (populated from the social fields).

**OG image caveat**: WhatsApp and LinkedIn **do not render SVG OG images**. Until the Phase 2.1 `/c/:slug/og.png` endpoint ships, `og:image` must point at a **static branded PNG** (no photo) committed to the repo, e.g. `/og-namecard-default.png`. Otherwise previews are blank on those platforms. A photo-bearing OG image arrives in Phase 2.1 alongside `/c/:slug/og.png`.

### 6.5 URL scheme allow-list

Every URL field (`website`, `facebook`, `linkedin`, `instagram`, `tiktok`, `youtube`, `whatsapp`) is validated server-side on write. Allowed schemes: `http:`, `https:` only. `whatsapp` is additionally normalised to digits-only with a leading `+`. `mailto:` and `tel:` are constructed by the renderer from `email`/`mobile` — never taken as raw input. `javascript:`, `data:`, `vbscript:`, `file:`, and unknown schemes are rejected with 400. See `src/worker/lib/namecard-sanitize.ts`.

### 6.6 Disabled / not-found public states

A visitor who hits a slug that is missing, has `has_namecard = 0`, or belongs to a soft-deleted member sees a **branded** HTML page (not a bare 404): "This namecard is not available. Visit singaporewomenassociation.org." with a link to the marketing site. Status code 404 (or 410 if the card was intentionally disabled, at the implementation's discretion).

The "Copy vCard text" button in §6.2 step 4 covers the iOS Safari edge case where `.vcf` download is intercepted and rendered as plain text: the user can paste the vCard into a contacts app manually as a last-resort fallback.

---

## 7. QR Code Generation (Requirement 2)

### 7.1 What the QR encodes

Two variants, selectable per member via `namecards.qr_variant`:

| Variant | Payload | Scan behaviour |
|---------|---------|----------------|
| `vcf` (default) | `https://admin.singaporewomenassociation.org/c/{slug}/contact.vcf` | Phone browser opens the URL, downloads the `.vcf`, user taps to import into Contacts. Reliable cross-platform path. |
| `page` | `https://admin.singaporewomenassociation.org/c/{slug}` | Phone browser opens the full interactive card. Visitor can then tap "Save contact". |

Raw `BEGIN:VCARD` text in the QR is intentionally avoided because recent iOS and many Android camera apps no longer parse vCard-text QR into the contact picker, and vCard text produces large QR payloads that scan poorly. A URL QR is small, scans fast, and degrades gracefully.

### 7.2 QR rendering (PNG download)

**MVP (v2.0)**: client-side, reusing the proven pattern already in this repo at `src/pages/reg/membership/register.astro:142-205`:

```ts
// Loaded from /js/qrcode.min.js (already shipped via the copy:qrcode prebuild hook)
const QRCode = (window as any).QRCode;
QRCode.toCanvas(canvas, payload, {
  width: 512,
  margin: 2,
  errorCorrectionLevel: 'H',     // required so the SWA centre logo does not break scanning
  color: { dark: '#70308c', light: '#ffffff' },
}, () => {
  // Overlay SWA logo at centre (≤15% of QR width — see §7.3), then:
  const pngDataUrl = canvas.toDataURL('image/png');
  // Trigger download as {slug}-qr.png
});
```

This produces a 512×512 PNG with the SWA mark embedded, directly saveable to a phone gallery. No server rasterisation, no new heavy dependency, no Workers-runtime risk.

**Target (Phase 2.1)**: a server endpoint `GET /c/:slug/qr.png` so a stable image URL exists for embedding in emails or printed collateral. Prerequisites the owner must approve:

- Move `qrcode` from `devDependencies` to `dependencies` (currently `package.json:30`) — bundled into the Worker.
- PNG output requires either `qrcode`'s PNG encoder (pure JS but uses Node-style `Buffer`, needing a small polyfill) or `@resvg/resvg-wasm`. SVG-first via `qrcode.toString(text, { type: 'svg' })` is Workers-safe and is the recommendation; PNG follows once `resvg-wasm` is validated. Package-safety approval per `AGENTS.md` is required before either install.

### 7.3 Logo embedding constraint

The SWA centre mark is composited client-side on the canvas after the QR is drawn. To keep scan reliability across render sizes (512px download, smaller web/print embeds), the logo is capped at **≤15% of QR width** with a white-filled circular backdrop. `errorCorrectionLevel: 'H'` is mandatory. The original 20% figure was at the edge of scannability at sub-256px render sizes and is reduced as a safety margin.

**The logo must be inlined as a data URI or inline `<svg>` paths in any canvas-rendered output.** An external `<img src="/swa-logo.webp">` would taint the canvas and silently break PNG export (§8.2 has the same rule for the card SVG).

### 7.4 Download affordances

Two places a member obtains the QR PNG:

1. **swa-portal, member self-service panel** (after OTP login): a "Your namecard" card shows a live QR preview and a "Download QR image" button. Primary path.
2. **Public card page** (`/c/:slug`): a "Save QR" button on the QR panel, for visitors who received the card link and want the QR too.

Both use the same client-side canvas routine.

---

## 8. Namecard Image Generation (Requirement 3)

### 8.1 Template

A branded SVG template (`src/worker/lib/namecard-svg.ts`) renders a 1050×600 (roughly 7:4 business-card-landscape) image with:

- SWA gradient header band (`#70308c` -> `#450a5e`).
- SWA monogram top-left, **inlined as `<svg>` paths** (not `<img>`).
- Circular headshot (photo fetched from R2, embedded as a base64 JPEG/WebP inside the SVG `<image>` so the SVG is self-contained and portable).
- Name (large, extrabold) — uses `name_given` / `name_family` when set, else `members.name`.
- `job_title` (medium purple), "Singapore Women's Association" (muted).
- Contact block: mobile, email.
- Social icon strip: filled glyphs for each populated platform (inline SVG), with the platform handle or URL beneath.
- Footer: card URL `admin.singaporewomenassociation.org/c/{slug}` and a small SWA logo (inline).

**Every resource inside the SVG is inlined** (data URIs or inline SVG). No external references — this is required for the client-side canvas PNG export (§8.2) to avoid tainting. All text uses British English and the SWA palette. `template = 'default'` today; alternative layouts can be added later without API changes.

### 8.2 Delivery formats

| Endpoint / button | Format | How produced | Phase |
|-------------------|--------|--------------|-------|
| `GET /c/:slug/card.svg` | SVG | Server-rendered from D1 + R2, deterministic | 2.0 (primary) |
| "Save card image" button | PNG | Client-side: SVG -> `<img>` -> `<canvas>` -> `toDataURL('image/png')` | 2.0 |
| `GET /c/:slug/card.png` | PNG | Server-side raster via `@resvg/resvg-wasm` | 2.1 |
| `GET /c/:slug/og.png` | PNG (1200×630) | Server-side raster, OG crop | 2.1 |

SVG is the v2.0 primary because it is crisp, self-contained, Workers-safe (pure string templating, no rasteriser), and editable. The "save to phone gallery" use case is served by client-side canvas conversion. The server PNG endpoints are reserved paths, delivered in Phase 2.1 once `resvg-wasm` is validated in the Workers runtime (and approved per `AGENTS.md` package safety).

### 8.3 Photo handling

- Admin uploads a headshot via `swa-portal` -> stored in R2 bucket `swa-portal-uploads` under key `namecards/{member_id}/photo.{ext}`. Handler enforces ≤2 MB and image/* content-type (§4.2).
- The public Worker streams it at `GET /c/:slug/photo.{ext}` straight from R2. Response headers:
  - `Content-Type`: from R2 `httpMetadata.contentType` (falls back to `application/octet-stream`).
  - `Cache-Control: public, max-age=86400, s-maxage=2592000` (immutable per slug; bump by overwriting the R2 key).
  - **Note**: this differs from `handleMembershipImage` at `src/worker/api/membership-reg.ts:520-530`, which uses `Cache-Control: private, max-age=3600` because it serves an authenticated admin drawer. The public photo stream **must** use `public` directives for edge caching to work. The R2-streaming *pattern* is reusable; the cache headers and the auth gate are not.
- For the SVG card image, the Worker fetches the photo from R2 at render time and base64-embeds it. With the 2 MB upload cap and recommended client-side normalisation (~800×800 square JPEG/WebP), the SVG payload stays bounded. Client-side resize happens in the admin upload form (canvas) before POSTing, matching how the membership form handles signature images.

### 8.4 WhatsApp, mobile, email formats

- `whatsapp`: stored as full international form, digits-only with leading `+`. Link form `https://wa.me/{digits-without-plus}`. Admin form normalises on save; server rejects malformed with 400.
- `mobile`: rendered with `tel:` and displayed human-formatted (`+65 9123 4567`).
- `email`: rendered with `mailto:`.

### 8.5 Caching

| Asset | `Cache-Control` | Notes |
|-------|-----------------|-------|
| Card page `/c/:slug` | `public, max-age=300, s-maxage=600` | Short browser TTL, longer edge TTL; edits appear within 5-10 min. A "purge after save" hook can be added in the admin handler. |
| vCard `/c/:slug/contact.vcf` | `public, max-age=300, s-maxage=600` | Same. |
| Photo `/c/:slug/photo.{ext}` | `public, max-age=86400, s-maxage=2592000` | Immutable per slug; bump by overwriting the R2 key. |
| QR/card SVG | `public, max-age=300, s-maxage=600` | Regenerable from D1; short TTL keeps edits fresh. |

The `REV` timestamp inside the vCard uses the row's `updated_at` reformatted as `YYYYMMDDTHHMMSSZ`, so re-importing an updated card refreshes the contact on devices that honour `REV`.

---

## 9. API Surface

### 9.1 Public endpoints (no auth, served by `swa-portal` Worker under `/c/*`)

| Method | Path | Response |
|--------|------|----------|
| GET | `/c/:slug` | HTML card page (or branded 404) |
| GET | `/c/:slug/contact.vcf` | `text/vcard; charset=utf-8`, attachment |
| GET | `/c/:slug/qr.svg` | SVG QR (Phase 2.1; client-side until then) |
| GET | `/c/:slug/qr.png` | PNG QR (Phase 2.1) |
| GET | `/c/:slug/card.svg` | SVG namecard image |
| GET | `/c/:slug/card.png` | PNG namecard image (Phase 2.1) |
| GET | `/c/:slug/photo.{ext}` | Raw photo streamed from R2 |

vCard response headers (critical for "scan -> download -> add to phonebook"):

```
Content-Type: text/vcard; charset=utf-8
Content-Disposition: attachment; filename="{Name}_SWA.vcf"
Cache-Control: public, max-age=300, s-maxage=600
X-Content-Type-Options: nosniff
```

**`X-Content-Type-Options: nosniff` is mandatory.** Without it, iOS Safari in some versions renders `.vcf` inline as text instead of offering the download/import flow.

### 9.2 Admin endpoints (`/api/namecards/*`, auth-gated)

Registered in `src/worker/index.ts`. Auth via existing `authMiddleware`.

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/api/namecards` | any authenticated | List all namecard rows joined with member identity |
| GET | `/api/namecards/:id` | any authenticated | Single namecard row |
| POST | `/api/namecards` | admin | Create namecard for a member (auto-derives slug from member name unless supplied) |
| POST | `/api/namecards/bulk` | admin | Create namecards for every member who lacks one (board onboarding) |
| PATCH | `/api/namecards/:id` | admin | Edit fields (socials, bio, whatsapp, website, template, qr_variant, photo_alt, name_family, name_given) |
| PATCH | `/api/namecards/:id/slug` | admin | Change slug (validates format + uniqueness; returns 409 with suggestion on clash) |
| POST | `/api/namecards/:id/photo` | admin | Upload headshot to R2, set `photo_r2_key` (≤2 MB, image/* only) |
| DELETE | `/api/namecards/:id/photo` | admin | Remove photo (clears key + deletes R2 object) |
| PATCH | `/api/namecards/:id/toggle` | admin | Flip `has_namecard` (soft enable/disable) |
| DELETE | `/api/namecards/:id` | admin | Hard delete row + its R2 photo |
| GET | `/api/namecards/me` | any authenticated | The caller's own namecard + public share URL + QR payload (for the self-service download panel) |

Writes are admin-only via `/api/namecards` membership in `ADMIN_WRITE_API` (`src/worker/middleware.ts:24-26`). The in-handler `session.role === 'admin'` check is defence-in-depth, not the primary gate.

### 9.3 vCard string format

vCard 3.0, built by `src/worker/lib/namecard-vcard.ts` with **mandatory** CRLF safety:

- Comma, semicolon, newline, and backslash in any field value are backslash-escaped per RFC 2426.
- Lines are folded at 75 octets.
- `N:` field uses `name_family`/`name_given` when set; otherwise splits `members.name` on the last whitespace (Western-order fallback).
- `PHOTO;ENCODING=b;TYPE=jpeg:{base64}` is included when a photo exists, so iOS Contacts and most Android skins display the photo on import. Base64 is folded across lines per spec.
- `REV` is the row's `updated_at` reformatted as `YYYYMMDDTHHMMSSZ`.
- Social links use the `X-SOCIALPROFILE;TYPE={platform}:` extension (imported or safely ignored by contact apps).

```
BEGIN:VCARD
VERSION:3.0
FN:Sarah Chen
N:Chen;Sarah;;;
TITLE:Chief Innovation Officer
ORG:Singapore Women's Association
TEL;TYPE=CELL:+6591234567
EMAIL;TYPE=INTERNET:sarah.chen@singaporewomenassociation.org
ADR;TYPE=WORK:;;96 Waterloo Street;Singapore;;187967;Singapore
URL:https://admin.singaporewomenassociation.org/c/sarah-chen
URL:https://www.singaporewomenassociation.org
X-SOCIALPROFILE;TYPE=facebook:https://www.facebook.com/...
X-SOCIALPROFILE;TYPE=linkedin:https://www.linkedin.com/in/...
PHOTO;ENCODING=b;TYPE=jpeg:/9j/4AAQSkZJRgABAQEASABIA...
REV:20260725T120000Z
END:VCARD
```

### 9.4 Member soft-delete interaction (required refactor)

The existing `DELETE /api/members/:id` handler at `src/worker/api/members.ts:124-154` currently issues a single `.run()` UPDATE. To make the namecard-dark promise atomic, refactor to a D1 batch (D1 executes a `batch()` as a single transaction):

```ts
await c.env.DB.batch([
  c.env.DB.prepare(
    `UPDATE members SET deleted_at = datetime('now'), can_login = 0, updated_at = datetime('now') WHERE id = ?`
  ).bind(id),
  c.env.DB.prepare(
    `UPDATE namecards SET has_namecard = 0, updated_at = datetime('now') WHERE member_id = ?`
  ).bind(id),
]);
```

The existing OTP-kill KV delete (`members.ts:150`, `c.env.SWA_SESSION.delete(\`swa:otp:${email}\`)`) stays as-is, after the batch.

---

## 10. Admin UI (inside `swa-portal`)

### 10.1 Topbar entry

Add a "Namecards" item to `navItems` in `src/layouts/AdminLayout.astro`, with `matchPrefix: ['/namecards']`. All authenticated roles see it (writes admin-only). This mirrors how Members is exposed today.

### 10.2 `pages/namecards.astro`

A single-page admin screen (pattern matches the existing `members.astro`):

- **Table**: photo thumbnail, name, `job_title`, slug (with copy-link button), socials present (icons), visibility toggle, "Edit", "Preview".
- **Filters**: search by name/slug; filter by visible/hidden.
- **Edit drawer/modal**: edit socials, whatsapp, website, bio, photo_alt, template, qr_variant, `name_family`/`name_given`; upload/replace/remove photo; change slug; toggle visibility.
- **Preview** (new): opens `/c/{slug}` in a new tab so the admin sees exactly what a visitor will see. (Staging of unpublished changes is a Phase 2 candidate; v2.0 preview reflects the live row.)
- **Create flow**: "Add namecard" picks an existing member who does not yet have a row, auto-derives a slug, opens the edit drawer.
- **Bulk create** (new): "Create namecards for all members without one" action — derives slugs, opens a review screen before commit. Useful for board onboarding (see `seed-members.sql`).
- **Slug collision helper** (new): when a slug clashes, the API returns 409 with a suggested alternative (`{slug}-2`, `-3`, …); the UI prefills it.
- **Self-service panel** (separate, on the existing members/profile page): shows the logged-in member their own card preview, public URL, "Download QR image", "Download card image", "Download vCard". Visible to any authenticated role.

### 10.3 Photo upload

The upload form resizes and square-crops client-side (canvas) to ~800×800 JPEG/WebP before POSTing to `/api/namecards/:id/photo` as `multipart/form-data`. The handler streams the bytes to R2 at key `namecards/{member_id}/photo.{ext}` and records the key + content-type. **The server enforces the 2 MB cap and image/* content-type regardless of what the client sends** (§4.2), avoiding any server-side image processing in the Workers runtime (no `sharp`).

---

## 11. Cloudflare Resources and Deployment

### 11.1 No new Cloudflare resources

This design adds **zero** new Cloudflare resources:

- No new D1 database (uses existing `swa-portal`, id `b8ca063c-6767-445c-a42e-d092daf80fc4`).
- No new KV namespace (uses existing `SWA_SESSION` id `ddb93996417c4476ac0f90ddf1eb332d`, and `SWA_CONFIG`).
- No new R2 bucket (uses existing `swa-portal-uploads`).
- No new Worker (uses existing `swa-portal`).
- No new DNS record, no new custom domain.
- No new secrets (`SESSION_SECRET`, `OTP_SECRET` already configured on the Worker).

### 11.2 Required `wrangler.jsonc` change (owner-applied on next deploy)

Extend `run_worker_first` from:

```jsonc
"run_worker_first": ["/api/*"]
```

to:

```jsonc
"run_worker_first": ["/api/*", "/c/*"]
```

This routes public namecard requests to the Hono worker instead of the static asset handler. The owner makes this edit and deploys manually.

### 11.3 Build and deploy (owner-run only)

```bash
# Local dev (any contributor)
npm run dev                  # Astro dev server at localhost:4321
npm run dev:worker           # wrangler dev (static + API) at localhost:8787

# Production build + deploy (OWNER ONLY, manual)
npm run build
npm run deploy
```

No new `package.json` scripts are required for v2.0. No npm workspaces. Phase 2.1 server-side QR/card PNG may introduce a helper script only if a separate build step becomes necessary; it does not today.

---

## 12. Cloudflare Edge Runtime Constraints

The same rules in the root `AGENTS.md` apply:

- **No Node.js built-ins.** Never import `fs`, `path`, `crypto` (Node), `http`/`https`. Use `fetch`, `crypto.subtle`, `Request`/`Response`, `URL`, `TextEncoder`/`TextDecoder`.
- **All bindings via `c.env`** (`DB`, `SWA_SESSION`, `R2_BUCKET`, `ASSETS`). `process.env` does not exist.
- **No `@astrojs/cloudflare` or SSR adapter.** The `/c/:slug` HTML is rendered as a `Response` from Hono (string HTML), not via Astro SSR.
- **Image work in v2.0 is client-side** precisely to stay within these constraints. Phase 2.1 server-side rasterisation must use WASM libraries validated against the Workers runtime (`@resvg/resvg-wasm`), not Node-native modules, and must be approved per `AGENTS.md` package safety before install.

---

## 13. Migration Plan and Rollback

### 13.1 Sequencing (each production step is owner-run, manual)

1. **DB first.** Owner backs up D1 (`wrangler d1 export swa-portal --remote --output=backup.sql`), then applies `migrations/007_namecards.sql` (`wrangler d1 execute swa-portal --remote --file=migrations/007_namecards.sql`). No code depends on it yet, so this is safe to land early.
2. **`wrangler.jsonc`.** Owner extends `run_worker_first` to include `/c/*`.
3. **Admin + public code.** Owner deploys `swa-portal` with the new `/api/namecards/*` handlers, the `/c/*` public handlers, and `pages/namecards.astro`. Admins can now create rows; the public surface is live but empty.
4. **Seed.** Admin creates namecard rows for current board members (re-using the names/slugs previously documented in `swa2024/docs/NAMECARD.md`), uploads photos. Bulk create may be used.
5. **Smoke.** Owner verifies a handful of slugs at `admin.singaporewomenassociation.org/c/{slug}`.
6. **swa2024 cleanup.** Section 14 in a single PR. The old `/namecard/*` URLs on the marketing site either 301 to the new path or 404; see §17.2.

### 13.2 Rollback

| Change | Rollback |
|--------|----------|
| Bad namecard code | Owner reverts and redeploys `swa-portal`. Cards go dark; admin data untouched. |
| Bad migration | `DROP TABLE namecards` (it has no inbound foreign keys from other tables). |
| `run_worker_first` regression | Owner removes `/c/*` from the array and redeploys; `/c/*` returns 404 from the asset handler. |

Every step is independently reversible by the owner.

---

## 14. swa2024 Removal Checklist

Requirement 4 mandates removing all namecard code from `swa2024`. The following must be deleted or cleaned in one PR (after the new surface is live):

### 14.1 Files to delete

- `src/components/shared/NameCardLayout.astro`
- `src/components/shared/NameCardActions.astro`
- `src/components/shared/MemberBioModal.astro`
- `src/layouts/StandaloneLayout.astro` (only if confirmed unused elsewhere; grep first)
- `src/pages/namecard/[id].astro`
- `src/pages/namecard/index.astro` (and the `src/pages/namecard/` directory)
- `src/content/members/namecard-urls.txt`
- `src/content/members/namecard-urls-table.txt`
- `src/utils/vcard.js` (only if confirmed unused elsewhere)

### 14.2 Files to edit

- `src/content.config.ts`: remove namecard-only schema fields from the `members` collection: `hasNamecard`, `showOnWebsite` (if namecard-gated), `jobTitle`, `whatsapp`, `address`, and the social fields (`facebook`, `linkedIn`, `ig`, `tiktok`, `yt`), plus the `email`/`mobile` fields if they were namecard-only. Keep `name`, `role`, `description`, `sortOrder`, `photo`, `photoAlt` if still used by the public members listing.
- Every `src/content/members/*.md`: strip the same frontmatter keys. (The body biography text can stay if it is still rendered on the public site; only the namecard-only keys go.)
- `NameCardLayout.astro` imports and any references in other components/pages (grep `NameCard`, `namecard`).
- `docs/NAMECARD.md` in swa2024: replace with a short pointer ("Digital namecards have moved to the `swa-portal` Worker. See `swa-portal/docs/specs/features/namecards.md`.") rather than deleting, so old links still resolve.
- Redirects: see §17.2.

### 14.3 Verification before delete

Run, from the swa2024 root, to confirm nothing else references the removed code:

```
rg -n "NameCard|namecard|hasNamecard|MemberBioModal|StandaloneLayout|vcard" src/
```

Any hit outside Section 14.1 must be resolved before deletion.

---

## 15. Phased Delivery

| Phase | Scope | Outcome |
|-------|-------|---------|
| **2.0 (MVP)** | Migration 007; admin CRUD + UI + bulk create + preview; public `/c/*` routes (HTML, `.vcf`, `card.svg`, photo); client-side QR PNG and card PNG download (admin + public); branded 404; vCard with `PHOTO`; URL scheme validation; IP rate limit; swa2024 cleanup. | All four requirements met. |
| **2.1** | Server endpoints `/c/:slug/qr.png`, `/card.png`, `/og.png` via `@resvg/resvg-wasm`; `qrcode` moved to `dependencies`; per-card view analytics (`swa:card:{slug}:views` KV counter) surfaced in admin. | Printable/embeddable assets; analytics. |
| **2.2** | Optional public directory page `/c/` on the Worker (only if SWA wants a browsable index; currently out of scope since cards are shared individually). | Discoverability. |
| **3.0** | Member self-edit at `/c/:slug/edit` (authenticated via the existing OTP). **Includes** server-side re-check of `members.category`, `can_login`, `deleted_at` on each write (closes the §5.3 stale-role gap). Admin remains source of truth for identity and visibility. | Self-service. |

---

## 16. Testing Checklist

Before go-live:

- [ ] `migrations/007_namecards.sql` applies cleanly on a fresh local D1. Owner confirms on remote after backup.
- [ ] `wrangler.jsonc` `run_worker_first` includes `/c/*`; `/c/:slug` reaches the Hono handler, not the asset handler.
- [ ] Admin can create, edit, bulk-create, toggle-visibility, and delete a namecard row; slug collisions return 409 with a suggestion.
- [ ] Photo upload rejects > 2 MB and non-image content-types; stores an R2 object; streams at `/c/:slug/photo.*` with `Cache-Control: public`.
- [ ] Public `/c/:slug` renders for a visible card and shows the branded not-available page for `has_namecard = 0` or soft-deleted members.
- [ ] `/c/:slug/contact.vcf` returns `text/vcard` with `attachment` and `nosniff`; downloads on **real** iOS Safari and Android Chrome; imports into Contacts.
- [ ] vCard `PHOTO;ENCODING=b` round-trips into iOS Contacts with the photo visible.
- [ ] vCard handles names containing commas, semicolons, newlines without structural breakage.
- [ ] URL fields reject `javascript:`, `data:` schemes server-side (write returns 400).
- [ ] Scanning the QR (vcf variant) on iOS and Android opens the vCard URL and offers "Add to contacts".
- [ ] Scanning the QR (page variant) opens the card page.
- [ ] "Download QR image" saves a 512×512 PNG with the SWA centre mark; the same payload still scans when rendered at 256px.
- [ ] "Download card image" saves the branded PNG; canvas is not tainted (no external resource refs in the SVG).
- [ ] WhatsApp link uses `https://wa.me/{digits}` and opens the app on mobile.
- [ ] Web Share API triggers the native sheet on mobile; falls back to clipboard on Firefox.
- [ ] OG image is the static PNG fallback (WhatsApp/LinkedIn preview renders, not blank).
- [ ] JSON-LD `Person`, Open Graph, and Twitter card validate.
- [ ] Soft-deleting a member atomically darks their card (verify via `DB.batch` transaction).
- [ ] IP-keyed rate limiter on `/c/:slug/contact.vcf` returns 429 after 60 req/min from one IP.
- [ ] `/api/namecards` writes return 403 for non-admin sessions.
- [ ] swa2024 cleanup PR: site builds, no dangling references, redirect/404 policy decided.
- [ ] Lighthouse mobile score >= 90 on `/c/:slug`.

---

## 17. Open Decisions

These are flagged for the product owner to confirm before implementation:

1. **Slug source.** Auto-derive from `members.name` (e.g. "Sarah Chen" -> `sarah-chen`), editable thereafter, with `name_family`/`name_given` overrides for vCard accuracy. Proposed: yes.
2. **`/namecard/*` redirects from swa2024.** 301 to `https://admin.singaporewomenassociation.org/c/:slug` (recommended for anyone with an old printed card or link), or let them 404? **Owner decides.**
3. **Public directory page.** Should `/c/` list all visible cards (v1.x had `/namecard/index.astro`), or remain a closed surface where only direct links work? Proposed: closed for v2.0 (cards are personal, shared individually); revisit in Phase 2.2.
4. **Bio rendering.** Plain text (zero-JS `<details>`) is the default. Markdown only if rich formatting is later requested.
5. **Committee-vs-volunteer read gating on `/api/namecards`.** MVP leaves reads open to all authenticated roles. Tighten to committee-or-above only if SWA requests it (would need a new path-specific gate in middleware).
6. **Photo-in-vCard.** Included by default in v2.0 (high UX value, ~1 day work). Owner to confirm.

---

## 18. Cross-References

- `docs/SWAPortal-Functional-Specs.md` — role access matrix; the namecard rows should be updated to point at this document and the new `/api/namecards/*` endpoints.
- `migrations/006_remove_website_columns.sql` — precedent for the isolation principle this design re-asserts.
- `src/pages/reg/membership/register.astro:142-205` — proven client-side QR + canvas + PNG-download pattern reused for namecard QR and card image export.
- `src/worker/api/membership-reg.ts:486-531` (`handleMembershipImage`) — R2-streaming reference (note `Cache-Control` and auth differences called out in §8.3).
- `src/worker/api/members.ts:124-154` — soft-delete handler to be refactored to `DB.batch` per §9.4.
- `src/worker/middleware.ts:24-26, 162-166` — `ADMIN_WRITE_API` and `ONLINE_FORMS_API` gating patterns.
- `src/worker/lib/rate-limit.ts:9-29` — email-keyed limiter; new IP-keyed limiter needed for public vCard (§5.4).
- `src/worker/lib/session-role.ts:30-53` — mint-time role resolution; stale-role gap (§5.3) to be addressed in Phase 3.
- `src/worker/api/session.ts:113-146` — stateless HMAC session verification (no KV/D1 at verify time).
- `swa2024/docs/NAMECARD.md` (v1.x) — visual/UX reference for the card layout; superseded by this file for architecture and data.

---

**Last updated**: 2026-07-25
**Author**: SWA digital infrastructure
**Reviewers**: pending (IT Admin, SWA board representative)
