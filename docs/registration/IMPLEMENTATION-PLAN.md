# SWA Gala Registration Module — Implementation Plan

**Host:** `admin.singaporewomenassociation.org` (existing swa-portal Worker)
**Stack:** Astro (static) + Hono + D1 + KV + Resend (existing swa-portal bindings)
**Auth:** Extends existing swa-portal OTP session auth
**New D1 tables:** `reg_bookings`, `reg_guests`, `reg_tokens`
**Deployment:** Same Worker, same wrangler.jsonc, same D1 and KV bindings

---

## Overview

This module adds gala dinner guest registration and arrival tracking to the existing SWA Portal. It does not create a new Worker or new infrastructure. All new API routes are mounted under `/api/reg/*` on the existing Hono app. All new pages live under `src/pages/reg/`.

Four audiences, four access patterns:

| Audience | Pages | Auth |
|---|---|---|
| SWA admin staff | `/reg/admin/*` | Existing session + `admin` role or `reg_role='reg_admin'` |
| SWA volunteers | `/reg/volunteer/*` | Existing session + `reg_role='reg_volunteer'` (or admin) |
| SWA committee (read-only) | `/reg/dashboard` | Existing session + any valid role |
| Buyers (external) | `/reg/buyer/:token` | Magic-link token only, no session required |

The buyer route is the only public-facing route. Everything else sits behind the existing swa-portal session middleware.

---

## Why swa-portal, not GTW

1. **Zero risk to GTW.** GTW is tested and 1 month from the live event. Adding registration would modify its auth middleware, session cookie, D1 schema, and deployment pipeline. A regression could break ticket sales or the live draw.

2. **Registration is an admin function.** It belongs in an admin portal, not a lucky-draw app. Table seating, guest names, and arrival tracking are operational tasks that SWA committee manages.

3. **Auth fits naturally.** swa-portal already has D1-based auth with `category` roles. Adding `reg_role` is a small extension. GTW's domain-based auth would require significant retrofitting.

4. **Independent deploy.** Fix a registration bug at midnight without worrying about GTW side effects.

5. **Gives swa-portal its first real event module.** Registration drives architecture decisions (magic-link auth, public pages outside AdminLayout) instead of building a portal shell with no real features.

---

## Key Differences from Original GTW Registration Plan

The original plan was written assuming it would be added to the GTW Worker. This plan adapts it for swa-portal. Major differences:

| # | Original plan | This plan | Reason |
|---|---|---|---|
| 1 | References "existing bookings table" | Creates `reg_bookings` from scratch | No bookings table exists anywhere in GTW or swa-portal |
| 2 | `src/templates/reg/` with Hono-rendered HTML | Astro pages in `src/pages/reg/` + client-side fetch | Matches swa-portal's existing pattern (Astro static pages, dynamic data via fetch) |
| 3 | Routes at `/reg/admin/*`, `/reg/volunteer/*` | APIs at `/api/reg/admin/*`, `/api/reg/volunteer/*` | `run_worker_first: ["/api/*"]` means only `/api/*` routes hit the Worker |
| 4 | `reg_admin`/`reg_volunteer` as permission flags in GTW auth | `reg_role` column on `members` table, stored in session cookie | swa-portal uses D1-based roles, not domain-based or KV allowlist |
| 5 | `src/services/reg/`, `src/routes/reg/`, `src/db/migrations/` | `src/worker/lib/reg/`, `src/worker/api/reg/`, `migrations/` | Follows swa-portal directory conventions |
| 6 | Cookie `gtw_session` | Cookie `swa_session` | Different project, different cookie |
| 7 | KV prefix `gtw:` | KV prefix `swa:` | Matches swa-portal's existing KV namespace and key convention |

---

## Critical Constraints

These apply in addition to all existing swa-portal constraints documented in `AGENTS.md`.

1. **Follow existing swa-portal patterns exactly.** API handlers in `src/worker/api/`, shared libs in `src/worker/lib/`, Astro pages in `src/pages/`, client-side data loading via `fetch('/api/*')`. No new directories or patterns.
2. **D1 `batch()` for ticket code assignment.** Seat counter allocation must use a UNIQUE constraint on `ticket_code` plus a retry on conflict. Do not assume sequential writes will be collision-free.
3. **Table config is always read from KV, never hardcoded.** Table names, VIP flags, capacities, and ticket code prefixes come from the `swa:reg_tables_config` KV key. No table data in source code.
4. **Walk-in guests have `booking_id = NULL`.** Do not attempt to assign a booking to a walk-in guest record.
5. **Notes field is operational, not guest-facing.** UI copy must make clear that notes are visible to SWA staff only and are not reflected on e-tickets already distributed.
6. **Magic-link tokens expire at the configured form cutoff time.** After cutoff, the buyer form returns a closed message. The admin interface has no cutoff.
7. **No R2 usage in this module.** No file uploads, no image generation. The PNG e-ticket generator is an external tool run by CJ outside this Worker.
8. **No em dashes** in any UI copy, email templates, or code comments.
9. **British English** throughout all UI copy and emails.
10. **Buyer page must NOT use AdminLayout.** It is a public-facing page with its own layout (SWA branding, no sidebar nav, no auth gate).
11. **Export column names must match CJ's PNG generator input schema.** Confirm column headers before finalising the export endpoint.

---

## New Files

All new files follow existing swa-portal conventions. No new top-level directories.

```
src/
  pages/reg/
    admin/
      bookings.astro           # Booking list with completion status
      booking-detail.astro     # Booking detail: guest rows, add/edit/delete
    volunteer/
      search.astro             # Search + mark arrived (phone-optimised)
      add-walkin.astro         # Add walk-in guest form
    buyer/
      form.astro               # Buyer guest name entry (token-gated)
      closed.astro             # Form cutoff / invalid token message
    dashboard.astro            # Live arrival dashboard (read-only)
  worker/api/reg/
    admin-bookings.ts          # List bookings, create booking, booking detail
    admin-guests.ts            # Add/edit/delete guest, assign to booking
    admin-export.ts            # CSV export
    volunteer-search.ts        # Search guests, mark arrived
    volunteer-walkin.ts        # Add walk-in guest
    buyer-form.ts              # Token validation, guest name update
    reg-dashboard.ts           # JSON stats for live dashboard
  worker/lib/reg/
    tables.ts                  # KV table config loader and helpers
    tickets.ts                 # Ticket code generator with retry logic
    guests.ts                  # Guest CRUD operations (D1)
    tokens.ts                  # Magic-link token generator and validator
    email.ts                   # Magic-link email via Resend
migrations/
  002_registration.sql           # New tables: reg_bookings, reg_guests, reg_tokens + reg_role column
scripts/
  seed-bookings.ts               # Bulk create bookings + guests from CSV/JSON
  seed-magic-links.ts            # Generate tokens + send magic-link emails
e-tickets-v2/
  generate_tickets.py            # e-Ticket generator v2 (CSV input, ticket_code format)
  e-ticket-2026.pptx            # Updated PPTX template (no [pax], ticket_code format)
  AGENTS.md                      # v2 instructions
```

### Modifications to existing files

- `src/worker/index.ts` — import and mount registration API routes under `/api/reg/*`
- `src/worker/middleware.ts` — add registration path auth checks (buyer routes bypass auth; volunteer routes require `reg_volunteer` or `admin`; admin routes require `admin` or `reg_admin`)
- `src/worker/api/verify-otp.ts` — include `regRole` in session cookie payload (derived from `reg_role` column in members table)
- `src/worker/api/session.ts` — return `regRole` in session JSON response
- `src/worker/types.ts` — add `sessionRegRole` to Hono Variables type
- `src/scripts/auth-gate.ts` — add `requireRegAdmin()` and `requireRegVolunteer()` helper functions
- `src/layouts/AdminLayout.astro` — add "Registration" nav item in sidebar
- `src/pages/index.astro` — add registration card to dashboard

---

## KV Configuration

### New key: `swa:reg_tables_config`

Set via Cloudflare dashboard or `wrangler kv:key put`. Read on every request that needs table data (cached for the lifetime of the request, not across requests).

```json
{
  "formCutoffTime": "2026-06-20T18:00:00+08:00",
  "tables": [
    {
      "id": "01",
      "label": "Table 1",
      "ticketPrefix": "01",
      "capacity": 10,
      "isVIP": false
    },
    {
      "id": "02",
      "label": "Table 2",
      "ticketPrefix": "02",
      "capacity": 10,
      "isVIP": false
    },
    {
      "id": "VIP-1",
      "label": "VIP-1",
      "ticketPrefix": "V1",
      "capacity": 10,
      "isVIP": true
    },
    {
      "id": "VIP-2",
      "label": "VIP-2",
      "ticketPrefix": "V2",
      "capacity": 10,
      "isVIP": true
    }
  ]
}
```

Populate with the full table list before Phase 1 begins. CJ to confirm exact table IDs, labels, prefixes, capacities, and VIP designations from SWA's seating plan.

---

## D1 Migration

**File:** `migrations/002_registration.sql`

Apply via `wrangler d1 execute swa-portal --remote --file=migrations/002_registration.sql`

```sql
-- Table bookings: one row per table reservation (a buyer reserves N seats at a table)
CREATE TABLE IF NOT EXISTS reg_bookings (
  id               TEXT PRIMARY KEY,              -- UUID
  booking_ref      TEXT NOT NULL UNIQUE,          -- Human-readable ref e.g. "REG-A3F2K"
  buyer_name       TEXT NOT NULL,                 -- Person who made the reservation
  buyer_email      TEXT,                          -- Buyer email for magic link
  buyer_phone      TEXT,                          -- Buyer phone for contact
  table_id         TEXT NOT NULL,                 -- Matches id in swa:reg_tables_config KV
  pax              INTEGER NOT NULL DEFAULT 1,    -- Total seats reserved
  notes            TEXT,                          -- Operational notes, staff eyes only
  created_by       TEXT NOT NULL,                 -- Session email of admin who created
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reg_bookings_ref    ON reg_bookings(booking_ref);
CREATE INDEX idx_reg_bookings_table  ON reg_bookings(table_id);
CREATE INDEX idx_reg_bookings_email  ON reg_bookings(buyer_email);

-- Guest records: one row per expected attendee
CREATE TABLE IF NOT EXISTS reg_guests (
  id               TEXT PRIMARY KEY,              -- UUID
  booking_id       TEXT,                          -- FK to reg_bookings, NULL for walk-ins
  table_id         TEXT NOT NULL,                 -- Matches id in swa:reg_tables_config KV
  seat_counter     INTEGER NOT NULL,              -- Registration sequence within this table (1, 2, 3...)
  ticket_code      TEXT NOT NULL UNIQUE,          -- e.g. "04-07", "V1-03"
  guest_name       TEXT,                          -- NULL until filled by buyer or admin
  is_buyer         INTEGER NOT NULL DEFAULT 0,    -- 1 if this row is the booking buyer
  is_walk_in       INTEGER NOT NULL DEFAULT 0,    -- 1 if added by volunteer at the door
  notes            TEXT,                          -- Operational note, staff eyes only
  arrived_at       TEXT,                          -- ISO8601 timestamp, NULL until checked in
  arrived_by       TEXT,                          -- Session email of volunteer who checked in
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (booking_id) REFERENCES reg_bookings(id)
);

CREATE INDEX idx_reg_guests_booking    ON reg_guests(booking_id);
CREATE INDEX idx_reg_guests_table      ON reg_guests(table_id);
CREATE INDEX idx_reg_guests_name       ON reg_guests(guest_name);
CREATE INDEX idx_reg_guests_ticket     ON reg_guests(ticket_code);
CREATE INDEX idx_reg_guests_arrived    ON reg_guests(arrived_at);

-- Magic-link tokens: one per booking, for buyer-facing form access
CREATE TABLE IF NOT EXISTS reg_tokens (
  token            TEXT PRIMARY KEY,              -- 32-char hex random string
  booking_id       TEXT NOT NULL,                 -- FK to reg_bookings
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL,                 -- ISO8601, set to formCutoffTime from KV
  FOREIGN KEY (booking_id) REFERENCES reg_bookings(id)
);

CREATE INDEX idx_reg_tokens_booking ON reg_tokens(booking_id);
```

### Why `reg_bookings` is needed

The original GTW registration plan assumed an "existing bookings table" for table reservations. No such table exists in GTW or swa-portal. We must create it. A booking represents a table reservation: a buyer (e.g. a company or individual) reserves N seats at a specific table. When a booking is created, N guest slot rows are auto-generated in `reg_guests`.

---

## Auth Extension

### Current swa-portal auth (unchanged for existing features)

- Session cookie: `swa_session` with `{ email, name, role, exp }`
- Role: `admin` (IT_ADMIN_EMAILS or `category='admin'`) or `committee` (`category='committee'` with `can_login=1`)
- Middleware: public paths, IT-admin-only paths, admin-write paths, authenticated paths

### New: `reg_role` column on members table

```sql
ALTER TABLE members ADD COLUMN reg_role TEXT DEFAULT NULL;
-- Values: NULL (no reg access), 'reg_admin', 'reg_volunteer'
```

**Why a new column instead of deriving from `category`:** A committee member who volunteers at reception on event night needs `reg_volunteer` access without changing their membership category. Decoupling keeps things clean.

### Session cookie change

Add `regRole` to the session payload in `verify-otp.ts`:

```typescript
const regRole = member.reg_role || null; // from D1 members table
const payload = base64urlEncode(JSON.stringify({ email, name, role, regRole, exp }));
```

### Session API change

Return `regRole` in the JSON response in `session.ts`:

```typescript
return c.json({
  authenticated: true,
  email: session.email,
  name: session.name,
  role: session.role,
  regRole: session.regRole, // null | 'reg_admin' | 'reg_volunteer'
  is_admin: ...,
  is_it_admin: ...,
});
```

### Middleware changes for registration

Add three new path sets:

```typescript
// Buyer routes: token-gated, bypass session auth entirely
const REG_BUYER_API = new Set(['/api/reg/buyer']);

// Volunteer routes: session required + reg_volunteer or admin
const REG_VOLUNTEER_API = new Set(['/api/reg/volunteer']);

// Admin routes: session required + reg_admin (or admin role)
const REG_ADMIN_API = new Set(['/api/reg/admin']);
```

Auth flow for registration paths:

1. **`/api/reg/buyer/*`** — Skip session check. Token validation happens inside the handler.
2. **`/api/reg/volunteer/*`** — Session required. Check `sessionRole === 'admin'` OR `sessionRegRole === 'reg_admin'` OR `sessionRegRole === 'reg_volunteer'`.
3. **`/api/reg/admin/*`** — Session required. Check `sessionRole === 'admin'` OR `sessionRegRole === 'reg_admin'`.
4. **`/api/reg/dashboard`** — Session required. Any valid session (same as `/api/bookings` today).

### Client-side auth gate extension

Add two helper functions to `src/scripts/auth-gate.ts`:

```typescript
export function requireRegAdmin(onAuthenticated?: (data: SessionResponse) => void): void {
  requireAuth({
    onAuthenticated: (data) => {
      if (data.role !== 'admin' && data.regRole !== 'reg_admin') {
        window.location.href = '/';
        return;
      }
      onAuthenticated?.(data);
    },
  });
}

export function requireRegVolunteer(onAuthenticated?: (data: SessionResponse) => void): void {
  requireAuth({
    onAuthenticated: (data) => {
      if (
        data.role !== 'admin' &&
        data.regRole !== 'reg_admin' &&
        data.regRole !== 'reg_volunteer'
      ) {
        window.location.href = '/';
        return;
      }
      onAuthenticated?.(data);
    },
  });
}
```

The `SessionResponse` interface must also be updated to include `regRole: string | null`.

---

## Phase Plan

### Phase 1: Foundation

**What:** Database schema, KV config, auth extension, shared service libraries

**Why:** Everything else depends on these. Must be done first and tested before building any UI.

**How:**

1. **Create D1 migration** — `migrations/002_registration.sql` with `reg_bookings`, `reg_guests`, `reg_tokens` tables. Apply to production D1.
2. **Add `reg_role` column** — `ALTER TABLE members ADD COLUMN reg_role TEXT DEFAULT NULL`. Set values for relevant members (admin staff get `'reg_admin'`, event volunteers get `'reg_volunteer'`).
3. **Seed KV config** — Populate `swa:reg_tables_config` with the full table list. Confirm with CJ: table IDs, labels, prefixes, capacities, VIP flags.
4. **Extend session auth** — Modify `verify-otp.ts` to include `regRole` in session cookie. Modify `session.ts` to return `regRole`. Add `regRole` to `SessionData` interface. Modify `types.ts` to add `sessionRegRole` to Variables.
5. **Extend middleware** — Add `REG_BUYER_API`, `REG_VOLUNTEER_API`, `REG_ADMIN_API` path checks. Buyer routes bypass session; volunteer routes check `regRole`; admin routes check `regRole` or `role`.
6. **Extend auth-gate** — Add `requireRegAdmin()` and `requireRegVolunteer()` to client-side auth script. Add `regRole` to `SessionResponse` interface.
7. **Build service: tables.ts** — Load `swa:reg_tables_config` from KV, parse it, provide `getTable()`, `isFormOpen()` helpers.
8. **Build service: tickets.ts** — `generateTicketCode(prefix, counter)` and `allocateGuestSlot()` with retry-on-UNIQUE-conflict logic.
9. **Build service: guests.ts** — CRUD operations: `getGuestsByBooking()`, `searchGuests()`, `updateGuest()`, `deleteGuest()`, `markArrived()`, `getArrivalStats()`, `getRecentArrivals()`.
10. **Build service: tokens.ts** — `createToken()` and `validateToken()` for magic-link flow.

**New files:**
- `migrations/002_registration.sql`
- `src/worker/lib/reg/tables.ts`
- `src/worker/lib/reg/tickets.ts`
- `src/worker/lib/reg/guests.ts`
- `src/worker/lib/reg/tokens.ts`

**Modified files:**
- `src/worker/api/verify-otp.ts`
- `src/worker/api/session.ts`
- `src/worker/middleware.ts`
- `src/worker/types.ts`
- `src/scripts/auth-gate.ts`

**Gate:** Can create a session with `regRole`, middleware correctly blocks/allows registration API paths, ticket code generation works for both numbered (`04-07`) and VIP (`V1-03`) tables, `isFormOpen()` returns correct values against a test cutoff time. Existing portal features (login, bookings, members) still work unchanged.

---

### Phase 2: Admin Interface

**What:** Admin pages and APIs to create bookings, manage guest slots, and export data

**Why:** Bookings and guest slots must exist before volunteers can check anyone in or buyers can fill in names. Admin creates the data that drives everything else.

**How:**

Admin creates a booking by specifying: buyer name, buyer email, table, pax count. The system auto-generates N guest slot rows in `reg_guests` with ticket codes. Seat 1 gets `is_buyer = 1` and the buyer name pre-filled; remaining slots have `guest_name = NULL`. Admin can then edit guest names, add extra guests to a booking, remove guests, and view all bookings.

**API endpoints:**

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/reg/admin/bookings` | GET | reg_admin | List all bookings with named/unnamed counts |
| `/api/reg/admin/bookings` | POST | reg_admin | Create booking + auto-generate guest slots |
| `/api/reg/admin/bookings/:id` | GET | reg_admin | Booking detail with all guest rows |
| `/api/reg/admin/guests` | POST | reg_admin | Add a guest to a booking |
| `/api/reg/admin/guests/:id` | PATCH | reg_admin | Edit guest name/notes |
| `/api/reg/admin/guests/:id` | DELETE | reg_admin | Remove a guest |
| `/api/reg/admin/export` | GET | reg_admin | CSV export of all guests |

**Pages:**

- **`src/pages/reg/admin/bookings.astro`** — Booking list page. Shows each booking with: buyer name, table, pax, named/unnamed count (colour-coded: grey=0 named, amber=partial, green=all named). Search by buyer name. Filter by table dropdown (populated from KV config). "Add Booking" button. "Download CSV" button. Footer: "Download since last run" link with date pre-filled. Uses AdminLayout.
- **`src/pages/reg/admin/booking-detail.astro`** — Single booking detail. Header: buyer name, table label, pax, named/unnamed count. "Add Guest" inline form at top: name input, notes input, table selector (defaults to this booking's table), save button. Guest list: ticket code, name, notes, walk-in flag, arrived status. Edit (inline form toggle) and delete per row. Notes displayed in amber/yellow highlight labelled "Staff note - not on e-ticket". Arrived status: timestamp if arrived, "Not yet" otherwise. Uses AdminLayout.

**Gate:** Admin can create a booking, see guest slots auto-generated with ticket codes, edit guest names, remove a guest, and download a CSV. Existing portal features still work.

---

### Phase 3: Volunteer Reception

**What:** Search guests by name/ticket code, mark arrived, add walk-in guests. Optimised for phone use with large tap targets.

**Why:** This is the most critical feature for event night. Volunteers at the door need fast, single-handed check-in on their phone.

**How:**

Volunteer opens the search page. Large auto-focused search input. Results show guest name, ticket code, table, and a big green "Mark Arrived" button. If already arrived, show grey "Arrived at HH:mm" label. Walk-in button adds a guest with `booking_id = NULL` who is immediately marked arrived. Notes shown in amber banner so volunteers see dietary info etc.

**API endpoints:**

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/reg/volunteer/search` | GET | reg_volunteer+ | Search guests by name/ticket code |
| `/api/reg/volunteer/arrive/:id` | POST | reg_volunteer+ | Mark guest arrived |
| `/api/reg/volunteer/walkin` | POST | reg_volunteer+ | Add walk-in + mark arrived |

**Route specs:**

**GET /api/reg/volunteer/search**

Query params: `q` (search string), `table` (table ID filter, optional).

- If `q` is empty, return empty results.
- Search across `guest_name` and `ticket_code`. Also accepts `tableId` filter.
- Return up to 20 results.

**POST /api/reg/volunteer/arrive/:id**

- Fetch guest. If already arrived, return success with message: "Already checked in at [time]."
- Call `markArrived(db, guestId, sessionEmail)`.
- Return success with guest name and table label.

**POST /api/reg/volunteer/walkin**

Body: `guestName` (required), `tableId` (required), `notes` (optional).

- Load table config from KV to get `ticketPrefix` and confirm table exists.
- Call `allocateGuestSlot` with `bookingId = null`, `isWalkIn = true`.
- Mark arrived immediately (walk-in guests are present by definition).
- Return success with guest name, ticket code, and table label.

**Pages:**

- **`src/pages/reg/volunteer/search.astro`** — Phone-optimised search page. Large search input (autofocus), table filter dropdown (default "All tables"), "Add Walk-in Guest" secondary button (links to add-walkin page). Results list: each result is a large block with guest name (bold), ticket code, table label. If guest has notes: amber highlighted banner reading "Staff note: [notes text]". If not arrived: large green "Mark Arrived" button (one tap, no confirmation dialog). If already arrived: grey "Arrived at HH:mm" label. Walk-in badge on row. No results: "No guests found. Try a different name or ticket code. Or add a walk-in guest." Uses AdminLayout.
- **`src/pages/reg/volunteer/add-walkin.astro`** — Minimal form: name input (required), table selector (required), notes input (optional). Submit button: "Add and Check In". Back link to search page. Uses AdminLayout.

**Gate:** Volunteer can search by name, search by ticket code, mark a guest arrived, see a note banner when a note exists, and add a walk-in guest who is immediately checked in. Admin can also access all volunteer routes. Existing portal features still work.

---

### Phase 4: Buyer Self-Service

**What:** Magic-link emails let buyers fill in their own guest names before the event. No SWA login required.

**Why:** Reduces admin workload dramatically. Instead of SWA staff calling every buyer to collect names, buyers self-serve via a unique link emailed to them. This is the biggest time-saver for the team.

**How:**

Admin clicks "Send Magic Link" on the booking detail page (Phase 2 page, add a button). Email contains a unique token URL (`/reg/buyer/:token`). Buyer opens link, sees their guest slots, fills in names one by one. Each name saved individually (per-row save buttons). Saved rows show ticket code. Form closes at configured cutoff time.

**API endpoints:**

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/reg/buyer/:token` | GET | Token only | Load booking + guest list for buyer form |
| `/api/reg/buyer/:token/guests/:id` | PATCH | Token only | Update guest name/notes |
| `/api/reg/admin/send-magic-link/:bookingId` | POST | reg_admin | Generate token + send email |

**Route specs:**

**GET /api/reg/buyer/:token**

- Validate token via `validateToken()`. If null, return `{ closed: true, reason: 'invalid' }`.
- Load KV config. If `!isFormOpen(config)`, return `{ closed: true, reason: 'cutoff' }`.
- Load booking from `reg_bookings`.
- Load all `reg_guests` for this booking.
- Return booking data + guest list + formCutoffTime formatted.

**PATCH /api/reg/buyer/:token/guests/:id**

Body: `guestName` (required), `notes` (optional, labelled as dietary or accessibility requirements).

- Validate token and form-open status.
- Confirm `guestId` belongs to the booking associated with this token. If not, return 403.
- If `is_buyer = 1` and already has a name, allow update (buyer may correct their own name).
- Update guest.

**POST /api/reg/admin/send-magic-link/:bookingId**

- Load booking. If no `buyer_email`, return error: "No buyer email on file."
- Load or create token via `createToken()`.
- Send magic-link email via `sendMagicLink()`.
- Return success.

**Pages:**

- **`src/pages/reg/buyer/form.astro`** — Public page (NO AdminLayout). SWA branding header. Title: "49th Annual Charity Dinner 2026 - Guest Registration". Instruction text: "Please add the names of your guests below. You can return to this page any time before [formCutoffTime formatted as human-readable date and time] to make changes." Guest list: one row per seat. Buyer row (pre-filled, editable). Remaining rows: name input + notes input ("Dietary or accessibility requirements - optional") + Save button per row. Saved rows show name with small "Saved" tick + ticket code (label: "Ticket reference: 04-03"). Edit button to toggle back to input mode. Unsaved rows show placeholder "Enter guest name". Footer: "Your guest list was last updated [timestamp]." Small text: "These details are used for event registration. Individual e-tickets will be sent separately by SWA." Has its own minimal layout with SWA logo and footer.
- **`src/pages/reg/buyer/closed.astro`** — Public page (NO AdminLayout). Shows either "This link is invalid or has expired." or "Guest registration has closed for this event. If you have any questions, please contact SWA directly." with SWA contact info.

**Email template** (`src/worker/lib/reg/email.ts`):

```typescript
export async function sendMagicLink(
  env: Env,
  params: {
    buyerEmail: string;
    buyerName: string;
    bookingRef: string;
    paxCount: number;
    tableLabel: string;
    magicLinkUrl: string;
    formCutoffFormatted: string;
  }
): Promise<void>
```

Email content:

- Subject: "49th SWA Annual Charity Dinner 2026 - Please register your guests"
- SWA purple theme (matching existing portal email templates)
- Body: "Dear [buyerName],", "Thank you for your support of the 49th SWA Annual Charity Dinner 2026.", "You have reserved [paxCount] seats at [tableLabel]. To help us prepare for your arrival, please let us know the names of your guests using the link below.", Large button: "Register My Guests" linking to `magicLinkUrl`, "This link is unique to your booking and will remain active until [formCutoffFormatted].", "If you have any questions, please contact SWA directly.", SWA signature block.
- From: `SWA Portal <contactus@singaporewomenassociation.org>` (existing Resend sender)
- Sent via `waitUntil()` (non-blocking), errors logged via `logError()` but don't fail the request

**Gate:** Admin can trigger a magic-link email from booking detail page. Buyer receives email, opens link, fills in guest names, sees ticket codes after saving. Form shows closed message after cutoff. Invalid token shows error page. Existing portal features still work.

---

### Phase 5: Live Dashboard

**What:** Real-time arrival monitoring visible to any logged-in SWA member on their phone.

**Why:** Committee members and organisers want to see arrival progress during the event without going to reception. Nice-to-have, not critical for the door operation.

**How:**

Stats strip at top: total expected / arrived / percentage (large numbers, visible at a glance). VIP section (shown above general tables for quick visibility). Table list: one row per table with label, arrived/expected, visual fill bar. Recent arrivals panel: last 10 arrivals, scrollable. Auto-refresh every 15 seconds via client-side polling.

**API endpoint:**

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/reg/dashboard/stats` | GET | Any session | JSON stats for live dashboard |

**Response shape:**

```typescript
type DashboardStats = {
  totalExpected: number;       // all named reg_guests rows
  totalArrived: number;        // reg_guests where arrived_at IS NOT NULL
  arrivalPct: number;          // percentage, 0-100
  tables: TableDashboardRow[];
  recentArrivals: RecentArrival[];
};

type TableDashboardRow = {
  tableId: string;
  tableLabel: string;
  isVIP: boolean;
  capacity: number;
  namedCount: number;
  arrivedCount: number;
};

type RecentArrival = {
  guestName: string;
  tableLabel: string;
  ticketCode: string;
  arrivedAt: string;           // ISO8601
};
```

**Page:**

- **`src/pages/reg/dashboard.astro`** — Live dashboard. Stats strip (top): Total Expected | Total Arrived | Arrival % (large numbers). VIP section: list of VIP tables, each showing arrived/capacity (shown above general tables). Table list: one row per table with label, arrived/expected, visual fill bar (grey=0 arrived, amber=1 to capacity-1, green=all arrived). Sorted: VIP tables first, then by table ID. Recent arrivals panel: last 10, scrollable, each entry shows name + table + time. Auto-refresh via `setInterval` every 15 seconds calling `GET /api/reg/dashboard/stats`, updates DOM without full page reload. Last refreshed timestamp in small text at bottom. Uses AdminLayout.

**Gate:** Dashboard shows accurate counts. Auto-refresh updates numbers without page reload. VIP tables at top. Readable on mobile browser. Existing portal features still work.

---

### Phase 6: e-Ticket Generator v2

**What:** e-Ticket generator that works with the registration module's per-guest ticket codes and CSV export format.

**Why:** The current v1 generator (in `e-tickets/`) uses sequential 3-digit ticket numbers and "for N pax" which doesn't match the registration module's per-guest ticket codes (e.g. `04-07`, `V1-03`) and individual e-tickets. v2 must exist before Phase 7 so the CSV export endpoint has a known column schema to target. v2 is a standalone Python tool that can be built and tested with Phase 2 data.

**How:**

1. **Create `e-tickets-v2/` as a sibling folder to `e-tickets/`** (not inside swa-portal). The v1 project stays untouched for backward compatibility.

2. **Copy `e-ticket-2026.pptx` to `e-tickets-v2/`** and modify TextBox 27 from `"Ticket: [number]    Table [table] for [pax] pax"` to `"Ticket: [number]    [table]"`. Remove the `[pax]` placeholder entirely.

3. **Rewrite `generate_tickets.py`** with these changes:
   - Input: CSV files instead of XLSX. Column headers: `ticket_code,guest_name,table_label,is_buyer,is_walk_in`
   - `[number]` receives `ticket_code` (e.g. `04-07`, `V1-03`)
   - `[name]` receives `guest_name`
   - `[table]` receives `table_label` (e.g. `Table 4`, `VIP-1`)
   - `[pax]` placeholder removed from template and script
   - Rows with blank `guest_name` are skipped with a warning
   - No sequential counter — `ticket_code` from CSV is used directly
   - Output naming: `{Name}_Table{Label}_{TicketCode}.png` (e.g. `Jane_Doe_Table4_04-07.png`)
   - Register format: `ticket-register.csv` with columns `ticket_code,guest_name,table_label,generated_on`

4. **PPTX template changes summary:**
   - TextBox 27: `"Ticket: [number]    [table]"`
   - `[number]` = `ticket_code`, `[table]` = `table_label`
   - `[pax]` removed — each ticket is for one individual guest
   - `[name]` scaling logic retained from v1 (28-char threshold, 70% minimum)

**Files:**

- `e-tickets-v2/generate_tickets.py` — new, rewritten for CSV input and ticket_code format
- `e-tickets-v2/e-ticket-2026.pptx` — modified copy of v1 template
- `e-tickets-v2/AGENTS.md` — updated instructions for v2 workflow

**Gate:** Script reads a test CSV with `ticket_code,guest_name,table_label` columns, generates correct PNGs with ticket codes (e.g. `04-07`, `V1-03`) on the ticket face, skips blank guest names with warnings, produces expected output filenames.

---

### Phase 7: Polish and Integration

**What:** CSV export for PNG generator, seed scripts, sidebar navigation integration

**Why:** Integration tooling for e-ticket v2 generator and bulk data operations. Done last because the system must be fully working before bulk imports. Column headers confirmed: `ticket_code,guest_name,table_label,is_buyer,is_walk_in`.

**How:**

- CSV export endpoint produces columns: `ticket_code,guest_name,table_label,is_buyer,is_walk_in` matching e-tickets-v2 input format
- Seed script: bulk-create bookings + guests from a JSON/CSV source file
- Magic-link backfill: generate tokens and send emails for all existing bookings
- Add "Registration" section to AdminLayout sidebar nav
- Add registration links to the dashboard page (index.astro)

**New files:**

- **`scripts/seed-bookings.ts`** — Bulk create bookings + guests from a JSON file. Steps: read JSON source, for each entry create a booking row, then call `allocateGuestSlot` N times. Dry-run flag: `--dry-run` prints the plan without writing to D1. Idempotent: skip any booking that already exists (by `booking_ref`). Confirm prompt before running in production mode.
- **`scripts/seed-magic-links.ts`** — Generate tokens + send magic-link emails for all bookings that have a `buyer_email` but no token yet. Steps: query `reg_bookings` with emails, skip if token already exists in `reg_tokens`, create token, send email. Dry-run flag. Confirm prompt. Idempotent.

**Modified files:**

- `src/layouts/AdminLayout.astro` — Add "Registration" nav section with sub-items: Bookings, Dashboard
- `src/pages/index.astro` — Add registration card to dashboard (links to `/reg/admin/bookings` and `/reg/dashboard`)

**Gate:** CSV export column headers match e-tickets-v2 input format. Seed script runs with `--dry-run` and produces correct output. Magic links send correctly. Navigation shows registration links. All existing portal features still work.

---

## Dependency Map

```
Phase 1 (Foundation)
  ├── Phase 2 (Admin Interface) — needs tables, auth, services
  │     ├── Phase 4 (Buyer Self-Service) — needs bookings + guests to exist
  │     └── Phase 6 (e-Ticket v2) — needs booking data for testing
  ├── Phase 3 (Volunteer Reception) — needs tables, auth, services
  │     └── Phase 5 (Live Dashboard) — needs arrivals flowing
  ├── Phase 5 (Live Dashboard) — needs guest data, can build in parallel with 2-4
  └── Phase 7 (Polish) — needs full system working
```

Phases 2, 3, and 5 are independent after Phase 1 — build whichever is most urgent first. Phase 4 depends on Phase 2 (bookings must exist). Phase 6 (e-ticket v2) depends on Phase 2 (needs booking data for testing) and must be done before Phase 7 (export format must match v2 input). Phase 7 depends on everything else.

---

## Open Items (resolve before relevant phase)

1. **Table layout** — CJ to confirm all table IDs, labels, prefixes, capacities, VIP flags. Needed before Phase 1.
2. **Volunteer reg_role assignments** — Which members get `reg_admin` vs `reg_volunteer` vs no reg access. Needed before Phase 1.
3. **Form cutoff time** — What date/time the buyer form closes. Needed before Phase 4.
4. **CSV column headers** — Confirmed: `ticket_code,guest_name,table_label,is_buyer,is_walk_in`. Matches e-tickets-v2 input format. Resolved.
5. **Buyer email availability** — When admin creates a booking, do they always have the buyer's email? If not, magic links can't be sent for that booking. Is this acceptable? Needed before Phase 4.
