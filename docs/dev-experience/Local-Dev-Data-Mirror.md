# Local Dev Data Mirror

Populate the local wrangler D1 emulator with real production data so
`npm run dev:worker` can serve actual members, bookings, and registrations
— not just empty tables. Implemented 2026-07-04.

## Quick start (one-time sync)

```bash
# 1. Export production D1 to a SQL dump (read-only on prod)
npx wrangler d1 export swa-portal --remote --output=prod-dump.sql

# 2. Wipe the local emulator's state
rm -f .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite \
      .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite-shm \
      .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite-wal

# 3. Import the production dump into local
npx wrangler d1 execute swa-portal --local --file=prod-dump.sql

# 4. Verify
npx wrangler d1 execute swa-portal --local \
  --command="SELECT COUNT(*) as n FROM members;"
```

After this, `npm run dev:worker` serves the same data production serves.

## What it does

Wrangler's local D1 emulator (`miniflare`) stores data in a SQLite file under
`.wrangler/state/v3/d1/`. By default that file has **no schema and no rows** —
every API endpoint that queries D1 returns `500`. This procedure copies a
snapshot of production's schema and data into that local SQLite file.

It is a **one-time snapshot**. Local edits don't sync back to production, and
production changes don't flow into local. Re-run the procedure any time to
refresh.

## How to refresh

To re-sync after production has changed:

```bash
npx wrangler d1 export swa-portal --remote --output=prod-dump.sql
rm -f .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite*
npx wrangler d1 execute swa-portal --local --file=prod-dump.sql
```

Each run overwrites local state entirely (the dump includes
`CREATE TABLE` statements, and you wiped the SQLite file first).

### Backups

The original implementation backed up the existing local SQLite file before
wiping:

```bash
DBDIR=.wrangler/state/v3/d1/miniflare-D1DatabaseObject
cp "$DBDIR"/*.sqlite "$DBDIR"/local-backup-$(date +%Y%m%d-%H%M%S).sqlite
```

Optional, but useful if you've made local test edits you might want back.
Backups are stored alongside the live SQLite file and are gitignored.

## Production safety

| Concern | Mitigation |
|---|---|
| Writing to production by accident | All write commands use `--local`. Only the export step uses `--remote`, and `d1 export` is a read operation (it produces a SQL dump). |
| Production data overwritten | Impossible — the import binds to the local miniflare SQLite file, not the remote database. |
| `prod-dump.sql` committed to git | The file is generated in the repo root. **It contains member emails and PII** — do not commit it. Add `prod-dump.sql` to `.gitignore` if you intend to keep it around. |
| Wrangler credentials | Export uses the same OAuth token as `wrangler whoami` (`cjtay@outlook.sg`). No new credentials are stored. |

## Technical appendix

### Why data was missing

The Hono worker accesses D1 via `c.env.DB`. In `wrangler dev`, this binding
points at a local miniflare SQLite file at
`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`.

That file is created on first request but **starts empty** — no tables, no
rows. Every API endpoint that runs `c.env.DB.prepare(...)` returns a 500
because the queried table doesn't exist.

The local emulator never automatically mirrors production. You must populate
it explicitly, either from `schema.sql` + `seed-members.sql` (the seed-data
approach) or from a production export (this approach).

### The OAuth scope issue with `d1 export`

`wrangler d1 export --remote` requires the `d1:edit` OAuth scope, which is
**not** in the token granted by older `wrangler login` flows. On first run it
fails with:

```
🎢 Membership roles in "SWA": Contact account super admin to change your permissions.
```

even though `wrangler whoami` shows you're logged in.

Fix: re-run `wrangler login` and click "Allow" on the refreshed permission
prompt. This refreshes the token with the full scope set. Use the same
account you normally deploy with (`cjtay@outlook.sg` for this project).

You can confirm read access works before exporting:

```bash
npx wrangler d1 execute swa-portal --remote \
  --command="SELECT COUNT(*) as n FROM members;"
```

If that returns a count, your token is fine for export.

### Tables and counts (2026-07-04 snapshot)

| Table | Rows |
|---|---|
| `members` | 19 |
| `office_bookings` | 4 |
| `volunteer_registrations` | 41 |
| `reg_bookings` | 32 |
| `reg_guests` | 251 |
| `reg_tokens` | 2 |
| `memberships` | 0 |
| `error_log` | 2 |

Total dump size: ~149 KB.

### File locations

| Path | Purpose |
|---|---|
| `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` | Active local D1 database (what `c.env.DB` reads/writes in `wrangler dev`). |
| `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite.backup-*` | Backup of the previous local DB, created before each wipe. |
| `prod-dump.sql` | Generated SQL dump of production. Safe to delete after import; gitignored recommended. |
| `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/metadata.sqlite` | Miniflare internal metadata. Don't touch. |

`.wrangler/` is gitignored — none of this state is committed or deployed.

## Troubleshooting

**`d1 export --remote` fails with "Membership roles" error**
- Your OAuth token is missing scopes. Run `wrangler login` and approve the
  prompt, then retry.

**`d1 execute --local --file=prod-dump.sql` reports "table already exists"**
- You didn't wipe the local SQLite first. Run the `rm` step and retry.

**Counts don't match production after import**
- You may have an older `prod-dump.sql`. Re-run the export step to regenerate
  it, then re-import.

**`npm run dev:worker` still returns 500 on `/api/members` after import**
- Confirm the dev server actually restarted (it caches the SQLite handle).
  Stop it, restart, and hit `/api/health` first to confirm it's up.
- If `/api/session` returns the dev admin identity (auth bypass works) but
  `/api/members` still 500s, the issue is D1 — verify with
  `wrangler d1 execute swa-portal --local --command="SELECT COUNT(*) FROM members;"`.

**Want to start fresh with seed data instead of production data**
- Use `schema.sql` + `seed-members.sql`:
  ```bash
  rm -f .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite*
  npx wrangler d1 execute swa-portal --local --file=schema.sql
  npx wrangler d1 execute swa-portal --local --file=seed-members.sql
  ```
  This gives 19 members but no bookings/registrations.

## See also

- [Local-Dev-Auth-Bypass.md](./Local-Dev-Auth-Bypass.md) — skip OTP login in
  `npm run dev:worker`.
- `docs/registration/SEED-DATA-GUIDE.md` — alternative seed approach using
  `scripts/seed-test-data.sql` (synthetic registration data, not production).
