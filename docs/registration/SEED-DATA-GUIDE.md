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

Open `scripts/table-config-builder.html` in your browser. It starts with the current table layout pre-filled. Add, edit, or remove tables. The JSON updates live. Click Copy, then paste into Cloudflare KV.

### Step by step

1. Open `scripts/table-config-builder.html` in a browser (just double-click the file)
2. Edit the cutoff time, add/remove/edit tables as needed
3. The generated JSON at the bottom updates automatically
4. Click **Copy** to copy the JSON
5. Go to Cloudflare Dashboard → Workers & Pages → KV → **SWA_SESSION** namespace
6. Find the key `swa:reg_tables_config` and click **Edit**
7. Replace the value with the copied JSON
8. Click **Save**

Changes take effect immediately.

**Important:** Never remove a table ID that has existing bookings or guests. Check first:

```bash
npx wrangler d1 execute swa-portal --remote --command="SELECT DISTINCT table_id FROM reg_bookings;"
```

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