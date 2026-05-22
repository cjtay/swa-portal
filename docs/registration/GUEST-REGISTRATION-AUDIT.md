# Guest Registration — Code Audit

> **Date**: 2026-05-22
> **Audit scope**: All code related to the guest registration feature (bookings, guests, magic links, buyer form, volunteer check-in, dashboard)
> **Files audited**: `src/worker/api/reg/*.ts`, `src/worker/lib/reg/*.ts`, `src/worker/middleware.ts`, `src/pages/reg/**/*.astro`, `migrations/002_registration.sql`

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| High | 2 | Data corruption / integrity guaranteed on failure |
| Medium | 6 | Functional bugs under specific conditions, or security exposure |
| Low | 8 | Edge cases, dev workflow, or cosmetic issues |
| Feature Gap | 1 | Desirable but currently unsupported |

---

## High Severity

### H1 — No transaction wrapping: partial booking on failure

| | |
|---|---|
| **Files** | `src/worker/api/reg/admin-bookings.ts` (lines 91–110), `src/worker/api/reg/admin-guests.ts` (lines 45–57) |
| **What happens** | **Booking creation:** The booking row is inserted first, then each guest slot is inserted in a loop — all as separate, independent database operations, not inside a transaction. **Add guest to existing booking:** In `admin-guests.ts`, the guest INSERT and the `pax = pax + 1` UPDATE run as two separate operations. |
| **Why it's a problem** | **Booking creation:** If the booking row inserts successfully but guest #3 of 5 fails (e.g., network hiccup, D1 capacity issue, UNIQUE constraint collision after retries), the database is left permanently broken: a booking with `pax = 5` but only 2 actual guest rows. **Add guest:** If the guest is inserted successfully but the `UPDATE reg_bookings SET pax = pax + 1` statement fails (network blip mid-flight), the booking's `pax` counter no longer matches the actual guest count. Both scenarios produce wrong dashboard numbers and mismatched exports, with no automatic recovery. |
| **How to reproduce** | Create a booking with a large `pax` value under load (or mock a DB error mid-loop). |
| **How to fix** | Wrap the booking INSERT and all guest INSERTs inside a D1 transaction. D1 supports `db.batch()` for atomic write operations. Restructure the booking creation flow to prepare all statements first, then `await db.batch([...])`. Since `allocateGuestSlot` does a SELECT (MAX seat_counter) before INSERT, you cannot use `batch()` directly — instead, pre-compute seat counters at the handler level, or use `db.exec('BEGIN TRANSACTION')` / `db.exec('COMMIT')` around the loop. |
| **Related files** | `src/worker/lib/reg/tickets.ts:19-85` |

**Example of the problem in pseudo-code:**

```
// Current flow (no transaction)
INSERT INTO reg_bookings ...     ← succeeds
INSERT INTO reg_guests (guest 1) ← succeeds
INSERT INTO reg_guests (guest 2) ← succeeds
INSERT INTO reg_guests (guest 3) ← FAILS! (e.g. D1 error)
// State: booking says 5 pax, but only 2 guests exist
```

**What it should look like:**

```
// Desired flow (with transaction)
BEGIN TRANSACTION
  INSERT INTO reg_bookings ...
  INSERT INTO reg_guests (guest 1)
  INSERT INTO reg_guests (guest 2)
  INSERT INTO reg_guests (guest 3)
  ...
COMMIT  ← either ALL succeed, or ALL rollback (nothing saved)
```

---

### H2 — No table capacity enforcement: tables can be overbooked indefinitely

| | |
|---|---|
| **Files** | `src/worker/lib/reg/tickets.ts` (lines 19–85), `src/worker/api/reg/admin-bookings.ts` (lines 71–79), `src/worker/api/reg/admin-guests.ts` (lines 39–53), `src/worker/api/reg/volunteer-search.ts` (lines 120–135) |
| **What happens** | The `allocateGuestSlot` function receives the `tableConfig` object (which includes a `.capacity` field) as a parameter — but **never reads or checks it**. The only protection against overfilling a table is the `ticket_code` UNIQUE constraint in the database, which prevents duplicate ticket codes but does **not** prevent exceeding the table's capacity. |
| **Why it's a problem** | An admin could create a booking with `pax = 20` for a table with `capacity = 10`. All 20 guest slots would be created successfully because `MAX(seat_counter) + 1` keeps producing new seat numbers (11, 12, 13...). The `ticket_code` is computed from the seat counter, so each gets a unique code. The physical venue would have 20 guests at a 10-seat table. Similarly, volunteers can add unlimited walk-ins to an already-full table. |
| **How to reproduce** | 1. Configure a table with `capacity: 10` in KV (`swa:reg_tables_config`). 2. Create a booking with `pax: 20` — all 20 guests are inserted successfully. 3. Check the guest list — the table now has 20 guests. |
| **How to fix** | Inside `allocateGuestSlot`, before allocating, run a COUNT query: `SELECT COUNT(*) FROM reg_guests WHERE table_id = ?`. If `current_count >= tableConfig.capacity`, throw an error (or return a meaningful rejection). The handler should catch this and return a `400` response like `"Table is full (capacity N)"`. Apply the same check in `handleAdminBookings` POST, `handleAdminGuests` POST, and `handleVolunteerWalkin` before calling `allocateGuestSlot`. |
| **Related files** | `src/worker/lib/reg/tables.ts:1-7` (TableConfig interface, capacity field at line 5) |

---

## Medium Severity

### M1 — Deleting the buyer guest leaves the booking with no buyer-linked guest

| | |
|---|---|
| **File** | `src/worker/api/reg/admin-bookings.ts` (lines 97–99), `src/worker/api/reg/admin-guests.ts` (lines 47–53, 123–137) |
| **What happens** | When a booking is created, the very first guest (index 0) is tagged as `is_buyer: true` and gets `guest_name` set to the buyer's name. If an admin later deletes this guest via `DELETE /api/reg/admin/guests/:id`, no guest in the booking is flagged as the buyer anymore. The booking's `buyer_name` column still has the name, but it's orphaned — no guest row carries the `is_buyer = 1` flag. |
| **Why it's a problem** | The `is_buyer` flag is used throughout the code to identify the buyer's seat (e.g., in the buyer form it shows "(Buyer)" label, in exports the flag is a column, and search results highlight it). After deleting the buyer guest, any place that relies on `is_buyer = 1` to identify the buyer would fail to find them. Additionally, the `POST /api/reg/admin/guests` endpoint hardcodes `isBuyer: false` (line 50), so there is **no way** to re-create the buyer slot through the current API. |
| **How to reproduce** | 1. Create a booking with `pax = 3`. 2. Note the guest with `is_buyer = 1`. 3. Delete that guest via the admin API. 4. List the booking's guests — none has `is_buyer = 1`. |
| **How to fix** | Option A: The cleanest fix is to **stop deleting the buyer guest** — add a check in `handleAdminGuestById` DELETE that blocks deletion if `is_buyer = 1`, returning `400` with `"Cannot delete the buyer seat. Delete the booking instead."`. Option B: Allow re-assignment — on delete of the buyer guest, find the next guest in the booking and update `is_buyer = 1` and `guest_name = buyerName`. |

---

### M2 — Race condition when marking a guest as arrived (TOCTOU)

| | |
|---|---|
| **Files** | `src/worker/api/reg/volunteer-search.ts` (lines 58–82), `src/worker/lib/reg/guests.ts` (lines 74–80) |
| **What happens** | When two volunteers try to check in the same guest at the same time, both see the guest as not-yet-arrived (line 68: `if (g.arrived_at)` returns `null`), so both proceed to `markArrived` (line 82). The `markArrived` function's SQL includes `WHERE arrived_at IS NULL` as a guard — only one UPDATE actually modifies the row. **But the code does not check whether the UPDATE actually changed anything.** Both volunteers receive a `"success: true"` response, and the second volunteer gets a freshly-generated `new Date().toISOString()` timestamp instead of the actual arrival time from the database. |
| **Why it's a problem** | The second volunteer sees a "success" message and a timestamp that does **not** match the database. If they rely on that timestamp for attendance tracking (e.g., "Guest arrived at 7:32 PM" when the DB says 7:31 PM), it's a data inconsistency. The check-in UI also doesn't show the "Already checked in" warning — the volunteer thinks they just checked in the guest. |
| **How to reproduce** | In a concurrent test (or manual: open two check-in pages, search the same guest, click "Arrive" on both at the same time). The second click will return `success: true` with a new timestamp. |
| **How to fix** | Check `meta.changes` on the D1 result returned by `markArrived`. If `changes === 0`, the guest was already marked — return the same response as the `if (g.arrived_at)` guard (i.e., `"Already checked in at ..."` with the original timestamp). The `markArrived` function currently returns `void`; change it to return `boolean` (whether a row was affected). |

---

### M3 — Buyer can edit a guest's name after the guest has been checked in

| | |
|---|---|
| **Files** | `src/worker/api/reg/buyer-form.ts` (lines 85–97), `src/worker/api/reg/volunteer-search.ts` (lines 175–176) |
| **What happens** | The volunteer check-in handler (`handleVolunteerUpdateGuest`) blocks editing a guest name if the guest has already arrived: `if (g.arrived_at) return error "Cannot edit name after guest has arrived."`. The buyer form handler (`handleBuyerUpdateGuest`) has **no such check** — it only validates the token belongs to the booking and that the guest belongs to that booking. |
| **Why it's a problem** | During the event, a volunteer checks in a guest at 7:00 PM. At 7:05 PM, the buyer (using their magic link) edits that guest's name from "Sarah Lim" to "Amy Tan". The check-in record now shows a different name than the volunteer originally checked in. This could cause confusion if printed name tags or table place-cards were already generated, or if attendance is being actively tracked. |
| **How to reproduce** | 1. Volunteer checks in a guest via check-in page. 2. Buyer opens their magic link and edits that guest's name. 3. The PATCH succeeds (200) and the name is changed. |
| **How to fix** | Add the same `arrived_at` guard to `handleBuyerUpdateGuest` (buyer-form.ts), after the guest lookup at line 93 but before the update at line 113: `if ((guest as Record<string, unknown>).arrived_at) return c.json({ success: false, message: 'This guest has already arrived and can no longer be edited.' }, 400);` |

---

### M4 — Guests can be assigned to a different table than their booking

| | |
|---|---|
| **File** | `src/worker/api/reg/admin-guests.ts` (lines 37, 45–53) |
| **What happens** | When an admin adds a guest via `POST /api/reg/admin/guests`, the request body can optionally include a `table_id`. If provided, the guest is inserted at that table, but the `booking_id` still references the original booking. The `reg_bookings.pax` counter is incremented on the original booking. |
| **Why it's a problem** | You end up with: Booking A (at Table 1, pax=6) has 5 guests at Table 1 + 1 guest at Table 3. The admin guest list groups guests by their own `table_id`, so this guest appears under Table 3. The booking detail page shows the guest under Booking A. The export CSV shows the guest at Table 3 but linked to Booking A (which is at Table 1). This split location creates confusion in seating plans, printed table lists, and check-in workflows. |
| **How to reproduce** | 1. Create booking A at table "t1". 2. Add a guest: `POST /api/reg/admin/guests` with `{ booking_id: "A", table_id: "t3", guest_name: "Test" }`. 3. The guest is at table "t3" but linked to booking A. |
| **How to fix** | Remove the `table_id` override capability. In `handleAdminGuests` POST, always use the booking's own `table_id`: `const effectiveTableId = (booking as Record<string, unknown>).table_id as string;`. If the admin needs to add guests to a different table, they should create a separate booking for that table. |

---

### M5 — CSV export vulnerable to formula injection (spreadsheet cells can execute code)

| | |
|---|---|
| **File** | `src/worker/api/reg/admin-export.ts` (lines 54–59) |
| **What happens** | The `csvEscape()` function wraps a value in double-quotes only if it contains commas, double-quote characters, or newlines. It does **not** check for characters that trigger formulas in spreadsheet software: `=` (formulas), `+` (formulas), `-` (formulas), or `@` (formulas in newer Excel). A value like `=cmd|'/C calc'!A0` passes through unescaped. |
| **Why it's a problem** | Anyone who can submit a guest name can inject a formula into the CSV. When an admin opens the exported CSV in Excel or Google Sheets, a cell beginning with `=` is executed as a formula rather than displayed as text. A malicious buyer could insert `=cmd|'/C calc'!A0` as a guest name; when the admin opens the export, Excel would attempt to execute the command. This is a well-known attack class (OWASP CSV Injection / CWE-1236). |
| **How to reproduce** | 1. As a buyer, update a guest name to `=2+2`. 2. As an admin, download the CSV export at `/api/reg/admin/export`. 3. Open the file in Excel — the cell displays `4` instead of `=2+2`, confirming formula execution. |
| **How to fix** | Prefix any value that starts with `=`, `+`, `-`, or `@` with a single quote (`'`), which tells spreadsheet software to treat the cell as plain text. Updated function: `if (/^[=+\-@]/.test(value)) return '"' + "'" + value.replace(/"/g, '""') + '"';` before the existing comma/newline check. The single quote is not displayed in the cell but prevents formula interpretation. |

---

### M6 — Admin is told "email sent" even when email delivery fails

| | |
|---|---|
| **Files** | `src/worker/api/reg/admin-magic-link.ts` (lines 40–58), `src/worker/lib/reg/email.ts` (lines 96–122) |
| **What happens** | When an admin clicks "Send Magic Link", the handler tells the admin `success: true, message: "Magic link sent to buyer@example.com"` immediately — **before** the email has actually been sent. The actual email send runs via `c.executionCtx.waitUntil()`, which defers the work until after the HTTP response is returned. Inside `sendMagicLink`, if the Resend API returns an error (e.g., 400 bad request, 500 server error), the function only logs to the console — it does **not** throw an error. The `.catch()` in the handler also only logs. |
| **Why it's a problem** | Three failure scenarios exist where the admin sees "success" but the buyer never receives the email: (1) Resend API is down, (2) `RESEND_API_KEY` secret is invalid or missing, (3) the email address bounces or is rejected by Resend. The admin has no way to know this happened — they trust the "sent" confirmation and move on. Meanwhile, the booking exists with a valid magic link token, but the buyer never gets the URL to use it. |
| **How to reproduce** | Remove or invalidate the `RESEND_API_KEY` secret. Send a magic link — the API returns `success: true` with no indication of failure. Check the Worker logs for the `[REG EMAIL] Resend API error` or `[REG MAGIC LINK] Failed to send` console messages. |
| **How to fix** | Two complementary changes: **(a)** In `sendMagicLink`, re-throw the error after logging: `throw new Error(...)`. **(b)** In `handleSendMagicLink`, `await` the email send (instead of `waitUntil`) and catch failures to return an honest response: `try { await sendMagicLink(...); return c.json({ success: true, ... }); } catch { return c.json({ success: false, message: 'Email failed to send. Check logs or try again.' }, 502); }`. This does mean the API call takes ~1 second longer (waiting for Resend), but the admin gets accurate feedback. |

---

## Low Severity

### L1 — Magic link URL falls back to production in development

| | |
|---|---|
| **File** | `src/worker/api/reg/admin-magic-link.ts` (lines 35–38) |
| **What happens** | When `SWA_ADMIN_DOMAIN` environment variable is not set (common in local dev), the magic link URL falls back to `https://admin.singaporewomenassociation.org`. |
| **Why it's a problem** | During development, clicking a magic link generated from `localhost:8787` would navigate to the production site instead of the local dev server. This makes end-to-end testing of the buyer workflow impossible locally without manually configuring the env var. |
| **How to fix** | Use `c.req.url` or an env var for the base URL. For local dev, read the `Host` header from the incoming request: `const baseUrl = new URL(c.req.url).origin;`. Fall back to production only if that somehow fails. |

---

### L2 — Dashboard arrival stats undercount unnamed guests

| | |
|---|---|
| **Files** | `src/worker/lib/reg/guests.ts` (lines 101–117), `src/worker/api/reg/reg-dashboard.ts` (lines 36–37) |
| **What happens** | The `getArrivalStats` function counts "expected" guests as: `WHERE guest_name IS NOT NULL AND is_walk_in = 0`. This means pre-booked seats whose names haven't been filled in yet by the buyer are NOT counted as "expected." |
| **Why it's a problem** | Scenario: A booking has 10 pre-booked seats. The buyer hasn't filled in any names yet (all 10 have `guest_name = NULL`). The dashboard would show `totalExpected = 0`, `totalArrived = 0`, `arrivalPct = 0%`. An event organiser looking at the dashboard sees 0% and thinks no one is coming, when in reality 10 people are expected. The `arrivalPct` metric becomes misleading until names are filled in. |
| **How to fix** | Change the expected count to include all non-walk-in guests, regardless of name status: `SELECT COUNT(*) AS total FROM reg_guests WHERE is_walk_in = 0`. This counts every pre-booked seat as "expected." Alternatively, sum the `pax` column from `reg_bookings` for total expected. |

---

### L3 — Buyer endpoints have no rate limiting

| | |
|---|---|
| **File** | `src/worker/middleware.ts` (lines 64–66) |
| **What happens** | The buyer API routes (`/api/reg/buyer/*`) completely bypass the auth middleware. This includes bypassing the rate limiting that protects all other authenticated endpoints (lines 110–119). |
| **Why it's a problem** | If a valid magic link token leaks (e.g., email forwarded, URL shared), the holder could spam the PATCH endpoint thousands of times per second with no throttling. This could degrade D1 performance or incur costs. However, the token is 128-bit random (infeasible to brute-force), so the blast radius is limited to whoever legitimately has the link. |
| **How to fix** | Add a lightweight rate-limiting guard specifically for buyer routes. Since there's no session, rate-limit by token hash or IP address using KV. Example: `GET /api/reg/buyer/:token` — check KV for `swa:buyer_rl:<token_hash>` with a window of 60 requests per minute. |

---

### L4 — Expired magic link tokens accumulate indefinitely

| | |
|---|---|
| **File** | `src/worker/lib/reg/tokens.ts` (lines 26–44), `migrations/002_registration.sql` (lines 51–59) |
| **What happens** | Magic link tokens are created for each booking and stored in the `reg_tokens` table with an `expires_at` timestamp. The `validateToken` function checks `expires_at < new Date()` and returns `null` for expired tokens — so expired tokens are functionally dead. But the rows are **never physically deleted** from the database. |
| **Why it's a problem** | For a one-time event with a few hundred bookings, this is negligible. For recurring events over years, the table will accumulate stale rows. It's a maintenance/debt concern, not an immediate bug. |
| **How to fix** | Add a cron job (Cloudflare Workers Cron Triggers) that runs once daily: `DELETE FROM reg_tokens WHERE expires_at < datetime('now')`. Or periodically clean up stale tokens when a new magic link is sent. |

---

### L5 — `Math.random()` used for booking reference generation

| | |
|---|---|
| **File** | `src/worker/api/reg/admin-bookings.ts` (lines 11–17) |
| **What happens** | `generateBookingRef` uses `Math.random()` to pick characters for the booking reference code (e.g., `REG-A3K9F`). |
| **Why it's a problem** | `Math.random()` is not cryptographically secure — its output is more predictable and has less entropy than `crypto.getRandomValues()`. For a booking reference (not a security token), this is not a security vulnerability by itself. However, `crypto.getRandomValues()` is available in the Workers runtime and would produce more uniformly random results with lower collision probability. |
| **How to fix** | Replace with `crypto.getRandomValues()`: generate a random byte array, map each byte to the character set, and build the reference string. Example: `const bytes = crypto.getRandomValues(new Uint8Array(5)); ref = 'REG-' + Array.from(bytes, b => chars[b % chars.length]).join('');` |

---

### L6 — No length limits on name and notes fields — unbounded text storage

| | |
|---|---|
| **Files** | `src/worker/api/reg/admin-bookings.ts` (line 64), `src/worker/api/reg/admin-guests.ts` (lines 21, 100, 105), `src/worker/api/reg/buyer-form.ts` (line 106), `src/worker/api/reg/volunteer-search.ts` (line 109) |
| **What happens** | Every endpoint that accepts `guest_name`, `buyer_name`, or `notes` performs `.trim()` to remove whitespace but applies **no maximum length check**. The database schema uses `TEXT` columns (no length constraint in SQLite). A value of any size — even megabytes — is accepted and stored. |
| **Why it's a problem** | A malicious buyer (or an accidental copy-paste of a large document) could insert a 1 MB string as a guest name. This would: (a) bloat the database, (b) slow down queries that read the full row, (c) break UI rendering on pages that display the name without truncation. While practical risk is limited (requires intentional abuse), it's a defence-in-depth gap — the fix is a one-line validation. |
| **How to reproduce** | Send a PATCH to `/api/reg/buyer/:token/guests/:id` with `guest_name` set to a 50,000-character string. It succeeds and the value is stored. |
| **How to fix** | Add sensible maximum lengths before the database operation. For example: `guest_name` — 100 characters (a real person's name), `buyer_name` — 100 characters, `notes` — 500 characters. Validate in each endpoint: `if (guestName && guestName.length > 100) return c.json({ success: false, message: 'Guest name must be 100 characters or fewer.' }, 400);`. |

---

### L7 — Missing `ON DELETE CASCADE` on foreign key constraints

| | |
|---|---|
| **File** | `migrations/002_registration.sql` (lines 41, 56) |
| **What happens** | The `reg_guests` and `reg_tokens` tables both have a foreign key referencing `reg_bookings(id)`, but neither FK includes `ON DELETE CASCADE`: `FOREIGN KEY (booking_id) REFERENCES reg_bookings(id)`. |
| **Why it's a problem** | When the delete booking feature (FG1) is eventually implemented, attempting to delete a booking that has associated guests or tokens will either: (a) fail because the FK constraint blocks the deletion (D1 enforces foreign keys), or (b) leave orphaned rows if constraints are bypassed. The delete handler would need to manually delete all children first — more code, more risk of partial deletion. Adding `ON DELETE CASCADE` would let the database handle this automatically: deleting a booking row cascades to delete all linked guest and token rows in the same operation. |
| **How to reproduce** | Not directly reproducible through the current API (no booking delete endpoint). But if someone manually runs `DELETE FROM reg_bookings WHERE id = '...'` in D1 while guests exist, the query would fail with a foreign key constraint error. |
| **How to fix** | Alter the FK constraints to include cascade behaviour: `FOREIGN KEY (booking_id) REFERENCES reg_bookings(id) ON DELETE CASCADE`. In D1, this requires dropping and recreating the constraint (D1 doesn't support `ALTER TABLE ... ALTER CONSTRAINT`). Create a new migration that uses `ALTER TABLE ... RENAME TO ..._old`, creates new tables with the cascade FK, copies data, and drops the old tables. This should be done before implementing the booking delete feature. |

---

### L8 — No guard against double-clicking the Save button on the buyer form

| | |
|---|---|
| **File** | `src/pages/reg/buyer/index.astro` (lines 169–208) |
| **What happens** | The `saveGuest()` function sends a PATCH request to save a guest name, but it does not disable the Save button or set a loading flag while the request is in flight. A buyer who double-clicks or taps rapidly sends **multiple identical PATCH requests** to the server. |
| **Why it's a problem** | Multiple concurrent requests to the same endpoint with the same data. Since the operation is idempotent (setting the same name twice has no different effect), the worst practical impact is: (a) unnecessary D1 writes, (b) slightly noisy network logs, (c) the re-render happening multiple times. It does NOT create any data inconsistency or security issue — the same buyer, same data, same result. However, the absence of debounce/disable is an accessibility and UX polish gap. |
| **How to reproduce** | Open the buyer form, type a name, rapidly click "Save" three times. Three PATCH requests are sent. |
| **How to fix** | At the start of `saveGuest`, disable the button: `btn.disabled = true; btn.textContent = 'Saving...';`. In the `finally` block (or success/error handlers), re-enable it: `btn.disabled = false; btn.textContent = 'Save';`. Also apply the same pattern to `markArrived` in the check-in page (`checkin.astro:527`) and `saveGuestName` in the search page (`search.astro:503`). |

---

## Feature Gap

### FG1 — No API endpoint to delete a booking

| | |
|---|---|
| **File** | `src/worker/api/reg/admin-bookings.ts` (lines 124–143) |
| **What happens** | The `handleAdminBookingById` function only handles the `GET` method. There is no `DELETE` handler for individual bookings. |
| **Why it's a problem** | If an admin creates a booking by mistake, there is no way to remove it through the UI or API. The admin would need to manually delete rows from D1 (booking + all its guests + tokens). |
| **How to fix** | Add a `DELETE` handler to `handleAdminBookingById` that: 1) deletes all `reg_guests` rows with that `booking_id`, 2) deletes all `reg_tokens` rows with that `booking_id`, 3) deletes the `reg_bookings` row. Wrap all three in a transaction. |

---

## Quick Reference — Endpoints and Their Issues

| Endpoint | Method | Issues |
|----------|--------|--------|
| `/api/reg/admin/bookings` | POST | H1 (no transaction), H2 (no capacity check) |
| `/api/reg/admin/bookings/:id` | GET | FG1 (no DELETE support) |
| `/api/reg/admin/guests` | POST | H1 (no transaction with pax update), H2, M4 (cross-table) |
| `/api/reg/admin/guests/:id` | PATCH | L6 (no length limits) |
| `/api/reg/admin/guests/:id` | DELETE | M1 (deleting buyer guest) |
| `/api/reg/admin/send-magic-link/:id` | POST | L1 (URL fallback), M6 (email failure not signalled) |
| `/api/reg/admin/export` | GET | M5 (CSV formula injection) |
| `/api/reg/admin/guest-list` | GET | — |
| `/api/reg/volunteer/search` | GET | — |
| `/api/reg/volunteer/arrive/:id` | POST | M2 (TOCTOU race condition) |
| `/api/reg/volunteer/walkin` | POST | H2 (no capacity check), L6 |
| `/api/reg/volunteer/guest/:id` | POST | L6 |
| `/api/reg/buyer/:token` | GET | L3 (no rate limiting) |
| `/api/reg/buyer/:token/guests/:id` | PATCH | M3 (no arrived_at guard), L3, L6, L8 (double submit) |
| `/api/reg/dashboard/stats` | GET | L2 (stats undercount) |
| `/api/reg/tables` | GET | — |

---

## Files Referenced

| File | Role |
|------|------|
| `src/worker/index.ts` | Route registration (lines 55–82) |
| `src/worker/middleware.ts` | Auth and rate limiting (lines 24–34, 64–66, 110–119) |
| `src/worker/api/reg/admin-bookings.ts` | Booking CRUD (admin) |
| `src/worker/api/reg/admin-guests.ts` | Guest CRUD (admin) |
| `src/worker/api/reg/admin-guest-list.ts` | Full guest list with seat grid |
| `src/worker/api/reg/admin-export.ts` | CSV export |
| `src/worker/api/reg/admin-magic-link.ts` | Send magic link email |
| `src/worker/api/reg/volunteer-search.ts` | Volunteer search, arrive, walk-in, update guest |
| `src/worker/api/reg/buyer-form.ts` | Buyer-facing magic link form |
| `src/worker/api/reg/reg-dashboard.ts` | Dashboard stats |
| `src/worker/api/reg/reg-tables.ts` | Table config + occupancy |
| `src/worker/lib/reg/guests.ts` | Guest DB helpers and stats queries |
| `src/worker/lib/reg/tickets.ts` | Seat allocation logic |
| `src/worker/lib/reg/tables.ts` | Table config loading |
| `src/worker/lib/reg/tokens.ts` | Magic link token create/validate |
| `src/worker/lib/reg/email.ts` | Resend email delivery for magic links |
| `migrations/002_registration.sql` | Database schema |
| `src/pages/reg/buyer/index.astro` | Buyer guest registration form |
| `src/pages/reg/volunteer/checkin.astro` | Volunteer check-in page |
| `src/pages/reg/volunteer/search.astro` | Volunteer guest search page |
| `src/pages/reg/volunteer/add-walkin.astro` | Walk-in add form |
