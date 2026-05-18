# Registration Data Guide

## Seed Test Data

One command to populate D1 with 3 bookings and ~19 guests (including unnamed slots and walk-in-ready structure):

```bash
npx wrangler d1 execute swa-portal --remote --file=scripts/seed-test-data.sql
```

This gives you immediate data to test:
- Bookings list at `/reg/admin/bookings`
- Guest search and arrival marking at `/reg/volunteer/search`
- Walk-in guest creation
- Dashboard stats at `/reg/dashboard`

## Clear Data

Remove all registration data (run in order):

```bash
npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_tokens;"
npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_guests;"
npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_bookings;"
```

Clear only magic link tokens:

```bash
npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_tokens;"
```

Full reset (drop and recreate tables):

```bash
npx wrangler d1 execute swa-portal --remote --command="DROP TABLE IF EXISTS reg_tokens;"
npx wrangler d1 execute swa-portal --remote --command="DROP TABLE IF EXISTS reg_guests;"
npx wrangler d1 execute swa-portal --remote --command="DROP TABLE IF EXISTS reg_bookings;"
npx wrangler d1 execute swa-portal --remote --file=migrations/002_registration.sql
```

Reset `reg_role` on all members:

```bash
npx wrangler d1 execute swa-portal --remote --command="UPDATE members SET reg_role = NULL;"
```

## Update Table Configuration

Change the table layout (capacities, VIP flags, labels):

```bash
npx wrangler kv:key put --namespace-id=ddb93996417c4476ac0f90ddf1eb332d --remote \
  "swa:reg_tables_config" \
  '{"formCutoffTime":"2026-06-20T18:00:00+08:00","tables":[{"id":"01","label":"Table 1","ticketPrefix":"01","capacity":10,"isVIP":false},{"id":"02","label":"Table 2","ticketPrefix":"02","capacity":10,"isVIP":false},{"id":"VIP-1","label":"VIP-1","ticketPrefix":"V1","capacity":10,"isVIP":true},{"id":"VIP-2","label":"VIP-2","ticketPrefix":"V2","capacity":10,"isVIP":true}]}'
```

Changes take effect immediately (KV is read on every request).

## Export Guest Data

Admin UI "Download CSV" button on the Bookings page, or via API:

```bash
curl -H "Cookie: swa_session=YOUR_SESSION_COOKIE" \
  https://admin.singaporewomenassociation.org/api/reg/admin/export \
  -o guest-export.csv
```

CSV columns: `ticket_code,guest_name,table_label,is_buyer,is_walk_in,booking_ref,buyer_name,buyer_email,arrived_at,notes`

---

## Reference

### Table Schema

Key columns in `reg_bookings`:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `booking_ref` | TEXT | Unique human-readable code (e.g. `REG-ABC12`) |
| `buyer_name` | TEXT | Name of the person who booked |
| `buyer_email` | TEXT | Email for magic links |
| `table_id` | TEXT | Must match a table in KV config |
| `pax` | INTEGER | Total guests for this booking |
| `created_by` | TEXT | Email of the admin who created it |

Key columns in `reg_guests`:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `booking_id` | UUID | FK to reg_bookings |
| `table_id` | TEXT | Table assignment |
| `seat_counter` | INTEGER | Seat position within table |
| `ticket_code` | TEXT | Format: `{prefix}-{counter}` e.g. `01-07`, `V1-03` |
| `guest_name` | TEXT NULL | NULL until filled in |
| `is_buyer` | INTEGER | 1 for the booking buyer |
| `is_walk_in` | INTEGER | 1 if guest was added on-site |
| `arrived_at` | TEXT NULL | Set when volunteer marks arrival |

Key columns in `reg_tokens`:

| Column | Type | Notes |
|---|---|---|
| `token` | TEXT | Hex string for magic link URL |
| `booking_id` | UUID | FK to reg_bookings |
| `created_at` | TEXT | Token creation timestamp |
| `expires_at` | TEXT | Token expiry (matches formCutoffTime from KV) |

### Ticket Code Format

`{ticketPrefix}-{seat_counter padded to 2 digits}`

Examples:
- Table 01, seat 7 → `01-07`
- VIP-1, seat 3 → `V1-03`

The `ticketPrefix` comes from the KV table config, not from the `table_id`.

### Magic Links

Magic links are independent of seeding. Use the admin UI:
- **Send Magic Link** button on Booking Detail page sends an email via Resend
- **Copy Link** button copies the URL to clipboard for manual sharing

You can also generate tokens via SQL if needed (see `reg_tokens` schema above).

### Member reg_role Values

| Email | reg_role |
|---|---|
| cjtay@singaporewomenassociation.org | reg_admin |
| angela.wong@singaporewomenassociation.org | reg_admin |
| joyce.yeo@singaporewomenassociation.org | reg_admin |
| cjtay@outlook.sg | reg_volunteer |