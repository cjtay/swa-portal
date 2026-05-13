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

> **Own only** for booking cancel: the backend checks `created_by === sessionEmail`.

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

> *Authenticated writes include: `POST /api/bookings`, `PATCH /api/bookings/:id/cancel`, `POST /api/members`, `PATCH /api/members/:id`, `DELETE /api/members/:id`, `POST /api/members/:id/photo`, `POST /api/sync-website`.

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

---

## 10. Key Files Reference

| File | Purpose |
|------|---------|
| `src/worker/middleware.ts` | Auth + access control + rate limiting |
| `src/worker/lib/rate-limit.ts` | General-purpose authenticated endpoint rate limiting |
| `src/constants/portal.ts` | `IT_ADMIN_EMAILS`, session config, rate limit constants |
| `src/worker/api/verify-otp.ts` | Role assignment at login |
| `src/worker/api/session.ts` | Session reading, returns `is_admin` and `is_it_admin` |
| `src/scripts/auth-gate.ts` | Client-side auth gate, supports `requireAdmin` and `requireItAdmin` |
