# Namecard Feature — Analysis Report

## 1. Features & Functionality

The feature provides a **digital namecard system** for SWA members, with three surfaces:

### Public surface (`/c/*` — no auth, 4 endpoints)

| Endpoint | Description |
|----------|-------------|
| `GET /c/:slug` | Branded HTML card page with photo, bio, contact details, social links, QR code, Share/Copy/Save buttons. Server-rendered as a Hono `Response` (no Astro SSR). Includes JSON-LD `Person` schema, Open Graph, and Twitter card tags. |
| `GET /c/:slug/contact.vcf` | vCard 3.0 download with embedded photo, CRLF-safe, line-folded at 75 octets, `X-SOCIALPROFILE` extensions. Triggers "Add to Contacts" on iOS and Android. |
| `GET /c/:slug/card.svg` | 1050×600 branded SVG card. Fully self-contained — all assets inlined as data URIs, no external references — so the canvas PNG export is not tainted. |
| `GET /c/:slug/photo` | Raw photo streamed from R2 with long immutable cache headers. |

### Admin surface (`/api/namecards/*` — auth-gated, 11 endpoints)

Full CRUD (create, list, read, edit, delete), photo upload (≤2 MB, JPEG/PNG/WebP stored in R2), visibility toggle, slug management with collision detection, bulk create for all members lacking a card, and a `/me` self-service endpoint.

### Admin UI (`/namecards.astro`)

Self-service panel showing the logged-in user's own card with QR preview and download buttons. Table view with search/filter, admin-only edit/add/delete/toggle actions. Edit modal with all fields, photo upload with client-side square crop to 800×800 JPEG.

### Integration points

- Member soft-delete atomically darkens the namecard via D1 `batch()` transaction.
- `wrangler.jsonc` `run_worker_first` includes `/c/*` so public routes hit the Worker.

---

## 2. Architecture & Setup

### AstroJS

- Static build only (no SSR). The single `namecards.astro` page is pre-built as static HTML + JS, then fetches data from the Worker at runtime (SPA-like pattern).
- The public card page is NOT built by Astro — it is a string template rendered by the Hono Worker at request time.
- `AdminLayout` wraps the admin page; auth gate via `requireAuth()` in the client script.

### Hono Worker

- Public routes (`/c/*`) are registered BEFORE the `authMiddleware` (scoped to `/api/*`), so they remain unauthenticated by design.
- Admin routes (`/api/namecards/*`) go through the existing auth pipeline. Writes are gated by `ADMIN_WRITE_API` in middleware plus defence-in-depth `requireAdmin()` in handlers.
- Route registration at `src/worker/index.ts:59-65` (public) and `170-180` (admin).

### Cloudflare Resources

- **D1** (`swa-portal`): `namecards` table (migration `007_namecards.sql`) with 1:1 FK to `members`. Three indexes (slug, member_id, partial visibility index).
- **R2** (`swa-portal-uploads`): Photos stored at `namecards/{member_id}/photo.{ext}`.
- **KV** (`SWA_SESSION`): IP-keyed rate limiter at `swa:rl:card:ip:{ip}`.
- **No new Cloudflare resources** were created — reuses existing D1, KV, R2, Worker, and DNS.

### Lib structure (7 files, `src/worker/lib/`)

| File | Lines | Purpose |
|------|-------|---------|
| `namecard-slug.ts` | 112 | Derivation (kebab-case, accent folding), validation, collision suggestion |
| `namecard-sanitize.ts` | 75 | URL scheme allow-list, WhatsApp normalisation, vCard escaping |
| `namecard-qr.ts` | 30 | QR payload URL builder (vcf / page variant) |
| `namecard-photo.ts` | 94 | R2 photo read helpers (stream + bytes) with visibility enforcement |
| `namecard-rate-limit.ts` | 70 | IP-keyed sliding-window rate limiter (60 req/min) |
| `namecard-svg.ts` | 159 | Branded 1050×600 SVG renderer with exact pixel geometry |
| `namecard-vcard.ts` | 271 | vCard 3.0 builder with RFC 2426 compliance, line folding, base64 photo |

### Test coverage (7 test files, ~1,221 lines)

Admin CRUD API tests, public endpoint tests, unit tests for slug, sanitize, vCard, SVG, QR. Smoke tests verifying DB constraints.

---

## 3. Over-Engineering & Unnecessary Complexity

### Genuinely justified complexity

- Rate limiting on public endpoints is necessary for abuse prevention.
- URL sanitisation + WhatsApp normalisation is a security requirement.
- vCard RFC compliance (CRLF, 75-octet folding, multi-byte-safe) is needed for cross-platform compatibility.
- SVG self-containment (all assets inlined as data URIs) is required for the canvas PNG export feature to work without taint errors.
- Separate lib from API handlers enables unit testing.

### Areas of potential over-engineering

1. **Two nearly identical photo read helpers** (`namecard-photo.ts:35-60` and `69-94` — `streamNamecardPhoto` vs `readNamecardPhotoBytes`). They share the same DB query logic but return different types. Could be refactored to a single helper with a streaming/bytes option, reducing ~60 lines of duplication.

2. **7 separate lib files** for ~811 lines total. Some are very small:
   - `namecard-qr.ts` (30 lines) — a single function, could be inlined into the public API handler.
   - `namecard-sanitize.ts` (75 lines) — used by both vCard builder and admin API; justified as shared but could live in a larger file.
   This is a minor concern — the separation aids testing and reasoning.

3. **vCard builder** (271 lines) is RFC-compliant with proper line folding, multi-byte character boundary handling, and edge-case fallbacks. For a member portal serving ~50-100 cards, a simpler vCard builder (e.g., joining lines with `\r\n`, no folding) would work on all modern phones. The folding and multi-byte handling is technically correct but likely unnecessary for real-world usage.

4. **SVG renderer** (159 lines) uses exact pixel coordinates for every element, referencing a specific Lee Li Hua reference card with precise geometry. Appropriate for a branded asset, but represents significant investment in pixel-perfect rendering for a contact card template.

5. **Admin API handler** (`namecards.ts:77-104`) uses a single `handleNamecards` function that dispatches on `c.req.method` within the body, rather than separate handler functions per HTTP method. This is inconsistent with the rest of the file (other handlers are method-specific) and slightly less readable.

6. **Defence-in-depth admin checks** — the middleware gates writes via `ADMIN_WRITE_API`, but each handler also calls `requireAdmin()` internally. Documented as intentional defence-in-depth, but adds ~5 lines of boilerplate per handler (3 handlers).

7. **The `takenSlugs` helper** loads ALL slugs from the DB into memory for collision checking. For a small dataset this is fine, but the pattern does not scale. A targeted `SELECT 1 FROM namecards WHERE slug = ? AND id != ?` (used in the slug change handler) is more efficient.

### Summary

The feature is **well-architected** with clear separation of concerns, thorough testing, and proper security measures. The "over-engineering" is largely **thoroughness rather than bloat** — RFC compliance, edge case handling, and pixel-perfect design. The only concrete candidates for simplification:

- Merge `streamNamecardPhoto` and `readNamecardPhotoBytes` into a shared helper.
- Consider whether vCard RFC folding (multi-byte-safe, 75-octet) is necessary for the target audience.
- Replace the `takenSlugs` full-table scan with targeted DB queries.

None of these are significant issues. The feature is production-quality and follows the project's existing patterns consistently.