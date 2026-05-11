# SWA Portal — AI Agent Guide

## Quick Start
```bash
npm install              # Install dependencies
npm run dev              # Astro dev server at localhost:4321
npm run dev:worker       # Wrangler dev (static + API) at localhost:8787
npm run build            # Production build
npm run deploy           # Build + deploy to Cloudflare Workers
npm run cf-typegen       # Regenerate worker-configuration.d.ts
```

## Project Status

**Phase 1 partial complete.** Auth system, project scaffold, and base pages are done. Office booking UI, namecard management, and member directory UI still needed.

See `docs/SWAPortal-Implementation-Plan.md` for full progress tracker.

## Core Rules
- **British English** spelling (organise, programme, colour)
- **SWA brand colours** — purple palette: `swa-1 #70308c`, `swa-2 #450a5e`, `swa-3 #874ba1`, `swa-4 #f3d2ff`, `swa-5` (see `src/styles/admin.css`)
- **Auth system** — OTP via email, HMAC-signed sessions in cookies (`swa_session`)
- **Role tiers** — `admin` (IT_ADMIN_EMAILS or @singaporewomenassociation.org), `committee` (D1 `can_login=1`)
- **No emoji icons** in professional components

## Architecture
- **Astro static build** for pages, **Hono worker** for API routes
- **Cloudflare Workers** deployment with D1 (database), KV (sessions/OTP), R2 (uploads)
- Auth files ported from GTW project — see `src/worker/` and `src/scripts/auth-gate.ts`
- **D1-based auth** — no KV allowlist; `send-otp.ts` queries members table for `can_login=1`

## Cloudflare Resources

| Resource | Name | ID |
|---|---|---|
| D1 database | `swa-portal` | `b8ca063c-6767-445c-a42e-d092daf80fc4` |
| KV namespace | `SWA_SESSION` | `ddb93996417c4476ac0f90ddf1eb332d` |
| R2 bucket | `swa-portal-uploads` | — |
| Worker | `swa-portal` | — |

Secrets: `OTP_SECRET`, `RESEND_API_KEY` (set interactively via `wrangler secret put`)

## Key Files

| File | Purpose |
|---|---|
| `src/worker/index.ts` | Hono app entry, route registration |
| `src/worker/middleware.ts` | Auth middleware (admin/committee tiers) |
| `src/worker/api/send-otp.ts` | Generate + email OTP (D1 can_login check) |
| `src/worker/api/verify-otp.ts` | Verify OTP + create session cookie (D1 name lookup) |
| `src/worker/api/session.ts` | Read current session from `swa_session` cookie |
| `src/worker/api/members.ts` | Member CRUD API (includes `slug`, `can_login` fields) |
| `src/worker/api/bookings.ts` | Office booking CRUD API |
| `src/constants/portal.ts` | `IT_ADMIN_EMAILS`, session config, OTP TTL |
| `src/pages/login.astro` | Standalone login (NO AdminLayout — avoids redirect loop) |
| `src/layouts/AdminLayout.astro` | Sidebar nav with auth gate |
| `schema.sql` | D1 schema with `can_login`, `slug`, `error_log` |
| `seed-members.sql` | 19 member seed data (17 board + 2 IT admin) |

## Deployment
- **Platform**: Cloudflare Workers + Hono
- **Deploy**: `npm run deploy`
- **Dev URL**: `swa-portal.cjtay-4e0.workers.dev`
- **Production**: `admin.singaporewomenassociation.org` (pending domain transfer)
- **Secrets**: `npx wrangler secret put OTP_SECRET --name swa-portal` and `RESEND_API_KEY`

## Critical Gotchas
1. **`workers_dev: true`** must be in `wrangler.jsonc` — without it, workers.dev returns error 1042
2. **Login page must NOT use AdminLayout** — causes infinite redirect loop
3. **D1 `ALTER TABLE ADD COLUMN`** doesn't support `UNIQUE` — add column first, then `CREATE UNIQUE INDEX`
4. **Session cookie**: `swa_session` (not `gtw_session`)
5. **KV key prefix**: `swa:` (not `gtw:`)
6. **`RESEND_API_KEY`** must be set interactively — piping values causes 502 from Resend

## Response Style
- Be concise — no preamble or postamble
- Output code directly when implementing changes
- Explain only when asked or when decisions are non-obvious

## Next Steps
- Office booking calendar UI (Phase 1D)
- Namecard management UI + photo upload (Phase 1E)
- Member directory with search/filter/pagination (Phase 1F)
- Domain transfer: configure `admin.singaporewomenassociation.org` custom domain
- Phase 2: Membership fees, payment reminders, member self-service