# SWA Admin Portal — Functional Specification

> **Version**: 1.0
> **Date**: 2026-05-13
> **Purpose**: Comprehensive reference for role access, feature behaviour, and API permissions. Future features must follow this specification to maintain consistency.

---

## 1. Overview

The SWA Admin Portal (`swa-portal`) is an internal management tool for the Singapore Women's Association. It is built as a Cloudflare Worker using Hono for API routes and Astro for static page generation.

### Target Users

| Role | Description |
|------|-------------|
| IT Admin | System administrators with full portal control, including infrastructure features (website sync, etc.) |
| Admin | SWA board members and senior committee with member management privileges |
| Committee | SWA committee members with read access and limited write access |

### Registration Roles

Registration access is controlled by a separate `reg_role` column on the `members` table, independent of the portal `category`/`role`.

| reg_role | Description |
|----------|-------------|
| `reg_admin` | Full registration management: create bookings, edit guests, send magic links, export data, check-in guests |
| `reg_volunteer` | Event-night operations only: search guests, mark arrived, add walk-ins |
| `NULL` | No registration access (sidebar Registration section hidden or limited to dashboard only) |

Portal `admin` role always has access to all registration features, regardless of `reg_role`.

### Architecture Summary

- **Frontend**: Astro static build (`output: 'static'`)
- **API**: Hono worker on Cloudflare Workers
- **Data**: Cloudflare D1 (database), KV (sessions + rate limiting), R2 (uploads)
- **Email**: Resend API for OTP and booking confirmations
- **Auth**: OTP via email, HMAC-signed session cookie (`swa_session`)

---

## 2. Role Definitions

### 2.1 How Roles Are Determined

Roles are determined at login time in `src/worker/api/verify-otp.ts` based on the D1 `members` table record and the hardcoded `IT_ADMIN_EMAILS` list.

**Login eligibility** (handled in `send-otp.ts`):
```sql
SELECT id FROM members WHERE email = ? AND can_login = 1
```
Any email can log in provided `can_login = 1` is set in the members table. Email domain does not matter.

**Role assignment** (handled in `verify-otp.ts`):
```
if (email in IT_ADMIN_EMAILS) → role = 'admin', is_it_admin = true
else if (member.category = 'admin') → role = 'admin', is_it_admin = false
else → role = 'committee', is_it_admin = false
```

**reg_role assignment**: Read from `member.reg_role` column. Values: `reg_admin`, `reg_volunteer`, or NULL. Added to session cookie as `regRole`.

**Member categories in D1**:
| Category | Default can_login | Portal Access |
|----------|-------------------|---------------|
| `admin` | 0 | Admin role (must set `can_login = 1`) |
| `committee` | 1 | Committee role |
| `member` | 0 | No portal access by default |
| `volunteer` | 0 | No portal access by default |

> **Rule**: The portal is not intended for `member` or `volunteer` categories. These default to `can_login = 0`. If manually enabled, they will receive the `committee` role.

### 2.2 Session Data

The `swa_session` cookie contains a HMAC-signed payload:
```json
{
  "email": "user@example.com",
  "name": "Full Name",
  "role": "admin" | "committee",
  "regRole": "reg_admin" | "reg_volunteer" | null,
  "exp": 1715600000000
}
```

The `/api/session` endpoint returns:
```json
{
  "authenticated": true,
  "email": "user@example.com",
  "name": "Full Name",
  "role": "admin",
  "regRole": "reg_admin",
  "is_admin": true,
  "is_it_admin": false
}
```

---

## 3. Access Control Matrix

### 3.1 Feature-Level Access

| Feature | Committee | Admin | IT Admin |
|---------|-----------|-------|----------|
| **Dashboard** | View | View | View |
| **Office Booking — View calendar** | Yes | Yes | Yes |
| **Office Booking — Create** | Yes | Yes | Yes |
| **Office Booking — Cancel own** | Yes | Yes | Yes |
| **Office Booking — Cancel others'** | No | Yes | Yes |
| **Members — View list** | Yes | Yes | Yes |
| **Members — Add / Edit / Delete** | No | Yes | Yes |
| **Members — Photo upload** | No | Yes | Yes |
| **Namecards — View list** | Yes | Yes | Yes |
| **Namecards — Edit** | No | Yes | Yes |
| **Website Sync** | No | No | Yes |
| **Registration — Manage bookings** | No (`reg_admin` only) | Yes | Yes |
| **Registration — Export CSV** | No (`reg_admin` only) | Yes | Yes |
| **Registration — Send magic links** | No (`reg_admin` only) | Yes | Yes |
| **Registration — Check-in guests** | No (`reg_volunteer` only) | Yes | Yes |
| **Registration — Add walk-ins** | No (`reg_volunteer` only) | Yes | Yes |
| **Registration — View dashboard** | No (any auth) | Yes | Yes |
| **Registration — Buyer form** | Public (token-gated) | Public (token-gated) | Public (token-gated) |

> **Note**: Registration access is controlled by `reg_role` on the `members` table, independent of the portal `category`/`role`. A committee member with `reg_role='reg_volunteer'` can check in guests. A committee member with `reg_role='reg_admin'` can manage bookings. Portal `admin` role always has full registration access regardless of `reg_role`.

### 3.2 API Access Matrix

| Endpoint | Method | Committee | Admin | IT Admin |
|----------|--------|-----------|-------|----------|
| `GET /api/health` | GET | Public | Public | Public |
| `GET /api/session` | GET | Public | Public | Public |
| `POST /api/send-otp` | POST | Public | Public | Public |
| `POST /api/verify-otp` | POST | Public | Public | Public |
| `GET /api/turnstile-config` | GET | Public | Public | Public |
| `GET /api/bookings` | GET | Yes | Yes | Yes |
| `POST /api/bookings` | POST | Yes | Yes | Yes |
| `GET /api/bookings/:id` | GET | Yes | Yes | Yes |
| `PATCH /api/bookings/:id/cancel` | PATCH | Own only | Yes | Yes |
| `GET /api/members` | GET | Yes | Yes | Yes |
| `POST /api/members` | POST | No | Yes | Yes |
| `GET /api/members/:id` | GET | Yes | Yes | Yes |
| `PATCH /api/members/:id` | PATCH | No | Yes | Yes |
| `DELETE /api/members/:id` | DELETE | No | Yes | Yes |
| `POST /api/members/:id/photo` | POST | No | Yes | Yes |
| `POST /api/sync-website` | POST | No | No | Yes |

### 3.3 Registration API Access Matrix

Registration endpoints use a separate auth layer based on `reg_role` (and `role` for portal admins).

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `GET /api/reg/admin/bookings` | GET | `role=admin` or `reg_role=reg_admin` | List all bookings |
| `POST /api/reg/admin/bookings` | POST | `role=admin` or `reg_role=reg_admin` | Create booking + guest slots |
| `GET /api/reg/admin/bookings/:id` | GET | `role=admin` or `reg_role=reg_admin` | Booking detail with guests |
| `POST /api/reg/admin/guests` | POST | `role=admin` or `reg_role=reg_admin` | Add guest to booking |
| `PATCH /api/reg/admin/guests/:id` | PATCH | `role=admin` or `reg_role=reg_admin` | Edit guest name/notes |
| `DELETE /api/reg/admin/guests/:id` | DELETE | `role=admin` or `reg_role=reg_admin` | Remove guest |
| `GET /api/reg/admin/export` | GET | `role=admin` or `reg_role=reg_admin` | CSV export of all guests |
| `GET /api/reg/admin/guest-list` | GET | `role=admin` or `reg_role=reg_admin` | JSON guest list grouped by table (for print) |
| `POST /api/reg/admin/send-magic-link/:bookingId` | POST | `role=admin` or `reg_role=reg_admin` | Generate token + send email |
| `GET /api/reg/volunteer/search` | GET | `role=admin` or `reg_role=reg_admin` or `reg_role=reg_volunteer` | Search guests |
| `POST /api/reg/volunteer/arrive/:id` | POST | `role=admin` or `reg_role=reg_admin` or `reg_role=reg_volunteer` | Mark guest arrived |
| `POST /api/reg/volunteer/walkin` | POST | `role=admin` or `reg_role=reg_admin` or `reg_role=reg_volunteer` | Add walk-in + mark arrived |
| `GET /api/reg/dashboard/stats` | GET | Any valid session | Dashboard arrival stats |
| `GET /api/reg/buyer` | GET | Token only (no session) | Load buyer form data |
| `PATCH /api/reg/buyer/guests/:id` | PATCH | Token only (no session) | Update guest name via buyer form |

> **Token auth**: Buyer endpoints bypass session auth entirely. A valid `reg_tokens` row is required, and the form must not be past the configured cutoff time.

---

## 4. Authentication

### 4.1 OTP Flow

1. User enters email on `/login`
2. Frontend sends `POST /api/send-otp` with Turnstile token
3. Backend verifies Turnstile, checks `can_login = 1` in D1
4. If valid, generates 6-digit OTP, stores signed OTP in KV (`swa:otp:{email}`)
5. Resend emails the OTP code
6. User enters OTP, frontend sends `POST /api/verify-otp`
7. Backend verifies OTP signature, looks up member in D1, assigns role
8. Sets `swa_session` cookie with HMAC signature

### 4.2 Rate Limiting

| Endpoint | Limit Type | Window | Max Requests |
|----------|-----------|--------|-------------|
| `POST /api/send-otp` | Per IP | 15 min | 5 |
| `POST /api/verify-otp` | Per IP | 15 min | 10 |
| `POST /api/verify-otp` | Per email | 15 min | 5 |
| `POST /api/verify-otp` | Per OTP | OTP lifetime | 5 failures |
| Authenticated writes* | Per user per endpoint | 15 min | 10 |

> *Authenticated writes include: `POST /api/bookings`, `PATCH /api/bookings/:id/cancel`, `POST /api/members`, `PATCH /api/members/:id`, `DELETE /api/members/:id`, `POST /api/members/:id/photo`, `POST /api/sync-website`, `POST /api/reg/admin/bookings`, `POST /api/reg/admin/guests`, `PATCH /api/reg/admin/guests/:id`, `DELETE /api/reg/admin/guests/:id`, `PATCH /api/reg/buyer/guests/:id`, `POST /api/reg/volunteer/arrive/:id`, `POST /api/reg/volunteer/walkin`.

### 4.3 Magic Link Auth

Buyer-facing endpoints (`/api/reg/buyer/*`) bypass session auth entirely. They use a token-based system:

1. Admin clicks "Send Magic Link" or "Copy Link" on booking detail page
2. System generates a random 32-char hex token, stores in `reg_tokens` table with expiry = `formCutoffTime` from KV
3. Email sent to buyer via Resend with link: `/reg/buyer/?token={token}`
4. Buyer opens link. Frontend calls `GET /api/reg/buyer` with `?token={token}` in query string
5. Backend validates token exists and has not expired
6. Buyer submits guest names via `PATCH /api/reg/buyer/guests/:id` with token in query string
7. After `formCutoffTime`, all buyer endpoints return `{ closed: true, reason: 'cutoff' }`

---

## 5. Feature Specifications

### 5.1 Dashboard (`/`)

**Visibility**: All authenticated users

**Content**:
- Welcome message
- Three cards linking to Office Booking, Namecards, Members
- No role-based restrictions

### 5.2 Office Booking (`/office-booking`)

**Visibility**: All authenticated users

**Features**:
- **Calendar view**: Month-by-month calendar with booking dots per day
- **Day detail panel**: Click a day to see all bookings for that day
- **New booking form**: Name, email, purpose, start/end datetime, attendees, notes
- **List view**: Table of all upcoming bookings with status filter

**Committee vs Admin differences**:
- Both can create bookings and cancel their own bookings
- Admin can cancel **any** booking (List View and Day Detail)
- Both can view all bookings (no visibility restrictions)
- Booking form pre-fills with session name and email

**Server-side validation**:
- End time must be after start time
- Cannot book in the past
- Attendees must be at least 1
- Time conflict check against approved bookings

**Email**: Booking confirmation sent via Resend on creation.

### 5.3 Members (`/members`)

**Visibility**: All authenticated users

**Committee view**:
- Read-only table of all members
- Search by name, email, or role
- Filter by category dropdown
- Columns: Name, Role, Email, Category, Namecard (Yes/No), Login (Yes/No)
- **No Add Member button**
- **No Edit button** per row

**Admin view** (same as committee, plus):
- Add Member button (opens modal)
- Edit button per row (opens modal)
- Modal supports: name, role, category, email, mobile, job title, show_on_website, has_namecard, can_login
- Save triggers POST (new) or PATCH (edit)

### 5.4 Namecards (`/namecards`)

**Visibility**: All authenticated users

**Committee view**:
- Read-only table of members with `has_namecard = 1` OR `show_on_website = 1`
- Columns: Name, Role, Namecard (Yes/No), Visible (Yes/No)
- **No Edit link**
- **No Sync to Website button**

**Admin view** (same as committee, plus):
- Edit link per row (redirects to `/members`)

**IT Admin view** (same as admin, plus):
- Sync to Website button

### 5.5 Website Sync (`/api/sync-website`)

**Visibility**: IT Admin only

**Purpose**: Trigger a rebuild of the public website (`swa2024`) to sync member namecard data.

**Current status**: Not yet implemented (returns 404). When implemented, it will likely trigger a GitHub Actions workflow.

### 5.6 Gala Registration — Admin (`/reg/admin`)

**Visibility**: `role=admin` or `reg_role=reg_admin`

**Features**:
- **Bookings list** (`/reg/admin/bookings`): Table of all bookings with buyer name, table, pax, named/unnamed guest count (colour-coded). Search by buyer name, filter by table.
- **Booking detail** (`/reg/admin/booking-detail?id=...`): Guest rows for a single booking. Add guest, edit guest name/notes, delete guest. "Send Magic Link" button (sends email via Resend). "Copy Link" button (copies buyer form URL to clipboard).
- **CSV export**: Downloads all guests as CSV. Columns: `ticket_code,guest_name,table_label,is_buyer,is_walk_in,booking_ref,buyer_name,buyer_email,arrived_at,notes`.
- **Print guest list**: Generates a print-optimised guest list (A4 landscape) with columns: Ticket Code, Guest Name, Flags (Buyer/Walk-in), Arrived (tick if arrived), Signature (blank), Remarks (blank). Grouped by table with continuous flow. If printed before the event, all arrival columns are blank (clean checklist). If printed during the event, arrived guests show a tick mark. Business continuity fallback: download CSV or print this list for manual check-in at reception.

### 5.7 Gala Registration — Volunteer (`/reg/volunteer`)

**Visibility**: `role=admin` or `reg_role=reg_admin` or `reg_role=reg_volunteer`

**Features**:
- **Search** (`/reg/volunteer/search`): Phone-optimised page with large search input (autofocus). Search by guest name or ticket code. Table filter dropdown.
- **Mark arrived**: One-tap "Mark Arrived" button per result. Shows grey "Arrived at HH:mm" if already checked in.
- **Walk-in** (`/reg/volunteer/add-walkin`): Minimal form to add a guest at the door. Name (required), table (required), notes (optional). Walk-in guests have `booking_id = NULL` and are immediately marked arrived.

### 5.8 Gala Registration — Dashboard (`/reg/dashboard`)

**Visibility**: Any authenticated user

**Features**:
- Stats strip: Total Expected / Total Arrived / Arrival Percentage
- VIP tables section (shown above general tables)
- Per-table row with label, arrived/expected, visual fill bar
- Recent arrivals panel (last 10)
- Auto-refresh every 15 seconds via client-side polling

### 5.9 Gala Registration — Buyer Form (`/reg/buyer`)

**Visibility**: Public (token-gated, no session required)

**Features**:
- Access via magic link: `/reg/buyer/?token=xxx`
- Shows all guest slots for the buyer's booking
- Buyer can fill in guest names and dietary/accessibility notes per slot
- Each slot saves individually
- Saved slots display ticket code (e.g. "Ticket reference: 04-03")
- Form closes at configured cutoff time
- Invalid or expired tokens show a closed/error page
- No sidebar, no auth gate (public page with SWA branding)

### 5.10 Gala Registration — Magic Links

**How it works**:
- Admin clicks "Send Magic Link" on booking detail page
- System generates a random token, stores in `reg_tokens` table with expiry set to `formCutoffTime` from KV config
- Email sent via Resend with unique link to buyer form
- Admin can also click "Copy Link" to copy the URL for manual sharing (WhatsApp etc)
- Tokens are per-booking. One booking = one token.
- After cutoff time, the buyer form shows a "registration closed" message

---

## 6. UI Visibility Rules

### 6.1 Global

| Element | Condition |
|---------|-----------|
| Sidebar nav items | All authenticated users see all items |
| User name in sidebar | All authenticated users |

### 6.2 Members Page (`/members`)

| Element | Visible When |
|---------|-------------|
| Search input | Always |
| Category filter | Always |
| Add Member button | `is_admin === true` |
| Edit button per row | `is_admin === true` |
| Edit modal | Triggered by Add/Edit buttons only |

### 6.3 Namecards Page (`/namecards`)

| Element | Visible When |
|---------|-------------|
| Namecard table | Always |
| Edit link per row | `is_admin === true` |
| Sync to Website button | `is_it_admin === true` |

### 6.4 Office Booking Page (`/office-booking`)

| Element | Visible When |
|---------|-------------|
| Calendar | Always |
| Day detail panel | Always (click to open) |
| New booking form | Always (click + New Booking to toggle) |
| List View toggle | Always |
| Cancel button (day detail) | `created_by === sessionEmail \|\| is_admin` |
| Cancel button (list view) | `created_by === sessionEmail \|\| is_admin` |

### 6.5 Registration Section (Sidebar)

The Registration section is visible to any user with `reg_role` set, or `role=admin`. Items within are gated by reg_role.

| Sidebar Item | Visible When |
|-------------|-------------|
| Bookings | `role=admin` or `regRole=reg_admin` |
| Check-in (Search) | `role=admin` or `regRole=reg_admin` or `regRole=reg_volunteer` |
| Arrivals Dashboard | Any valid session (including `reg_volunteer`) |

Users without `reg_role` and without `role=admin` see only the dashboard link (not Bookings or Check-in).

### 6.6 Registration — Bookings Page (`/reg/admin/bookings`)

| Element | Visible When |
|---------|-------------|
| Booking table | `role=admin` or `regRole=reg_admin` |
| Add Booking button | `role=admin` or `regRole=reg_admin` |
| Download CSV button | `role=admin` or `regRole=reg_admin` |
| Print Guest List button | `role=admin` or `regRole=reg_admin` |
| Search input | Always (within reg admin) |
| Table filter | Always (within reg admin) |
| Named/unnamed count badges | Always (grey=0 named, amber=partial, green=all named) |

### 6.7 Registration — Booking Detail (`/reg/admin/booking-detail`)

| Element | Visible When |
|---------|-------------|
| Guest list | `role=admin` or `regRole=reg_admin` |
| Add Guest inline form | `role=admin` or `regRole=reg_admin` |
| Edit guest name | `role=admin` or `regRole=reg_admin` |
| Delete guest | `role=admin` or `regRole=reg_admin` |
| Send Magic Link button | Booking has a `buyer_email` |
| Copy Link button | Always (generates/retrieves token) |
| Staff note highlight | When guest has `notes` (amber background) |
| Arrived status | "Arrived at HH:mm" or "Not yet" |

### 6.8 Registration — Volunteer Search (`/reg/volunteer/search`)

| Element | Visible When |
|---------|-------------|
| Search input (autofocus) | `role=admin` or `regRole=reg_admin` or `regRole=reg_volunteer` |
| Table filter dropdown | Always (within reg volunteer/admin) |
| Mark Arrived button | Guest not yet arrived |
| "Arrived at HH:mm" label | Guest already arrived |
| Add Walk-in Guest button | Always |
| Staff note banner | When guest has `notes` |

### 6.9 Registration — Buyer Form (`/reg/buyer`)

| Element | Visible When |
|---------|-------------|
| Buyer form (all elements) | Valid, non-expired token AND before form cutoff time |
| "Registration closed" message | Token valid but past cutoff time |
| "Invalid link" message | Token invalid or expired |
| Save button per guest slot | Always (within form) |
| Ticket code display | After guest name is saved |
| Edit button | On previously saved guest names |

---

## 7. Database Schema Reference

### 7.1 `members` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | INTEGER | AUTOINCREMENT | PK |
| `name` | TEXT | NOT NULL | |
| `slug` | TEXT | — | UNIQUE, URL-safe identifier |
| `role` | TEXT | NOT NULL | Display role |
| `email` | TEXT | — | UNIQUE |
| `mobile` | TEXT | — | |
| `job_title` | TEXT | — | |
| `photo_url` | TEXT | — | R2 path |
| `photo_alt` | TEXT | — | |
| `description` | TEXT | — | |
| `category` | TEXT | `'committee'` | `admin`, `committee`, `member`, `volunteer` |
| `can_login` | INTEGER | `0` | `1` = can log in |
| `reg_role` | TEXT | NULL | `reg_admin`, `reg_volunteer`, or NULL |
| `show_on_website` | INTEGER | `1` | `1` = visible on public site |
| `has_namecard` | INTEGER | `0` | `1` = has namecard data |
| `address_line1` | TEXT | — | |
| `address_line2` | TEXT | — | |
| `address_postal_code` | TEXT | — | |
| `address_country` | TEXT | `'Singapore'` | |
| `facebook` | TEXT | — | |
| `linkedin` | TEXT | — | |
| `instagram` | TEXT | — | |
| `tiktok` | TEXT | — | |
| `youtube` | TEXT | — | |
| `sort_order` | INTEGER | `0` | |
| `created_at` | TEXT | `datetime('now')` | |
| `updated_at` | TEXT | `datetime('now')` | |

### 7.2 `office_bookings` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | INTEGER | AUTOINCREMENT | PK |
| `member_id` | INTEGER | — | FK to members (nullable) |
| `booker_name` | TEXT | NOT NULL | |
| `booker_email` | TEXT | NOT NULL | |
| `purpose` | TEXT | NOT NULL | |
| `attendees` | INTEGER | `1` | |
| `start_datetime` | TEXT | NOT NULL | ISO format |
| `end_datetime` | TEXT | NOT NULL | ISO format |
| `notes` | TEXT | — | |
| `status` | TEXT | `'approved'` | `approved` or `cancelled` |
| `created_by` | TEXT | — | Session email |
| `created_at` | TEXT | `datetime('now')` | |
| `updated_at` | TEXT | `datetime('now')` | |

### 7.3 `reg_bookings` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PK, UUID |
| `booking_ref` | TEXT | NOT NULL | UNIQUE, human-readable (e.g. `REG-ABC12`) |
| `buyer_name` | TEXT | NOT NULL | Person who made the reservation |
| `buyer_email` | TEXT | — | Buyer email for magic link |
| `buyer_phone` | TEXT | — | |
| `table_id` | TEXT | NOT NULL | Must match a table ID in KV config |
| `pax` | INTEGER | NOT NULL DEFAULT 1 | Total seats reserved |
| `notes` | TEXT | — | Staff-only operational notes |
| `created_by` | TEXT | NOT NULL | Session email of admin who created |
| `created_at` | TEXT | `datetime('now')` | |
| `updated_at` | TEXT | `datetime('now')` | |

### 7.4 `reg_guests` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PK, UUID |
| `booking_id` | TEXT | — | FK to `reg_bookings`, NULL for walk-ins |
| `table_id` | TEXT | NOT NULL | Must match a table ID in KV config |
| `seat_counter` | INTEGER | NOT NULL | Seat position within table |
| `ticket_code` | TEXT | NOT NULL | UNIQUE, format `{prefix}-{counter}` e.g. `04-07`, `V1-03` |
| `guest_name` | TEXT | — | NULL until filled by buyer or admin |
| `is_buyer` | INTEGER | NOT NULL DEFAULT 0 | 1 for the booking buyer |
| `is_walk_in` | INTEGER | NOT NULL DEFAULT 0 | 1 if added at the door |
| `notes` | TEXT | — | Staff-only (dietary, accessibility) |
| `arrived_at` | TEXT | — | Set when volunteer marks arrival |
| `arrived_by` | TEXT | — | Session email of volunteer |
| `created_at` | TEXT | `datetime('now')` | |
| `updated_at` | TEXT | `datetime('now')` | |

### 7.5 `reg_tokens` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `token` | TEXT | — | PK, 32-char hex random string |
| `booking_id` | TEXT | NOT NULL | FK to `reg_bookings` |
| `created_at` | TEXT | `datetime('now')` | |
| `expires_at` | TEXT | NOT NULL | Set to `formCutoffTime` from KV config |

### 7.6 KV Configuration

**Key**: `swa:reg_tables_config`

```json
{
  "formCutoffTime": "2026-06-20T18:00:00+08:00",
  "tables": [
    { "id": "01", "label": "Table 1", "ticketPrefix": "01", "capacity": 10, "isVIP": false },
    { "id": "02", "label": "Table 2", "ticketPrefix": "02", "capacity": 10, "isVIP": false },
    { "id": "VIP-1", "label": "VIP-1", "ticketPrefix": "V1", "capacity": 10, "isVIP": true },
    { "id": "VIP-2", "label": "VIP-2", "ticketPrefix": "V2", "capacity": 10, "isVIP": true }
  ]
}
```

Table config is always read from KV, never hardcoded. The `formCutoffTime` determines when the buyer form closes and when magic-link tokens expire.

---

## 8. Future Features — Expected Access Tiers

When adding new features, use this guidance:

| Feature Type | Committee | Admin | IT Admin |
|-------------|-----------|-------|----------|
| View-only data | Yes | Yes | Yes |
| Self-service actions | Yes | Yes | Yes |
| Create / edit records | No | Yes | Yes |
| Delete records | No | Yes | Yes |
| Infrastructure / system features | No | No | Yes |
| Billing / payment management | No | Yes | Yes |
| Self-service profile edit | Yes | Yes | Yes |

### Phase 2 (Membership Fees) — Tentative

| Feature | Expected Tier |
|---------|--------------|
| Membership types CRUD | Admin |
| Fee tracking dashboard | Admin |
| Payment confirmation | Admin |
| Payment proof upload | Admin |
| Payment reminders (cron) | Admin |
| Member self-service dashboard | Committee (own data only) |
| Member payment proof upload | Committee (own data only) |

### Phase 3 (CMS + Forms) — Tentative

| Feature | Expected Tier |
|---------|--------------|
| Event posts editor | Admin |
| Image upload | Admin |
| Form submissions view | Admin |
| CSV export | Admin |
| Form migration dashboard | Admin |

---

## 9. Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `UNAUTHORIZED` | 401 | Not logged in |
| `FORBIDDEN` | 403 | Logged in but insufficient role |
| `RATE_LIMITED` | 429 | Too many requests |
| `INVALID_OR_EXPIRED` | 401 | OTP invalid or expired |
| `TOO_MANY_ATTEMPTS` | 429 | Too many OTP failures |
| `TURNSTILE_MISSING` | 400 | Missing Turnstile token |
| `TURNSTILE_FAILED` | 403 | Turnstile verification failed |
| `VALIDATION_ERROR` | 400 | Invalid request body |
| `CONFIG_ERROR` | 500 | Missing server config |
| `TOKEN_INVALID` | 401 | Magic link token invalid or expired |
| `FORM_CLOSED` | 403 | Buyer form past cutoff time |

---

## 10. Key Files Reference

### Core Portal

| File | Purpose |
|------|---------|
| `src/worker/middleware.ts` | Auth + access control + rate limiting |
| `src/worker/lib/rate-limit.ts` | General-purpose authenticated endpoint rate limiting |
| `src/constants/portal.ts` | `IT_ADMIN_EMAILS`, session config, rate limit constants |
| `src/worker/api/verify-otp.ts` | Role assignment at login (includes `regRole`) |
| `src/worker/api/session.ts` | Session reading, returns `is_admin`, `is_it_admin`, `regRole` |
| `src/scripts/auth-gate.ts` | Client-side auth gate, supports `requireAdmin`, `requireItAdmin`, `requireRegAdmin`, `requireRegVolunteer` |
| `src/layouts/AdminLayout.astro` | Sidebar nav with role-gated Registration section |

### Registration Module

| File | Purpose |
|------|---------|
| `src/worker/lib/reg/tables.ts` | KV table config loader and helpers |
| `src/worker/lib/reg/tickets.ts` | Ticket code generation with UNIQUE retry |
| `src/worker/lib/reg/guests.ts` | Guest CRUD operations (D1) |
| `src/worker/lib/reg/tokens.ts` | Magic-link token create and validate |
| `src/worker/lib/reg/email.ts` | Magic-link email via Resend |
| `src/worker/api/reg/` | All registration API handlers |
| `src/worker/api/reg/admin-guest-list.ts` | JSON guest list for print (grouped by table) |
| `src/pages/reg/admin/` | Admin pages (bookings, booking detail) |
| `src/pages/reg/volunteer/` | Volunteer pages (search, add walk-in) |
| `src/pages/reg/buyer/` | Public buyer form (token-gated) |
| `src/pages/reg/dashboard.astro` | Live arrival dashboard |
| `migrations/002_registration.sql` | D1 migration: reg_bookings, reg_guests, reg_tokens, reg_role column |
| `scripts/seed-test-data.sql` | Test data for manual testing |
