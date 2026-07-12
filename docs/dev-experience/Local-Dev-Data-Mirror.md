# Local Dev Database & Test Data

How the local test database works, how to fill it with **dummy data only**
(never production data), and how to test forms end-to-end on your laptop
before deploying. Written for clarity — no Cloudflare expertise required.

> **The golden rule:** the local database contains **only fabricated dummy
> data**. We do **not** copy production data into it, so no real members'
> personal information (emails, phone numbers, NRICs) ever sits on a developer
> laptop or is exposed to tooling. The previous "production mirror" workflow
> has been retired for this reason (see [Why not copy from production](#why-not-copy-from-production)).

---

## Quick start

```bash
npm run db:setup      # wipes + rebuilds the local database with dummy data
npm run dev:worker    # starts the site at http://localhost:8787
```

That's it. Open `http://localhost:8787/`, fill in a form, submit it, and watch
the record appear in the relevant admin list — all on your laptop, all dummy
data, production untouched.

You only need to run `npm run db:setup` once (or again whenever you want a
fresh slate). The data persists between `dev:worker` restarts.

---

## What `db:setup` puts in the database

It rebuilds the local database from scratch, in this order:

1. **`schema.sql`** — the *structure* (every table and column). No data.
   This is the single source of truth for the database shape (see
   [Schema source of truth](#schema-source-of-truth)).
2. **`seed-members.sql`** — 14 fake members (12 committee + 2 admin), all
   using the mobile number `9323 1688`. Four of them use the project owner's
   real test emails so login flows can be exercised; the rest use clearly-fake
   `example.com` addresses (the `members.email` column is `UNIQUE`, so each
   email can only appear once).
3. **`seed-membership.sql`** — 4 fake membership applications with a mix of
   statuses (2 pending, 1 approved, 1 rejected) so the admin list shows
   variety without you having to submit by hand.
4. **`scripts/seed-test-data.sql`** — fake registration data (32 bookings,
   250 guests) so the registration admin screens have something to display.

Everything is fabricated. No real personal data is involved.

---

## How to test a form locally (membership example)

This is the full loop — the reason all of this exists:

1. Run `npm run db:setup` (once) so the database has the right tables.
2. Run `npm run dev:worker`.
3. Open `http://localhost:8787/reg/membership/register`.
4. Fill in the form with any dummy values and submit.

What makes this work locally:

- **The dev auth bypass** (`DEV_BYPASS_AUTH=true` in `.dev.vars`) logs you in
  automatically as a fake admin — no OTP needed. See
  [Local-Dev-Auth-Bypass.md](./Local-Dev-Auth-Bypass.md).
- **Turnstile is skipped in dev.** The "prove you're human" check can't load
  on `localhost`, so the server (and, after the `'bypassed'` state fix, the
  forms) allow submission without a token. Production is unaffected — the
  bypass only activates when `DEV_BYPASS_AUTH=true`.
- **The submission writes to the local database**, which now has the
  `membership_applications` table.

5. To see the saved record, open the admin applications list
   (`/admin/forms/membership`) — your submission (plus the 4 seeded fakes)
   appears there.

The volunteer registration form (`/reg/volunteer/register`) works the same
way.

---

## Command reference

| Command | What it does |
|---|---|
| `npm run db:setup` | Wipe local database + apply `schema.sql` + apply all dummy seed files. Use this for a clean restart. |
| `npm run db:seed` | Re-apply the dummy seed files **without** wiping or re-applying the schema. Useful after you've edited a seed file. |
| `npm run dev:worker` | Build the static pages and start the local site + API at `:8787`. |

Both `db:*` commands are **local-only** — they never touch production (every
underlying `wrangler` call uses `--local`). The helper script is
`scripts/db-setup.mjs`.

### Manual one-off queries

To inspect or change the local database directly:

```bash
# Count rows in a table
npx wrangler d1 execute swa-portal --local \
  --command="SELECT COUNT(*) AS n FROM membership_applications;"

# Run a SQL file
npx wrangler d1 execute swa-portal --local --file=some-file.sql
```

The `--local` flag is what keeps you safe. **Never** run these with
`--remote` against production for testing.

---

## How the local database actually works

Your laptop runs a mini version of the database inside a single file:

```
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
```

It's a real SQLite file. `npm run dev:worker` reads and writes this file.
Key points:

- **It starts empty.** A fresh clone has no tables — which is why every query
  would `500` until you run `db:setup`.
- **`db:setup` deletes the file and rebuilds it** from `schema.sql` + seeds.
- **It persists** between `dev:worker` restarts (so your test data sticks
  around).
- **It's gitignored** (the whole `.wrangler/` folder is). It never gets
  committed or deployed.

---

## Schema source of truth

`schema.sql` is the **single, complete** definition of the database structure.
It creates every table (members, office bookings, memberships, membership
applications, volunteer registrations, the registration tables, and the error
log) with all current columns.

The `migrations/` folder exists for **upgrading existing databases** (like
production) that were created before later features. On a **fresh** local
database you do **not** need the migrations — `schema.sql` already contains
their changes (registration tables and soft-delete columns were backported so
the baseline is complete).

### When you add a new table or column

1. **Add it to `schema.sql`** (so fresh local databases and any future fresh
   installs get it). For a new table, add a `CREATE TABLE IF NOT EXISTS ...`
   block. For a new column on an existing table, either add it inline to the
   `CREATE TABLE` statement or append an `ALTER TABLE ... ADD COLUMN ...` near
   the other `ALTER`s at the bottom.
2. **Add a migration file** in `migrations/` (`005_<name>.sql`) so
   **production** (which already exists and can't be recreated from scratch)
   gets the change too. Apply it to production with
   `npx wrangler d1 migrations apply swa-portal --remote`.
3. **Re-run `npm run db:setup`** locally to pick up the change.

Keeping `schema.sql` and the migrations in sync is what prevents the "stale
local database" problem (where local is missing a table production has).

---

## Adding your own test data

If you want extra rows to test something specific, the simplest way is to
**submit through the form** — that exercises the real code path and produces
realistic data. To add many rows at once, append `INSERT` statements to the
relevant seed file and run `npm run db:seed`:

| To populate… | Edit… |
|---|---|
| Members | `seed-members.sql` |
| Membership applications | `seed-membership.sql` |
| Registration bookings/guests | `scripts/seed-test-data.sql` |

Keep all seed data obviously fake (no real names, emails, or NRICs).

---

## Why not copy from production

An earlier version of this guide described exporting production data into the
local database. That approach has been **retired** because:

- **PII exposure.** A production export contains real member emails, phone
  numbers, addresses, and NRICs. Copying it onto a laptop (and potentially
  into backups, screenshots, or AI tooling) is an unnecessary privacy risk.
- **Staleness.** A copied snapshot goes out of date the moment a new table or
  column is added (which is exactly how the `membership_applications` table
  went missing locally — the snapshot predated it).
- **No real benefit.** Dummy data is enough to test every screen and every
  form flow.

The retired export file (`prod-dump.sql`) has been deleted. **Do not**
regenerate it. If you ever genuinely need production data for debugging, do it
out-of-band on a secure machine, never committed to the repo and never in the
local dev database.

---

## Future: a private staging website (not yet implemented)

`db:setup` lets you test most things on your laptop. But some flows only
reveal themselves on a real deployed site (the genuine Turnstile check, real
email delivery via Resend, custom-domain behaviour). The professional answer
to "I keep deploying to production to test" is a **second, private copy of the
whole site just for testing** — a *staging environment*. This section is a
placeholder for when that's worth setting up; **it is not implemented yet**.

### What staging would give you

- A separate URL (e.g. `swa-portal-staging.<your-subdomain>.workers.dev`)
  running the same code, but with **its own** database, KV, and file storage —
  fully isolated from production.
- You deploy there first, test the real end-to-end flow (real human-check, real
  emails), and only promote to production once it passes.
- Production never receives test data, and is never at risk from an untested
  change.

### Roughly what it would take (for later)

Cloudflare Workers supports named **environments** in `wrangler.jsonc`. A
staging environment would be an `[env.staging]` block with its **own bindings**
(bindings are **not** inherited — `d1_databases`, `kv_namespaces`, and
`r2_buckets` must each be redeclared with staging IDs):

```jsonc
"env": {
  "staging": {
    "d1_databases":     [{ "binding": "DB", "database_name": "swa-portal-staging", "database_id": "<staging-uuid>" }],
    "kv_namespaces":    [{ "binding": "SWA_SESSION", "id": "<staging-kv-id>" }, { "binding": "SWA_CONFIG", "id": "<staging-kv-id>" }],
    "r2_buckets":       [{ "binding": "R2_BUCKET", "bucket_name": "swa-portal-staging-uploads" }]
  }
}
```

Steps (each a one-time setup):

1. `npx wrangler d1 create swa-portal-staging` → note the `database_id`.
2. Create staging KV namespaces and R2 bucket; note their IDs.
3. Add the `[env.staging]` block above to `wrangler.jsonc`.
4. Apply schema + dummy seed to staging:
   `npx wrangler d1 execute swa-portal-staging --remote --file=schema.sql` (and
   the seed files).
5. Set staging secrets:
   `npx wrangler secret put OTP_SECRET --env staging` (repeat for
   `SESSION_SECRET`, `RESEND_API_KEY`).
6. Add the staging hostname to the Turnstile dashboard allow-list so the real
   human-check works there.
7. Deploy: `npx wrangler deploy --env staging`. Test. Then
   `npm run deploy` (production) when happy.

Add an npm script (`deploy:staging`) to make step 7 a one-liner. This is the
durable fix for the "deploy to prod to test" habit; the local dummy-data setup
above handles everything else.

---

## Troubleshooting

**`npm run dev:worker` returns `500` on API calls (e.g. `/api/members`)**
- The local database is empty or missing tables. Run `npm run db:setup`.

**Submitting a form shows "The security check is unavailable"**
- The dev bypass isn't active. Confirm `.dev.vars` contains
  `DEV_BYPASS_AUTH=true` and `SESSION_SECRET` starts with `local-dev-`, then
  restart `npm run dev:worker` (wrangler only re-reads `.dev.vars` on start).

**`db:setup` fails with "no such table"**
- `schema.sql` is missing a table a seed file needs. Make sure any new table
  is added to `schema.sql`, not just to a migration (see
  [Schema source of truth](#schema-source-of-truth)).

**Counts look wrong after editing a seed file**
- Run `npm run db:seed` to re-apply the seed files, or `npm run db:setup` for
  a full clean rebuild.

**`npm run dev` (port 4321) doesn't work for forms**
- `npm run dev` is Astro-only (static pages, no API). The Hono worker — which
  serves `/api/*` and writes to the database — only runs under
  `npm run dev:worker`. Always use `dev:worker` for form/API/database work.

---

## See also

- [Local-Dev-Auth-Bypass.md](./Local-Dev-Auth-Bypass.md) — skip OTP login in
  `npm run dev:worker`.
- `docs/registration/SEED-DATA-GUIDE.md` — notes on the registration seed file.
