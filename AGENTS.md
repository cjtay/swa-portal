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

## Core Rules
- **British English** spelling (organise, programme, colour)
- **SWA brand colours** — gold `#a8892e`, dark `#1a1a2e`
- **Auth system** — OTP via email, HMAC-signed sessions in cookies (`swa_session`)
- **Role tiers** — `admin` (IT admin emails or @singaporewomenassociation.org), `committee` (KV allowlist)
- **No emoji icons** in professional components

## Architecture
- **Astro static build** for pages, **Hono worker** for API routes
- **Cloudflare Workers** deployment with D1 (database), KV (sessions/OTP), R2 (uploads)
- Auth files ported from GTW project — see `src/worker/` and `src/scripts/auth-gate.ts`

## Key Files
| File | Purpose |
|---|---|
| `src/worker/index.ts` | Hono app entry, route registration |
| `src/worker/middleware.ts` | Auth middleware (admin/committee tiers) |
| `src/worker/api/send-otp.ts` | Generate + email OTP |
| `src/worker/api/verify-otp.ts` | Verify OTP + create session |
| `src/worker/api/session.ts` | Read current session from cookie |
| `src/constants/portal.ts` | Admin emails, session config constants |
| `schema.sql` | D1 database schema |

## Deployment
- **Platform**: Cloudflare Workers + Hono
- **Deploy**: `npm run deploy`
- **Dev URL**: `swa-portal.cjtay-4e0.workers.dev`
- **Production**: `admin.singaporewomenassociation.org`
- **Secrets**: `npx wrangler secret put OTP_SECRET --name swa-portal` and `RESEND_API_KEY`

## Response Style
- Be concise — no preamble or postamble
- Output code directly when implementing changes
- Explain only when asked or when decisions are non-obvious