# SWA Portal — AI Agent Guide

## Quick Start

```bash
npm install              # Install dependencies
npm run dev              # Astro dev server at localhost:4321
npm run dev:worker       # Wrangler dev (static + API) at localhost:8787
npm run build            # Production build
npm run deploy           # Build + deploy to Cloudflare Workers
npm run deploy:staging   # Build + deploy to the staging Worker (needs owner setup, docs/plans/staging-environment-plan.md)
npm run cf-typegen       # Regenerate worker-configuration.d.ts
npm run db:clear:membership  # Clear local membership applications + approved test members (LOCAL only)
```

**Check `progress.md` first** — it is the dated session log with current status and the next-steps backlog. This guide holds stable facts only.

## Project Status

**Phase 1 complete + feature expansion.** Auth, office booking, member directory, online forms (membership application, volunteer, laughter yoga) and the event registration/check-in system are built and deployed. The full security remediation plan (1 critical, 2 high, 7 medium findings from the 2026-08-21 audit) was implemented 22-08-2026 and deployed to production 23-08-2026 — see `docs/plans/security-remediation-plan.md` for the implementation log.

The public-website integration (`show_on_website`, `has_namecard`, `slug`, photo uploads, `/api/sync-website`) was **removed on 19-07-2026** — swa-portal is isolated from the public `swa2024` website for risk segregation. The digital namecard feature (public `/c/:slug` pages + admin UI, spec `docs/specs/features/namecards.md`) was hidden on 22-08-2026 after the security audit, then **restored on 23-08-2026 as board-only**: cards are auto-generated for `category` IN (`committee`, `advisor`), every card shows the SWA office address (never personal addresses), and `/c/*` is blocked from search engines and AI crawlers via `robots.txt` + `X-Robots-Tag` + noindex meta.

See `docs/plans/SWAPortal-Implementation-Plan.md` for full progress tracker.

See `docs/specs/SWAPortal-Functional-Specs.md` (core: roles, access matrix, conventions) and `docs/specs/features/` (one spec per feature) for role access, API permissions, and feature specifications. A new feature adds one matrix row there plus one feature spec file — same commit as the code.

## Core Rules

- **British English** spelling (organise, programme, colour)
- **SWA brand colours** — purple palette: `swa-1 #70308c`, `swa-2 #450a5e`, `swa-3 #874ba1`, `swa-4 #f3d2ff`, `swa-5` (see `src/styles/admin.css`)
- **Auth system** — OTP via email, HMAC-signed sessions in cookies (`swa_session`)
- **Role tiers** — `admin` (D1 `category='admin'` or `IT_ADMIN_EMAILS`), `committee` session role (D1 `category='committee'` or `category='advisor'` with `can_login=1`). Advisor = same session tier as committee, but `fee_waived=1`.
- **Local dev login** — With `DEV_BYPASS_AUTH=true` (`.dev.vars`), `/login` shows a "Dev quick login" picker listing every `can_login=1` member. `POST /api/dev/login { email }` signs a real `swa_session` cookie without OTP. Logout sets a `swa_dev_logout` marker so the bypass stays inert until you pick another identity. Real cookie always wins over the bypass injection. All dev-login paths 404 in prod.
- **Feature availability flags** — WIP features (`namecards`, `office_booking`, `events`) are hidden in production until an IT admin enables them from Settings → Feature availability (KV key `swa:feature_flags`; code defaults in `src/worker/lib/feature-flags.ts` are the fail-safe source of truth, all `false` in prod, all `true` under dev bypass). Every NEW feature ships behind a flag defaulting to `false` — gate APIs in `middleware.ts`, pages via auth-gate's `feature` option, and add the Settings card row. See `docs/specs/SWAPortal-Functional-Specs.md` §3.2.
- **No emoji icons** in professional components

## Safety Standards

- **Build mode confirmation** — Before creating, editing, or deleting any files, list every file path and the planned operation (create/edit/delete), then ask for confirmation before proceeding.
- **Package safety** — Before running `npm install <package>` or downloading any external library/asset, explain what the package does, why it is needed, and any transitive dependencies it introduces. Ask for confirmation before installing. This prevents supply chain attacks and unnecessary bloat.
- **Verify changes** — Run the project's typecheck/lint/build command before committing to catch errors.
- **Pre-commit review** — A `.githooks/pre-commit` script lists all staged files (new, deleted, modified) and prompts for confirmation before every `git commit`. Enable on fresh clone: `git config core.hooksPath .githooks`
- **Destructive local scripts are user-invoked only** — Never run `npm run db:clear:membership`, `npm run db:setup`, or `npm run db:seed` autonomously, even for test cleanup. Only run them when the user explicitly asks in the current message.

## Role Access

Three tiers. See `docs/specs/SWAPortal-Functional-Specs.md` for the full access matrix.

| Role          | How determined                                                          | What they can do                                  |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| **IT Admin**  | Email in `IT_ADMIN_EMAILS` (hardcoded)                                  | Everything admin can do + infrastructure features |
| **Admin**     | D1 `members.category = 'admin'` with `can_login=1`                      | Full CRUD on members, can cancel any booking      |
| **Committee** | D1 `members.category = 'committee'` (or `'advisor'`) with `can_login=1` | Read members, create/cancel own bookings          |

**Login eligibility**: `can_login = 1` in D1 members table. Email domain does not matter.

## Architecture

- **Astro static build** for pages, **Hono worker** for API routes
- **Cloudflare Workers** deployment with D1 (database), KV (sessions/OTP), R2 (uploads)
- Auth files ported from GTW project — see `src/worker/` and `src/scripts/auth-gate.ts`
- **D1-based auth** — no KV allowlist; `send-otp.ts` queries members table for `can_login=1`
- **Astro 7** (Rust compiler, queue-based rendering, Sätteri markdown pipeline) — static build only, no SSR adapter. Upgraded from 6.4.8 on 2026-07-06; v7 content/SSR features (Sätteri, `src/fetch.ts`, route caching) intentionally not adopted — not relevant to a static admin portal.

## Cloudflare Edge Runtime Rules

- **No Node.js APIs** — Cloudflare Workers run in V8 isolates, not Node.js. Never import or use `fs`, `path`, `crypto` (Node.js), `http`/`https`, or any Node.js built-in module. Use Web Standard APIs: `fetch`, `crypto.subtle` (WebCrypto), `Request`/`Response`, `URL`, `ReadableStream`, `TextEncoder`/`TextDecoder`.
- **Access bindings via `c.env`** — D1 (`c.env.DB`), KV (`c.env.SWA_SESSION`, `c.env.SWA_CONFIG`), R2 (`c.env.R2_BUCKET`), and secrets are accessed through the Hono context's `env` object in route handlers. `process.env` does NOT exist in Cloudflare Workers. For local dev, use `.dev.vars`.
- **No `@astrojs/cloudflare` adapter** — This project uses Wrangler's `assets` binding with `run_worker_first: ["/api/*"]` to route API calls to the Hono worker and serve static pages from `./dist`. Do NOT introduce `@astrojs/cloudflare` or any SSR adapter.

## Cloudflare Resources

| Resource     | Name                 | ID                                     |
| ------------ | -------------------- | -------------------------------------- |
| D1 database  | `swa-portal`         | `b8ca063c-6767-445c-a42e-d092daf80fc4` |
| KV namespace | `SWA_SESSION`        | `ddb93996417c4476ac0f90ddf1eb332d`     |
| KV namespace | `SWA_CONFIG`         | `663295deb2f94800986e3dfe6f8ea230`     |
| R2 bucket    | `swa-portal-uploads` | —                                      |
| Worker       | `swa-portal`         | —                                      |

Staging equivalents (own isolated resources; IDs live in `wrangler.jsonc` `env.staging`): D1 `swa-portal-staging`, KV `SWA_SESSION_STAGING` + `SWA_CONFIG_STAGING`, R2 `swa-portal-staging-uploads`.

Secrets: `OTP_SECRET`, `SESSION_SECRET`, `RESEND_API_KEY` (set interactively via `wrangler secret put`)

## Key Files

| File                             | Purpose                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`           | Living architecture reference (stack, auth, roles, tables, routes). Update it in the same commit as any structural change.               |
| `src/worker/index.ts`            | Hono app entry, route registration                                                                                                       |
| `src/worker/middleware.ts`       | Auth middleware (admin/committee tiers)                                                                                                  |
| `src/worker/api/send-otp.ts`     | Generate + email OTP (D1 can_login check)                                                                                                |
| `src/worker/api/verify-otp.ts`   | Verify OTP + create session cookie (D1 name lookup)                                                                                      |
| `src/worker/api/session.ts`      | Read current session from `swa_session` cookie                                                                                           |
| `src/worker/api/members.ts`      | Member CRUD API (includes `can_login`, membership lifecycle fields)                                                                      |
| `src/worker/api/bookings.ts`     | Office booking CRUD API                                                                                                                  |
| `src/worker/lib/rate-limit.ts`   | General-purpose authenticated endpoint rate limiting                                                                                     |
| `src/worker/lib/feature-flags.ts` | Runtime feature availability (KV-overridden code defaults; gates WIP features in prod, all-on in dev)                                  |
| `src/worker/lib/session-role.ts` | Shared `resolveSessionRole` — single source of truth for the IT-admin/admin/volunteer/committee mapping (used by verify-otp + dev-login) |
| `src/constants/portal.ts`        | `IT_ADMIN_EMAILS`, session config, OTP TTL, rate limit constants, `DEV_LOGOUT_COOKIE_NAME`                                               |
| `src/pages/login.astro`          | Standalone login (NO AdminLayout — avoids redirect loop). Renders the dev role-picker when `/api/dev/members` succeeds                   |
| `src/worker/api/dev-login.ts`    | Dev-only role picker: `GET /api/dev/members` + `POST /api/dev/login`. Both 404 in prod (guarded by `isDevBypassActive`)                  |
| `src/layouts/AdminLayout.astro`  | Topbar nav with auth gate                                                                                                                |
| `schema.sql`                     | D1 schema with `can_login`, `membership_status`, `fee_due_date`, `fee_waived`, `error_log`                                               |
| `seed-members.sql`               | 14 dummy members (12 board + 2 admin) for local dev only                                                                                 |

## Deployment

- **Platform**: Cloudflare Workers + Hono
- **Deploy**: `npm run deploy`
- **Staging**: `npm run deploy:staging` → `swa-portal-staging.cjtay-4e0.workers.dev` (own D1/KV/R2; `env.staging` in `wrangler.jsonc`; see `docs/plans/staging-environment-plan.md`)
- **Dev URL**: `swa-portal.cjtay-4e0.workers.dev`
- **Production**: `admin.singaporewomenassociation.org` (pending domain transfer)
- **Secrets**: `npx wrangler secret put OTP_SECRET --name swa-portal`, `SESSION_SECRET`, and `RESEND_API_KEY`

## Critical Gotchas

1. **`workers_dev: true`** must be in `wrangler.jsonc` — without it, workers.dev returns error 1042
2. **Login page must NOT use AdminLayout** — causes infinite redirect loop
3. **D1 `ALTER TABLE ADD COLUMN`** doesn't support `UNIQUE` — add column first, then `CREATE UNIQUE INDEX`
4. **Session cookie**: `swa_session` (not `gtw_session`)
5. **KV key prefix**: `swa:` (not `gtw:`)
6. **`RESEND_API_KEY`** must be set interactively — piping values causes 502 from Resend
7. **Astro 7 stricter HTML** — the Rust compiler throws hard errors on unclosed tags (the old Go compiler silently auto-closed them). `AdminLayout.astro` previously omitted `</body></html>` and had to be fixed on upgrade. Always close all non-void elements. Also, `compressHTML` defaults to `'jsx'` (strips whitespace between adjacent inline elements) — rely on flex/grid `gap` or explicit `{' '}` for inline spacing.

## Response Style

- Be concise — no preamble or postamble
- Output code directly when implementing changes
- Explain only when asked or when decisions are non-obvious
