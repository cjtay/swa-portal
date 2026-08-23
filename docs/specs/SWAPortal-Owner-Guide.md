# SWA Admin Portal — Owner Guide

> **Version**: 2.0 (owner-facing narrative; last updated 2026-05-22 — predates the approval workflow)
> **Renamed** 2026-08-23 from "SWAPortal-Functional-Specification.md" to avoid confusion with the technical specs. The up-to-date technical reference is `docs/specs/SWAPortal-Functional-Specs.md` (core) + `docs/specs/features/`.
> **Purpose**: Comprehensive guide to everything the SWA Admin Portal does — who uses it, how it works, and how all the pieces fit together. Written for non-technical readers with technical detail included where needed.
>
> **Current feature set**: Dashboard, Office Booking, Member Directory, Namecard Management, Gala Dinner Registration, Admin Settings, Authentication

---

## 1. What is the SWA Portal

The SWA Admin Portal is the internal management tool for the Singapore Women's Association (SWA). It is where SWA board members, committee members, and event volunteers handle the operational work of running the association:

| Task | Who does it |
|------|-------------|
| Book the SWA office meeting room | All committee and admin members |
| Maintain the member directory | Admin members only |
| Manage namecards for the public website | Admin and IT Admin members |
| Organise gala dinner seating and check-in | Registration administrators and volunteers |
| Track gala dinner arrivals live | All committee and admin members |

The portal runs as a website at `admin.singaporewomenassociation.org`. It is accessible from any web browser — desktop, tablet, or mobile phone. The check-in features are specifically designed for one-handed phone use on event night.

The portal is separate from the SWA public website (`singaporewomenassociation.org`) and the GTW lucky-draw system (`gtw.singaporewomenassociation.org`). All three are independent systems, each with its own purpose, database, and deployment.

---

## 2. How the Portal is Built — A Plain-English Overview

The portal is built on Cloudflare's global network. This means it loads quickly, stays online reliably, and costs very little to run (within Cloudflare's free tier for a non-profit of SWA's size).

### The Building Blocks

```
 ┌──────────────────────────────────────────────────┐
 │              Your Browser                         │
 │    (desktop, tablet, or mobile phone)              │
 └────────────────────┬─────────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────────┐
 │        Cloudflare Worker (the "server")           │
 │  This is the brain — it handles every request,    │
 │  checks who you are, and decides what to do.       │
 │                                                    │
 │  ┌──────────────┐     ┌──────────────────┐        │
 │  │ Static Pages  │     │  Hono API Worker  │       │
 │  │ (Astro)      │     │  (dynamic data)   │       │
 │  └──────────────┘     └────────┬─────────┘        │
 └────────────────────────────────┼──────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
                    ▼             ▼             ▼
              ┌─────────┐  ┌──────────┐  ┌──────────┐
              │   D1    │  │    KV    │  │    R2    │
              │ Database│  │ Key-Value│  │  File    │
              │         │  │  Store   │  │  Storage │
              └─────────┘  └──────────┘  └──────────┘
              Permanent    Temporary     Uploads
              data         data          (photos)
              (members,    (sessions,    stored as
              bookings,    rate limits,  files)
              guests)      config)

                                  │
                                  ▼
                          ┌──────────────┐
                          │    Resend    │
                          │  Email API   │
                          └──────────────┘
                          Sends OTP
                          codes, booking
                          confirmations,
                          magic links
```

### What Each Piece Does

**Cloudflare Worker** — This is the "application server." When you visit the portal, the Worker runs the code that builds pages, checks your login, and processes your actions. It lives on Cloudflare's global network of data centres, so it responds from whichever location is closest to you.

**Astro (Static Pages)** — The pages you see (the layout, colours, buttons, navigation sidebar) are pre-built as static files. This makes them load fast. Dynamic content (member lists, booking calendars, guest search results) is loaded after the page opens, using JavaScript to fetch data from the API.

**Hono (API Worker)** — When the page needs live data, it calls the API. For example, searching for a guest name sends a request to the API, which queries the database and returns results. The API also handles all the business logic — is this person allowed to do this? Is this table full? Has this guest already arrived?

**D1 Database** — Cloudflare's SQLite-based database. This is where everything permanent lives: member records, office bookings, gala dinner bookings, guest names, arrival timestamps. Think of it as a set of spreadsheets (tables) that can be queried and updated.

**KV Key-Value Store** — A fast, simple storage system for temporary data. Used for:
- Login sessions (your "I am logged in" token)
- Rate limiting counters (how many times has this person tried to log in?)
- Registration table configuration (which tables exist, how many seats each has)

**R2 File Storage** — Cloudflare's file storage (similar to Google Drive or Dropbox, but for the application). Used to store member profile photos that are uploaded through the portal.

**Resend Email API** — Sends all the emails from the portal: one-time passcodes for login, booking confirmation emails for office bookings, and magic link invitations for gala dinner buyers.

### Development vs Production

| Environment | URL | Purpose |
|-------------|-----|---------|
| Production | `admin.singaporewomenassociation.org` | Live site used by SWA |
| Development | `swa-portal.cjtay-4e0.workers.dev` | Testing environment |
| Local | `localhost:4321` (Astro) or `localhost:8787` (Worker) | Developer's computer |

The production and development environments use the same Cloudflare resources (same D1 database, same KV namespaces, same R2 bucket). This means test data in development is visible on the production site and vice versa. Be careful when testing — use separate test bookings if needed.

---

## 3. Who Uses the Portal — Roles & Access

The portal has three levels of access for SWA members, plus a fourth for external buyers of gala dinner seats.

### 3.1 The Four User Types

#### IT Administrator
The system administrator. Currently **three** people hold this role (hardcoded by email address: `cjtay@...`, `angela.wong@...`, `system@...`).

**Can do everything an Admin can do, PLUS:**
- Website synchronisation (triggering a rebuild of the public website)
- Admin settings (table configuration, registration roles)

#### Admin
SWA board members and senior committee members. Determined by having `category = 'admin'` in the member database AND `can_login = 1` (login enabled).

**Can do:**
- Full member management (add, edit, delete members)
- Cancel any office booking (not just their own)
- Manage namecard data (which members appear on the public website)
- Everything in the gala dinner registration system (see table below)

#### Committee Member
SWA committee members. Determined by having `category = 'committee'` (or `'advisor'`) in the member database AND `can_login = 1`. This is the largest group of portal users.

**Can do:**
- Book and cancel their own office bookings
- View the member directory (read-only)
- View namecards (read-only)
- Check in guests at the gala dinner (search, mark arrived, add walk-ins)
- View the live arrival dashboard

#### Buyer (External — Gala Dinner Only)
A person or company that has purchased seats at the gala dinner. They are NOT SWA members and do NOT log into the portal. Instead, they receive a unique "magic link" via email that lets them access one specific page: the guest registration form where they fill in the names of their guests. This link works on any device and does not require any account or password.

### 3.2 Registration Sub-Roles

For the gala dinner event, two additional roles provide finer-grained control over who manages what:

| Sub-Role | Meaning | Who typically gets this |
|----------|---------|------------------------|
| `reg_admin` | Registration administrator | SWA staff managing the entire dinner logistics |
| `reg_volunteer` | Registration volunteer | SWA members working the reception desk on event night |

These sub-roles are stored in the `reg_role` column on each member's record. They are separate from the member's main `category` (admin/committee). This means a committee member can be given `reg_admin` access for the dinner without being promoted to full portal admin, and a volunteer who is not even a committee member can be given `reg_volunteer` access solely for event night.

> **Important**: All committee and admin members can check in guests at the gala dinner regardless of their `reg_role` value. The `reg_role` column only controls access to registration **admin** features (booking creation, exports, magic links).

### 3.3 How Roles Are Determined (The Login Flow)

When you log in, the system does not check your email domain (e.g., `@singaporewomenassociation.org`). It only checks one thing: does this email exist in the `members` table with `can_login = 1`?

```
1. You enter your email on the login page
2. The system checks the members database:
   - Is can_login = 1? → Yes, proceed
   - Is can_login = 0? → "Access denied" (not authorised to log in)
   - Email not found? → "Access denied"
3. A 6-digit code is sent to your email
4. You enter the code
5. The system looks up your record again and determines your role:
   - Email in IT_ADMIN_EMAILS? → IT Admin
   - category = 'admin'? → Admin
   - Otherwise → Committee
6. Your reg_role (if any) is also read from your member record
7. A session is created — you are now logged in
```

The session lasts for 7 days or until you log out. You do not need to enter an OTP every time you visit.

### 3.4 The Complete Access Matrix

| Feature | Committee | Admin | IT Admin | Buyer (Public) |
|---------|-----------|-------|----------|----------------|
| **Dashboard** | View | View | View | — |
| **Office Booking — View calendar** | Yes | Yes | Yes | — |
| **Office Booking — Create** | Yes | Yes | Yes | — |
| **Office Booking — Cancel own** | Yes | Yes | Yes | — |
| **Office Booking — Cancel others'** | No | Yes | Yes | — |
| **Members — View list** | Yes | Yes | Yes | — |
| **Members — Add / Edit / Delete** | No | Yes | Yes | — |
| **Members — Upload photo** | No | Yes | Yes | — |
| **Namecards — View list** | Yes | Yes | Yes | — |
| **Namecards — Edit** | No | Yes | Yes | — |
| **Website Sync** | No | No | Yes | — |
| **Admin Settings** | No | No | Yes | — |
| **Registration — Create bookings** | No (`reg_admin` only) | Yes | Yes | — |
| **Registration — Edit/delete guests** | No (`reg_admin` only) | Yes | Yes | — |
| **Registration — Export CSV** | No (`reg_admin` only) | Yes | Yes | — |
| **Registration — Send magic links** | No (`reg_admin` only) | Yes | Yes | — |
| **Registration — Check-in guests** | Yes (all committee) | Yes | Yes | — |
| **Registration — Add walk-ins** | Yes (all committee) | Yes | Yes | — |
| **Registration — View dashboard** | Yes (any auth user) | Yes | Yes | — |
| **Registration — Buyer form** | — | — | — | Yes (token) |

---

## 4. Logging In — How Authentication Works

The portal does not use passwords. Instead, it uses one-time passcodes (OTP) sent to your email. This means:
- No passwords to remember or reset
- No accounts to manage (your member record IS your account)
- Security is tied to your email inbox — if someone else has access to your email, they could log in (same as any password-reset flow)

### The Login Flow

1. You visit `admin.singaporewomenassociation.org/login`
2. You see the login page with an email input, a "I am human" checkbox (Turnstile), and a "Send Code" button
3. You enter your email and complete the Turnstile check
4. The system checks if your email exists in the member database with `can_login = 1`. If not, you see a generic "access denied" message
5. If authorised, a 6-digit code is generated and emailed to you from `contactus@singaporewomenassociation.org`
6. You enter the 6-digit code on the login page
7. The system verifies the code is correct and has not expired (codes last 10 minutes)
8. You are logged in and redirected to the dashboard

### Protections Against Abuse

| Protection | How it works |
|------------|-------------|
| Turnstile (bot check) | Prevents automated scripts from requesting OTP codes |
| OTP rate limit | Maximum 5 code requests per 15 minutes from the same IP address |
| Verify rate limit | Maximum 10 verification attempts per IP address per 15 minutes |
| Failure limit | Maximum 5 wrong code entries per OTP before that code is invalidated |
| Code expiry | OTP codes expire after 10 minutes |

### The Session Cookie

After successful login, your browser receives a secure cookie called `swa_session`. This cookie contains:

- Your email address
- Your full name
- Your role (admin or committee)
- Your registration sub-role (if any)
- An expiry timestamp (7 days from login)

The cookie is cryptographically signed using a secret key (HMAC-SHA256). This means the cookie cannot be forged or tampered with — the server can always verify it is authentic. When you visit any page on the portal, the server reads this cookie to know who you are and what you are allowed to do.

### Magic Link Authentication (Buyers Only)

Buyers do not log into the portal. Instead, they receive a unique "magic link" — a URL containing a 32-character random token. When they visit this URL, the system validates the token and loads their specific booking's guest form. No session, no cookie, no password.

Magic link tokens are:
- 128-bit random (mathematically infeasible to guess)
- Stored in the database with an expiry time (set to the form cutoff time from KV config)
- Scoped to one booking only (the token can only access guests from that booking)
- Usable by anyone who has the link (intentional — allows delegation)

See Section 9.5 for the full magic link workflow.

---

## 5. Dashboard

The dashboard (`/`) is the first page you see after logging in. It shows:

- A welcome message with your name
- Cards linking to each feature module:
  - **Office Booking** — Book the SWA office meeting room
  - **Namecards** — Manage which members appear on the public website
  - **Members** — Searchable member directory
  - **Gala Registration** — Manage dinner bookings and check guests in

The sidebar navigation on the left provides quick access to all modules. The Registration section in the sidebar is role-gated:
- **Bookings** — Visible to portal admins and `reg_admin` members
- **Check-in** — Visible to all committee members, admins, and registration volunteers
- **Arrivals Dashboard** — Visible to anyone who is logged in

---

## 6. Office Booking

### What It Does

The Office Booking feature lets SWA members reserve the association's meeting room. Anyone who can log in can book the office. Committee members can only cancel their own bookings; admins can cancel anyone's.

### How to Book

1. Navigate to **Office Booking** from the sidebar
2. Use the calendar to browse months. Days with existing bookings show coloured dots
3. Click a day to see all bookings for that date in the detail panel
4. Click **New Booking** to open the booking form
5. Fill in: your name and email (pre-filled from your session), the meeting purpose, start and end date/time, number of attendees, and any notes
6. Click **Create Booking**

### Rules

- The end time must be after the start time
- You cannot book in the past
- Attendees must be at least 1
- The system checks for time conflicts — two approved bookings cannot overlap for the same time slot
- All bookings are automatically approved (there is no approval workflow — the office operates on trust)

### Cancelling

**Cancelling your own booking**: Find your booking in the calendar day view or the list view. Click Cancel. Only the person who created the booking can cancel it (by default).

**Cancelling someone else's booking**: Admins can cancel any booking from either the day detail panel or the list view table. This is useful if someone booked the office but is no longer using it.

### Confirmation Email

When you create a booking, a confirmation email is sent to your email address via Resend. The email includes the date, time, purpose, and a cancellation reminder. It uses SWA's purple branding.

### List View

The **List View** toggle switches from the calendar to a table showing all upcoming bookings. Admins can filter by status (approved/cancelled) and cancel any booking directly from this table.

---

## 7. Member Directory

### What It Is

The member directory (`/members`) is a searchable, filterable table of all SWA members stored in the portal's database. It is the single source of truth for member contact information, roles, and login access.

### What Committee Members Can Do

- View the full member list
- Search by name, email, or role
- Filter by category (admin, committee, member, volunteer)
- See each member's name, role, email, category, namecard status (Yes/No), and login status (Yes/No)

### What Admins Can Do (Everything Above, Plus)

- **Add a new member**: Click the "Add Member" button, fill in the form (name, role, category, email, mobile, job title, and flags for show_on_website, has_namecard, can_login), and save
- **Edit a member**: Click the edit icon on any row, modify fields in the modal, and save
- **Delete a member**: Click the delete icon on any row
- **Upload a member photo**: The API supports photo upload to R2 storage (frontend UI for this is still being completed)

### Key Fields Explained

| Field | What it means |
|-------|--------------|
| `name` | Full name of the member |
| `slug` | URL-safe version of the name (e.g., `angela-wong`). Used for public website namecard URLs |
| `role` | Display role (e.g., "President", "Treasurer") |
| `category` | Member type: `admin`, `committee`, `advisor`, `member`, or `volunteer`. Determines portal access level |
| `can_login` | `1` means this person can log into the portal. `0` means they cannot. Only admins can toggle this |
| `reg_role` | Registration sub-role for gala dinner: `reg_admin`, `reg_volunteer`, or blank (no registration access) |
| `show_on_website` | `1` means this member appears on the public website's namecard directory |
| `has_namecard` | `1` means this member has namecard data (photo, description, social links) |
| `sort_order` | Controls the display order on the public website (lower numbers appear first) |

---

## 8. Namecard Management

> **REMOVED 19-07-2026** — Public-website integration dropped. swa-portal is now isolated from swa2024. The `/namecards` page, the `/api/sync-website` plumbing, and the `members.slug`/`photo_url`/`description`/`show_on_website`/`has_namecard`/social-link columns were removed (see migration `006_remove_website_columns.sql`). Historical spec preserved below for audit only.

### What It Is

The Namecards page (`/namecards`) shows which SWA members have namecard profiles that appear on the public website. A namecard on the public website includes the member's photo, role, description, and social media links.

### How It Works

- The page shows members who have `has_namecard = 1` OR `show_on_website = 1`
- Clicking a namecard row redirects to the Members page where details can be edited
- The **Sync to Website** button (IT Admin only) is intended to trigger a rebuild of the public website, so that changes to namecard data are reflected on `singaporewomenassociation.org`

### Current Status

- Namecard data management is live
- Photo upload API exists but the frontend upload UI in the edit modal is pending
- The Sync to Website button exists in the UI but the `/api/sync-website` route is not yet registered (clicking it returns a 404 error)
- Once implemented, it will trigger a GitHub Actions workflow that rebuilds the public website

---

## 9. Gala Dinner Registration

This is the newest and most detailed feature module. It was built to manage guest registration, seating, and arrival tracking for the 49th SWA Annual Charity Dinner 2026.

### 9.1 The Big Picture — How the Registration System Works

The registration system has four stages, each involving a different group of people:

```
STAGE 1                STAGE 2               STAGE 3                STAGE 4
Admin creates          Buyer fills in         Volunteer checks       Dashboard shows
bookings               guest names            in guests              live arrivals

┌──────────┐         ┌──────────┐          ┌──────────┐          ┌──────────┐
│  Admin   │         │  Buyer   │          │Volunteer │          │ Organiser│
│ (Portal) │         │ (Email)  │          │  (Phone) │          │ (Phone)  │
└────┬─────┘         └────┬─────┘          └────┬─────┘          └────┬─────┘
     │                     │                    │                     │
     ▼                     ▼                    ▼                     ▼
Creates booking      Opens magic link     Searches guest       Watches arrival
with pax count       names each guest     by name or ticket    stats update
Table A, 5 seats     Sarah, John, etc.    "Mark Arrived"       every 15 seconds
     │                     │                    │                     │
     ▼                     ▼                    ▼                     │
5 guest slots         5 names filled       Guest record         ┌────┴────┐
auto-generated        in 1 by 1           timestamped          │ Expected │
ticket codes          buyer can revise    arrived_by logged    │ Arrived  │
assigned              until cutoff                              │ Walk-ins │
                                                                │    %     │
                                                                └─────────┘
```

**Stage 1 — Admin creates bookings (weeks before the event)**: SWA staff receive seat reservations from buyers (companies, individuals, organisations). An admin creates a "booking" in the portal — a reservation of N seats at a specific table. The system automatically generates N "guest slots" — placeholder seats with unique ticket codes (e.g., `04-07` for Table 4, Seat 7). The first slot is pre-filled with the buyer's name.

**Stage 2 — Buyer fills in guest names (before cutoff)**: The admin sends a "magic link" email to the buyer. The buyer opens the link (no login required), sees their guest slots, and fills in each guest's name. They can also add dietary or accessibility notes. Buyers can return to the form multiple times before the cutoff time to update names.

**Stage 3 — Volunteer checks in guests (event night)**: At the venue entrance, volunteers use their phones to search for guests by name or ticket code. When a guest arrives, the volunteer taps "Mark Arrived" — the guest's record is timestamped with the arrival time and the volunteer's identity. Guests without bookings (walk-ins) can be added on the spot.

**Stage 4 — Dashboard tracks arrivals (event night)**: Organisers monitor a live dashboard showing arrival progress: total expected vs arrived, per-table breakdown, and a scrolling list of the most recent arrivals. The dashboard auto-refreshes every 15 seconds.

### 9.2 Tables and Ticket Codes

#### Table Configuration

Tables are configured in a KV (key-value) store — not hardcoded in the application. This means tables can be added, removed, or modified without changing any code. The configuration lives at the KV key `swa:reg_tables_config` and looks like this:

```
Tables for the 49th Dinner:
┌───────┬─────────────┬──────────┬──────────┬───────┐
│  ID   │ Label       │ Prefix   │ Capacity │  VIP  │
├───────┼─────────────┼──────────┼──────────┼───────┤
│  01   │ Table 1     │    01    │    10    │  No   │
│  02   │ Table 2     │    02    │    10    │  No   │
│  ...  │ ...         │   ...    │   ...    │   -   │
│  23   │ Table 23    │    23    │    10    │  No   │
│ VIP-1 │ VIP Table 1 │    V1    │    10    │  Yes  │
│ VIP-2 │ VIP Table 2 │    V2    │    10    │  Yes  │
└───────┴─────────────┴──────────┴──────────┴───────┘
```

Each table has:
- **ID** — Internal identifier, must be unique
- **Label** — Human-readable name shown in the UI
- **Ticket Prefix** — Used to generate ticket codes (usually matches the table number)
- **Capacity** — Maximum seats at this table
- **VIP Flag** — VIP tables are shown separately and at the top of the dashboard

#### How Ticket Codes Work

Ticket codes uniquely identify each seat. The format is `{prefix}-{seat_number}`:

- Table 4, Seat 7 → `04-07`
- VIP Table 1, Seat 3 → `V1-03`
- Table 15, Seat 10 → `15-10`

Each ticket code is unique across the entire event (enforced by the database). This means `04-07` can only exist once — you cannot accidentally assign the same code to two guests.

#### Seat Allocation

When a guest slot is created (either during booking creation or when adding a guest later), the system:

1. Looks at all existing guests at that table
2. Finds the highest seat number currently in use
3. Assigns the next number (e.g., if seats 1-5 exist, the next guest gets seat 6)
4. Generates the ticket code from the prefix and seat number
5. If two people try to assign a seat at the exact same moment (extremely rare), the system detects the collision and retries automatically

> **Known limitation**: The system does not currently enforce table capacity limits. A table set to capacity 10 can have more than 10 guests assigned to it. This is tracked as a known issue for future improvement.

### 9.3 Admin — Creating and Managing Bookings

#### Booking List (`/reg/admin/bookings`)

The admin bookings page shows all dinner reservations in a table:

| Column | What it shows |
|--------|--------------|
| Booking Ref | Unique code like `REG-A3F2K` |
| Buyer Name | The person or company who reserved the seats |
| Table | Which table the booking is at |
| Pax | Total seats reserved |
| Named | How many guest names have been filled in (colour-coded: grey = none, amber = partial, green = all done) |

The page includes a search input (by buyer name) and a table filter dropdown. Admins can download a CSV export of all guests and view a print-optimised guest list grouped by table.

#### Creating a Booking

1. Click **Add Booking**
2. Fill in the form:
   - **Buyer Name** — The person or organisation who purchased the seats (required)
   - **Buyer Email** — For sending the magic link later (optional but needed for buyer self-service)
   - **Buyer Phone** — Contact number (optional)
   - **Table** — Select from the dropdown of configured tables
   - **Number of Guests (Pax)** — How many seats are reserved (minimum 1)
   - **Notes** — Staff-only notes (optional, not visible to buyers)
3. Click **Create**

When the booking is created, the system automatically generates the guest slots:
- 1 guest slot per pax
- The first slot is tagged as the "buyer" and pre-filled with the buyer's name
- Remaining slots are blank (guest_name = NULL) — waiting for the buyer to fill them in
- Each slot gets a unique ticket code

#### Booking Detail (`/reg/admin/booking-detail?id=...`)

Clicking a booking from the list opens its detail page. This shows:

- **Booking header**: Buyer name, table label, pax count, named/unnamed count
- **Guest list**: One row per guest slot showing:
  - Ticket code (e.g., `04-07`)
  - Guest name (blank until filled in, editable by admin)
  - Notes (staff-only, shown with amber highlight when present)
  - Arrival status (timestamp if arrived, "Not yet" if not)
  - Edit and delete buttons per row
- **Add Guest form**: A form at the top to add an extra guest to this booking (increments the pax count)
- **Send Magic Link button**: Sends the buyer an email with a link to the self-service form (only enabled if the booking has an email address)
- **Copy Link button**: Copies the magic link URL to the clipboard for manual sharing

#### Editing and Deleting Guests

Admins can:
- **Edit a guest name** — Click edit, type the name, save. This can be done even after the guest has arrived (unlike the buyer form, which blocks edits after arrival)
- **Edit notes** — Staff-only notes for dietary requirements, accessibility needs, etc.
- **Delete a guest** — Removes the guest slot and decrements the booking's pax count

> **Known limitation**: Deleting the buyer guest (the first seat, tagged as the buyer) leaves the booking with no buyer-linked guest. The buyer's name remains on the booking record but no guest row carries the `is_buyer` flag. Avoid deleting the buyer's own seat unless removing the entire booking.

#### CSV Export

The CSV export downloads all guests as a spreadsheet file. Columns include:

`ticket_code, guest_name, table_label, is_buyer, is_walk_in, booking_ref, buyer_name, buyer_email, arrived_at, notes`

This export is used to feed guest names into the e-ticket generator (a separate tool that creates individual PDF/PNG e-tickets).

#### Print Guest List

The `GET /api/reg/admin/guest-list` endpoint returns a JSON response that powers a print-optimised guest list. It shows all tables — including empty seats — with their ticket codes. Each seat shows:
- Ticket code
- Guest name (if filled in)
- Whether the guest is a buyer or walk-in
- Arrival status
- Blank space for a physical signature (when printed)

This serves as a paper backup for check-in: if the electronic system fails, volunteers can check guests in manually on the printed list.

### 9.4 Admin Settings — Table Configuration and User Roles

The **Admin Settings** page (`/admin/settings`) is accessible only to IT Admins. It contains two cards:

#### Table Configuration
- View the current table configuration loaded from KV (`swa:reg_tables_config`)
- Edit the list: add tables, remove tables, change capacities, toggle VIP status, update ticket prefixes
- Set the **form cutoff time** — the deadline after which the buyer form closes (e.g., "2026-06-20T18:00:00+08:00")
- Changes are saved directly to KV and take effect immediately

> **Warning**: Do not remove a table ID that has existing bookings or guests. Check `SELECT DISTINCT table_id FROM reg_bookings` first.

#### Registration User Roles
- Lists all members who have `can_login = 1`
- Shows each member's current `reg_role` (Registration Admin, Registration Volunteer, or None)
- Allows changing a member's `reg_role` via a dropdown selector
- Changes are saved individually via the Members API
- Unsaved changes are highlighted in yellow

### 9.5 Magic Links — How Buyers Register Their Guests

#### The Concept

A magic link is a personalised URL sent to a buyer, letting them fill in guest names without needing a SWA Portal login. This is the biggest time-saver in the registration system — instead of SWA staff calling every buyer to collect names, buyers self-serve.

#### Sending a Magic Link

1. Admin opens a booking's detail page
2. Admin clicks **Send Magic Link** (if the booking has a buyer email) or **Copy Link** (to share manually)
3. The system generates a 32-character random token (or reuses an existing non-expired token)
4. The token is stored in the `reg_tokens` database table with an expiry set to the form cutoff time

If using **Send Magic Link**, an email is sent via Resend:
- From: `SWA Portal <contactus@singaporewomenassociation.org>`
- Subject: `49th SWA Annual Charity Dinner 2026 — Please register your guests`
- Body: Personalised with the buyer's name, booking reference, number of seats, table name, and a big "Register My Guests" button
- The button links to `https://admin.singaporewomenassociation.org/reg/buyer/?token={32-char-hex-token}`
- The email states the deadline: "This link will remain active until [cutoff time]"

If using **Copy Link**, the URL is copied to the admin's clipboard. The admin can paste it into WhatsApp, SMS, or any other messaging channel.

#### Token Security

- 128-bit random value — mathematically infeasible to guess or brute-force
- Each token is scoped to one booking only. The API validates that the guest being edited belongs to the booking linked to the token
- Tokens expire at the configured form cutoff time
- The buyer form page has meta tags to prevent search engine indexing
- If a token is compromised, the admin can delete the token row from the database and generate a new one

#### Token Lifespan

- Tokens are per-booking (one booking = one token)
- If the admin clicks "Send Magic Link" multiple times and the existing token has not expired, the same token is reused
- If the existing token has expired, a new token is created with the current cutoff time
- **Changing the cutoff time in KV does not retroactively change existing tokens**. Existing tokens keep their original expiry. If you extend the deadline, you must delete old tokens and re-send magic links for the new deadline to take effect

### 9.6 Buyer — Self-Service Guest Registration

#### The Buyer Experience

1. The buyer receives an email with a "Register My Guests" button
2. They click it and open the SWA-branded registration page (no login required)
3. The page shows:
   - Their name and booking reference
   - The table they are seated at
   - How many guests they have registered for
   - A deadline: "You can return to this page any time before [cutoff date/time] to make changes"
4. Below the header, each seat is shown as a card:
   - Seat 1 (Buyer) — pre-filled and editable
   - Seats 2, 3, 4... — showing "Enter guest name" with input fields
5. The buyer types each guest's name and clicks **Save**
6. Once saved, the name is confirmed with a "Saved" badge and the corresponding ticket code is displayed
7. A dietary/accessibility requirements field is available per guest (optional)
8. The buyer can **Edit** any previously saved name by clicking the edit button

#### What the Buyer Can and Cannot Do

**Can do:**
- Fill in guest names for their booking
- Edit previously saved names (until cutoff)
- Add dietary/accessibility notes
- Return to the form multiple times
- Access the form from any device (phone, tablet, computer)

**Cannot do:**
- Add extra seats (the pax count is fixed by the booking)
- Delete guest slots
- See other bookings' data
- Access the form after the cutoff time
- See staff-only notes

#### Cutoff Time

The cutoff time is configured in KV (`formCutoffTime` in `swa:reg_tables_config`). When the current time passes the cutoff:

- The buyer form shows "Guest registration has closed for this event. If you have any questions, please contact SWA directly."
- All buyer endpoints return a "closed" response
- Buyers can no longer edit names through the form
- Admins can still edit names directly in the booking detail page (the cutoff only affects the buyer form)
- The existing data remains — nothing is deleted

#### Link Forwarding

The magic link can be forwarded to anyone. This is intentional:
- A company representative can forward the link to their assistant to fill in details
- A table host can share the link with co-hosts
- All changes are incremental (no "delete all" button)
- Admins can monitor changes in the booking detail page and manually revert if needed

#### Error States

| What happened | What the buyer sees |
|---------------|-------------------|
| Token does not exist or was deleted | "This link is invalid or has expired." |
| Token expired (past form cutoff time) | "Guest registration has closed for this event." |
| Booking was deleted | "This link is invalid or has expired." |

### 9.7 Volunteer — Guest Check-In (Event Night)

The volunteer check-in page is designed for fast, single-handed use on a mobile phone during the event.

#### Searching for a Guest (`/reg/volunteer/search`)

1. Open the check-in page on your phone
2. A large search input is auto-focused — start typing immediately
3. Search by guest name OR ticket code (e.g., type "Sarah" or "04-07")
4. Optionally filter by table using the dropdown
5. Results appear below the search bar. Each result shows:
   - Guest name (in bold) — or an input field to add the name if blank
   - Ticket code (e.g., `04-07`)
   - Table label (e.g., "Table 4")
   - Staff notes banner (amber highlight, if present)
   - A big green **Mark Arrived** button — or a grey "Arrived at 19:32" label if already checked in

#### Marking a Guest as Arrived

1. Find the guest by name or ticket code
2. Tap the green **Mark Arrived** button
3. The guest is immediately marked as arrived. The button turns into a grey "Arrived at HH:MM" label
4. No confirmation dialog — the action is one-tap

Behind the scenes, the system records:
- The arrival timestamp
- Which volunteer performed the check-in (by their session email)
- The guest is only marked once (if two volunteers attempt to check in the same guest simultaneously, only the first one succeeds)

#### Adding a Walk-In Guest (`/reg/volunteer/add-walkin`)

A walk-in guest is someone who arrives at the dinner without a pre-existing booking. Volunteers can add them on the spot:

1. Tap **Add Walk-In Guest** from the search page
2. Fill in:
   - **Guest Name** (required) — The person's name
   - **Table** (required) — Select from the dropdown. Each table shows "N seats left" or "FULL (overbooked)" for guidance, but all tables remain selectable
   - **Notes** (optional, staff only) — Dietary or accessibility requirements
3. Tap **Add and Check In**

The walk-in guest is created in the database with:
- `booking_id = NULL` (not linked to any booking)
- `is_walk_in = 1` (flagged as a walk-in)
- `arrived_at` set immediately (they are present by definition)
- A unique ticket code auto-generated based on the table

#### Updating a Guest Name (Volunteer)

If a guest arrives without their name pre-filled (the buyer never completed the form), the volunteer can add it:

1. Find the guest by ticket code
2. If the name is blank, an input field appears instead of the name
3. Type the guest's name and tap **Save**
4. Once marked as arrived, the name can no longer be edited through the volunteer interface

### 9.8 Live Arrival Dashboard (`/reg/dashboard`)

The dashboard is a read-only page that any logged-in SWA member can view. It shows real-time arrival progress and auto-refreshes every 15 seconds.

#### Stats Strip (Top)

Four large number cards:

| Card | What it shows | Definition |
|------|--------------|------------|
| **Expected** | Total pre-registered guests | Count of guests who are not walk-ins, regardless of whether their name has been filled in |
| **Arrived** | Total checked in (pre-registered) | Count of non-walk-in guests with `arrived_at` set |
| **Walk-ins** | Walk-in guests | Count of guests with `is_walk_in = 1` |
| **Arrival %** | Percentage arrived | `(Arrived ÷ Expected) × 100`, pre-registered guests only |

> **Important**: Walk-ins are counted separately and do not affect the Arrival %. They are additional guests beyond the pre-registered count.

#### Table List

Below the stats strip, all tables are listed — VIP tables first, then by table ID. Each table row shows:

- **Table label** (e.g., "VIP-1", "Table 4")
- **Arrived / Capacity** (e.g., "7 / 10")
- **+N walk-in** annotation if the table has walk-in guests (e.g., "+2 walk-in" means 2 additional people seated here beyond the pre-registered count)
- **Visual fill bar**: grey when empty, amber as guests arrive, green when all pre-registered guests have arrived

#### Recent Arrivals

A scrolling list of the 10 most recent check-ins, showing:
- Guest name (or "Guest" if name not filled in)
- Table label
- Arrival time (e.g., "19:32")

This gives organisers a real-time feed of who is coming through the door without being at the reception desk.

---

## 10. How the Data is Stored

### 10.1 The Database (D1)

The portal uses one database with multiple tables. Think of each table as a spreadsheet with rows and columns.

#### `members` — The Central Person Database

Every person who interacts with the portal has a row in the `members` table. This includes board members, committee members, volunteers, and general members. Each row stores:

- **Identity**: Name, email, phone number, job title, role
- **Portal access**: category (admin/committee/member/volunteer), can_login flag, reg_role
- **Public website**: whether they appear on the website, their photo, description, social media links, sort order

This table is the single source of truth. The portal does not maintain a separate user accounts table — the members table IS the accounts table.

#### `office_bookings` — Meeting Room Reservations

Each office booking is a row with the booker's details, the date/time range, the meeting purpose, attendee count, and booking status (approved or cancelled).

#### `reg_bookings` — Gala Dinner Reservations

Each dinner booking is a row representing one buyer's reservation of N seats at a specific table. Key details:

| What it stores | Example |
|----------------|---------|
| Booking reference | `REG-A3F2K` |
| Buyer name | "Tan Enterprises Pte Ltd" |
| Buyer email | `tan@example.com` |
| Table | "Table 4" |
| Number of seats (pax) | 5 |
| Who created it | `admin@swa.org` |

#### `reg_guests` — Individual Guest Records

Each guest slot is a separate row. A booking with pax=5 has 5 guest rows. Walk-in guests also have rows here (but with `booking_id = NULL`). Key details:

| What it stores | Example | Notes |
|----------------|---------|-------|
| Ticket code | `04-07` | Unique across all guests |
| Guest name | "Sarah Lim" | NULL until buyer or admin fills it in |
| Table | "Table 4" | Where the guest is seated |
| Seat number | 7 | Position at the table |
| is_buyer | 0 or 1 | 1 = this is the person who made the booking |
| is_walk_in | 0 or 1 | 1 = added at the door, not pre-booked |
| Notes | "Vegetarian" | Staff-only dietary/accessibility |
| arrived_at | `2026-06-21T19:32:00+08:00` | NULL until checked in |
| arrived_by | `volunteer@swa.org` | Who checked them in |

#### `reg_tokens` — Magic Link Tokens

One token per booking. Each row stores the random 32-character token string, which booking it belongs to, when it was created, and when it expires.

#### `error_log` — Error Tracking

When something goes wrong (API error, database failure), an entry is written here. This helps with debugging without needing to inspect Worker logs.

### 10.2 Key-Value Store (KV)

KV is used for data that needs fast access or temporary storage:

| KV Key | What it stores | Purpose |
|--------|---------------|---------|
| `swa:otp:{email}` | Encrypted OTP code | Temporary storage during login |
| `swa:session:{hash}` | Session data | Verifying your login across page visits |
| `swa:ratelimit:*` | Rate limit counters | Preventing API abuse |
| `swa:reg_tables_config` | Table configuration JSON | Gala dinner table layout and cutoff time |

### 10.3 File Storage (R2)

R2 stores uploaded files:
- Member profile photos (uploaded via `POST /api/members/:id/photo`)
- Future: payment proof receipts, event images

---

## 11. Security & Safeguards

### 11.1 Session Security

- Sessions use HMAC-SHA256 cryptographic signing. The session cookie cannot be forged or modified without detection
- A separate `SESSION_SECRET` (set via `wrangler secret put`) is used to sign cookies — this secret is never exposed to clients
- Session expiry is enforced both in the cookie (7 days) and verified server-side on every request

### 11.2 Rate Limiting

The portal limits how often certain actions can be performed. This prevents accidental or malicious overuse:

| Action | Limit | Window |
|--------|-------|--------|
| Request OTP code | 5 per IP | 15 minutes |
| Verify OTP code | 10 per IP | 15 minutes |
| Verify OTP code (per email) | 5 per email | 15 minutes |
| Wrong OTP entries | 5 per code | Until expired |
| Authenticated write actions | 10 per user per endpoint | 15 minutes |

Authenticated write actions include: creating bookings, editing members, deleting members, marking guests as arrived, adding walk-ins. Read actions (viewing lists, searching) are not rate-limited.

The buyer form endpoints (`/api/reg/buyer/*`) are NOT currently rate-limited, as they bypass the session-based rate limiter. Token validation provides some protection (only those with a valid, non-guessable token can access these endpoints).

### 11.3 Access Control Layers

Access control happens at multiple levels:

1. **Middleware (server-side)** — Every API request passes through the auth middleware. It checks: Is this person logged in? What role do they have? Is this endpoint allowed for their role?

2. **Auth gate (client-side)** — Before a page loads, the browser checks the session. Unauthorised visitors are redirected to the login page. Pages that require specific roles (e.g., registration admin) redirect to the dashboard.

3. **UI visibility (client-side)** — Buttons and controls are shown or hidden based on the user's role. For example, the "Add Member" button only appears for admins. This is a convenience measure, not a security measure — the server always enforces authorisation regardless of what the UI shows.

### 11.4 What's Public vs Private

| Page/Endpoint | Who can access |
|---------------|---------------|
| Login page (`/login`) | Anyone |
| Buyer registration form (`/reg/buyer`) | Anyone with a valid token |
| Buyer form closed page (`/reg/buyer/closed`) | Anyone |
| Everything else | Must be logged in (session required) |

The buyer form is the only public-facing feature. It uses its own token-based security rather than session-based authentication. All other pages and API endpoints require a valid `swa_session` cookie.

### 11.5 Email Security

- OTP codes are 6 random digits, stored encrypted in KV, with a 10-minute expiry
- Magic link tokens are 128-bit random (32 hex characters), stored in D1 with an expiry matching the form cutoff time
- All emails are sent through Resend's API with TLS encryption
- The email sender address (`contactus@singaporewomenassociation.org`) is verified in Resend
- No passwords or sensitive data are included in email bodies

---

## 12. API Endpoints Reference

### 12.1 Authentication

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/health` | GET | Public | Health check |
| `/api/session` | GET | Cookie | Get current session info |
| `/api/turnstile-config` | GET | Public | Get Turnstile site key for login page |
| `/api/send-otp` | POST | Public + Turnstile | Request OTP code |
| `/api/verify-otp` | POST | Public | Verify OTP code, create session |

### 12.2 Office Bookings

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/bookings` | GET | Session | List all bookings |
| `/api/bookings` | POST | Session | Create a booking |
| `/api/bookings/:id` | GET | Session | Get booking details |
| `/api/bookings/:id/cancel` | PATCH | Session (creator or admin) | Cancel a booking |

### 12.3 Members

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/members` | GET | Session | List all members |
| `/api/members` | POST | Admin only | Create a member |
| `/api/members/:id` | GET | Session | Get member details |
| `/api/members/:id` | PATCH | Admin only | Update a member |
| `/api/members/:id` | DELETE | Admin only | Delete a member |
| `/api/members/:id/photo` | POST | Admin only | Upload member photo (R2) |

### 12.4 Registration — Admin

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/reg/admin/bookings` | GET | Admin or reg_admin | List all dinner bookings |
| `/api/reg/admin/bookings` | POST | Admin or reg_admin | Create booking + guest slots |
| `/api/reg/admin/bookings/:id` | GET | Admin or reg_admin | Booking detail with guests |
| `/api/reg/admin/guests` | POST | Admin or reg_admin | Add guest to existing booking |
| `/api/reg/admin/guests/:id` | PATCH | Admin or reg_admin | Edit guest name/notes |
| `/api/reg/admin/guests/:id` | DELETE | Admin or reg_admin | Remove guest |
| `/api/reg/admin/export` | GET | Admin or reg_admin | Download CSV of all guests |
| `/api/reg/admin/guest-list` | GET | Admin or reg_admin | JSON guest list grouped by table |
| `/api/reg/admin/send-magic-link/:bookingId` | POST | Admin or reg_admin | Generate token + email buyer |

### 12.5 Registration — Volunteer

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/reg/volunteer/search` | GET | Committee, admin, reg_admin, or reg_volunteer | Search guests by name/ticket code |
| `/api/reg/volunteer/arrive/:id` | POST | Committee, admin, reg_admin, or reg_volunteer | Mark guest as arrived |
| `/api/reg/volunteer/walkin` | POST | Committee, admin, reg_admin, or reg_volunteer | Add walk-in + mark arrived |
| `/api/reg/volunteer/guest/:id` | POST | Committee, admin, reg_admin, or reg_volunteer | Update guest name (not after arrival) |

### 12.6 Registration — Buyer (Token-Gated, No Session)

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/reg/buyer/:token` | GET | Token only | Load booking + guests for buyer form |
| `/api/reg/buyer/:token/guests/:id` | PATCH | Token only | Update guest name via buyer form |

### 12.7 Registration — Shared

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/reg/dashboard/stats` | GET | Any valid session | Dashboard arrival statistics |
| `/api/reg/tables` | GET | Any valid session | Table configuration + occupancy |

### 12.8 Admin Settings

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/admin/settings` | GET | IT Admin only | Get admin settings |
| `/api/admin/settings` | POST | IT Admin only | Save admin settings |

---

## 13. Detailed Database Schema

### 13.1 `members` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | INTEGER | AUTOINCREMENT | Primary key |
| `name` | TEXT | NOT NULL | Full name |
| `slug` | TEXT | NULL, UNIQUE | URL-safe identifier (e.g., `angela-wong`) for public website namecard URLs |
| `role` | TEXT | NOT NULL | Display role (e.g., "President") |
| `email` | TEXT | NULL, UNIQUE | Email address used for login |
| `mobile` | TEXT | NULL | Phone number |
| `job_title` | TEXT | NULL | Professional title |
| `photo_url` | TEXT | NULL | R2 path to uploaded photo |
| `photo_alt` | TEXT | NULL | Alt text for photo |
| `description` | TEXT | NULL | Bio / description for public website |
| `category` | TEXT | `'committee'` | `admin`, `committee`, `advisor`, `member`, or `volunteer` |
| `can_login` | INTEGER | `0` | `1` = can log into the portal |
| `reg_role` | TEXT | NULL | `reg_admin`, `reg_volunteer`, or NULL |
| `show_on_website` | INTEGER | `1` | `1` = visible on public website namecard directory |
| `has_namecard` | INTEGER | `0` | `1` = has namecard data (photo, description, social links) |
| `address_line1` | TEXT | NULL | |
| `address_line2` | TEXT | NULL | |
| `address_postal_code` | TEXT | NULL | |
| `address_country` | TEXT | `'Singapore'` | |
| `facebook` | TEXT | NULL | Social media profile URLs |
| `linkedin` | TEXT | NULL | |
| `instagram` | TEXT | NULL | |
| `tiktok` | TEXT | NULL | |
| `youtube` | TEXT | NULL | |
| `sort_order` | INTEGER | `0` | Display order on public website (lower first) |
| `created_at` | TEXT | `datetime('now')` | Auto-set on creation |
| `updated_at` | TEXT | `datetime('now')` | Auto-set on update |

### 13.2 `office_bookings` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | INTEGER | AUTOINCREMENT | Primary key |
| `member_id` | INTEGER | NULL | FK to members (optional reference) |
| `booker_name` | TEXT | NOT NULL | Name of the person booking |
| `booker_email` | TEXT | NOT NULL | Email of the person booking |
| `purpose` | TEXT | NOT NULL | Meeting purpose / description |
| `attendees` | INTEGER | `1` | Number of people attending |
| `start_datetime` | TEXT | NOT NULL | ISO 8601 start time |
| `end_datetime` | TEXT | NOT NULL | ISO 8601 end time |
| `notes` | TEXT | NULL | Additional notes |
| `status` | TEXT | `'approved'` | `approved` or `cancelled` |
| `created_by` | TEXT | NULL | Session email of creator |
| `created_at` | TEXT | `datetime('now')` | |
| `updated_at` | TEXT | `datetime('now')` | |

Status constraint: `CHECK(status IN ('approved', 'cancelled'))`

### 13.3 `reg_bookings` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | Primary key, UUID |
| `booking_ref` | TEXT | NOT NULL, UNIQUE | Human-readable code (e.g., `REG-A3F2K`) |
| `buyer_name` | TEXT | NOT NULL | Person or organisation who reserved seats |
| `buyer_email` | TEXT | NULL | Email for magic link (needed for buyer self-service) |
| `buyer_phone` | TEXT | NULL | Contact number |
| `table_id` | TEXT | NOT NULL | Must match a table ID in KV config |
| `pax` | INTEGER | NOT NULL DEFAULT 1 | Total seats reserved |
| `notes` | TEXT | NULL | Staff-only operational notes |
| `created_by` | TEXT | NOT NULL | Session email of admin who created |
| `created_at` | TEXT | `datetime('now')` | |
| `updated_at` | TEXT | `datetime('now')` | |

### 13.4 `reg_guests` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | Primary key, UUID |
| `booking_id` | TEXT | NULL | FK to `reg_bookings`. NULL = walk-in guest |
| `table_id` | TEXT | NOT NULL | Must match a table ID in KV config |
| `seat_counter` | INTEGER | NOT NULL | Seat position at the table (1, 2, 3...) |
| `ticket_code` | TEXT | NOT NULL, UNIQUE | Format `{prefix}-{seat}` (e.g., `04-07`, `V1-03`) |
| `guest_name` | TEXT | NULL | NULL until filled by buyer or admin |
| `is_buyer` | INTEGER | NOT NULL DEFAULT 0 | 1 if this guest is the booking buyer |
| `is_walk_in` | INTEGER | NOT NULL DEFAULT 0 | 1 if added at the door on event night |
| `notes` | TEXT | NULL | Dietary, accessibility, or other operational notes (staff only) |
| `arrived_at` | TEXT | NULL | ISO 8601 timestamp, NULL until checked in |
| `arrived_by` | TEXT | NULL | Session email of volunteer who checked in |
| `created_at` | TEXT | `datetime('now')` | |
| `updated_at` | TEXT | `datetime('now')` | |

Foreign key: `booking_id REFERENCES reg_bookings(id)` (no CASCADE — guests are not automatically deleted when a booking is deleted)

### 13.5 `reg_tokens` Table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `token` | TEXT | — | Primary key, 32-char hex random string |
| `booking_id` | TEXT | NOT NULL | FK to `reg_bookings` |
| `created_at` | TEXT | `datetime('now')` | |
| `expires_at` | TEXT | NOT NULL | Set to formCutoffTime from KV at creation time |

Foreign key: `booking_id REFERENCES reg_bookings(id)` (no CASCADE)

### 13.6 `error_log` Table

Stores API errors for debugging. Columns: `id`, `endpoint`, `error_type`, `error_message`, `http_status`, `user_email`, `created_at`.

---

## 14. KV Configuration Reference

### 14.1 `swa:reg_tables_config` — Gala Dinner Table Configuration

This KV key stores the table layout for the gala dinner. It must be set before any registration features can be used.

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
      "id": "VIP-1",
      "label": "VIP Table 1",
      "ticketPrefix": "V1",
      "capacity": 10,
      "isVIP": true
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `formCutoffTime` | ISO 8601 string | When the buyer form closes. Must include timezone (e.g., `+08:00`) |
| `tables[].id` | string | Unique table identifier, matches `reg_bookings.table_id` and `reg_guests.table_id` |
| `tables[].label` | string | Human-readable name displayed in the UI |
| `tables[].ticketPrefix` | string | Used to generate ticket codes (usually matches table number, e.g., `01`, `V1`) |
| `tables[].capacity` | number | Maximum seats at this table |
| `tables[].isVIP` | boolean | `true` = VIP table (shown separately and at top of dashboard) |

**Important**: 
- Do not remove a `table_id` that has existing bookings or guests
- The `formCutoffTime` must include a timezone offset (e.g., `+08:00` for Singapore). Without it, JavaScript interprets the time as UTC, which would be 8 hours off
- Changing the cutoff time does NOT retroactively update existing token expiry times. To extend the deadline for existing buyers, you must delete old tokens and re-send magic links

### 14.2 Other KV Keys (Managed Automatically)

These keys are managed by the system — you do not need to set them manually:

| Key Pattern | Purpose |
|-------------|---------|
| `swa:otp:{email}` | OTP codes during login |
| `swa:session:*` | Login session data |
| `swa:ratelimit:*` | Rate limiting counters |
| `swa:settings:tables` | Admin settings (table config managed via UI) |

---

## 15. Error Codes

When an API request fails, the response includes an `error_code` and a human-readable `message`. These codes help with debugging and can be shown to users where appropriate.

| Code | HTTP Status | When it happens |
|------|------------|-----------------|
| `UNAUTHORIZED` | 401 | You need to log in first |
| `FORBIDDEN` | 403 | You are logged in but do not have permission for this action |
| `RATE_LIMITED` | 429 | You have made too many requests — wait and try again |
| `INVALID_OR_EXPIRED` | 401 | The OTP code is wrong or has expired |
| `TOO_MANY_ATTEMPTS` | 429 | Too many wrong OTP attempts — request a new code |
| `TURNSTILE_MISSING` | 400 | The "I am human" check was not completed |
| `TURNSTILE_FAILED` | 403 | The "I am human" check failed |
| `VALIDATION_ERROR` | 400 | The data you submitted is invalid (e.g., missing required field) |
| `CONFIG_ERROR` | 500 | Server configuration is missing (e.g., KV table config not set) |
| `TOKEN_INVALID` | 401 | The magic link token is invalid or expired |
| `FORM_CLOSED` | 403 | The buyer form has passed its cutoff time |
| `UNEXPECTED_ERROR` | 500 | Something went wrong on the server |

---

## 16. What's Coming Next

The portal is designed to grow. The current feature set (Phase 1) establishes the foundation. Future phases are planned but not yet implemented.

### Phase 2: Membership Fees

| Feature | What it will do |
|---------|----------------|
| Membership types | Define fee categories (Ordinary, Life, etc.) |
| Fee tracking | See who has paid, who is outstanding, who is overdue |
| Payment confirmation | Admins can mark payments as received |
| Payment proof upload | Members can upload screenshots of bank transfers |
| Payment reminders | Automated email reminders for overdue fees (scheduled via cron) |
| Member self-service | Members can log in to view their own fee status and upload payments |

### Phase 3: Content Management & Form Migration

| Feature | What it will do |
|---------|----------------|
| Event posts editor | Create and publish event announcements to the public website |
| Image upload | Upload event photos with Cloudinary integration |
| Form migration | Replace 16 Microsoft Forms with native portal forms (contact, volunteer registration, sponsorship, event enrolment, etc.) |
| CSV export | Generic export for form submissions |

### How New Features Fit In

New features follow the same access control pattern:

| Feature type | Committee | Admin | IT Admin |
|-------------|-----------|-------|----------|
| View-only data | Yes | Yes | Yes |
| Self-service actions | Yes (own data) | Yes | Yes |
| Create / edit records | No | Yes | Yes |
| Delete records | No | Yes | Yes |
| Infrastructure / system settings | No | No | Yes |
| Financial / billing management | No | Yes | Yes |

When adding a new feature to the portal:
- API routes go under `/api/...` in the Hono worker
- Pages go under `src/pages/...` using Astro and the AdminLayout
- New database tables are defined in migration files under `migrations/`
- Auth middleware is updated with the appropriate role checks for new endpoints
- The sidebar navigation is updated in `AdminLayout.astro` with role-gated visibility

---

## 17. Key Files and Where to Find Them

### Core Portal Infrastructure

| File | What it does |
|------|-------------|
| `src/worker/index.ts` | Main application — registers all API routes |
| `src/worker/middleware.ts` | Authentication and access control for every API request |
| `src/worker/types.ts` | TypeScript type definitions for the application |
| `src/constants/portal.ts` | Hardcoded configuration (IT admin emails, session duration, rate limits) |
| `src/layouts/AdminLayout.astro` | Page layout with sidebar navigation (shared by all admin pages) |
| `src/scripts/auth-gate.ts` | Browser-side authentication checks |
| `src/styles/admin.css` | SWA purple brand styling |

### Authentication

| File | What it does |
|------|-------------|
| `src/worker/api/send-otp.ts` | Generates and emails OTP login codes |
| `src/worker/api/verify-otp.ts` | Verifies OTP codes and creates sessions |
| `src/worker/api/session.ts` | Reads the current session from the cookie |
| `src/worker/lib/crypto.ts` | Cryptographic functions (HMAC signing, base64 encoding) |
| `src/worker/lib/email-otp.ts` | OTP email HTML template |
| `src/worker/lib/rate-limit.ts` | Rate limiting logic |

### Office Booking

| File | What it does |
|------|-------------|
| `src/worker/api/bookings.ts` | Booking CRUD API and conflict validation |
| `src/worker/lib/email-booking.ts` | Booking confirmation email template |
| `src/pages/office-booking.astro` | Calendar UI and booking form |

### Member Directory & Namecards

| File | What it does |
|------|-------------|
| `src/worker/api/members.ts` | Member CRUD API and photo upload |
| `src/pages/members.astro` | Searchable member directory with edit modal |
| `src/pages/namecards.astro` | Namecard management table |

### Gala Dinner Registration

| File | What it does |
|------|-------------|
| `src/worker/api/reg/admin-bookings.ts` | Booking creation and listing API |
| `src/worker/api/reg/admin-guests.ts` | Guest CRUD API (add, edit, delete) |
| `src/worker/api/reg/admin-guest-list.ts` | JSON guest list grouped by table (for print) |
| `src/worker/api/reg/admin-export.ts` | CSV export of all guests |
| `src/worker/api/reg/admin-magic-link.ts` | Magic link token generation and email sending |
| `src/worker/api/reg/volunteer-search.ts` | Guest search, mark arrived, walk-in, update guest name |
| `src/worker/api/reg/buyer-form.ts` | Buyer-facing magic link form (token-gated) |
| `src/worker/api/reg/reg-dashboard.ts` | Live dashboard statistics |
| `src/worker/api/reg/reg-tables.ts` | Table configuration + occupancy data |
| `src/worker/lib/reg/tables.ts` | KV table config loading and helpers |
| `src/worker/lib/reg/tickets.ts` | Ticket code generation and seat allocation |
| `src/worker/lib/reg/guests.ts` | Guest database operations (CRUD, stats) |
| `src/worker/lib/reg/tokens.ts` | Magic link token creation and validation |
| `src/worker/lib/reg/email.ts` | Magic link email HTML template and Resend sending |
| `src/pages/reg/admin/bookings.astro` | Admin booking list page |
| `src/pages/reg/admin/booking-detail.astro` | Admin booking detail page |
| `src/pages/reg/volunteer/search.astro` | Volunteer check-in search page |
| `src/pages/reg/volunteer/checkin.astro` | Volunteer check-in actions page |
| `src/pages/reg/volunteer/add-walkin.astro` | Add walk-in guest form |
| `src/pages/reg/buyer/index.astro` | Public buyer guest registration form |
| `src/pages/reg/buyer/closed.astro` | Buyer form closed/error page |
| `src/pages/reg/dashboard.astro` | Live arrival dashboard |

### Database & Migrations

| File | What it does |
|------|-------------|
| `schema.sql` | Full D1 database schema |
| `migrations/002_registration.sql` | Registration tables migration |
| `seed-members.sql` | Seed data — 19 members (17 board + 2 IT admin) |
| `scripts/seed-test-data.sql` | Test data — 32 bookings, 250 guests across 25 tables |

---

## 18. Known Limitations

The guest registration module has several known issues identified during an independent code audit. These are documented in full at `docs/registration/GUEST-REGISTRATION-AUDIT.md`.

Key items to be aware of:

| Issue | Impact | Workaround |
|-------|--------|------------|
| Table capacity not enforced | A table set to 10 seats can have more than 10 guests assigned | Manually verify counts before the event |
| No transaction wrapping on booking creation | If an error occurs mid-creation, partial data may be left behind | Verify bookings after creation; delete and recreate if incomplete |
| Booking ref collision check is single-pass | Extremely unlikely but theoretically possible collision | Retry booking creation if it fails with a reference error |
| Email delivery failures not signalled to the admin | Admin may think a magic link was sent when it actually failed | Use "Copy Link" and share manually if the buyer did not receive the email |
| CSV export vulnerable to formula injection | Guest names starting with `=`, `+`, `-`, or `@` could execute as spreadsheet formulas | Trusted admins only; fix planned |
| No length limits on name/notes fields | Very long strings could be stored, affecting database size and UI rendering | None currently; fix planned |
| Buyer can edit guest names after arrival | Buyer form does not block edits once a guest is checked in | Notify volunteers to confirm names before marking arrived; fix planned |

These items are tracked for resolution in a future maintenance cycle.

---

## 19. Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-05-13 | Initial functional specification (developer-focused) |
| 2.0 | 2026-05-22 | Comprehensive rewrite for non-technical audience; expanded registration module detail; added architecture overview, security section, known limitations, and forward-looking phases |
