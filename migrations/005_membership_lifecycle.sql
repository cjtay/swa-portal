-- Migration: Membership lifecycle — per-member fields + payment log
-- Date: 2026-07-14
-- Plan: docs/plans/membership-lifecycle-plan.md §5
--
-- Adds three columns to `members` that replace the half-built memberships/
-- membership_types tables as the source of truth for fee tracking, plus
-- a new append-only `membership_payments` log. Also adds a `request_body`
-- column to `error_log` for post-incident forensics (pattern adopted from
-- the gtw2026 project's gtw_error_log table).
--
-- All changes are ADDITIVE. Nothing is dropped, no data is transformed.
-- NOTE (15-07-2026): the planned `committee → exco` rename was DROPPED.
-- The `committee` category value is retained as-is. Production data and
-- seed data already use `committee`; login logic in verify-otp.ts maps
-- `committee` → the 'committee' session tier. No data UPDATE is needed.
--
-- Idempotency:
--   ALTER TABLE ADD COLUMN is NOT idempotent in SQLite/D1. Apply
--   conditionally — each statement below errors if the column already
--   exists. On a fresh DB created from the current schema.sql (which
--   mirrors these columns) they will already exist and must be skipped.
--
-- Apply locally:
--   ./node_modules/.bin/wrangler d1 execute swa-portal --local --file=migrations/005_membership_lifecycle.sql
--
-- Apply to production (after backup + approval):
--   ./node_modules/.bin/wrangler d1 execute swa-portal --remote --file=migrations/005_membership_lifecycle.sql

-- Per-member lifecycle fields.
-- membership_status: 'active' | 'inactive'. 'pending' lives on
--   membership_applications.status, NOT here.
-- fee_due_date: stored ISO YYYY-MM-DD. Displayed as DD-MM-YYYY in UI.
-- fee_waived: 0 | 1. Advisors are permanently waived (fee_waived=1).
ALTER TABLE members ADD COLUMN membership_status TEXT DEFAULT 'active';
ALTER TABLE members ADD COLUMN fee_due_date TEXT;
ALTER TABLE members ADD COLUMN fee_waived INTEGER DEFAULT 0;

-- Append-only payment log. One row per payment.
CREATE TABLE IF NOT EXISTS membership_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  paid_date TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT DEFAULT 'paynow',
  reference TEXT,
  recorded_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mempay_member ON membership_payments(member_id);
CREATE INDEX IF NOT EXISTS idx_mempay_date ON membership_payments(paid_date);

-- Forensic capture: redacted/truncated request body for debugging.
-- Pattern adopted from gtw2026's gtw_error_log (used successfully in the
-- 2026-06-20 D1 incident post-mortem).
ALTER TABLE error_log ADD COLUMN request_body TEXT;
