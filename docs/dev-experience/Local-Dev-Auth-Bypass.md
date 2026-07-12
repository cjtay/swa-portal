# Local Dev Auth Bypass

Skip OTP login when running the portal locally with `npm run dev:worker`, while
keeping production auth fully enforced. Implemented 2026-07-04.

## Quick start

```bash
cp .dev.vars.example .dev.vars      # 1. Create local env file (gitignored)
npm run dev:worker                   # 2. Start worker at http://localhost:8787
```

Open `http://localhost:8787/` — the admin UI loads **without redirecting to
`/login`**. You are impersonated as an IT Admin.

To verify:

```bash
curl http://localhost:8787/api/session
# {"authenticated":true,"email":"cjtay@singaporewomenassociation.org",
#  "role":"admin","is_admin":true,"is_it_admin":true, ...}
```

To disable the bypass, delete `.dev.vars` (or set `DEV_BYPASS_AUTH=false` inside
it) and restart `npm run dev:worker`. The real OTP login flow takes over again.

## What it does

When the env var `DEV_BYPASS_AUTH=true` is present, the dev bypass does two
things:

1. **Skips authentication.** The API auth middleware short-circuits every
   authenticated request with a fake IT-admin session. No HMAC cookie check
   runs, no OTP is needed, and the client-side auth gate sees
   `authenticated: true` so it never redirects to `/login`.

2. **Skips Turnstile.** The same flag drives a separate lightweight helper,
   `isDevBypassActive()` (`src/worker/api/session.ts`), that the three public
   form handlers (`send-otp`, `membership-reg`, `volunteer-reg`) and the
   `/api/turnstile-config` endpoint consult. The config endpoint returns an
   empty site key so the Turnstile widget never loads, and the handlers skip
   server-side `siteverify`. Without this the forms couldn't submit on
   `localhost` — the production site key isn't authorised for `localhost`.
   See [Local-Dev-Database.md](./Local-Dev-Database.md) for the form-testing
   walkthrough.

## Production safety

This bypass is **physically impossible to activate in production**:

| Concern | Mitigation |
|---|---|
| Flag leaks to production | `DEV_BYPASS_AUTH` is **not** declared in `wrangler.jsonc` `vars`, and is **not** set via `wrangler secret put`. Production `c.env.DEV_BYPASS_AUTH` is `undefined`, so every bypass branch is dead code at runtime. |
| Second trust anchor | Even if the flag somehow leaked into prod, `getDevBypassSession()` also requires `SESSION_SECRET` to start with `local-dev-`. Production's real secret is a high-entropy value set via `wrangler secret put` and will never match — the bypass aborts with `DEV_BYPASS_MISCONFIG`. |
| Tunnel exposure | If both anchors match but the request host is not in the allow-list (`localhost`, `127.0.0.1`, `[::1]`, the configured `SWA_ADMIN_DOMAIN`, or `*.workers.dev`), the worker returns `500` and logs `DEV_BYPASS_MISCONFIG` plus a `[DEV_BYPASS]` error. |
| `.dev.vars` committed to git | `.dev.vars` is in `.gitignore`. Only `.dev.vars.example` is committed, and it contains no real secrets. |
| Real auth path degraded | Untouched. The bypass is an early-return added *before* `getSession()`. The HMAC cookie verification, OTP flow, and rate limiting all remain intact. |

Rate limiting is still applied in dev (keyed on the impersonated dev email), so
burst-protecting logic stays exercised.

## Production cautions

**Never run `npm run dev:worker -- --remote`.** The `--remote` flag makes
wrangler bind `c.env.DB`, `c.env.SWA_SESSION`, and `c.env.R2_BUCKET` to the
**real production** D1, KV, and R2 — any request you make in dev would read
and write live production data. Plain `npm run dev:worker` (no flag) is always
local-only and safe.

**Trust model.** The bypass activates only when **all three** conditions hold:
1. `DEV_BYPASS_AUTH === 'true'` (the flag), AND
2. `SESSION_SECRET` starts with `local-dev-` (defense against a prod flag leak), AND
3. the request host is in the allow-list (defense against tunneling).

If the flag is **absent**, the bypass simply stays dormant (the helper returns
`null`) and normal auth runs — no error. If the flag is set but either of the
other two anchors fails, the worker returns `500 DEV_BYPASS_MISCONFIG` and
normal auth runs. In production the flag is absent, so the bypass never
activates regardless of host.

**Never commit** `.dev.vars` or `.wrangler/` — both are gitignored. `.dev.vars`
holds the bypass flag and local secrets; `.wrangler/` holds the local database.
Only `.dev.vars.example` (no real secrets) is committed.

---

## Technical appendix — how it works

### Auth model recap

Authentication is enforced in two layers:

1. **Server / API** — `src/worker/middleware.ts` → `authMiddleware`. Runs on
   every `/api/*` request. Calls `getSession(c)`, which reads the `swa_session`
   cookie, HMAC-verifies it against `SESSION_SECRET`, and returns the session
   payload (email, name, role, reg role, expiry). No valid session → `401`.
   Role checks (admin / IT-admin / reg roles) are layered on top.

2. **Client / UI** — `src/scripts/auth-gate.ts` → `requireAuth()`. Fetches
   `/api/session`; if `authenticated === false`, hard-redirects the browser to
   `/login?redirect=…`.

Public exemptions (`middleware.ts`): `/api/health`, `/api/session`,
`/api/send-otp`, `/api/verify-otp`, `/api/turnstile-config`, plus the public
registration routes — buyer (token-gated), volunteer (Turnstile-gated), and
membership (Turnstile-gated).

The bypass hooks into **both layers** by making `/api/session` return
`authenticated: true` — the server middleware accepts the fake session and the
client auth gate sees no reason to redirect.

### The dev bypass helper

Single source of truth: `getDevBypassSession()` in
`src/worker/api/session.ts`.

```ts
export type DevBypassResult =
  | { kind: 'abort' }            // flag set on disallowed host
  | { kind: 'session'; data: SessionData }  // inject this session
  | null;                        // flag not set — run normal auth
```

Logic, in order:

1. If `c.env.DEV_BYPASS_AUTH !== 'true'` → return `null` (normal auth runs).
2. **Second trust anchor** — if `SESSION_SECRET` is missing or doesn't start
   with `local-dev-` → log `[DEV_BYPASS]` error, return `{ kind: 'abort' }`.
   Production's real secret never matches, so a leaked flag alone can't
   activate the bypass.
3. Parse the host from `new URL(c.req.url).hostname`.
4. If host is not in the allow-list → log `[DEV_BYPASS]` error, return
   `{ kind: 'abort' }`.
5. Otherwise return `{ kind: 'session', data: { ... } }` with the IT-admin
   identity (email = first entry of `IT_ADMIN_EMAILS`, role = `admin`).

The allow-list (`isDevBypassHost()`) accepts:

- `localhost`, `127.0.0.1`, `[::1]` — direct loopback access
- `c.env.SWA_ADMIN_DOMAIN` (i.e. `admin.singaporewomenassociation.org`) — see
  the host quirk below
- any `*.workers.dev` host

For Turnstile-only checks (not the full session injection), the lighter
`isDevBypassActive(env, url)` helper applies the same three guards and returns
a boolean. It's what the public form handlers and `/api/turnstile-config` use
to skip the human-verification step in dev — see [What it does](#what-it-does).

### Where it plugs in

**`src/worker/middleware.ts`** — after the public-path and volunteer/buyer
exemptions, before the real `getSession()` call:

```ts
const dev = getDevBypassSession(c);
if (dev?.kind === 'abort') {
  return c.json({ ..., error_code: 'DEV_BYPASS_MISCONFIG', ... }, 500);
}
if (dev?.kind === 'session') {
  c.set('sessionEmail', dev.data.email);
  c.set('sessionName', dev.data.name);
  c.set('sessionRole', dev.data.role);
  c.set('sessionRegRole', dev.data.regRole);
  // rate limiter still runs (uses session.email)
  return next();
}
// ... otherwise: normal getSession() path
```

**`src/worker/api/session.ts`** — `handleSession()` checks the same helper
before reading the cookie, so `/api/session` returns `authenticated: true`
with the dev identity. This is what stops the client auth gate from
redirecting.

### The `wrangler dev` host quirk

You'd expect `c.req.url` to report `localhost` when you hit
`http://localhost:8787/`. It doesn't. Because `wrangler.jsonc` declares a
`routes` entry for `admin.singaporewomenassociation.org`, wrangler's local
emulator resolves `c.req.url` against that configured route. The host seen by
the worker is `admin.singaporewomenassociation.org`, not `localhost`.

That's why the allow-list also accepts `SWA_ADMIN_DOMAIN` and `*.workers.dev`.
Without those, the safety guard would fire on every local request.

This is safe because the host check is **not** the trust anchor — the
`DEV_BYPASS_AUTH` flag is. The host check only exists to prevent tunneling
(e.g. via `cloudflared`) when the flag is on. In production the flag is
absent, so the allow-list never gets evaluated.

### Files involved

| File | Role |
|---|---|
| `src/worker/types.ts` | Optional `DEV_BYPASS_AUTH?: string` on `Env` (optional so prod type-check stays valid). |
| `src/worker/api/session.ts` | `DEV_BYPASS_HOSTS`, `isDevBypassHost()`, `getDevBypassSession()` (session injection), and `isDevBypassActive()` (lightweight Turnstile-skip boolean); `handleSession` short-circuits when active. |
| `src/worker/middleware.ts` | Calls `getDevBypassSession()` after public-path checks; injects session and runs rate limiter if active, otherwise falls through to real auth. |
| `src/worker/api/send-otp.ts` | Guards Turnstile siteverify with `isDevBypassActive()`. |
| `src/worker/api/membership-reg.ts` | Guards Turnstile siteverify with `isDevBypassActive()`. |
| `src/worker/api/volunteer-reg.ts` | Guards Turnstile siteverify with `isDevBypassActive()`. |
| `src/worker/index.ts` | `/api/turnstile-config` returns an empty site key when `isDevBypassActive()`. |
| `.dev.vars.example` | Committed template documenting the local vars (no real secrets). |
| `.dev.vars` | Local file (gitignored), copied from the example. |

### Type-check note

`npx tsc --noEmit` reports a handful of errors of the form
`Argument of type '"sessionEmail"' is not assignable to parameter of type 'never'`
on the `c.set(...)` calls. These are **pre-existing** — the project's `Context`
type doesn't declare a `Variables` map, so Hono types `c.set` as `never`. The
new bypass code uses the exact same `c.set` pattern as the existing auth block,
producing errors of the same form. The production build (`npm run build`, which
uses esbuild) is unaffected and passes.

## Troubleshooting

**I'm still redirected to `/login`**
- Confirm `.dev.vars` exists in the project root and contains
  `DEV_BYPASS_AUTH=true`.
- Restart `npm run dev:worker` — wrangler only re-reads `.dev.vars` on start.
- Hit `http://localhost:8787/api/session` directly. If it returns
  `authenticated:false`, the flag isn't loading. If it returns the
  `DEV_BYPASS_MISCONFIG` error, see the next item.

**I see `DEV_BYPASS_MISCONFIG` / 500**
- One of the trust anchors failed. Check the wrangler log for the `[DEV_BYPASS]` line:
  - *"...SESSION_SECRET does not start with 'local-dev-'"* → your `.dev.vars` has a non-matching `SESSION_SECRET`. It must start with `local-dev-` (see `.dev.vars.example`).
  - *"...enabled on non-localhost host"* → the flag and secret are correct but the request host isn't in the allow-list. If you're accessing via a tunnel (e.g. `cloudflared`, ngrok), the tunnel host won't match. Either access via `http://localhost:8787` directly, or extend `isDevBypassHost()` in `src/worker/api/session.ts` to accept your tunnel host. **Never** widen this beyond what you need.

**`/api/members` returns 500 but `/api/session` works**
- Auth bypass is working; the 500 is the D1 binding. The local wrangler D1
  emulator is empty by default. See
  [Local-Dev-Database.md](./Local-Dev-Database.md) to populate it.

**Logout doesn't work — I bounce straight back to the dashboard**
- Expected while the bypass is on. `handleSession()` consults
  `getDevBypassSession()` *before* the real cookie, so it re-synthesises the
  fake IT-admin session on every request regardless of whether the
  `swa_session` cookie was cleared. Clicking "Log out" clears the cookie but
  the next `/api/session` call authenticates you again. The bypass is
  intentionally an "always logged in" shim, so logout can't take effect while
  it's active. To exercise login/logout, disable the bypass (next item).

**Want to test the real auth flow locally**
- Set `DEV_BYPASS_AUTH=false` (or delete the line) in `.dev.vars`, restart
  `npm run dev:worker`, and the OTP login flow takes over. You'll also need a
  valid member row with `can_login=1` in local D1.

## `npm run dev` vs `npm run dev:worker`

This bypass **only affects `npm run dev:worker`** (`wrangler dev`, port 8787).

`npm run dev` (`astro dev`, port 4321) is static-only — the Hono worker does
not run there, so `/api/*` returns 404 and pages redirect to `/login`
regardless of `.dev.vars`. Use `dev:worker` for any work that touches auth or
API data.
