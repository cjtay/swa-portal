# Gala Registration — Functional Spec

> **Status**: live (Gala Dinner 2026 cycle)
> **Guides**: `docs/registration/MAGIC-LINK-GUIDE.md`, `docs/registration/SEED-DATA-GUIDE.md` (historical audit and implementation-plan docs also live in `docs/registration/`)

## 1. Purpose

Table bookings and guest check-in for the gala dinner: admins manage bookings and guests, send magic links so buyers name their own guests, volunteers check guests in at the door, and a live dashboard tracks arrivals.

## 2. Visibility and roles

Access is controlled by `members.reg_role` (on top of the base role):

| reg_role | Grants |
|----------|--------|
| `reg_admin` | Full registration management: bookings, guests, magic links, export, guest list, check-in |
| `reg_volunteer` | Event-night only: search, mark arrived, walk-ins |
| NULL | No registration access beyond what the base role grants |

Portal `admin` always has full access. All `committee` members can check in guests regardless of `reg_role`.

## 3. API permissions

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `GET /api/reg/admin/bookings` | GET | `role=admin` or `reg_role=reg_admin` | List all bookings |
| `POST /api/reg/admin/bookings` | POST | same | Create booking + guest slots |
| `GET /api/reg/admin/bookings/:id` | GET | same | Booking detail with guests |
| `POST /api/reg/admin/guests` | POST | same | Add guest to booking |
| `PATCH /api/reg/admin/guests/:id` | PATCH | same | Edit guest name/notes |
| `DELETE /api/reg/admin/guests/:id` | DELETE | same | Remove guest |
| `GET /api/reg/admin/export` | GET | same | CSV of all guests |
| `GET /api/reg/admin/guest-list` | GET | same | JSON guest list grouped by table (print) |
| `POST /api/reg/admin/send-magic-link/:bookingId` | POST | same | Generate token + send email |
| `GET /api/reg/volunteer/search` | GET | `admin`, `committee`, `reg_admin`, `reg_volunteer` | Search guests |
| `POST /api/reg/volunteer/arrive/:id` | POST | same | Mark guest arrived |
| `POST /api/reg/volunteer/walkin` | POST | same | Add walk-in + mark arrived |
| `GET /api/reg/tables` | GET | Any authenticated | Table config for pickers |
| `GET /api/reg/dashboard/stats` | GET | Any authenticated | Arrival stats |
| `GET /api/reg/buyer/:token` | GET | Token only (no session) | Load buyer form |
| `PATCH /api/reg/buyer/:token/guests/:id` | PATCH | Token only | Update guest name |

Magic-link sends are rate-limited to 5/hour per email (externally visible). Volunteer check-in writes get 30 per 15 minutes (kiosk use).

## 4. Feature behaviour

**Admin bookings** (`/reg/admin/bookings`): table of bookings with buyer, table, pax, colour-coded named/unnamed counts; search and table filter; CSV export; print guest list (A4 landscape, grouped by table, tick column fills in during the event — business-continuity fallback for manual reception check-in).

**Booking detail** (`/reg/admin/booking-detail?id=`): guest rows for one booking — add/edit/delete guests, "Send Magic Link" (needs a `buyer_email`), "Copy Link" for WhatsApp sharing, staff-note highlighting, arrival status.

**Volunteer check-in** (`/reg/volunteer/search`, `/reg/volunteer/add-walkin`): phone-optimised, autofocus search by name or ticket code, one-tap "Mark Arrived", walk-in form showing per-table availability as guidance only (overbooking remains possible; walk-ins have `booking_id = NULL` and arrive immediately).

**Arrivals dashboard** (`/reg/dashboard`): Expected / Arrived / Walk-ins / Arrival % (pre-registered only), VIP tables first, per-table fill bars, recent arrivals, 15-second auto-refresh.

**Buyer form** (`/reg/buyer/?token=…`, public): guest slots for the buyer's booking, each saved individually with its ticket code shown (e.g. `04-03`); closes at the configured cutoff; invalid/expired tokens show a closed page.

**Magic links**: one token per booking (32-char hex) stored in `reg_tokens` with expiry = `formCutoffTime`; emailed via Resend; copy-link for manual sharing.

## 5. UI rules

| Element | Visible When |
|---------|-------------|
| Bookings page + Add/CSV/Print buttons | `role=admin` or `regRole=reg_admin` |
| Booking detail guest CRUD | same |
| Send Magic Link | booking has `buyer_email` |
| Check-in (search/walk-in) | `admin`, `committee`, `reg_admin`, `reg_volunteer` |
| Arrivals Dashboard | any valid session |
| Buyer form elements | valid, unexpired token AND before cutoff |

Events nav grouping hides for users with no event access at all; check-in volunteers (`role=volunteer`) get a scoped view with a dedicated logout.

## 6. Data model (migration 002)

**`reg_bookings`** — `id` (UUID PK), `booking_ref` (UNIQUE, e.g. `REG-ABC12`), `buyer_name`, `buyer_email`, `buyer_phone`, `table_id`, `pax`, `notes`, `created_by`, timestamps.

**`reg_guests`** — `id` (UUID PK), `booking_id` (NULL for walk-ins), `table_id`, `seat_counter`, `ticket_code` (UNIQUE, `{prefix}-{counter}` e.g. `04-07`, `V1-03`), `guest_name`, `is_buyer`, `is_walk_in`, `notes`, `arrived_at`, `arrived_by`, timestamps.

**`reg_tokens`** — `token` (PK), `booking_id`, `expires_at` = cutoff time.

**KV** `swa:reg_tables_config`: `formCutoffTime` + table list (`id`, `label`, `ticketPrefix`, `capacity`, `isVIP`). Always read from KV, never hardcoded.

## 7. Tests and guides

Functional walkthrough and seed data: `docs/registration/` guides above. Historical records (audit, implementation plan) stay in `docs/registration/` as point-in-time documents.
