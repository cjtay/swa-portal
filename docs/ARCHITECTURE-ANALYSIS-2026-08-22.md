# SWA Portal — Architecture Report

> **Date:** 22 August 2026 (errata applied 23 August 2026: remediation is committed, `prod-dump.sql` deleted, 9 migration files, `NAMECARD.md` carries a hidden-feature banner, laughter-yoga CSV guard fixed)
> **Audience:** junior developers and people learning the codebase. Everything is explained from first principles — you do not need prior knowledge of Cloudflare, Workers, Hono, or Astro.
> **Scope:** how the whole project fits together, what is good, what is flawed, which documents are out of date, and what to do about it.

---

## Table of contents

1. [What is this project?](#1-what-is-this-project)
2. [Beginner crash-course on the stack](#2-beginner-crash-course-on-the-stack)
3. [The big picture: how a request flows through the app](#3-the-big-picture-how-a-request-flows-through-the-app)
4. [The two halves: static pages and the worker](#4-the-two-halves-static-pages-and-the-worker)
5. [How logins and permissions work](#5-how-logins-and-permissions-work)
6. [The database, table by table](#6-the-database-table-by-table)
7. [A map of the source folders](#7-a-map-of-the-source-folders)
8. [What is genuinely good](#8-what-is-genuinely-good)
9. [The flaws, explained in simple terms](#9-the-flaws-explained-in-simple-terms)
10. [Stale and outdated documents](#10-stale-and-outdated-documents)
11. [Current risks and housekeeping debt](#11-current-risks-and-housekeeping-debt)
12. [Recommendations, in priority order](#12-recommendations-in-priority-order)
13. [Should we rebuild from scratch?](#13-should-we-rebuild-from-scratch)
14. [Glossary](#14-glossary)
15. [Where to start reading the code](#15-where-to-start-reading-the-code)

---

## 1. What is this project?

The **SWA Portal** is the internal admin tool for the Singapore Women's Association. It is a web application used by:

- **IT Admins** — run the whole system.
- **Admins** — manage members, view forms, organise events.
- **Committee members** — book the office, view the member directory.
- **Registration volunteers** — check in guests at events.
- **The public** — who submit volunteer sign-ups, laughter-yoga training registrations, and membership applications via public forms.

In plain English: it replaces a stack of paper forms, spreadsheets and Microsoft Forms with one web app. Members are stored in a database, office bookings are made in a calendar view, event walk-ins are ticked off on a phone, and public forms land in an admin review screen.

Here are the headline numbers (so you have a mental size for the project):

| Thing | Count |
|---|---|
| Production dependencies | 2 (`astro`, `hono`) |
| Page files | 24 (23 live + 1 hidden) |
| API routes | 69 |
| Database tables | 13 (12 in `schema.sql` + the `namecards` table from migration 007) |
| Migration files | 9 (two of them share the number `005`) |
| Automated tests | 112 |
| Approximate source lines | ~18,000 (not counting generated type files) |
| Feature areas | ~14 |

The important number is the **2 production dependencies**. This project deliberately uses almost nothing external — everything is built with two small libraries plus Cloudflare's built-in services. That is a strong point, discussed in [section 8](#8-what-is-genuinely-good).

---

## 2. Beginner crash-course on the stack

If you already know these terms, skip to [section 3](#3-the-big-picture-how-a-request-flows-through-the-app). If not, here is everything you need, in plain English.

### The platform: Cloudflare Workers

A normal website runs on a **server**: one computer (or a few) that you rent, that sits somewhere and answers requests. A **Cloudflare Worker** is different:

> **Analogy:** a normal server is a single checkout till. A Worker is a script that Cloudflare copies onto hundreds of tills around the world (actually, onto its CDN edge). When a request arrives, the *nearest* till runs your script and answers instantly.

You write a Worker in JavaScript/TypeScript. Cloudflare runs it (using V8, the same engine inside Chrome), scales it automatically, and you pay almost nothing until you get lots of traffic. The Worker for this project is in `src/worker/`.

**Important constraints to memorise** (they explain several design decisions later):

- Workers do **not** run Node.js. You cannot use `fs`, `path`, `http`, or `process.env`. You use web-standard things: `fetch`, `Request`, `Response`, `crypto.subtle`, `URL`.
- You reach Cloudflare's services through `c.env` — a bundle of "bindings" (see below).
- There is a **10 MB compressed size limit** on the Worker script. It is nowhere near that limit today.

### The services the Worker talks to (all via `c.env`)

| Binding | What it is | Analogy | Used for |
|---|---|---|---|
| `DB` (D1) | A **database** — Cloudflare's version of SQLite, with tables, rows, SQL queries, indexes, and transactions | A filing cabinet with labelled drawers | All persistent data: members, bookings, forms, registrations |
| `SWA_SESSION` (KV) | **Key-value storage** — a fast dictionary you set/get with string keys | A coat-check counter where you hand in a ticket and get a coat back | OTP codes, rate-limit counters, session expiry |
| `SWA_CONFIG` (KV) | The same key-value store, different namespace | A second coat-check counter | Event configuration (table layouts, form settings) |
| `R2_BUCKET` (R2) | **File storage** — Cloudflare's version of S3 | A warehouse for big boxes | Uploaded images: PayNow screenshots, signatures, card photos |
| `ASSETS` | The **static build output** served by Cloudflare | A pre-printed poster stand | The finished HTML/CSS/JS pages |

> **Key difference — D1 vs KV:** D1 is a *real* database: you can query, join tables, search, count. KV is just `key → value`. You use D1 when data is relational (members relate to bookings relate to payments). You use KV when you just need to store something small and fast (a code, a counter, a config blob). KV is "eventually consistent" — a write might take a moment to be visible everywhere — which is fine for codes and counters but not for accounting.

### The frameworks

- **Hono** (`src/worker/index.ts`) — a tiny web framework for Workers. It gives you **routing** (`app.get('/api/members', handler)`) and **middleware** (code that runs before your handler, e.g. "is this user logged in?"). Think of it as a slimmer Express.
- **Astro** — a **static site generator**. At build time (`npm run build`) it turns your `.astro` page files into plain HTML, CSS and JavaScript. It does **not** run a server at request time. This project deliberately uses "static only" mode (`astro.config.mjs` has `output: 'static'`) — no server-side rendering (SSR). The browser gets pre-built pages and a little JavaScript that fetches data from the Worker.

### Authentication ingredients

- **OTP** — One-Time Password. A 6-digit code emailed to you, valid for 5 minutes, used instead of a password.
- **HMAC** — a way to *sign* data with a secret so nobody can tamper with it. The session cookie's contents are signed with a secret. If someone edits the cookie, the signature no longer matches and the login is rejected.
- **Session** — a record of "this browser is logged in as this person". It lives inside a cookie named `swa_session`.
- **Turnstile** — Cloudflare's anti-bot check (their privacy-friendly alternative to CAPTCHA). Public forms make the user tick a box to prove they are human.

### Database concepts you will see repeatedly

- **Migration** — a numbered `.sql` file that records a change to the database (add a table, add a column). They run in order, once, and act as the database's history book (`migrations/`).
- **Schema** — the full structure of the database (all tables and columns). `schema.sql` is the rolled-up version used to create a fresh local database.
- **Batch / transaction** — grouping several SQL writes so they all succeed or all fail together. D1's `batch()` does this. If one step fails, nothing is half-saved.
- **Soft delete** — instead of deleting a row, set a `deleted_at` column. The row stays (so related records keep working) but is treated as gone.
- **Idempotent** — "doing it twice is the same as doing it once." Handlers that send emails or create records guard against a slow network causing a double-submit.
- **Rate limiting** — limiting how many times something can happen per user/IP per time window, to stop abuse.
- **N+1 query problem** — running N extra database queries in a loop instead of one clever query. Slower, but harmless at this project's size.

### Tooling

- **`wrangler`** — the command-line tool for running (`wrangler dev`), deploying (`wrangler deploy`), and managing Cloudflare resources.
- **Vitest + Miniflare** — the test runner. Tests run against a *simulated* Cloudflare environment (fake D1, KV, R2), so they are fast and safe. Config in `vitest.config.ts`.

---

## 3. The big picture: how a request flows through the app

The most important mental model for this codebase is: **pages are pre-built static files; all real work happens in the Worker over `/api/*`.**

Read this diagram slowly — it is the whole architecture in one picture:

```
                    ┌─────────────────────────────────────────────┐
                    │              The Browser                     │
                    │  (a person at their computer)                │
                    └───────────────────┬─────────────────────────┘
                                        │
                    (1) User types/clicked a URL, e.g. /office-booking
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │   Cloudflare serves a PRE-BUILT static page │
                    │   (plain HTML + a <script> tag)             │
                    │   This comes from the ./dist folder         │
                    │   built by Astro at `npm run build` time.   │
                    └───────────────────┬─────────────────────────┘
                                        │
                    (2) The page's JavaScript runs in the browser.
                    It calls: fetch('/api/bookings')
                                        │
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │   wrangler.jsonc has:                      │
                    │   run_worker_first: ["/api/*"]             │
                    │   → any URL starting with /api/ is sent to │
                    │     the WORKER, not served as a static file│
                    └───────────────────┬─────────────────────────┘
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │   src/worker/index.ts  (the Hono app)      │
                    │   It matches the route, e.g. GET /api/bookings
                    │                                            │
                    │   FIRST a middleman runs:                  │
                    │   src/worker/middleware.ts                 │
                    │   • read the swa_session cookie            │
                    │   • check the user's CURRENT role in D1    │
                    │   • block if they aren't allowed           │
                    │   • apply rate limits                      │
                    └───────────────────┬─────────────────────────┘
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │   The handler for that route, e.g.          │
                    │   src/worker/api/bookings.ts                │
                    │   • runs SQL against D1                     │
                    │   • maybe emails someone (via Support)      │
                    │   • returns JSON like { success:true, ... } │
                    └───────────────────┬─────────────────────────┘
                                        ▼
                    (3) JSON comes back to the browser.
                    The page's JavaScript turns it into rows/tables.
```

Two takeaways to really absorb:

1. **The server (Worker) never builds HTML for the admin pages.** The HTML is baked at build time; the Worker only does "log in check + database work + return JSON".
2. **The browser does the "drawing".** Each page has scripting that takes the JSON and renders it. This is why the pages have big `<script>` blocks — see the flaw discussion in [section 9](#9-the-flaws-explained-in-simple-terms).

---

## 4. The two halves: static pages and the worker

### Half 1 — Astro pages (`src/pages/`)

Astro files (`.astro`) are a mix of:

- a **frontmatter block** (`---` at the top) — code that runs *at build time*,
- **HTML** with `{expr}` slots, and
- a `<script>` block — this is bundled and shipped to the browser.

For this project the frontmatter is nearly empty (just `import AdminLayout`). The pages are **thin HTML shells**. All interesting things that happen after page load are in the `<script>` block:

```astro
<script>
  import { requireAuth } from '../scripts/auth-gate';
  // fetch('/api/members'), render rows, open modals, submit forms...
</script>
```

So each page is basically: *blank page + one script that talks to the Worker*. That is a deliberate "SPA-lite" pattern and it is fine — but the scripts repeat a lot of code (see the duplication flaw).

**The login page is special:** `src/pages/login.astro` intentionally does *not* use the shared layout, because layout code redirects already-logged-in users... which would make the login page bounce you in a loop. This is a documented trap in `AGENTS.md`.

### Half 2 — the Worker (`src/worker/`)

| Location | Purpose |
|---|---|
| `index.ts` | Creates the Hono app, registers **all 69 routes**, applies `authMiddleware` to everything under `/api/*` |
| `middleware.ts` | The gatekeeper: session check, role checks, rate limiting (see [section 5](#5-how-logins-and-permissions-work)) |
| `api/` | One file per **feature area**. Each file exports handler functions: booked-able — `members.ts`, `bookings.ts`, `membership-reg.ts`, `volunteer-reg.ts`, `laughter-yoga-reg.ts`, the `reg/` folder (gala event) |
| `lib/` | **Shared helpers** used by handlers: sending emails, rate limiting, crypto, session signing, CSV building, and the `reg/` subfolder for gala-event logic |
| `types.ts` | TypeScript types for the Worker's environment (`Env`), so `c.env.DB` etc. are typed |

There is one rule that keeps this tidy, repeated in `AGENTS.md`: **no Node.js APIs inside the Worker** — it must only use web-standard APIs plus `c.env` bindings.

### How the two halves connect: `wrangler.jsonc`

The glue is the `assets` block in `wrangler.jsonc`:

```jsonc
"assets": {
  "directory": "./dist",
  "binding": "ASSETS",
  "run_worker_first": ["/api/*"]
}
```

- `./dist` is the Astro build output (the static pages).
- `run_worker_first: ["/api/*"]` means: "if the URL starts with `/api/`, call the Worker first; otherwise serve the static file."

The public forms also have **non-API** routes served by the Worker (`/c/:slug` for namecards) — those are commented out now, which is part of the dead-code story in [section 9](#9-the-flaws-explained-in-simple-terms).

---

## 5. How logins and permissions work

This is the most carefully built part of the project, and it was recently hardened after a security audit. Understanding it will make the middleware make sense.

### Step-by-step login

1. User visits `/login` and types their email.
2. Browser calls `POST /api/send-otp` (`api/send-otp.ts`). The Worker checks the `members` table: does this email exist **and** have `can_login = 1`? If yes, it emails a 6-digit code (valid 5 minutes). If no, it still answers "if that email is registered, a code has been sent" — so you can't tell which emails exist.
3. User types the code. `POST /api/verify-otp` checks it (the code is signed with a secret so it can't be forged), then creates a **session**.
4. The session is put in the `swa_session` cookie, HMAC-signed. The cookie says who you are and what role you had *at login time*.
5. Every later request, the middleware **re-checks** the live member row in D1 (this step is called "revalidation") — so if an admin demotes you or disables your login while you are still logged in, you lose access immediately rather than keeping it for up to 30 days. That fix was the **critical** finding in the security audit.

The browser-side part is `src/scripts/auth-gate.ts` — a tiny helper called `requireAuth()` that pages run before doing anything, which redirects to `/login` if not logged in.

### The roles

There are three base roles, decided by the `members.category` column *plus* a hardcoded list:

| Role | Who gets it | What they can do |
|---|---|---|
| **IT Admin** | Emails hardcoded in `src/constants/portal.ts` (`IT_ADMIN_EMAILS`) | Everything, including infra settings |
| **Admin** | `members.category = 'admin'` + `can_login = 1` | Full member CRUD, cancel any booking |
| **Committee** | `category = 'committee'` or `'advisor'` + `can_login = 1` | View members, manage own bookings |

There are extra **registration roles** for events (`reg_role` column): `reg_admin` (manage event bookings/exports) and `reg_volunteer` (search guests, check people in). A committee member can also tick guests in.

### Where permissions are enforced

- `src/worker/lib/session-role.ts` — **single source of truth** for mapping a member row to a role. If you ever think "what role does this person have?", the answer starts here.
- `src/worker/middleware.ts` — the main gate. It has:
  - `PUBLIC_PATHS` — routes anyone can hit unauthenticated (login, OTP, health).
  - sets of path-prefixes that are public but handled specially: volunteer/membership/laughter-yoga forms (they do their own Turnstile check), and the buyer form (token-gated).
  - sets of admin-only paths (`/api/admin/settings`), and write-gating for `/api/members` and `/api/namecards`.
  - role checks for the registration routes and the admin forms viewer.
  - **general rate limiting** on authenticated write endpoints.
- Handlers sometimes double-check roles too ("defence in depth") — e.g. `members.ts` re-checks `sessionRole === 'admin'` before revealing a member's dependencies.

**Trade-off to remember:** the middleware does a **D1 read on every single authenticated request** to revalidate the session. That is a deliberate safety/ease-of-use trade-off, documented as acceptable at this scale, with "add a KV cache later" noted as a future optimisation.

---

## 6. The database, table by table

The source of truth for the schema is `schema.sql`, plus migration files for newer additions. Full table list:

| Table | Stores | Built-in purpose | Status |
|---|---|---|---|
| `members` | People (name, email, mobile, addresses, `category`, `can_login`, membership/fee fields, `reg_role`) | The core directory + login identity | **Live** |
| `office_bookings` | Office room bookings (who, when, purpose, status) | The booking module | **Live** |
| `membership_payments` | One row per payment received (member_id, amount, date, method) | Fee tracking — the real source of truth for fees | **Live** |
| `membership_applications` | Public membership-application form answers + proof-of-payment image keys + approval status | The membership intake workflow | **Live** |
| `volunteer_registrations` | Public volunteer sign-up form answers | The volunteer intake | **Live** |
| `laughter_yoga_registrations` | Public CLYL-training sign-up answers | The laughter-yoga intake | **Live** |
| `reg_bookings` / `reg_guests` / `reg_tokens` | Gala-event table bookings, guest rows/arrivals, magic-link tokens | The gala registration module | **Live** |
| `error_log` | Logged server errors (endpoint, type, message, user, request body) | Debugging/forensics | **Live** |
| `membership_types` | A fee-schedule table (First Year, Renewal) | Was the old fee model | **Dormant — kept but no longer read** |
| `memberships` | Per-member subscription periods | Was the old fee model | **Dormant — kept but no longer read** |
| `namecards` (from migration 007) | Digital card data + photo reference for each member | The namecard system | **Present but feature is hidden (dead-ish)** |

Two patterns worth noticing:

1. **Dormant tables are kept.** The fee feature was rebuilt (migration 005 + `membership_payments`) and the old `membership_types`/`memberships` tables were left in place rather than dropped. Keeping them avoids risky `DROP TABLE` migrations, but it adds confusion — a newcomer legitimately can't tell which fee table is "real". (The comments in `schema.sql` explain clearly which is which — good documentation, bad tidiness.)
2. **NRIC is deliberately hidden.** The members API returns an explicit column list that excludes `nric` (see `src/worker/api/members.ts`), so even though the column exists for de-duplication, it never leaves the API. This was a security-remediation win.

---

## 7. A map of the source folders

```
src/
├── constants/portal.ts              ← ALL the magic numbers in one place:
│                                      IT_ADMIN_EMAILS, fee amounts, expiry times,
│                                      rate limits, notification recipient lists.
│                                      ("If you change a number, it lives here.")
├── layouts/
│   └── AdminLayout.astro            ← shared page shell + top navigation bar + logout
├── styles/
│   ├── admin.css                    ← admin pages look
│   ├── membership-form.css          ← public membership form look
│   └── volunteer-form.css           ← public volunteer/laughter-yoga form look
├── scripts/
│   └── auth-gate.ts                 ← browser-side "am I logged in?" helper
├── pages/                           ← 24 page files (1 hidden)
│   ├── index.astro                  ← dashboard
│   ├── login.astro                  ← standalone login
│   ├── members.astro                ← member directory
│   ├── office-booking.astro         ← booking calendar
│   ├── events.astro                 ← events landing
│   ├── admin/…                      ← settings + the "view form submissions" pages
│   ├── reg/…                        ← gala module + public forms
│   └── _namecards.astro             ← HIDDEN page (renamed for the security audit)
└── worker/                          ← the entire back-end
    ├── index.ts                     ← Hono app + all routes
    ├── middleware.ts                ← auth/role/rate-limit gate
    ├── types.ts                     ← shared environment types
    ├── worker-configuration.d.ts    ← GENERATED by `wrangler types` — don't hand-edit
    ├── api/…                        ← one file (or folder) per feature area
    ├── lib/…                        ← shared logic: emails, crypto, rate-limit,
    │                                  sessions, CSV, and lib/reg for gala logic
    └── tsconfig.json                ← its own TS config (worker-side typecheck)
```

The two files worth reading *first* are `src/constants/portal.ts` (all the configuration) and `src/worker/index.ts` (the whole route map — it reads like a menu of "what this site can do").

---

## 8. What is genuinely good

Before the criticising, credit where it's due. These are real strengths, and a rewrite would risk losing them.

1. **Almost no dependencies.** Two production packages. No ORM, no UI framework, no giant utility libraries. Smaller dependency tree = smaller attack surface and fewer surprises. Rare and excellent.
2. **Security is taken seriously and improving.** HMAC-signed sessions, per-request role revalidation, Turnstile on public forms, rate limits, an allow-list on a full-name field to block XSS, NRIC never returned by the API, CSV formula-injection guard, explicit column lists on SQL `SELECT`s. After the 2026-08 audit the team fixed a critical privilege-escalation bug, a privacy bug, and an XSS bug — that is good practice.
3. **Atomic, safe database writes.** Uses `DB.batch()` so related writes all-or-nothing; uses `UPDATE ... WHERE status='pending'` for race-safe approve/reject; detects and handles duplicate-submit idempotently.
4. **Tests with a real simulated environment.** 112 tests run against Miniflare (simulated D1/KV/R2), not mocks. `npm test` catches database-query mistakes.
5. **Good documentation discipline at the file level.** Explicit column lists with comments explaining *why*; the dormant tables are clearly labelled; gotchas are written down (`AGENTS.md`); there is a decision log and honestly written progress notes (including "over-engineering I added that the user pushed back on").
6. **Consistent style.** British English, no emoji, the SWA purple palette everywhere, one shared CSS file for admins.

None of the flaws below mean "the code is bad" — they mean "the code was written fast, by a small team, one feature at a time, and nobody has done the consolidation pass yet."

---

## 9. The flaws, explained in simple terms

This section is the meat of the report. Every flaw is stated plainly, with a concrete example and its location, so you can go and look at it yourself.

### Flaw 1 — The three public forms are three near-copies of the same thing

The volunteer form, the laughter-yoga form, and the membership application form are each a complete "vertical slice": a public page + a config endpoint + a submit endpoint + an admin submissions viewer + a CSV export + a notification email. Each was written by **copy-pasting the previous one and changing the table name**.

The worker handlers speak for themselves:

| File | Lines |
|---|---|
| `src/worker/api/volunteer-reg.ts` | 666 |
| `src/worker/api/laughter-yoga-reg.ts` | 555 (after the CSV-guard fix of 23-08-2026) |
| `src/worker/api/membership-reg.ts` | 1105 |

Copied verbatim between them (same code, sometimes different constants):

- `verifyTurnstile()` — the anti-bot verification
- `checkRateLimit()` — the sliding-window rate limiter
- `isRetryableD1Error()` — matching flaky D1 errors
- `formatSg()` — formatting times for Singapore
- `str()` — safe string extraction from form data

**And here is the proof that duplication hurts:** the "CSV formula-injection guard" (a security fix that stops a spreadsheet running a formula typed in a name field) was implemented in a shared file `src/worker/lib/csv.ts`. The volunteer and membership handlers import it. The laughter-yoga handler had its **own local copy without the guard** — the drift was caught on 23 August 2026 and fixed the same day (the handler now imports the shared guard), but only after the unguarded copy had shipped. Exactly the kind of slow security drift duplication creates.

**Why this matters for you as a learner:** if you are asked to add a *fourth* form, the "easy" path (copy again) is also the wrong path. This is the single most important thing to fix, and it is discussed in [section 12](#12-recommendations-in-priority-order).

### Flaw 2 — The pages carry a lot of repeated inline code

Remember that pages are thin HTML shells + a `<script>`. Unfortunately each page re-implements the same helpers:

- `esc()` (escapes HTML to prevent XSS) — redefined on ~5+ different pages
- modal open/close logic — redefined per page
- `loadTableConfig` fetch — duplicated across reg pages
- the whole Turnstile setup — duplicated across the three form pages

Some page files are huge as a result:

| Page | Lines |
|---|---|
| `src/pages/reg/membership/register.astro` | 864 |
| `src/pages/reg/volunteer/register.astro` | 640 |
| `src/pages/reg/volunteer/checkin.astro` | 568 |
| `src/pages/reg/admin/bookings.astro` | 511 |
| `src/pages/office-booking.astro` | 454 |

The `checkin.astro` and `search.astro` pages are essentially the **same screen** (search a guest, mark them arrived) written twice with different styling.

There was even a plan written to fix exactly this — `docs/plans/astro-refactor-plan.md` (extract shared helpers, components, and move scripts out of pages). It was drafted on 27 June 2026 and **never executed** (there is still no `src/components/` folder today). So the diagnosis of this problem already exists; it just needs doing.

### Flaw 3 — Dead code that is "hidden, not deleted"

After the security audit found that the public namecard pages exposed member contact details without login, the team chose to **hide** the whole feature rather than delete it (commit 2026-08-22). Good decision from a "maybe we restore it" point of view — bad decision from a "keep the codebase understandable" point of view. What remains:

- `src/worker/api/namecard-public.ts` (496 lines) — unreachable (routes commented out)
- `src/worker/lib/namecard-{photo,svg,vcard,qr,rate-limit}.ts` (~600 lines) — unreachable
- `src/pages/_namecards.astro` (700 lines) — renamed so it isn't served
- its CSS, its tests, its migration, and its docs

That is roughly **1,700 lines** of code nobody can reach, plus documentation that tells a confused reader the feature is active. It also breaks the "one page file = one route" mental model (a file starting with `_` is a hidden page; readers must know that convention).

Similarly, `src/worker/lib/reg/guests.ts` exports 9 helpers but **5 of them are never imported** — the handlers re-written the same SQL themselves. Leftover code from an abandoned refactoring.

**Dead code is not free.** Every Git read, every search, every "is this the real way to do X?" question has to wade through it.

### Flaw 4 — The middleware keeps growing as features are added

`src/worker/middleware.ts` now contains four near-identical "public path prefix" sets:

```ts
const VOLUNTEER_API = new Set(['/api/volunteer']);
const MEMBERSHIP_API = new Set(['/api/membership']);
const LAUGHTER_YOGA_API = new Set(['/api/laughter-yoga']);
const REG_BUYER_API = new Set(['/api/reg/buyer']);
```

…each followed by a comment "public, Turnstile-verified in handler" and a bypass `return next()`. Adding form N requires editing the middleware, the route table, the constants file, the schema and the page. That cross-cutting cost is how the code got big quickly.

### Flaw 5 — Scope creep: the project quietly became 14 features

The original plan (`docs/plans/SWAPortal-Implementation-Plan.md`) describes a **lean admin tool** — a ~22-page portal with a booking module and a namecard *table*. What actually exists now:

- the original admin core (auth, dashboard, members, office booking)
- a full **gala dinner registration module** (imported from another project, with its own admin/volunteer/buyer/dashboard sub-surfaces)
- **three public intake forms** with admin review screens
- a **membership-fee lifecycle** (approve → member row → payment log → renewals)
- an **admin settings** module
- the namecard system, journey: built → removed → rebuilt bigger → hidden

Some of this is genuinely wanted by the client (the forms were the point of the tool). The problem is not adding features — it's adding them *by copy-paste* and never consolidating.

### Flaw 6 — Inconsistencies that trip people up

- **Two migration files share the number `005`**: `migrations/005_membership_lifecycle.sql` and `migrations/005_pdpa_consent.sql`. They are two different migrations with the same number, applied by hand in an order that isn't obvious from the filenames.
- **Mixed error-handling styles**: some handlers use `handleApiError` (which logs), others return bare `c.json(...)` with no logging. When debugging a prod issue you can't rely on `error_log` being populated for every endpoint.
- **Loose typing in handlers**: many use `Record<string, unknown>` + manual `String(body.x).trim()` rather than a typed request body. Works, but no compile-time safety.
- **Unused imports** (`import type { Context } from 'hono'` appears where it isn't needed) and workaround helpers (`getSessionEmail`/`getSessionRole` in `membership-reg.ts` that cast the context to read session values) are small smells signalling the type design is slightly awkward.

---

## 10. Stale and outdated documents

Documentation has the same problem as code: it was written for the state of the project *then*, and not all of it was updated when the project changed. Here is the honest list. A common thread: **the namecard feature and the website-sync feature were removed/hidden, but several documents still describe them as live.**

> **Flags used below:** 🔴 definitely misleading — 🟡 partly out of date — 🟢 fine (kept for reference)

| Document | Flag | What's wrong |
|---|---|---|
| `docs/specs/SWAPortal-Functional-Specification.md` (v2.0) | 🔴 | A full duplicate of the spec below, listing Namecards as an active feature. Two competing specs (v1.0 and v2.0) both exist and both describe a feature set that has changed. **Two specs should be one.** |
| `docs/specs/SWAPortal-Functional-Specs.md` (v1.0) | 🟡 | The other half of the duplicate. References website-sync and namecards as planned/removed inconsistently. Doesn't cover the public-intake forms or membership lifecycle. |
| `docs/NAMECARD.md` | 🟢 | Opens with a prominent "FEATURE HIDDEN — 22-08-2026" banner explaining why and where the `DISABLED 2026-08` markers are. The body below documents the feature as built — an honest archive. |
| `docs/plans/Namecard-Implementation-Plan.md` | 🔴 | Describes go-live phases for the now-hidden feature. Unlike `NAMECARD.md` it carries no hidden-feature banner, so it reads as if go-live is still ahead. |
| `docs/specs/SWA-Digital-Infrastructure-Functional-Specification.md` | 🟡 | Introduces "Namecard Management" as one of the portal's six features. Feature is hidden. |
| `docs/specs/SWA-Workers-Architecture-Assessment.md` | 🟡 | From 13 May, contains a whole section on cross-worker namecard data access that was **removed** on 19 Jul 2026. It has a "REMOVED" banner, so it's honest, but it's really an archive now. |
| `docs/plans/astro-refactor-plan.md` | 🟡 | A good plan that was never executed. Keep it — but add a status note so readers know it's "proposed, not done". |
| `docs/plans/SWAPortal-Implementation-Plan.md` | 🟡 | Phase tracker last updated 19 Jul 2026. Doesn't reflect the August security remediation or the hidden namecards. |
| `docs/checklist/*` (three files, May 2026) | 🟡 | Historical setup checklists. Useful reference, but they describe the world at setup time (e.g. they reference the sister project `gtw2026`). Not misleading per se — just ageing. |
| `AGENTS.md` | 🟢 | Maintained recently (21 Aug 2026) and correctly describes namecards as hidden. This is the doc to trust. |
| `progress.md` | 🟢 | In `src`-root, gitignored, updated to 22 Aug 2026 — a reliable recent-history log. |

**One-line summary:** if a document mentions "Namecards" or "website sync", assume it is out of date until proven otherwise. `AGENTS.md` and `progress.md` are the two to trust.

---

## 11. Current risks and housekeeping debt

These are not design flaws — they are **things that could bite us or are just untidy right now.**

1. **🔴 The security remediation (P1–P4) is committed but NOT deployed.** The fixes landed in commit `02799aa` on 22-08-2026 (docs follow-up `f7d8e8f`) and the full test suite passes, but production is still running the pre-fix code — including the critical session bug and the privacy bug. Until the owner runs `npm run deploy`, the live site keeps every bug the audit found. **This is the biggest single remaining risk in the repo.**
2. **`prod-dump.sql` — resolved.** The production dump that sat in the repo root has been deleted. It was never tracked by git, so no history rewrite was needed. No action left.
3. **Migration 007 (`namecards`) was never rolled into `schema.sql`.** So `npm run db:setup` (which builds a fresh local DB from `schema.sql`) does not create the `namecards` table — a documented local-dev gotcha, and a pending task.
4. **Two `005_*` migrations** (as above) make the migration history ambiguous.
5. **Members API has no pagination.** `GET /api/members` loads the whole table. Fine at ~14 seeded members; it will eventually be slow. The plan itself flags this as "will break at scale".
6. **The namecard decision is unmade.** It's hidden but fully present (code, table, migration, docs, tests). Every day it stays hidden-but-present is a day of confusing docs and dead weight. Either restore or delete.

---

## 12. Recommendations, in priority order

These are deliberately concrete and ordered by "cheapest now / most important later". None requires a rewrite.

### Short term (do this week — hygiene and safety)

1. **Deploy the security remediation.** The fixes are already committed (`02799aa`, 22-08-2026). Verify `npm test` passes, run migration 007 if needed on prod, then `npm run deploy`. This converts the single biggest remaining risk into a shipped improvement.
2. **Delete `prod-dump.sql`** from the repo root (after confirming a backup elsewhere, e.g. a `wrangler d1 export`).
3. **Decide the namecard question.** Recommend: delete the hidden public half (`namecard-public.ts`, `namecard-lib/*`, `_namecards.astro`, its CSS/frontend assets and tests), keeping the admin half (the `/api/namecards` CRUD) if the admin card-manager is wanted later. Git history is the safety net, so "delete" is not forever. **Then mark the docs** (`NAMECARD.md`, the namecard plan) clearly "RETIRED".

### Medium term (this month — the big wins)

4. **Execute `docs/plans/astro-refactor-plan.md`.** Create one shared client helper module (`esc`, `apiFetch`, `html`-style rendering), a `PublicLayout` for public pages, and small page components; move the big `<script>` blocks out of pages into typed modules. This kills the XSS-risk duplication in Flaw 2 and makes each page ~3× smaller. Do it page by page so nothing breaks.
5. **Build ONE shared public-form base.** Create a common handler skeleton that the volunteer, laughter-yoga and membership forms all extend (submit → validate → upload → insert → email → export), plus one shared front-end form script. After this, adding a 4th form is "one config + one field set", and the CSV-injection guard can never drift again. (The existing `lib/reg/*` module shows the pattern that works.)
6. **Consolidate the two functional specs** into one current document (or mark one as "historical"), and add a "proposed, not done" banner to `astro-refactor-plan.md`.
7. **Fix the migration history**: renumber the second `005` to `006`/`009` via new additive files if the DB state is already applied in prod (do **not** retro-edit applied migrations), and roll migration 007 into `schema.sql`.

### Longer term (when needed — don't do early)

8. **Add pagination** to the members endpoint + page before the member list gets large.
9. **Move the middleware's path-prefix sets and role rules into a small declarative config** (a table of "path → allowed roles") so future modules don't require editing the gatekeeper code.
10. **If request volume grows**, add a short-TTL KV cache in front of session revalidation (documented as the accepted future optimisation).
11. When **Phase 2B (membership fee reminders)** starts, add Cloudflare **cron** (`scheduled()` handler + `triggers.cron` in `wrangler.jsonc`) — currently there is no scheduled handler at all.

---

## 13. Should we rebuild from scratch?

**No.**

This is the question the report has been building towards, and the answer is a confident **no**, for four reasons:

1. **The architecture is right.** One small Worker + static pages + D1/KV/R2 is a simple, modern, cheap stack. It is not the cause of the complexity. Rebuilding on the *same* stack would not remove the complexity — the complexity is in the *amount of copy-paste*, not the *structure*.
2. **A lot of real, hard-won value would be thrown away.** A hardened auth system (the kind of thing that took a security audit to get right), 112 tests that actually exercise the database, 9 migrations of careful data modelling, and a decision trail in the docs that tells you *why* things are the way they are.
3. **A rewrite is not cheaper than a cleanup.** The un-wanted work in this codebase is duplication and dead code. Deleting and re-writing duplicated code costs more than extracting it into one shared place — and a pressure-filled rewrite is exactly how the same copy-paste habits would return (plus a fresh set of bugs with no test suite to catch them).
4. **The team already knows what to do.** The `astro-refactor-plan.md` shell exists. The codebase is ~18,000 lines, not 200,000. It is at the perfect size to fix *now*, cheaply, and far easier than a "big bang" rewrite.

**When would "rebuild" be the right call?** If the requirements changed fundamentally (e.g. you need multi-tenant support or a totally different data model), or if the team had no test safety net and the code were genuinely tangled. Neither is true here.

So: **keep the architecture, fix the duplication, prune the dead code, and let the docs tell the truth.** That is a 2–3 session job, not a project.

---

## 14. Glossary

Quick reference. Each term is one plain-English line.

| Term | Meaning |
|---|---|
| **Admin (role)** | A portal user with a `members.category` of `admin` plus `can_login=1`. |
| **Astro** | A static site generator; produces the finished HTML/CSS/JS pages at build time. |
| **Binding** | A pre-connected handle Cloudflare gives your Worker — e.g. `c.env.DB` is the *binding* to D1. |
| **Batch (D1)** | Running several SQL writes together so all succeed or all fail (a transaction). |
| **Cloudflare Workers** | Tiny scripts run on Cloudflare's global CDN instead of on your own servers. |
| **Committee (role)** | A portal user with `category = committee` or `advisor`. The default tier. |
| **Cookie** | A small piece of data the browser stores and sends with every request to a site. |
| **D1** | Cloudflare's SQLite-like relational database, reached through `c.env.DB`. |
| **Index** | A database feature that makes specific lookups fast (like an index in a book). |
| **HMAC** | A "signature" over some data using a secret key; proves it wasn't tampered with. |
| **Idempotent** | A request that produces the same result however many times it is retried. |
| **IT Admin (role)** | A user whose email is on the hardcoded `IT_ADMIN_EMAILS` list; full control. |
| **KV** | Cloudflare key–value store; a fast dictionary, reached through `c.env.SWA_SESSION` or `c.env.SWA_CONFIG`. |
| **Middleware** | Code that runs *before* a route handler — here, the auth/role/rate-limit gate. |
| **Migration** | A numbered `.sql` file recording one change to the database schema. |
| **N+1 problem** | A loop that runs one database query per item instead of one query for all items. |
| **OTP** | One-Time Password — the 6-digit login code emailed to you, valid for 5 minutes. |
| **R2** | Cloudflare's object storage (like S3) for files, reached through `c.env.R2_BUCKET`. |
| **Rate limit** | Capping how often something can happen, to stop abuse. |
| **run_worker_first** | The wrangler setting that sends certain URLs (here `/api/*`) to the Worker instead of serving static files. |
| **Schema** | The full structure of the database — all tables, columns, indexes. |
| **Session** | "This browser is logged in as this person", stored in the `swa_session` cookie. |
| **Soft delete** | Marking a row with a `deleted_at` timestamp instead of removing it. |
| **SSR / static** | Server-side rendering (pages built per request) vs static (pages pre-built once, then served). This project is static. |
| **Turnstile** | Cloudflare's anti-bot check used on the public forms. |
| **Vertical slice** | One complete feature end-to-end (page → handler → data → email). Here it's used to describe whole copy-pasted modules. |
| **Wrangler** | The CLI that runs, deploys and configures Cloudflare Workers. |
| **XSS** | Cross-site scripting; injecting script through user input. Escaping output prevents it. |

---

## 15. Where to start reading the code

If you're new to this repo, read in this order — each file teaches you the next one:

1. **`wrangler.jsonc`** — what the Worker is wired up to (all the bindings). 2 minutes.
2. **`src/constants/portal.ts`** — all the configuration and email lists. 5 minutes.
3. **`src/worker/index.ts`** — the full route map ("the menu"). 10 minutes.
4. **`src/worker/middleware.ts`** — how a request is gated. 15 minutes.
5. **`src/worker/lib/session-role.ts` + `session-revalidation.ts`** — how roles are decided and rechecked. 15 minutes.
6. **`src/worker/api/members.ts`** — a clean, representative CRUD handler. 10 minutes.
7. **`src/pages/members.astro`** — a representative admin page (thin HTML + script). Then compare with its duplication siblings. 15 minutes.
8. **`src/worker/api/bookings.ts`** — emails + a conflict check; the picture is then complete.
9. **`schema.sql`** — the database, table by table.
10. **`AGENTS.md`** — the project's operating manual; answer most "why" questions instantly.

After the files above, you'll have the same mental model as anyone working on this repo.

---

*End of report.* Questions, disagreements, or "the report is wrong about X" — the best outcome would be finding errors. This analysis is a snapshot dated **22 August 2026**.