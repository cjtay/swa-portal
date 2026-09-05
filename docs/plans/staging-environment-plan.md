# Staging environment plan

Date: 2026-08-29. Revised 2026-09-05: no seed data — the owner
adds real data directly via the staging Members feature; repo-side
config implemented (steps 2–3 done, below). Status: COMPLETE as of 2026-09-05 (all 8 steps — resources, config,
schema, Turnstile verified, all 4 secrets, bootstrap admin, deploy
`93b8febc`; owner finished steps 5–6 and logged in successfully; real
approver lists swapped in for UAT and redeployed). Remaining: the
step 8 E2E UAT walk with the real testers.

## The decision

We will not use Cloudflare's preview features. We will build a staging
Worker instead, deployed from this same repo via a named environment.

Preview URLs (from `wrangler versions upload` or Workers Builds branch
previews) serve a different code version of the same Worker. They still
connect to the same D1 database, R2 bucket and KV namespaces as
production. Tester data would land in the production database.

A named environment in `wrangler.jsonc` solves this. The command
`wrangler deploy --env staging` deploys the same code as a second Worker
named `swa-portal-staging`, wired to its own D1, KV, R2 and secrets. It
runs at `swa-portal-staging.cjtay-4e0.workers.dev`. Real users test the
full flow there: OTP login emails, file uploads, Workers AI analysis.

This is the same pattern as `gtw2026` and `swa-site`, which are separate
Workers in the SWA Cloudflare account. The only difference: staging does
not need its own repo. One repo, two deploy targets:

- `npm run deploy` → `swa-portal` (production, custom domain later)
- `npm run deploy:staging` → `swa-portal-staging` (testers, own data)

## Verified starting state (2026-08-29)

- The production Worker `swa-portal` was last deployed 3 Aug 2026. All
  August work (approvals, user guide, security fixes) is deployed
  nowhere yet.
- Remote resources exist: D1 `swa-portal`, R2 `swa-portal-uploads`, KV
  `SWA_SESSION` and `SWA_CONFIG`. No real users today.
- Email links use the `SWA_ADMIN_DOMAIN` var, so staging email links
  will point at the staging URL once the var is set.
- The CSP in `public/_headers` is same-origin, so it works on any host
  including workers.dev.
- The dev quick login stays off in staging because staging will not set
  `DEV_BYPASS_AUTH`. Testers use the real OTP flow.
- The rate limiter stores counters in `SWA_SESSION` KV, so staging rate
  limits are separate too.

## Locked choices

- Turnstile: real captcha. Add the staging hostname to the existing
  widget, so testers see the production behaviour.
- Staging database starts with `schema.sql` only (empty tables, no seed
  files). The owner inserts one bootstrap row for the IT admin (step 7),
  then adds all other real members directly in the staging Members UI.
- Deploys are manual via `npm run deploy:staging`. Git auto-deploy from
  a branch (Workers Builds) can be added later.

## Implementation steps

### Step 1 — Create staging resources (one-time) — DONE (2026-09-05)

D1 `swa-portal-staging` (owner-created), KV `SWA_SESSION_STAGING`
(`314f62835d7b41d1978e4de0c881ab55`), KV `SWA_CONFIG_STAGING`
(`82d3e18a71914f72bb336bcbce633bce`) and R2
`swa-portal-staging-uploads` all exist, and the real IDs are filled
into the `env.staging` block of `wrangler.jsonc`. The local-dev
remote-connect prompts were answered `n` (local dev keeps local
emulators), and wrangler's offer to auto-add bindings to the config
was declined — the bindings already exist in `env.staging` under their
code names (`DB`, `SWA_SESSION`, `SWA_CONFIG`, `R2_BUCKET`).

Original commands, kept for reference:

```
npx wrangler d1 create swa-portal-staging
npx wrangler kv namespace create SWA_SESSION_STAGING
npx wrangler kv namespace create SWA_CONFIG_STAGING
npx wrangler r2 bucket create swa-portal-staging-uploads
```

### Step 2 — Edit `wrangler.jsonc` — DONE (2026-09-05)

The `env.staging` block is in `wrangler.jsonc`. Bindings and vars do
not inherit into environments, so the block repeats each one with
staging resource IDs (real IDs, filled after step 1):

- `d1_databases` → `swa-portal-staging`
- `kv_namespaces` → the two staging namespaces
- `r2_buckets` → `swa-portal-staging-uploads`
- `ai` binding and `vars` (`SWA_ADMIN_DOMAIN` = staging URL, same
  Turnstile site key)

`assets`, `limits` and `observability` DO inherit from the top level,
so staging serves `./dist` with `run_worker_first` and keeps the 110 MB
upload ceiling without repeating them (confirmed by the bindings table
in the dry-run output).

The block pins `"routes": []` deliberately. A
`wrangler deploy --env staging --dry-run` on 2026-09-05 proved that
without it the environment inherits the top-level custom domain and a
staging deploy would REASSIGN `admin.singaporewomenassociation.org`
away from production — wrangler warns about exactly this. With the
empty array, staging lives only on
`swa-portal-staging.cjtay-4e0.workers.dev`. Production stays the
top-level default and `npm run deploy` keeps working unchanged (it now
prints a cosmetic advisory to pass `--env` explicitly because multiple
environments exist).

### Step 3 — Edit `package.json` — DONE (2026-09-05)

Added script:

```
"deploy:staging": "astro build && wrangler deploy --env staging"
```

### Step 4 — Load schema into staging D1 — DONE (2026-09-05)

`schema.sql` is the complete structure (every table, including all
migrated columns), so no migration files are needed on a fresh
database. Applied 2026-09-05: 54 queries, 16 tables, verified via a
`sqlite_master` table-list query. Kept for reference:

```
npx wrangler d1 execute swa-portal-staging --remote --file=schema.sql
```

### Step 5 — Turnstile hostname (manual dashboard step) — DONE (2026-09-05)

Turnstile site keys only work on hostnames allowlisted in the
Cloudflare dashboard. Add
`swa-portal-staging.cjtay-4e0.workers.dev` to the existing widget
(site key `0x4AAAAAADNT4-Bm-rzslbrc`). Two gotchas hit on 2026-09-05:
the Edit Widget form only applies once you click Update at the bottom
(unsaved hostname produces client error 110200), and the browser keeps
retrying the failed challenge until a hard refresh. Verified working:
a clean browser load renders the widget and issues a token invisibly
(Managed mode).

### Step 6 — Set secrets on the staging Worker — 3 of 4 DONE (2026-09-05)

Production carries FOUR secrets; staging needs all four. Set 2026-09-05:
`OTP_SECRET` and `SESSION_SECRET` as fresh 64-hex random values
(agent-uploaded, never displayed), and `RESEND_API_KEY` reused from
production (value supplied by the owner in chat; exact-byte piped to
avoid the Resend 502 gotcha). Still pending — `TURNSTILE_SECRET`, the
widget's server-side secret key: without it `send-otp` fails closed
with `500 CONFIG_ERROR` (send-otp.ts:79). Owner sets it interactively:

```
npx wrangler secret put TURNSTILE_SECRET --env staging
```

(The value is the Turnstile widget's Secret Key from the dashboard —
same widget, so the same secret as production.)

Use fresh values for `OTP_SECRET` and `SESSION_SECRET`, so production
and staging never accept each other's sessions. Reuse the existing
`RESEND_API_KEY` so staging sends real OTP emails from the verified
domain.

### Step 7 — Bootstrap the first admin — DONE (2026-09-05)

With no seed data, the staging database starts empty. Login is
impossible on an empty database: `send-otp` only emails addresses with a
`can_login = 1` members row, and the Members UI itself needs a logged-in
admin. One bootstrap row was inserted for the hardcoded IT admin email
(`cjtay@singaporewomenassociation.org`, `src/constants/portal.ts`) with
`can_login = 1` and `category = 'admin'`; verified by count only
(`admin_rows = 1`), per the counts-only privacy rule. After the first
login, every other member (real testers included) is added from the
staging Members UI — no further manual SQL.

### Step 8 — Deploy and verify — DEPLOYED 2026-09-05, E2E WALK PENDING

```
npm run deploy:staging
```

Deployed 2026-09-05: Worker `swa-portal-staging` live at
`https://swa-portal-staging.cjtay-4e0.workers.dev` (version
`b0534182-cd3f-4527-bb73-7516db0c90a4`); `/login` serves HTTP 200.
The E2E walk below is blocked until the owner finishes step 5 (Turnstile
hostname) — until then the login page loads but the captcha fails with
Turnstile error 110200 (hostname not allow-listed). Then walk the full
flow as a tester:

1. Load `https://swa-portal-staging.cjtay-4e0.workers.dev/login`,
   solve the captcha, receive the OTP email, log in.
2. Create an office booking.
3. Create an approval request with file uploads, run Analyse with AI.
4. Submit the public membership form, approve it as admin in staging.
5. Open a board namecard page at `/c/<slug>`.
6. Send an event magic link email and register a guest.

## Costs

All new resources sit within the free tier: one more Worker, one more
D1 database, one more R2 bucket, two more KV namespaces. Email sending
uses the existing Resend account.

## Notes and cautions

- Staging holds only real personal data (no dummy rows). Keep the same
  privacy rule as production: verify with counts only, never read raw
  rows.
- To reset staging data later: `schema.sql` uses
  `CREATE TABLE IF NOT EXISTS`, so re-running it does not clear existing
  rows. A reset means deleting the staging D1 database, recreating it
  (step 1), re-applying `schema.sql` (step 4) and the bootstrap admin
  row (step 7). Only do it between test rounds.
- Workers Builds auto-deploy from a `staging` git branch is a possible
  later addition, not part of this plan.
