-- Migration: Soft delete for members
-- Date: 2026-07-06
--
-- Adds a deleted_at column so the DELETE /api/members/:id endpoint can
-- deactivate a member (timestamp) instead of removing the row. This keeps
-- memberships, membership_applications, and office_bookings foreign keys
-- intact and makes the action reversible (set deleted_at = NULL).
--
-- Existing rows default to deleted_at = NULL (active). Soft-deleted members
-- are excluded from GET /api/members, the OTP issue/verify eligibility
-- queries, and the directory/namecards/roles pages.

ALTER TABLE members ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_members_deleted_at ON members(deleted_at);
