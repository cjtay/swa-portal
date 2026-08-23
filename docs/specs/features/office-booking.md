# Office Booking — Functional Spec

> **Status**: live
> **Replaces**: Microsoft Forms + Power Automate booking flow

## 1. Purpose

Members book the SWA office meeting room; everyone sees the calendar, everyone can book, and admins can cancel any booking (members only their own).

## 2. Visibility and roles

All authenticated users. The only role difference is cancellation scope.

## 3. API permissions

| Endpoint | Method | Committee | Admin/IT |
|----------|--------|-----------|----------|
| `GET /api/bookings` | GET | Yes | Yes |
| `POST /api/bookings` | POST | Yes | Yes |
| `GET /api/bookings/:id` | GET | Yes | Yes |
| `PATCH /api/bookings/:id/cancel` | PATCH | Own only | Any |

Booking creation is rate-limited (10 per 15 min per email).

## 4. Feature behaviour

- **Calendar**: month view with booking dots per day; click a day for its bookings.
- **New booking form**: name, email, purpose, start/end datetime, attendees, notes. Pre-fills the session's name and email.
- **List view**: upcoming bookings with status filter; cancel where permitted.
- **Server-side validation**: end after start, no past bookings, attendees ≥ 1, conflict check against approved bookings.
- **Email**: confirmation via Resend on creation.

## 5. UI rules (`/office-booking`)

| Element | Visible When |
|---------|-------------|
| Calendar, day panel, new booking form, list toggle | Always |
| Cancel button | `created_by === sessionEmail` OR `is_admin` |

## 6. Data model

**`office_bookings`** — `id`, `member_id` (nullable FK), `booker_name`, `booker_email`, `purpose`, `attendees`, `start_datetime`, `end_datetime`, `notes`, `status` (`approved`/`cancelled`), `created_by`, timestamps.
