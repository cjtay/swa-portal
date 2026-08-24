# Assets (Inventory Tracking) — Implementation Plan

> **Status: planned, not yet implemented.** Written 25 August 2026. This
> document is the plan for consideration; once the feature ships, the living
> spec becomes `docs/specs/features/assets.md` (same commit as the code, per
> the core-spec documentation rule). Session history lives in `progress.md`.

## 1. What we are building, in plain words

SWA owns a modest set of physical things: laptops, a printer, microphones,
furniture, appliances. Today nobody can answer "how many laptops do we have,
and who is holding the projector?" without walking around the office.

The Assets page lists every item in one table. Each asset records its name,
photos, asset number, serial number, description, category, status,
location, custodian, purchase date and cost. The page works out depreciation
by itself from the purchase date, cost and useful life, so nobody maintains
spreadsheet formulas.

Designated committee members and the office admin add and edit assets.
Every other logged-in board member can browse the list and open the detail
view. One button exports the whole inventory as a CSV file for auditors or
committee meetings.

Nothing here is financial workflow. Buying things goes through the
Approvals feature; this page only records what SWA already owns.

## 2. Decisions confirmed by the owner

| # | Decision | Choice |
|---|---|---|
| 1 | Who can view | All committee and admin tiers (advisors included via the committee tier) |
| 2 | Who can create and edit | Designated committee members (email list) plus the admin tier, checked by one helper `canManageAssets(session)` |
| 3 | Depreciation | Computed straight-line from purchase date, cost and useful life. Never stored in the database |
| 4 | Asset number | Manual entry, UNIQUE index. The editor types the number that matches any existing sticker |
| 5 | CSV export | Yes, one button on the Assets page, reusing `src/worker/lib/csv.ts` |
| 6 | Emails and audit log | None. Keep it basic. `created_by` / `updated_by` / `updated_at` columns are the whole history |

## 3. Roles and access

One new permission group, following the `MEMBERSHIP_APPROVER_EMAILS`
email-list pattern in `src/constants/portal.ts`:

- **Asset managers** — `ASSET_MANAGER_EMAILS`, checked by
  `canManageAssets(session)`: true when the session role is `admin` (this
  covers IT admins too, since they resolve to the admin tier) or the email
  is in the list. Widening or narrowing later means changing this one
  function, not hunting through handlers.

During development the list holds the shared test inbox
`assets@singaporewomenassociation.org` (§11), so the owner controls the
only mailbox that gains committee-tier manager powers in testing.
Production addresses are swapped in before go-live (§13), the same
owner-gated step as the approvals feature.

Access rules for `/api/assets`:

- Reads (list, detail, images, export): any authenticated session. The
  middleware's default authenticated gate already covers this; no new
  middleware set is needed.
- Create, edit, status change, image add and delete: `canManageAssets`,
  re-checked inside each handler (the membership handler-recheck pattern).

`GET /api/session` gains one flag, `is_asset_manager`, so the page can show
the edit buttons to the right people. The flag must be added to all three
reply branches in `session.ts` (logged-in, dev-bypass, logged-out) plus the
logged-out default, and to `SessionResponse` in `src/scripts/auth-gate.ts`.
`AdminLayout.astro` gains one nav item, "Assets", visible to every logged-in
session (no conditional gating).

## 4. Database

One migration, `migrations/011_assets.sql` (next free number after 010),
backported into `schema.sql` in the same commit so fresh local databases
match production. This follows the approvals convention from 23-08-2026.
The migration is idempotent (every CREATE uses IF NOT EXISTS).

### `assets`

| Column | Purpose |
|---|---|
| `id`, `created_at`, `updated_at` | Standard keys and timestamps |
| `asset_number` | UNIQUE, typed by the editor, e.g. `SWA-LT-04`. Required |
| `name` | What the item is, e.g. "Dell Latitude 5540 laptop". Required |
| `category` | Key from `ASSET_CATEGORIES` in `portal.ts`. Required |
| `serial_number` | Manufacturer serial, if any |
| `description` | Free text, capped at 2,000 chars |
| `status` | CHECK: `in_use`, `in_storage`, `under_repair`, `disposed`. Default `in_use` |
| `location` | Free text, e.g. "Office store room" |
| `custodian` | Free text: who holds the item. Not a member FK, to keep it simple |
| `purchase_date` | `YYYY-MM-DD`, optional |
| `purchase_cost` | REAL, S$, optional |
| `useful_life_years` | INTEGER, optional. Drives the depreciation maths |
| `disposal_date` | Set when status becomes `disposed` |
| `disposal_note` | Optional: sold, donated, scrapped |
| `created_by`, `updated_by` | Emails from the session |

Indexes: `status`, `category`. The UNIQUE index on `asset_number` is the
duplicate guard: the handler turns a constraint error into a friendly 409
`CONFLICT`, matching the error-code table in the core spec.

### `asset_images`

| Column | Purpose |
|---|---|
| `id`, `created_at` | Standard |
| `asset_id` | REFERENCES `assets(id)` |
| `r2_key` | UNIQUE object key under `assets/<assetId>/` |
| `filename`, `mime_type`, `size` | For display and download headers |

Cap: 5 images per asset, 10 MB per file. Unlike approvals attachments
(add-only there), asset images are deletable: photographing the wrong item
is a normal mistake. Deleting removes the R2 object and the row together.

### Categories

`ASSET_CATEGORIES` in `src/constants/portal.ts`, each with a key and label:
IT equipment, audio-visual, furniture, appliance, office equipment, other.
Adding a category later is a one-line constant change.

## 5. Depreciation maths

One pure function, `src/lib/asset-depreciation.ts`, imported by both the
CSV export handler (server) and the detail drawer script (browser), so the
formula exists in exactly one place.

Given `purchase_date`, `purchase_cost` and `useful_life_years`:

- Yearly depreciation = cost ÷ life.
- Months elapsed = whole months from purchase date to today.
- Book value today = cost × max(0, (life × 12 − months elapsed) ÷
  (life × 12)). The value floors at zero and stays there.
- Fully depreciated on = purchase date plus life years (displayed as a
  date, the "depreciation date" the owner asked for).

When cost or life is missing, the panel shows "—" and the CSV leaves the
columns blank. The drawer shows: original cost, yearly amount, book value
today, fully-depreciated-on date. No accounting export, no IRAS form
mapping; that is deliberately out of scope (§14).

## 6. API

A new file `src/worker/api/assets.ts`, registered in
`src/worker/index.ts`. Register `GET /api/assets/export` before the `:id`
param routes so the path is not swallowed by `GET /api/assets/:id` (the
approvals audit route does the same).

| Route | Purpose | Who |
|---|---|---|
| `GET /api/assets?status=&category=&q=` | List with filters and search (`q` matches name, asset number, serial number) | Any authenticated |
| `POST /api/assets` | Multipart create: fields plus up to 5 images | Manager |
| `GET /api/assets/:id` | Detail with images | Any authenticated |
| `POST /api/assets/:id/edit` | Edit fields, add images (caps counted across visits) | Manager |
| `POST /api/assets/:id/status` | Change status; `disposed` requires `disposal_date` | Manager |
| `GET /api/assets/:id/image/:imgId` | Stream image from R2; `?download=1` forces download | Any authenticated |
| `DELETE /api/assets/:id/image/:imgId` | Delete one image (R2 object and row together) | Manager |
| `GET /api/assets/export` | CSV of the full inventory, oldest first, capped at 5,000 rows | Any authenticated |

Validation rules: `asset_number` and `name` required; `category` must be a
key from `ASSET_CATEGORIES`; `status` must pass the CHECK; dates must parse
as `YYYY-MM-DD`; `purchase_cost` must be zero or positive; `useful_life_years`
must be 1 to 50 when present. Errors return 400 `VALIDATION_ERROR` with a
field list, the existing convention.

`src/worker/lib/rate-limit.ts` gains one endpoint key:

- `assets:write:post` — 20 per 15 minutes, covering every POST and DELETE
  under `/api/assets`. Generous on purpose: fixing photos after a photo
  session is a burst of small writes, not an attack.

## 7. Uploads and file safety

Images only. The allowlist is the approvals list minus PDF:

- Accepted: `image/jpeg`, `image/png`, `image/webp`, `image/heic`,
  `image/heif`.
- Never accepted: `text/html`, `image/svg+xml` (browsers can run scripts
  inside both when viewed inline), PDFs, and anything not on the list.
- Per file: 10 MB. Per asset: 5 images, counted across the create and
  add-image endpoints.
- The stream route sends `X-Content-Type-Options: nosniff`, sets
  `Content-Disposition: inline` with a sanitised filename, and switches to
  `attachment` when `?download=1` is present.
- No client-side resizing in v1. The namecard photo resizer exists because
  public pages serve those photos; asset images stay inside the
  authenticated portal, so the 10 MB cap is enough.

## 8. CSV export

`GET /api/assets/export` reuses the existing CSV builder
(`src/worker/lib/csv.ts`). Headers: asset number, name, category, status,
serial number, location, custodian, purchase date, purchase cost, yearly
depreciation, book value today, fully depreciated on, disposal date,
disposal note, created at. The depreciation columns are computed at export
time by the shared function from §5, so the file always matches the page.

Sorted oldest first, capped at 5,000 rows, injection-guarded by the builder.
Any authenticated session can export (decision §2.1). Reached from a button
on the Assets page, not the Settings page: this is inventory data, not
audit data.

## 9. Page

One page, **`src/pages/assets.astro`** (AdminLayout), `/assets`:

- Table: cover thumbnail (first image, 48 px), asset number, name, category,
  status badge, location, custodian, purchase date. Sortable by asset
  number and purchase date in v1; other columns can follow.
- Filters: status (All, In use, In storage, Under repair, Disposed) and
  category dropdowns, plus one search box (`q`).
- Detail drawer (pattern from `admin/forms/membership.astro`): photo
  gallery (thumbnails, click to enlarge), all fields, and the depreciation
  panel from §5. Manager-only: the edit form, the status changer, image
  add and delete. Non-managers see the same content read-only.
- Status badges use the existing admin.css purple palette. No emoji icons.
- The page redirects to `/` when unauthenticated, the standard
  AdminLayout auth-gate behaviour.

## 10. Tests

`src/worker/api/__tests__/assets.test.ts` (integration, mirroring the
approvals test structure):

- Role gates: logged-out 401; ordinary committee member reads but every
  write returns 403; the manager email and the admin tier both write.
- Create validation: missing name or asset number, bad category, bad date,
  negative cost.
- Duplicate asset number returns 409.
- File allowlist: an SVG and an HTML upload are rejected; an oversized
  file is rejected; the 6th image on one asset is rejected.
- Image delete removes the row (and would remove the R2 object; the test
  asserts the call, as the approvals tests do).
- Status change: `disposed` without a date fails; with a date succeeds and
  stamps it.
- CSV export: header row, oldest-first order, one row per asset.

`src/lib/__tests__/asset-depreciation.test.ts` (pure function): fresh
asset, half-life asset, fully depreciated asset floors at zero, missing
cost or life returns nulls.

## 11. Local testing

One row appended to `seed-members.sql` (dummy data, the owner's mobile on
the row, matching the existing seed policy):

| Name | Email | Category | Purpose |
|---|---|---|---|
| Asset Manager (test) | `assets@singaporewomenassociation.org` | committee | Committee-tier member listed in `ASSET_MANAGER_EMAILS` |

The row sets `can_login = 1`, so the dev quick-login picker lists it. For
read-only testing, any ordinary committee seed member works. The admin seed
rows (Jolene, admin tier) are managers automatically.

## 12. Build phases

Each phase ends with `npm run test:run`, `npm run typecheck`,
`npm run typecheck:worker` green, and a quick manual check in
`npm run dev:worker`.

**Phase 1 — Foundation.** Constants (manager list, categories, upload
caps), the `canManageAssets` helper, migration 011, `schema.sql` backport,
session flag across all `/api/session` branches, rate-limit key, seed row.
No visible feature yet, but the portal boots with the new flag.

**Phase 2 — List and detail.** List endpoint with filters and search, detail
endpoint, image stream route, the Assets page with table, filters, search
and the read-only drawer with the photo gallery.

**Phase 3 — Create, edit, images.** Create and edit endpoints with image
uploads, the manager form in the drawer, image add and delete, duplicate
number handling.

**Phase 4 — Finish.** Status and disposal flow, the depreciation panel
(shared function), CSV export.

**Phase 5 — Verify and ship.** Full test suite, typecheck, build, the
manual smoke walk, then owner-gated ship steps (§13).

## 13. Manual smoke walk

With `npm run dev:worker` and the dev picker: log in as the Asset Manager,
create a laptop with two photos and a full purchase record; check the
duplicate-number rejection by trying the same number again; edit the
asset; add a third photo, delete one; move it to under repair; dispose of
an old printer with a date and note; open the drawer and check the
depreciation numbers against a hand calculation; download the CSV and
check the columns. Switch to an ordinary committee login: the list and
drawer open, every edit control is gone. Logged out, `/assets` redirects.

## 14. Ship steps (owner-gated)

1. Swap the shared dev address in `ASSET_MANAGER_EMAILS` for the real
   addresses of the designated committee members (owner decision).
2. Apply the migration to production D1:
   `wrangler d1 execute swa-portal --remote --file=migrations/011_assets.sql`
   — never run by an agent.
3. `npm run deploy`.
4. In production, ensure the designated committee members have
   `can_login = 1` member rows.

## 15. Deferred and open

- **QR or barcode labels** on the physical items, scannable to the detail
  view. Deferred: the office is small and the search box finds items fast.
- **Checkout and loan tracking** (who borrowed the projector, when it is
  due back). The custodian free-text field covers the lightweight need.
- **Accounting exports** (IRAS capital allowance formats). Out of scope;
  the CSV serves the auditor conversation.
- **Warranty and maintenance schedule.** The description field can hold
  warranty notes for now.
- **Image captions and reordering.** First-uploaded is the cover; that is
  enough for v1.
- **Bulk import from an existing spreadsheet.** Deferred until the office
  says the manual entry burden is real; a CSV importer would need careful
  validation.

## 16. Files

Create:

- `migrations/011_assets.sql`
- `src/worker/api/assets.ts`
- `src/lib/asset-depreciation.ts`
- `src/pages/assets.astro`
- `src/worker/api/__tests__/assets.test.ts`
- `src/lib/__tests__/asset-depreciation.test.ts`

Edit:

- `schema.sql` (backport two tables)
- `src/constants/portal.ts` (manager list, categories, upload caps, helper)
- `src/worker/index.ts` (route registration)
- `src/worker/lib/rate-limit.ts` (one endpoint key)
- `src/worker/api/session.ts` (manager flag, all branches)
- `src/scripts/auth-gate.ts` (session type)
- `src/layouts/AdminLayout.astro` (nav item)
- `seed-members.sql` (one test row)
- `docs/ARCHITECTURE.md` (same commit as the structural change)
- `docs/specs/SWAPortal-Functional-Specs.md` (matrix rows: view; manage)
- `docs/specs/features/assets.md` (the living spec, written at ship time)
- `progress.md` (dated entry when the work lands)
