# Member Directory — Functional Spec

> **Status**: live
> **Related**: membership lifecycle (`docs/plans/membership-lifecycle-plan.md`), namecards (`features/namecards.md`)

## 1. Purpose

The member directory is the portal's identity list: contact details, category, login eligibility, membership status and fees. It is also the auth system's source of truth (who may log in, what role they get).

## 2. Visibility and roles

| Capability | Committee | Admin | IT Admin |
|------------|-----------|-------|----------|
| View list / search / filter | Yes | Yes | Yes |
| Add / edit / soft-delete members | No | Yes | Yes |
| View member dependencies | Yes | Yes | Yes |
| Record fee payments | No | Yes | Yes |

IT admins are governed by `IT_ADMIN_EMAILS` and may log in without a members row.

## 3. API permissions

| Endpoint | Method | Committee | Admin/IT |
|----------|--------|-----------|----------|
| `GET /api/members` | GET | Yes | Yes |
| `POST /api/members` | POST | No | Yes |
| `GET /api/members/:id` | GET | Yes | Yes |
| `PATCH /api/members/:id` | PATCH | No | Yes |
| `DELETE /api/members/:id` | DELETE | No | Yes (soft delete) |
| `GET /api/members/:id/dependencies` | GET | Yes | Yes |
| `GET /api/members/:id/payments` | GET | No | Yes |
| `POST /api/members/:id/payments` | POST | No | Yes |

Member writes are rate-limited (10 per 15 min per method per email). Deletes are soft (`deleted_at`), keeping foreign keys intact. Creating or promoting a member into a board category auto-generates their namecard (soft-fail — never blocks the member write).

## 4. Feature behaviour

- Table with search (name/email/role) and category filter.
- Committee view is read-only; admin gets Add Member and per-row Edit (modal).
- Membership lifecycle fields on each member: `membership_status`, `fee_due_date` (anchored to 31 January), `fee_waived` (advisors default 1).
- Fee recording writes to `membership_payments` (append-only, one row per payment).
- The API deliberately omits `nric` from reads (de-duplication only, never leaves the API).

## 5. UI rules (`/members`)

| Element | Visible When |
|---------|-------------|
| Search input, category filter | Always |
| Add Member button | `is_admin` |
| Edit button per row | `is_admin` |
| Edit modal | Triggered by Add/Edit only |

## 6. Data model

**`members`** (core identity; column list current as of migration 010):

| Column | Notes |
|--------|-------|
| `id`, `created_at`, `updated_at` | Standard |
| `name`, `role`, `email` (UNIQUE), `mobile`, `job_title` | Identity |
| `category` | `admin` / `committee` / `advisor` / `member` / `volunteer` |
| `can_login` | 1 = may log in (drives send-otp eligibility) |
| `address_line1/2`, `address_postal_code`, `address_country` | Address |
| `sort_order` | Directory ordering |
| `membership_status`, `fee_due_date`, `fee_waived` | Membership lifecycle |
| `nric` | De-duplication only; never returned by the API |
| `reg_role` | `reg_admin` / `reg_volunteer` / NULL (gala module) |
| `deleted_at` | Soft delete marker |

Public-website columns (`slug`, `photo_url`, `show_on_website`, `has_namecard`, social links) were removed on 19-07-2026 (migration 006).

**`membership_payments`** — `member_id`, `paid_date`, `amount`, `method`, `reference`, `recorded_by`. The fee source of truth (the old `memberships` / `membership_types` tables are dormant).

Membership fee amounts live in code, not the database: first year S$20 (Jan–Jun submissions) / S$10 (Jul–Dec), renewal S$20 — `src/constants/portal.ts`.
