# SWA Portal — Progress Log

A running log of work completed each session, plus the immediate next steps.
Append a new dated entry at the top; keep it short and skimmable.

This file is committed to git — it is the session memory that AI tools are
told (via AGENTS.md) to read first. Keep entries factual and short.

For the full phase tracker see `docs/plans/SWAPortal-Implementation-Plan.md`.
For role access, API permissions, and feature specs see
`docs/specs/SWAPortal-Functional-Specs.md`.

---

## 2026-08-23 (session 5) — Approval workflow Phase 3 (purchase stage)

Plan: `docs/plans/Approval-Workflow-Implementation-Plan.md` §14 Phase 3.
Stage one now runs end to end on the board.

### Done
- **`src/worker/lib/email-approval.ts`** (new): membership-email structure.
  Request email (new / resubmitted / reminder) → purchase approvers with
  description truncated to 500 chars; decision email → creator (approve
  points at the voucher step, reject shows the reason). Recipients are the
  named approver list only — the IT-admin union grants authority, not
  mailbox traffic. Resend, waitUntil, failures logged never fatal.
- **`approvals.ts`**: `POST /:id/approve` and `/:id/reject` —
  isPurchaseApprover re-checked in-handler, atomic
  `UPDATE … WHERE status='pending'` (second click 409), audit + state change
  in one batch, decision email to creator. `POST /:id/edit` — admin-only,
  title/payee/description/amount, add attachments (caps count existing),
  optional comparison rebuild validated against attachment ids
  (existing + new), `resubmit=true` routes by `rejected_stage`
  (purchase → pending, resets rejection fields) and re-emails approvers.
  `POST /:id/remind` — admin-only, pending-only, audit + reminder email.
  Create now emails approvers when `approval_required = 1`.
- **Board UI**: drawer action bar — Approve / Reject (reason box) for
  purchase approvers on pending; Send reminder and Edit (fields + add
  files + resubmit tick) for admins; `?item=<id>` deep link opens the
  drawer (the emails' target); drawer refreshes after every action.
- **Tests**: +21 (approve happy/race/403s/409-on-recurring, reject
  reason/400/403, edit fields+files/audits/resubmit routing/409s/403/
  foreign-comparison-400, remind 200/409/403) + 5 email-builder unit
  tests. 192 total. Test admins widened to 6 rotating identities — the
  shared-KV write bucket (10/15 min per email) counts validation-failing
  requests too, and Phase 2+3 together overflowed 3 identities.
- Docs: ARCHITECTURE.md (77 routes, 192 tests, Phase 3 roles paragraph,
  stale duplicate test-count line removed).

### Not done (by design — later phases)
- Phase 4: voucher form with numbering, finance approve/reject + emails,
  finance-check view. Phase 5: paid step, voucher export page, audit CSV.
- Comparison editing UI (API accepts it; edit form offers fields/files/
  resubmit only).

### Verification
- `npm run test:run` 192 passed; typecheck + typecheck:worker clean.
- Browser smoke of the full loop owed: create → approve → reject path →
  edit + resubmit → remind.

---

## 2026-08-23 (session 4) — Approval workflow Phase 2 (items and the board)

Plan: `docs/plans/Approval-Workflow-Implementation-Plan.md` §14 Phase 2.

### Done
- **`src/worker/api/approvals.ts`** (new): `GET /api/approvals?status=` (board
  list + per-status counts), `POST /api/approvals` (multipart create: fields,
  up to 10 files, comparison rows), `GET /api/approvals/:id` (detail with
  parsed comparison), `GET /api/approvals/:id/attachment/:attId` (R2 stream,
  `?download=1`, nosniff + sanitised Content-Disposition).
- **Create flow**: INSERT item → R2 uploads under `approvals/<id>/` → one
  D1 batch of attachment rows + the `item_created` audit row (plan §8:
  audit lands with the state change) → comparison stored with real
  attachment ids per §6. Recurring categories start at `purchase_approved`;
  `approvalRequired` flips the per-item default.
- **File safety** (plan §9): allowlist PDF/JPG/PNG/WebP/HEIC/HEIF
  (+ `image/jpg` alias, membership precedent), HTML and SVG always
  rejected, 10 MB per file, 10 files per item. Filenames are
  percent-decoded before sanitising (browsers encode `"` as %22).
- **`src/pages/approvals.astro`** (new): board with seven count-badged
  tabs, item table, read-only drawer (images inline, PDFs in iframes,
  comparison table with links), create form with per-file comparison
  builder. Admin-only create card; page gate redirects non-approvers.
- **AdminLayout**: "Approvals" nav item, visible to admin or either
  approver flag (the Phase 1 deferral).
- **Tests**: `approvals.test.ts` — 20 tests: role gates (plain committee
  403, both approvers read, finance cannot create), create validation
  (category defaults, override, HTML/SVG/oversize/11-file rejection,
  comparison mapping + phantom-file rejection), counts + status filter,
  detail, attachment stream headers (inline vs download, sanitised
  filename, cross-item 404). Admin identities rotate to stay under the
  approvals:write rate limit.
- Docs: ARCHITECTURE.md (73 routes, 25 pages, 16 tables live, 168 tests).

### Not done (by design — later phases)
- Phase 3: approve/reject, edit + resubmit, emails, remind button.
- Phase 4: voucher form, numbering, finance stage. Phase 5: paid step,
  voucher export page, audit CSV.

### Session 4 addendum — form improvements + two fixes (same day)

- **Description field**: optional textarea (4,000-char cap) on the create
  form — requester writes justification/context for approvers; stored on
  `approval_items.description` (migration 010, backported into
  `schema.sql`), rendered in the drawer, included in the detail API.
  Phase 3 should include it (truncated) in approval emails.
- **Comparison table is now opt-in**: a new "I have multiple quotations to
  compare" checkbox appears only when files are chosen; the per-file
  description rows appear only when it is ticked (a single quotation may
  span several uploads). Unticking clears the rows. Server still accepts
  comparison rows for any category (gate is UI-only).
- **CSP fix**: `public/_headers` `frame-src` gained `'self'` — the drawer's
  PDF iframe was blocked by the CSP (images were fine via img-src).
- **Page-script fix**: category labels are read from the `<select>` options
  instead of an inline JSON tag (Astro ships `{expression}` inside
  `<script>` unevaluated, which killed the whole page script).
- **Upload UX**: files now accumulate across multiple picker visits (the
  native input replaces its selection each time); chosen files render as a
  removable list with an "n of 10" counter, 10-file/10-MB caps enforced
  inline with messages, and typed comparison text + tick states survive
  adding/removing files (drafts keyed by name|size). Submit sends the
  accumulated list; server behaviour unchanged.
- Tests: +3 (description round-trip, 4000-char cap, files-without-
  comparison regression).

### Verification
- `npm run test:run` 168 passed; `npm run typecheck` 0 errors;
  `npm run typecheck:worker` clean. Manual smoke in `npm run dev:worker`
  still owed (log in as Jolene, raise an item, check the board).

---

## 2026-08-23 (session 3) — Approval workflow Phase 1 (foundation)

Plan: `docs/plans/Approval-Workflow-Implementation-Plan.md` (v2). Phase 1 is
plumbing only — no visible feature, no API handler, no pages.

### Done
- **Migration 009** (`migrations/009_approvals.sql`): `approval_items`
  (six-status CHECK, `UNIQUE voucher_no`, voucher + paid + comparison fields),
  `approval_attachments` (`UNIQUE r2_key`), `approval_audit_log`
  (insert-only). Idempotent; backported into `schema.sql` same commit.
- **portal.ts**: `APPROVAL_PURCHASE_APPROVER_EMAILS` (dev `approval@`,
  prod addresses commented for owner swap), `APPROVAL_FINANCE_APPROVER_EMAILS`
  (dev `finance@`; IT admins deliberately excluded),
  `isPurchaseApprover` (unions IT_ADMIN_EMAILS), `isFinanceApprover`,
  `canRaiseApprovalItem` (admin tier), `APPROVAL_CATEGORIES` (8, three
  recurring with no approval), caps 10 files/item + 10 MB/file.
- **Session flags**: `is_purchase_approver` / `is_finance_approver` added to
  all four `/api/session` reply branches + `SessionResponse`
  (`auth-gate.ts`).
- **Middleware gate 7c**: `/api/approvals` entry = admin or either approver,
  all methods; handlers enforce finer rules in later phases.
- **Rate limits**: `approvals:remind:post` (5/h), `approvals:review:post`
  (20/h), `approvals:write:post` (10/15m) with POST path routing.
- **Seed rows**: `approval@` (committee), `finance@` (committee), Jolene Lim
  (admin), all `can_login = 1`, owner test mobile.
- **Drive-by fix**: removed 4 stale address fields from the
  `namecard-svg.test.ts` fixture — a pre-existing `typecheck:worker` failure
  at HEAD (vitest never caught it because it skips type checking); leftover
  from the session 2 namecard restore.
- Docs: ARCHITECTURE.md counts (16 tables, 10 migrations), roles section,
  table list, migration-quirks note.

### Deferred to Phase 2
- AdminLayout "Approvals" nav item (no page exists yet — avoids dead link).
- Create/list endpoints, attachment stream, board page, audit writes.

### Verification
- `npm run test:run`, `npm run typecheck`, `npm run typecheck:worker` green;
  migration 009 applied to local D1.

---

## 2026-08-23 (session 2) — Namecards restored as board-only, auto-generated

Owner decision: restore (not delete). New rules, owner-confirmed:
board = `committee` + `advisor`; auto-created cards live immediately;
every card shows the SWA office address (409 Serangoon Central, #01-303,
Singapore 550409 — from the public website footer), never personal addresses.

### Done
- **Un-hidden** the four `/c/*` routes, `namecards.astro`, nav item, and
  `/c/*` in `run_worker_first` (all `DISABLED 2026-08` markers removed).
- **Board-only gate** at read time: `category IN ('committee','advisor')`
  in `namecard-public.ts` READ_QUERY + both queries in `namecard-photo.ts`.
  A demoted member's card 404s on the next request.
- **Office address only**: `SWA_OFFICE_ADDRESS` + `NAMECARD_BOARD_CATEGORIES`
  in `portal.ts`; HTML page + vCard render the office address; personal
  address columns removed from the public read query and `VcardMemberInput`.
- **Auto-generation**: `ensureBoardNamecards()` in `namecards.ts`; single
  create + bulk are board-only; members.ts auto-creates a card on member
  POST/PATCH into a board category and darkens it on demotion. Soft-fail so
  a card problem never blocks the member write.
- **Indexing/AI block**: robots.txt gets an explicit `Disallow: /c/` plus
  6 missing AI bots; `X-Robots-Tag` + meta robots extended to
  `noindex, nofollow, noarchive, nosnippet, notranslate, noimageindex`;
  HTML page route now IP-rate-limited like vcf/svg/photo.
- **Schema tidy (old next-step 2)**: namecards table + indexes backported
  into `schema.sql`; `db-helpers.ts` applies schema only; smoke test
  wording updated. Duplicate `005` migration rename NOT done (deferred).
- **Tests**: public tests restored + 6 new (category gates, office address,
  robots headers); admin tests get board-only bulk + hidden-stays-hidden;
  new `namecard-autogen.test.ts` (6 tests) covering member POST/PATCH
  card lifecycle. `namecard-vcard.test.ts` expects the office ADR.
- Docs: NAMECARD.md v2.2 restore banner, AGENTS.md status line.

### Verification + ship
- Local smoke test passed after applying migration 007 to the local D1
  (the table was missing — pre-tidy local rebuild; fixed via the documented
  `--local` command, data kept).
- Bulk button now reports real server errors (HTTP status + body snippet)
  instead of a blanket "Network error." — plain-text 500 pages from a
  crashed worker were previously indistinguishable from network failures.
- Tests 148/148, build 24 pages, `astro check` clean.
- Committed + pushed: `6590356` (restore) and `d2777d5` (button polish).
  Local D1 now has the namecards table; 12 committee cards generated and
  verified in the browser.

### Owner steps remaining
1. `npm run deploy` (not yet run at time of writing).
2. Post-deploy checks: `/robots.txt` shows `Disallow: /c/`; any `/c/*`
   shows the branded not-available page. Production has no board members
   yet, so 0 cards is expected — they auto-generate as board members are
   added.

### Note
Admin category 'member'/'volunteer' rows can no longer be given cards via
the API (400 "board members only"). An admin who wants a non-board card
must first set the member's category to committee/advisor.

---

## 2026-08-23 — Remediation deployed; CSV-guard fix + anti-drift guardrails

### Done
- **Deployed** the security remediation (`02799aa`) to production — owner ran
  `npm run deploy`. Tests 112/112 before deploy.
- **Fixed laughter-yoga CSV drift** — `laughter-yoga-reg.ts` carried a
  private, un-guarded `csvEscape` while volunteer/membership imported the
  shared guarded one (P4c had missed the copy). Now imports `lib/csv.ts`.
- **Corrected the architecture report** errata — remediation WAS committed
  (02799aa); `prod-dump.sql` already deleted; 9 migration files not 8;
  `NAMECARD.md` does carry a hidden-feature banner.
- **Anti-drift guardrails** so the CSV miss cannot repeat: tripwire test
  `src/worker/lib/__tests__/csv-guard.test.ts` (watches all 4 CSV exporters),
  pre-commit hook blocks private `csvEscape` copies, and
  `docs/how-to-add-a-form.md` checklist. Tests now 124/124.
- Deleted stray untracked `namecard-full.png` from repo root.
- AGENTS.md slimmed: Next Steps section removed, one pointer to this file.
- Global AI rules updated (beginner-friendly output; explain permission
  requests first) — outside this repo.

### Production note
Production D1 holds only the owner's login account — no member data yet, so
the empty live Members page is expected.

### Next steps (priority order)
1. **Namecard decision (owner)** — restore or delete the hidden feature.
   Recommend delete; git history keeps everything.
2. **Migration tidy-up** — two files share number `005`; roll migration 007
   (namecards) into `schema.sql` so fresh local DBs match prod.
3. **Docs consolidation** — merge the two functional specs into one; add a
   "never executed" banner to `docs/plans/astro-refactor-plan.md`.
4. **Member directory pagination** — only when the member list grows.
5. **Form engine + Astro refactor** — deferred until a 4th form is needed;
   follow `docs/how-to-add-a-form.md` until then.
6. Carried over from previous tracker: Phase 2B fee reminders (cron),
   Phase 2C/3 (member self-service, CMS, MS Forms migration), domain
   transfer for `admin.singaporewomenassociation.org`.

---

## 2026-08-22 — Security remediation plan fully implemented (pending deploy)

Executed `docs/plans/security-remediation-plan.md` end-to-end (P1–P4). Full
file list + verification record in that doc's "Implementation Log" section.

### Highlights
- **P1 critical fixed** — sessions are now revalidated against D1 on every
  authenticated request (`session-revalidation.ts`). Demotions, `can_login=0`
  lock-outs and soft-deletes kill the session immediately; role changes
  re-sign the cookie without extending its expiry. 6 new integration tests.
- **P2** — public namecard surface hidden: `/c/*` routes commented out,
  `namecards.astro` → `_namecards.astro`, nav link removed, `run_worker_first`
  tidied. Everything restorable via the DISABLED-2026-08 marker comments.
- **P3** — stored XSS closed: members table render escapes all member fields;
  `fullName` allowlist (letters/spaces/`.'`-`, max 100) enforced on the
  public membership form; three secondary sinks escaped.
- **P4** — NRIC removed from member API responses (`MEMBER_COLUMNS`), per-
  endpoint rate limits (magic-link 5/h etc.), shared CSV-injection-safe
  `csvEscape` (`lib/csv.ts`), JSON-LD `\u003c` escaping, bookings input
  validation, dev-bypass host wildcard removed.

### Gotchas found today
- **4e deviation**: `wrangler dev` presents `c.req.url` as
  `admin.singaporewomenassociation.org` (the configured route), NOT
  localhost — verified via temp log line. Loopback-only host check broke the
  dev-login picker; kept an exact `SWA_ADMIN_DOMAIN` exception alongside the
  two prod fail-closed anchors. Details in remediation plan §4e note.
- **Local D1 is stale** (pre-migration-005): `GET /api/members` now 500s
  locally because the explicit column list names `membership_status` etc.
  Prod is unaffected (migration 005 applied 19-07-2026). Fix locally when
  convenient: `npm run db:setup` + apply migration 007 (user-invoked only).

  **RESOLVED 2026-08-22 (additive path, data kept):** applied migrations
  004 (+ the two commented-out ALTERs `members.nric`,
  `memberships.application_id`), 005, 005_pdpa, 007, 008 to the local DB
  via `node ./node_modules/wrangler/bin/wrangler.js d1 execute swa-portal
  --local --file=...`. **006 was skipped locally** — the local table has
  `slug TEXT UNIQUE` inline, and SQLite cannot drop an inline-UNIQUE column
  without a table rebuild; the 11 columns are dead code anyway and vanish on
  any future `db:setup`. Migration 006's statement order (drop columns
  before the index) also fails on fresh local DBs — consider reordering if
  it ever needs to run locally. Backup of the pre-migration sqlite file:
  `...miniflare-D1DatabaseObject/373179...sqlite.backup-pre-migrations-20260822`.

### Not done (by design)
- **Production deploy** — owner-gated. Code is ready: tests 112/112, build
  clean, `astro check` clean. Deploy with `npm run deploy` after confirming
  migration 007 status on prod (namecards table — see 2026-07-25 entry).
- Migration 007 backport into `schema.sql` still open (local-dev gotcha
  from 2026-07-25 entry).

---

## 2026-07-25 — Namecard feature (Phases 0–4 done, 1 bug outstanding)

> **Update 2026-08-22:** the QR clipping bug below was fixed in commit
> `117a31f` ("stop QR canvas being clipped on /c/:slug preview"). The
> "OUTSTANDING BUG" section is historical.

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
