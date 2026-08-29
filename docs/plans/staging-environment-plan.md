# Staging environment plan

Date: 2026-08-29. Status: planned, not yet implemented.

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
- Staging database starts with `schema.sql` plus the three dummy seed
  files (`seed-members.sql`, `seed-membership.sql`,
  `scripts/seed-test-data.sql`). All seeded data is fabricated.
- Deploys are manual via `npm run deploy:staging`. Git auto-deploy from
  a branch (Workers Builds) can be added later.

## Implementation steps

### Step 1 — Create staging resources (one-time)

```
npx wrangler d1 create swa-portal-staging
npx wrangler kv namespace create SWA_SESSION_STAGING
npx wrangler kv namespace create SWA_CONFIG_STAGING
npx wrangler r2 bucket create swa-portal-staging-uploads
```

Namespace titles are account-wide names. The binding names inside the
code (`DB`, `SWA_SESSION`, `SWA_CONFIG`, `R2_BUCKET`) stay identical, so
no code changes are needed.

### Step 2 — Edit `wrangler.jsonc`

Add an `env.staging` block. Bindings do not inherit into environments,
so the block repeats every binding explicitly:

```jsonc
"env": {
  "staging": {
    "workers_dev": true,
    "d1_databases": [
      { "binding": "DB", "database_name": "swa-portal-staging",
        "database_id": "<from step 1>" }
    ],
    "kv_namespaces": [
      { "binding": "SWA_SESSION", "id": "<from step 1>" },
      { "binding": "SWA_CONFIG", "id": "<from step 1>" }
    ],
    "r2_buckets": [
      { "binding": "R2_BUCKET", "bucket_name": "swa-portal-staging-uploads" }
    ],
    "ai": { "binding": "AI" },
    "limits": { "max_request_body_size": 115343360 },
    "observability": { "enabled": true },
    "vars": {
      "SWA_ADMIN_DOMAIN": "swa-portal-staging.cjtay-4e0.workers.dev",
      "TURNSTILE_SITE_KEY": "<same key as production>"
    }
  }
}
```

The staging block has no `routes` entry, so a staging deploy can never
claim `admin.singaporewomenassociation.org`. Production stays the
top-level default and `npm run deploy` keeps working unchanged.

### Step 3 — Edit `package.json`

Add one script:

```
"deploy:staging": "astro build && wrangler deploy --env staging"
```

### Step 4 — Load schema and dummy data into staging D1

```
npx wrangler d1 execute swa-portal-staging --remote --file=schema.sql
npx wrangler d1 execute swa-portal-staging --remote --file=seed-members.sql
npx wrangler d1 execute swa-portal-staging --remote --file=seed-membership.sql
npx wrangler d1 execute swa-portal-staging --remote --file=scripts/seed-test-data.sql
```

### Step 5 — Turnstile hostname (manual dashboard step)

Turnstile site keys only work on hostnames allowlisted in the
Cloudflare dashboard. Add
`swa-portal-staging.cjtay-4e0.workers.dev` to the existing widget
(site key `0x4AAAAAADNT4-Bm-rzslbrc`).

### Step 6 — Set secrets on the staging Worker

Secrets are stored per Worker, so all three must be set again:

```
npx wrangler secret put OTP_SECRET --env staging
npx wrangler secret put SESSION_SECRET --env staging
npx wrangler secret put RESEND_API_KEY --env staging
```

Use fresh values for `OTP_SECRET` and `SESSION_SECRET`, so production
and staging never accept each other's sessions. Reuse the existing
`RESEND_API_KEY` so staging sends real OTP emails from the verified
domain.

### Step 7 — First admin login

The dummy seed members use example.org emails, which cannot receive
OTP emails. The IT admin email list is hardcoded
(`src/constants/portal.ts`, `cjtay@singaporewomenassociation.org`). So
the owner inserts one real member row for that email into staging D1,
with `can_login = 1` and `category = 'admin'`. The owner runs this
insert personally because it contains a real email address. Testers are
then onboarded from the staging admin UI.

### Step 8 — Deploy and verify

```
npm run deploy:staging
```

Then walk the full flow as a tester:

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

- Testers will key real personal data into staging. Keep the same
  privacy rule there: verify with counts only, never read raw rows.
- To reset staging data later, re-run step 4 (schema plus seeds). The
  membership application table and approved members are wiped by design
  in that flow, so only do it between test rounds.
- Workers Builds auto-deploy from a `staging` git branch is a possible
  later addition, not part of this plan.
