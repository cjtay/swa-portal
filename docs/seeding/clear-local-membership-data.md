# Clearing Local Membership Test Data

> **Scope: LOCAL development only.** This script never touches production.
> It exists so you can reset the membership intake pipeline between local test
> rounds without manually deleting rows in the UI.

## Copy-paste command

```bash
npm run db:clear:membership
```

That's the whole thing. Run it from the project root, with or without the dev
server running. Restart (or refresh) `/admin/forms/membership` afterwards and
the list will be empty.

Equivalent direct invocation (identical behaviour):

```bash
node scripts/db-clear-membership.mjs
```

## What it deletes

The script clears the full membership intake pipeline in FK-safe order. The
`member_id` link on `membership_applications` must be read **before** the
application rows are deleted, so the order is fixed:

| Step | Statement | What it removes |
|---|---|---|
| 1 | `DELETE FROM membership_payments WHERE member_id IN (SELECT member_id FROM membership_applications WHERE member_id IS NOT NULL)` | Payment-log rows belonging to members who were created by approving an application |
| 2 | `DELETE FROM members WHERE id IN (SELECT member_id FROM membership_applications WHERE member_id IS NOT NULL)` | The `members` rows created by approvals (they appear at `/members`) |
| 3 | `DELETE FROM membership_applications` | The application list shown at `/admin/forms/membership` |

It prints row **counts before and after** so you can see the clear worked.

### What it deliberately does NOT touch

- **Manually created members** — anyone you added directly at `/members` (not
  via an application approval) has no `member_id` link and is left alone.
- **Seed data** — `seed-members.sql` rows are unaffected.
- **Other tables** — bookings, volunteer registrations, error log, etc.
- **Local R2 images** — signature / PayNow uploads from test submissions
  become orphans. They are harmless (unreferenced, local-only, no cost). For a
  full local rebuild including a D1 wipe, use `npm run db:setup`.

## Safeguards (how production is protected)

1. **`--local` is hardcoded** in every wrangler command the script runs. There
   is no parameter, flag, or config path that switches it to `--remote`.
2. **Second-line guard**: the script inspects its own arguments and exits
   immediately with an error if `--remote` (or any `--remote-*` flag) is
   passed, before executing anything.
3. **No production credentials involved**: `--local` targets the miniflare
   SQLite file under `.wrangler/state/v3/d1/…` on your machine. Wrangler does
   not authenticate with Cloudflare for local commands, so even a
   misconfigured shell cannot reach the real D1.
4. **Read-only review**: the script is plain SQL `DELETE`s against hardcoded
   table names — no string interpolation of user input, no shell globbing.

## Typical local test loop

```bash
npm run dev:worker                                   # start local portal (localhost:8787)
# ... submit test applications at /reg/membership/register,
# ... approve/reject at /admin/forms/membership,
# ... check results at /members
npm run db:clear:membership                          # reset for the next round
```

If you ever want the entire local database back to a known baseline (schema +
dummy seed), use `npm run db:setup` instead — that wipes everything and
re-seeds.

## Related files

| File | Purpose |
|---|---|
| `scripts/db-clear-membership.mjs` | The script itself |
| `scripts/db-setup.mjs` | Full local DB rebuild (`npm run db:setup` / `db:seed`) |
| `docs/membership-lifecycle-plan.md` | The design this pipeline implements |
