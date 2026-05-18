# Registration Data Guide

This document explains how to seed registration data, bulk-create magic links, and clear data when needed.

---

## Seeding Bookings + Guests

The `scripts/seed-bookings.js` script reads a JSON file and generates SQL `INSERT` statements for the `reg_bookings` and `reg_guests` tables.

### Step 1: Prepare your data

Create a JSON file (or edit `scripts/seed-data-example.json`) with your booking data:

```json
{
  "bookings": [
    {
      "booking_ref": "REG-ABC12",
      "buyer_name": "Acme Corp",
      "buyer_email": "events@acme.com",
      "buyer_phone": "+65 9123 4567",
      "table_id": "01",
      "pax": 10,
      "notes": "VIP arrangement requested"
    }
  ],
  "guest_overrides": [
    {
      "booking_ref": "REG-ABC12",
      "seat": 2,
      "guest_name": "Alice Tan",
      "notes": "Vegetarian"
    }
  ]
}
```

- **`booking_ref`** must be unique. Use a human-readable code like `REG-ABC12`.
- **`table_id`** must match a table in the KV config (`swa:reg_tables_config`). Currently: `01`, `02`, `VIP-1`, `VIP-2`.
- **`pax`** is the total number of guests for this booking. Seat 1 is auto-set as the buyer with the buyer's name.
- **`guest_overrides`** is optional. Use it to pre-fill specific guest names by seat number.

### Step 2: Generate SQL

```bash
# Preview what will be inserted (no actual writes)
node scripts/seed-bookings.js scripts/seed-data-example.json --dry-run

# Generate SQL to a file
node scripts/seed-bookings.js scripts/seed-data-example.json > scripts/seed-output.sql
```

### Step 3: Apply to D1

```bash
npx wrangler d1 execute swa-portal --remote --file=scripts/seed-output.sql
```

### Idempotency

If you re-run the same seed data, you will get duplicate key errors on `booking_ref` (which has a UNIQUE constraint). To avoid this, either:
- Remove the previously inserted bookings first (see "Clearing Registration Data" below)
- Or change the `booking_ref` values in your JSON

---

## Bulk-Generating Magic Links

The `scripts/seed-magic-links.js` script generates token INSERT statements for bookings that need magic links.

### Step 1: Get bookings that need tokens

```bash
npx wrangler d1 execute swa-portal --remote --json \
  --command="SELECT id, booking_ref, buyer_email, buyer_name FROM reg_bookings WHERE buyer_email IS NOT NULL AND buyer_email != ''" \
  > scripts/bookings-needing-tokens.json
```

Then extract just the `results` array from the JSON output.

### Step 2: Generate tokens

```bash
# Preview
node scripts/seed-magic-links.js --dry-run

# Generate from a bookings file
node scripts/seed-magic-links.js scripts/bookings-needing-tokens.json > scripts/magic-links.sql
```

### Step 3: Apply tokens to D1

```bash
npx wrangler d1 execute swa-portal --remote --file=scripts/magic-links.sql
```

### Step 4: Share the URLs

The script prints the magic link URLs. You can:
- Copy each URL and share via WhatsApp/SMS manually
- Or use the admin UI: go to Booking Detail, click "Send Magic Link" (sends via email) or "Copy Link" (copies to clipboard)

**Note:** This script does NOT send emails. Email sending happens through the admin UI "Send Magic Link" button which uses the Resend API.

---

## Clearing Registration Data

To reset all registration data (bookings, guests, tokens):

```bash
npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_tokens;"
npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_guests;"
npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_bookings;"
```

Run them in this order (tokens first, then guests, then bookings) to respect foreign key constraints.

To clear only tokens (e.g., to invalidate all magic links):

```bash
npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_tokens;"
```

To reset the entire registration module (drop and recreate tables):

```bash
npx wrangler d1 execute swa-portal --remote --command="DROP TABLE IF EXISTS reg_tokens;"
npx wrangler d1 execute swa-portal --remote --command="DROP TABLE IF EXISTS reg_guests;"
npx wrangler d1 execute swa-portal --remote --command="DROP TABLE IF EXISTS reg_bookings;"
npx wrangler d1 execute swa-portal --remote --file=migrations/002_registration.sql
```

### Keeping member data

The above commands only affect `reg_*` tables. Your `members` table (including `reg_role` assignments) is untouched. To also reset `reg_role` on all members:

```bash
npx wrangler d1 execute swa-portal --remote --command="UPDATE members SET reg_role = NULL;"
```

Then re-assign roles as needed (see Phase 1 manual steps in `IMPLEMENTATION-PLAN.md`).

---

## Updating Table Configuration

To change the table layout (add/remove tables, change capacities, VIP flags):

```bash
npx wrangler kv:key put --namespace-id=ddb93996417c4476ac0f90ddf1eb332d --remote \
  "swa:reg_tables_config" \
  '{"formCutoffTime":"2026-06-20T18:00:00+08:00","tables":[{"id":"01","label":"Table 1","ticketPrefix":"01","capacity":10,"isVIP":false},{"id":"02","label":"Table 2","ticketPrefix":"02","capacity":10,"isVIP":false},{"id":"VIP-1","label":"VIP-1","ticketPrefix":"V1","capacity":10,"isVIP":true},{"id":"VIP-2","label":"VIP-2","ticketPrefix":"V2","capacity":10,"isVIP":true}]}'
```

The KV config is read on every request that needs table data. Changes take effect immediately.

To change the form cutoff time, update the `formCutoffTime` value in the same KV key.

---

## Exporting Guest Data

Use the admin UI "Download CSV" button on the Bookings page, or call the API directly:

```bash
curl -H "Cookie: swa_session=YOUR_SESSION_COOKIE" \
  https://admin.singaporewomenassociation.org/api/reg/admin/export \
  -o guest-export.csv
```

The CSV columns are: `ticket_code,guest_name,table_label,is_buyer,is_walk_in,booking_ref,buyer_name,buyer_email,arrived_at,notes`

This format matches the e-tickets-v2 generator input.