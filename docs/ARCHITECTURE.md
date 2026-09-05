# SWA Portal — Architecture

> **Living document.** It describes the system as it is today (last verified 29 August 2026).
> If a change alters how the system works (routes, tables, roles, page groups, bindings),
> update this file in the same commit. Session-by-session history lives in `progress.md`.
> A point-in-time critique of code quality from 22-08-2026 lives in
> `docs/ARCHITECTURE-ANALYSIS-2026-08-22.md`.

## Table of contents

1. [What this is](#1-what-this-is)
2. [The stack](#2-the-stack)
3. [How a request flows](#3-how-a-request-moves)
4. [Authentication](#4-authentication)
5. [Roles](#5-roles)
6. [The database](#6-the-database)
7. [Folder map](#7-folder-map)
8. [Route inventory](#8-route-inventory)
9. [Public registration forms](#9-public-registration-forms)
10. [Namecards (board-only)](#10-namecards-board-only)
11. [Conventions](#11-conventions)
12. [Known gotchas](#12-known-gotchas)
13. [Where to start reading](#13-where-to-start-reading)
14. [Keeping this document current](#14-keeping-this-document-current)

---

## 1. What this is

The SWA Portal is the internal admin tool for the Singapore Women's Association. It replaces
paper forms, spreadsheets and Microsoft Forms with one web app. The same codebase also hosts
three public registration forms and digital namecards for board members.

Who uses it:

- **IT Admins** run the whole system.
- **Admins** manage members, view form submissions, run events.
- **Committee members** book the office and read the member directory.
- **Registration volunteers** check guests in at events.
- **The public** submit volunteer sign-ups, laughter-yoga training registrations and membership applications.

Headline numbers, verified 23-08-2026:

| Thing | Count |
|---|---|
| Production dependencies | 2 (`astro`, `hono`) |
| Page files | 26 (all live) |
| Worker routes | 82 |
| Database tables | 16 (14 live, 2 dormant) |
| Migration files | 11 (two share the number `005`) |
| Automated tests | 285 |
| Source lines, including tests | ~22,000 |

The important number is the 2 production dependencies. The project deliberately builds on two
small libraries plus Cloudflare's own services, and nothing else.

## 2. The stack

One Cloudflare Worker serves everything. Cloudflare runs the Worker on its global network
instead of a single rented server, so the app scales automatically and costs almost nothing
at low traffic.

The app has two halves:

1. **Static pages (Astro 7).** `npm run build` compiles the `.astro` files in `src/pages/`
   into plain HTML, CSS and JavaScript in `./dist`. Astro does no work at request time:
   `astro.config.mjs` sets `output: 'static'` and the project uses no SSR adapter.
2. **The API Worker (Hono).** `src/worker/index.ts` builds a Hono app that handles every
   route under `/api/*` plus the public namecard pages under `/c/*`. Hono is a small web
   framework: it matches URLs to handler functions and runs middleware (code that checks the
   request first) before them.

The glue is the `assets` block in `wrangler.jsonc`:

```jsonc
"assets": {
  "directory": "./dist",
  "binding": "ASSETS",
  "run_worker_first": ["/api/*", "/c/*"]
}
```

`run_worker_first` tells Cloudflare to send matching URLs to the Worker first. Everything
else is served straight from the static build.

### Cloudflare services

The Worker reaches four services through `c.env`, the context object Hono hands to every
handler. Each entry is called a binding: a pre-connected handle to a Cloudflare service.

| Binding | Service | Purpose |
|---|---|---|
| `DB` | D1 (SQLite database) | All persistent data: members, bookings, forms, registrations |
| `SWA_SESSION` | KV (key–value store) | OTP codes, rate-limit counters, session bookkeeping |
| `SWA_CONFIG` | KV | Event and form configuration: open/closed flags, notify emails, table layouts, feature availability overrides |
| `R2_BUCKET` | R2 (file storage) | Uploaded images: PayNow screenshots, signatures, card photos |
| `AI` | Workers AI | Approvals AI quotation comparison: reads PDFs (`toMarkdown`) and photos (vision model), writes the comparison summary. All usage inside `src/worker/lib/ai-comparison.ts` |

D1 is a real database you can query, join and count. KV is a fast dictionary that only does
key → value lookups. KV is eventually consistent (a write can take a moment to appear
everywhere), so it suits codes and counters, not records that must never disagree.

### Worker runtime rules

Workers run on V8 (the engine inside Chrome), not Node.js. The code never imports `fs`,
`path`, `http` or `process.env`. It uses web-standard APIs: `fetch`, `crypto.subtle`,
`Request`/`Response`, `URL`. Local secrets live in `.dev.vars`; production secrets are set
with `wrangler secret put`.

## 3. How a request moves

The one mental model that explains the whole project: **pages are pre-built static files, and
all real work happens in the Worker over `/api/*`.**

```
Browser
  │ (1) the user opens /office-booking
  ▼
Cloudflare serves the pre-built static page from ./dist
  │ (2) the page's bundled <script> runs and calls fetch('/api/bookings')
  ▼
run_worker_first sends /api/* to the Worker
  │
  ▼
src/worker/index.ts — Hono matches the route
  │
  ▼
src/worker/middleware.ts — authMiddleware runs first:
  • reads the swa_session cookie
  • revalidates the session against D1
  • checks feature availability gates (503 before auth)
  • checks the caller's role against the route
  • applies rate limits
  │
  ▼
The handler (e.g. src/worker/api/bookings.ts)
  runs SQL, maybe sends an email, returns JSON
  │
  ▼
Browser — the page script turns the JSON into tables and forms
```

Two points matter:

1. The Worker never builds HTML for admin pages. It checks the login, does the database
   work, and returns JSON.
2. Each page is a thin HTML shell with one large `<script>` block that talks to the API.
   `src/scripts/auth-gate.ts` provides `requireAuth()`, which every protected page calls
   before doing anything. It redirects to `/login` when the session check fails.

The public namecard routes (`/c/*`) skip the auth middleware because they are meant for
anonymous visitors. They enforce their own IP-based rate limit inside
`src/worker/api/namecard-public.ts` instead.

### Feature availability flags

Not every built feature is launched. Namecards, Office Booking and Events are
work-in-progress; they are switched off for all users until an IT admin enables them from
Settings → Feature availability. The mechanism (`src/worker/lib/feature-flags.ts`, added
29-08-2026):

- **Code defaults are the source of truth** (`PROD_DEFAULT_FEATURE_FLAGS`, all `false`).
  The KV key `swa:feature_flags` in `SWA_CONFIG` is a per-key override, written only via
  `POST /api/admin/settings` from the Settings page. A missing or unparseable KV value
  falls back to the code default — a half-built feature can never leak into production
  because someone forgot a KV write.
- **Local dev sees everything.** When the dev bypass is active, the defaults flip to
  all-enabled, so WIP features stay visible while being built. A local KV override
  (`wrangler kv key put --local`) can preview the off state.
- **Enforcement is layered.** The middleware returns `503 FEATURE_DISABLED` on gated API
  prefixes (`/api/namecards*`, `/api/bookings*`, `/api/reg/*`) before auth and before the
  public buyer bypass; the public `/c/*` routes 404; nav items and dashboard cards hide
  via `data-feature` attributes driven by the `features` object on `/api/session`; gated
  pages bounce to `/` via auth-gate's `feature` option. A flip takes effect within ~60s
  (per-isolate cache, matching KV's eventual consistency).
- **New features ship behind a flag.** Add the key to `FeatureKey` +
  `PROD_DEFAULT_FEATURE_FLAGS` (`false`) in the same commit as the feature — TypeScript's
  `Record<FeatureKey, boolean>` makes a missing default a compile error.

Tests: `test/suite-setup.ts` seeds the KV override to all-true for the suite
(the test host is `example.com`, so dev defaults never apply) and asserts the
email-suppression sentinel is active;
`src/worker/api/__tests__/feature-flags.test.ts` covers the disabled/enabled paths.

## 4. Authentication

Login uses OTP (one-time password): a 6-digit code emailed to the user, valid for 5 minutes.
The system stores no passwords anywhere.

### The flow

1. The user enters their email on `/login`. `POST /api/send-otp` checks that the email may
   log in: it must be on the `IT_ADMIN_EMAILS` code list, or exist in the `members` table
   with `can_login = 1`. IT admins need no members row (changed 23-08-2026).
2. The endpoint emails the code via Resend and stores it signed, so it cannot be forged. It
   answers the same message whether or not the email exists, so strangers cannot probe which
   emails are registered.
3. `POST /api/verify-otp` checks the code, then signs a session into the `swa_session`
   cookie using HMAC (a signature made with a secret; any edit to the cookie breaks the
   signature and the login is rejected).
4. `src/worker/lib/session-role.ts` decides the session role from the member row. It is the
   single source of truth for role mapping.

Sessions last 12 hours by default, or 30 days with the extended option.

### Per-request revalidation

Every authenticated request triggers a fresh read of the member row in D1
(`src/worker/lib/session-revalidation.ts`). If the member was demoted, locked out
(`can_login = 0`) or soft-deleted since login, the session dies on that request. If the role
changed, the Worker re-signs the cookie without extending its expiry. This was the critical
fix from the August 2026 security audit.

The trade-off: one extra D1 read per authenticated request. The project accepts this at
current scale. A short-TTL KV cache is the documented future optimisation if traffic grows.

### Login rate limits

| Limit | Value |
|---|---|
| OTP sends per email | 5 per 15 minutes |
| Verify attempts per IP | 10 per 15 minutes |
| Verify attempts per email | 5 per 15 minutes |
| Wrong codes per OTP | 5, then the code dies |

### Dev bypass

With `DEV_BYPASS_AUTH=true` in `.dev.vars`, `/login` shows a picker listing every member
with `can_login = 1`. Picking one signs a real session cookie without OTP. Every dev-login
path returns 404 in production. See AGENTS.md, "Local dev login".

## 5. Roles

| Role | Who | Decided by |
|---|---|---|
| IT Admin | Infrastructure owners | Email on the `IT_ADMIN_EMAILS` code list in `src/constants/portal.ts`. No members row needed. Display names come from `IT_ADMIN_NAMES`. A read-only panel in Settings shows the list. |
| Admin | Day-to-day administrators, labelled "Office Admin" in the UI | `members.category = 'admin'` + `can_login = 1` |
| Committee | Board members | `category = 'committee'` or `'advisor'` + `can_login = 1`. Advisors sit in the same tier but get `fee_waived = 1`. |
| reg_admin / reg_volunteer | Gala event staff | The `members.reg_role` column, on top of the base role |

`src/worker/middleware.ts` enforces what each tier can do:

- **IT Admin only**: `/api/admin/settings` (all methods).
- **Admin writes**: `POST`/`PATCH`/`DELETE` on `/api/members` and `/api/namecards`. Reads
  stay open to every logged-in role, so committee members can use the namecard self-service
  panel.
- **Online forms viewers** (`/api/admin/forms/*`): admin or committee.
- **Gala module**: `/api/reg/admin/*` needs reg_admin or admin. `/api/reg/volunteer/*` needs
  reg_volunteer, reg_admin, admin or committee.
- **Membership approve/reject**: a separate email check, `isMembershipApprover()` in
  `portal.ts`. The approver list plus all IT admins pass.
- **Approval workflow** (`/api/approvals/*`, all methods): entry needs admin, purchase
  approver or finance approver. Purchase approvers are
  `APPROVAL_PURCHASE_APPROVER_EMAILS` plus all IT admins (`isPurchaseApprover()`).
  Finance approvers are `APPROVAL_FINANCE_APPROVER_EMAILS` only (`isFinanceApprover()`)
  — IT admins are deliberately excluded so an IT account can never approve a payment
  voucher. Item creation is gated by `canRaiseApprovalItem()` (admin tier only today).
  Email recipients are environment-aware (`lib/notify-recipients.ts`): local dev (the
  `local-dev-` SESSION_SECRET anchor) redirects approval and form-notification mail to
  the shared test inboxes / cjtay@, while staging and production use the real lists;
  the optional `NOTIFY_RECIPIENTS_OVERRIDE` var is honoured only under that same local
  anchor.
  Both flags reach the browser via `/api/session` (`is_purchase_approver`,
  `is_finance_approver`), which drives the Approvals nav item and the board page's
  role gate. Phase 2 ships list, create (multipart with documents), detail and the
  attachment stream; Phase 3 adds the purchase stage — approve/reject (atomic,
  race-safe), edit + resubmit with routing by `rejected_stage`, reminders, and the
  emails in `src/worker/lib/email-approval.ts` (request → purchase approvers,
  decision → creator; description included truncated). Phase 4 adds the finance
  stage: voucher submission with `PV<YY>-<MM><NN>` numbering (UNIQUE-index retry,
  two digits cap at 99 per month, number survives rejection), finance
  approve/reject (finance approvers only — verified by a test that IT admins get
  403), voucher resubmission straight back to finance check, and reminders at
  either waiting stage. Emails go to the named approver lists only — the IT-admin
  union grants authority, not mailbox traffic. Phase 5 completes the workflow:
  the paid step (`paid_recorded` audit, closes the item at `paid`), the
  standalone voucher export page at `/approvals/voucher?id=` (no AdminLayout,
  own noindex, browser "Save as PDF", prints "Prepared by" / "Payment approved
  by" names and "No approval required" for recurring items), and the audit CSV
  export (admin tier only, injection-guarded, oldest first, 5,000-row cap).
  Decision columns store the session name for the printed voucher; the audit
  log keeps emails. See `docs/plans/Approval-Workflow-Implementation-Plan.md`.
  The AI quotation comparison (2026-08-26) adds two admin-only analyse
  endpoints behind the same entry gate — `POST /api/approvals/analyse-preview`
  (form-time, stores nothing) and `POST /api/approvals/:id/analyse`
  (regeneration, reachable only from the edit form and only while the item is
  editable; stores `ai_comparison` + audit row) — served by
  `src/worker/lib/ai-comparison.ts`. The finance-policy compliance build
  (2026-09-05, Batch A, migration 012) adds: the self-approval ban (the
  creator gets 403 at all four decision endpoints), decision offices
  (`purchase_decision_office` / `finance_decision_office` from
  `APPROVAL_OFFICE_LABELS`, shown in drawer/emails/voucher print), the
  S$5,000 two-stage force at create and edit, the voucher invoice number
  (required at first submission; duplicates warn via `duplicateInvoice` /
  `duplicate_invoice` + a `possible_duplicate_invoice` audit row, never
  block), the two-signature voucher print at totals ≥ S$5,000 with the
  payment-record block, GIRO replacing Cheque in the paid step, and the
  `is_tax_invoice` attachment column (ticked document renders first).
  Threshold constants live in `src/constants/portal.ts` only — see
  `docs/plans/approvals-finance-compliance-implementation-plan.md`.
  Compliance Batch B (2026-09-05, migration 013) adds: the S$1,000-and-above
  evidence (two comparison rows or a waiver, budget/coi/no-split
  declarations, cheapest-supplier Yes/No with reason — stored in ten new
  `approval_items` columns), optional per-row quotation dates in the
  comparison JSON with a twelve-month staleness chip in the drawer, the
  S$10,000 board-approval guard (409 without a reference + attachment),
  R1 field-level audit (`field: old → new` pairs in the item_created /
  item_edited notes), R6 (`last_paid_method` on detail — the category's most
  recent paid method, pre-selected in the paid form), and the R7 checkbox
  (create/edit/drawer; one tick per item, ticked document first).
  Compliance Batch C (2026-09-05) adds: the R2 view-only auditor role
  (`APPROVAL_AUDITOR_EMAILS` + `isApprovalsAuditor()`; gate 7c admits
  auditors to GET approvals endpoints only; `is_approvals_viewer` on
  `/api/session` drives the nav; every write 403s for auditors — proven by
  test) and the R3 board-list CSV export
  (`GET /api/approvals/export?status=…`, admin tier, ≤5,000 rows,
  status-tab filter, Export CSV button on the board). Guards: an IT-admin kill-switch
  (`swa:ai_config` in SWA_CONFIG, surfaced as `ai_comparison_enabled` on
  `/api/session`), a 10/hour per-email rate bucket, and a portal-wide daily
  cap of 50 analyses (KV counter). S$ conversion happens in code from a
  KV-cached daily FX table, never by the model. See
  `docs/plans/AI-Quotation-Comparison-Plan.md`.

Handlers sometimes double-check roles as well (defence in depth). For example,
`api/members.ts` re-checks the session role before revealing a member's dependencies.

## 6. The database

Source of truth: `schema.sql` (the rolled-up baseline for fresh databases) plus the numbered
files in `migrations/` (the change history). `npm run db:setup` builds a fresh local
database from `schema.sql` alone.

### Tables

| Table | Stores | Status |
|---|---|---|
| `members` | People: contact details, `category`, `can_login`, fee fields, `reg_role` | Live. The directory and the login identity. |
| `office_bookings` | Office room bookings | Live |
| `membership_payments` | One row per fee payment received | Live. The fee source of truth. |
| `membership_applications` | Public membership form answers, payment-proof image keys, approval status | Live |
| `volunteer_registrations` | Volunteer sign-up answers | Live (form currently closed via config) |
| `laughter_yoga_registrations` | CLYL training sign-up answers | Live |
| `reg_bookings` / `reg_guests` / `reg_tokens` | Gala event table bookings, guest rows, magic-link tokens | Live |
| `namecards` | Digital card data + photo reference per member | Live, board members only (see section 10) |
| `error_log` | Logged server errors (endpoint, message, user, request body) | Live |
| `approval_items`, `approval_attachments`, `approval_audit_log` | Two-stage payment approvals: requests with description + voucher fields, uploaded documents (R2 keys), insert-only action log | Live (Phase 2: create, list, detail, attachment stream; audit writes begin with `item_created`). Approve/reject and voucher stages ship with later phases |
| `membership_types` | Old fee schedule | Dormant. Kept, no longer read. |
| `memberships` | Old per-member subscription periods | Dormant. Kept, no longer read. |

### Patterns to know

- **Soft delete.** Members get a `deleted_at` timestamp instead of being removed, so related
  records keep working.
- **Explicit column lists.** `SELECT` statements name every column. The members API
  deliberately leaves out `nric` (the national ID column, used only for de-duplication), so
  it never leaves the API.
- **Atomic writes.** Related writes go through `DB.batch()`, a transaction where all steps
  succeed or none do. Approve/reject uses `UPDATE ... WHERE status = 'pending'` so two
  admins clicking at once cannot both approve.
- **Fees live in code, not the database.** `src/constants/portal.ts` holds the amounts:
  first year S$20 if the application arrives Jan–Jun, S$10 from July onwards, renewals S$20
  anchored to 31 January. The dormant `membership_types` table was the old model.

### Migration quirks

Two files share the number `005` (`005_membership_lifecycle.sql` and
`005_pdpa_consent.sql`), so the file order does not fully tell you the apply order. The
`namecards` table was backported into `schema.sql` on 23-08-2026, so fresh local databases
now match production. The three approval tables (migration `009`) and the `description`
column (migration `010`) followed the same backport convention the same day.

## 7. Folder map

```
src/
├── constants/portal.ts          ← every magic number in one place: IT admin emails,
│                                   fee amounts, expiry times, rate limits, notification
│                                   recipient lists, office address, namecard rules
├── layouts/AdminLayout.astro    ← shared page shell + top navigation + logout
├── scripts/auth-gate.ts         ← browser-side "am I logged in?" helper
├── styles/                      ← admin.css, membership-form.css, volunteer-form.css
├── pages/                       ← 25 page files, all live
│   ├── index.astro              ← dashboard
│   ├── login.astro              ← standalone login (deliberately no AdminLayout)
│   ├── members.astro            ← member directory
│   ├── office-booking.astro     ← booking calendar
│   ├── approvals.astro          ← approval board (tabs + drawer + create form)
│   ├── approvals/guide.astro    ← approvals user guide (role chapters + screenshots
│   │                                from public/guide/approval/; admin/approvers only)
│   ├── approvals/voucher.astro  ← standalone voucher export page (print/PDF)
│   ├── events.astro             ← events landing
│   ├── namecards.astro          ← namecard management + self-service panel
│   ├── admin/forms/…            ← view, export, approve/reject public form submissions
│   ├── admin/settings/…         ← IT admin settings, roles, gala table layouts
│   └── reg/…                    ← gala module (admin, volunteer check-in, buyer form,
│                                   dashboard) + the three public registration forms
└── worker/                      ← the entire back-end
    ├── index.ts                 ← Hono app + all 69 routes
    ├── middleware.ts            ← the auth/role/rate-limit gate
    ├── types.ts                 ← environment types
    ├── worker-configuration.d.ts ← GENERATED by `wrangler types`; do not hand-edit
    ├── api/…                    ← one file per feature area (+ api/reg/ for the gala)
    └── lib/…                    ← shared logic: email, crypto, rate-limit, sessions,
                                    CSV guard, namecard rendering (+ lib/reg/)
public/                          ← static files served as-is: js/, robots.txt, logo
scripts/                         ← local dev tooling (db setup/seed, logo generation)
test/                            ← vitest helpers: Miniflare env, database fixtures
migrations/                      ← numbered .sql change history
```

## 8. Route inventory

All 69 routes registered in `src/worker/index.ts`, verified 23-08-2026.

### Public (no login)

| Routes | Purpose |
|---|---|
| `GET /c/:slug`, `/c/:slug/contact.vcf`, `/c/:slug/card.svg`, `/c/:slug/photo` (4) | Namecards, board-only. IP rate-limited in the handler. |
| `GET /api/health`, `GET /api/turnstile-config` (2) | Health probe; anti-bot site key |
| `GET /api/session`, `POST /api/send-otp`, `POST /api/verify-otp` (3) | Session read + login flow |
| `GET /api/dev/members`, `POST /api/dev/login` (2) | Dev-only picker; 404 in production |
| `GET /api/volunteer/config`, `POST /api/volunteer/register` (2) | Volunteer form |
| `GET /api/laughter-yoga/config`, `POST /api/laughter-yoga/register` (2) | Laughter-yoga form |
| `GET /api/membership/config`, `POST /api/membership/register` (2) | Membership form |
| `GET /api/reg/buyer/:token`, `PATCH /api/reg/buyer/:token/guests/:id` (2) | Gala buyer form, token-gated |

### Authenticated

| Routes | Purpose |
|---|---|
| `DELETE /api/session` (1) | Logout |
| `GET/POST /api/bookings`, `GET /api/bookings/:id`, `PATCH /api/bookings/:id/cancel` (4) | Office bookings |
| `GET/POST /api/members`; `GET/PATCH/DELETE /api/members/:id`; `GET /api/members/:id/dependencies`; `GET/POST /api/members/:id/payments` (8) | Member CRUD + fees |
| `GET/POST /api/reg/admin/bookings`, `GET …/:id`, `POST /api/reg/admin/guests`, `PATCH/DELETE …/guests/:id`, `GET /api/reg/admin/export`, `GET /api/reg/admin/guest-list`, `POST /api/reg/admin/send-magic-link/:bookingId` (9) | Gala admin |
| `GET /api/reg/volunteer/search`, `POST …/arrive/:id`, `POST …/walkin`, `POST …/guest/:id` (4) | Gala check-in |
| `GET /api/reg/tables`, `GET /api/reg/dashboard/stats` (2) | Gala shared views |
| `GET/POST /api/admin/settings` (2) | IT admin settings |
| `GET /api/admin/forms/volunteer`, `GET …/export` (2) | Volunteer submissions |
| `GET /api/admin/forms/laughter-yoga`, `GET …/export` (2) | Laughter-yoga submissions |
| `GET /api/admin/forms/membership`, `GET …/export`, `GET …/image/:id/:kind`, `POST …/:id/approve`, `POST …/:id/reject` (5) | Membership submissions + approvals |
| `GET/POST /api/namecards`, `POST /api/namecards/bulk`, `GET /api/namecards/me`, `GET/PATCH/DELETE /api/namecards/:id`, `PATCH …/:id/slug`, `PATCH …/:id/toggle`, `POST/DELETE …/:id/photo` (11) | Namecard admin + self-service |
| `GET /api/approvals`, `POST /api/approvals`, `POST /api/approvals/analyse-preview`, `GET /api/approvals/:id`, `GET /api/approvals/:id/attachment/:attId`, `POST …/:id/approve`, `POST …/:id/reject`, `POST …/:id/edit`, `POST …/:id/remind`, `POST …/:id/voucher`, `POST …/:id/analyse`, `POST …/:id/finance-approve`, `POST …/:id/finance-reject`, `POST …/:id/paid`, `GET /api/approvals/audit/export` (15; audit export IT-admin only; analyse routes admin only + kill-switch + daily cap) | Approval workflow, complete: board + create + attachments (Phase 2); purchase stage (Phase 3); voucher + finance stage (Phase 4); paid step + audit CSV (Phase 5); AI quotation comparison (2026-08-26) |

Totals: 19 public + 58 authenticated = 77.

## 9. Public registration forms

Three forms, each built as the same shape: public page → config endpoint → submit endpoint →
admin viewer → CSV export → notification email.

| Form | Public page | State |
|---|---|---|
| Membership application | `/reg/membership/register` | Open |
| Laughter yoga (CLYL training, 24–25 Oct 2026) | `/reg/laughter-yoga/register` | Open |
| Volunteer | `/reg/volunteer/register` | Closed since 04-08-2026 via config |

Shared behaviour:

- **Turnstile** (Cloudflare's privacy-friendly anti-bot check) guards every submission. In
  local dev the Worker returns an empty site key so the widget never loads.
- **Open/close state is configuration.** The volunteer form reads `isActive` + a cutoff date
  from the `SWA_CONFIG` KV; the handler answers `FORM_CLOSED` when either says stop.
- **Uploads go to R2.** The membership form takes a PayNow screenshot and a signature, up to
  10 MB each.
- **Notification emails** come from the `portal.ts` recipient lists, overridable per event in
  the `SWA_CONFIG` KV.
- **CSV exports are injection-safe.** Every field passes through the shared guard in
  `src/worker/lib/csv.ts`. A tripwire test (`lib/__tests__/csv-guard.test.ts`) and a
  pre-commit hook stop private copies from shipping again.
- **Adding a fourth form**: follow `docs/how-to-add-a-form.md`. The three existing handlers
  are near-copies of each other (666, 555 and 1105 lines); the checklist exists so the next
  one does not add a fourth copy.

## 10. Namecards (board-only)

The feature launched in July 2026, was hidden on 22-08-2026 after the security audit, and
was restored on 23-08-2026 under strict rules. The spec is `docs/specs/features/namecards.md` v2.2.

The rules:

- **Board members only.** A card exists only for `category` IN (`committee`, `advisor`).
- **Auto-generation.** `ensureBoardNamecards()` creates a card when a member is created or
  moved into a board category, and darkens it on demotion. Card failures never block the
  member write.
- **The gate is in the read query.** The public SQL only selects board categories, so a
  demoted member's card 404s on the very next request. No cleanup job needed.
- **Office address only.** Every card (HTML page, vCard, card image) shows
  `SWA_OFFICE_ADDRESS` from `portal.ts`. The public queries never select personal address
  columns.
- **Rate limiting.** All four public routes, including the HTML page, are IP rate-limited:
  60 requests per 60 seconds.
- **Crawler blocking.** `public/robots.txt` disallows `/c/` and names six AI bots.
  Responses carry an `X-Robots-Tag` header (`noindex, nofollow, noarchive, nosnippet,
  notranslate, noimageindex`) and the page carries a matching meta tag.
- **Admin + self-service.** Admin CRUD lives at `/api/namecards/*` (writes admin-only).
  `GET /api/namecards/me` returns the logged-in user's own card for the self-service panel.

## 11. Conventions

- **British English** everywhere: organise, programme, colour. No emoji icons in
  professional components. The SWA purple palette lives in `src/styles/admin.css`.
- **Configuration constants live in `src/constants/portal.ts`.** If you change a number,
  change it there.
- **Errors get logged.** Handlers route failures through `handleApiError` / `logError`,
  which write to the `error_log` table.
- **Two typechecks.** `npm run typecheck` runs `astro check` over the pages;
  `npm run typecheck:worker` runs `tsc` over the Worker with its own tsconfig.
- **Tests hit a simulated Cloudflare, not mocks.** Vitest + Miniflare give the tests a real
  fake D1/KV/R2. `npm run test:run` currently passes 285 tests; it runs through
  `scripts/test-run.mjs`, a watchdog that kills the process tree if the pool
  deadlocks in teardown (see progress.md 2026-08-23 session 7). The test files
  share one D1 isolate, so `vitest.config.ts` runs them serially.
- **Test runs never send email.** The vitest config replaces `RESEND_API_KEY`
  with a sentinel (`miniflare.bindings` override beating `.dev.vars`); every
  send site checks `src/worker/lib/resend.ts` and treats the sentinel as a
  suppressed no-op with a console log. `test/suite-setup.ts` asserts the
  sentinel is active and fails the whole suite otherwise. Production and
  local `wrangler dev` send normally — suppression exists only under vitest.
- **Destructive local scripts are user-invoked only.** `db:setup`, `db:seed` and
  `db:clear:membership` never run autonomously.

## 12. Known gotchas

Carried from AGENTS.md, restated here so the architecture doc stands alone:

1. `workers_dev: true` must stay in `wrangler.jsonc`. Without it, workers.dev returns
   error 1042.
2. `login.astro` must not use `AdminLayout`. The layout redirects logged-in users, which
   would bounce the login page in a loop.
3. D1 `ALTER TABLE ADD COLUMN` cannot carry a `UNIQUE` clause. Add the column first, then
   `CREATE UNIQUE INDEX`.
4. The session cookie is `swa_session` and the KV prefix is `swa:` (both ported from an
   older project that used `gtw_` names).
5. The shell `wrangler` shim misbehaves for `d1 execute`. Call the binary directly:
   `node ./node_modules/wrangler/bin/wrangler.js d1 execute swa-portal --local --file=...`
6. Astro 7 enforces strict HTML: every non-void element needs a closing tag. Its
   `compressHTML` default also strips whitespace between inline elements, so rely on
   flex/grid `gap` or explicit `{' '}` for spacing.
7. `wrangler dev` presents `c.req.url` as the configured production domain, not localhost.
   The dev-login host check keeps an explicit exception for it.

## 13. Where to start reading

Read in this order; each file teaches you the next one.

1. `wrangler.jsonc` — what the Worker is wired to (all the bindings). 2 minutes.
2. `src/constants/portal.ts` — all configuration and email lists. 5 minutes.
3. `src/worker/index.ts` — the full route map. 10 minutes.
4. `src/worker/middleware.ts` — how a request is gated. 15 minutes.
5. `src/worker/lib/session-role.ts` + `session-revalidation.ts` — how roles are decided and
   rechecked. 15 minutes.
6. `src/worker/api/members.ts` — a clean, representative CRUD handler. 10 minutes.
7. `src/pages/members.astro` — a representative admin page: thin HTML + one script.
8. `src/worker/api/bookings.ts` — emails + a conflict check; the picture is then complete.
9. `schema.sql` — the database, table by table.
10. `AGENTS.md` — the project's operating manual.

## 14. Keeping this document current

This file describes **how the system is built**. What each feature must do,
and who may use it, lives in the specs: `docs/specs/SWAPortal-Functional-Specs.md`
(core: roles, access matrix, conventions) plus one file per feature under
`docs/specs/features/`. Point-in-time plans and audits live in `docs/plans/`.

Update this file in the same commit when a change adds or removes: routes, tables, roles,
page groups, bindings, or rate limits. Refresh the counts in section 1 and the
"last verified" date in the banner at the same time. Keep this file factual; opinions and
retrospectives belong in dated analysis docs or in `progress.md`.
