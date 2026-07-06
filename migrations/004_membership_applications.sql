-- Migration: Membership applications table + linking columns
-- Date: 2026-07-06
--
-- Backfills the membership-application feature (commit 5684268) into databases
-- that pre-date it. The table and columns were added to schema.sql but never
-- had a migration, so existing databases created before the feature are missing
-- them — surfacing as 500s on /api/admin/forms/membership and the approve flow.
--
-- Idempotency:
--   * CREATE TABLE/INDEX use IF NOT EXISTS — safe to re-run.
--   * ALTER TABLE ADD COLUMN is NOT idempotent in SQLite/D1 (errors if the
--     column exists). Apply the two ALTERs conditionally — see the runner or
--     the guarded shell snippet in the apply step. On a fresh DB created from
--     the current schema.sql these columns already exist and must be skipped.

-- 1. membership_applications table -----------------------------------------
-- Includes the approval-gate columns (status, reviewed_by, reviewed_at,
-- member_id) inline so a fresh CREATE matches the current schema.sql.
CREATE TABLE IF NOT EXISTS membership_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_type TEXT NOT NULL DEFAULT 'new',
  full_name TEXT NOT NULL,
  nric TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  address_postal_code TEXT NOT NULL,
  phone_home TEXT,
  phone_office TEXT,
  email TEXT NOT NULL,
  handphone TEXT,
  date_of_birth TEXT,
  place_of_birth TEXT,
  citizenship TEXT,
  occupation TEXT,
  hobbies TEXT,
  skills_experiences TEXT,
  other_associations TEXT,
  membership_intent TEXT NOT NULL,        -- 'administration' | 'services' | 'supportive'
  recommended_by TEXT,
  paynow_r2_key TEXT,                     -- uploaded PayNow screenshot object key
  signature_r2_key TEXT NOT NULL,         -- drawn PNG or uploaded signature image key
  signature_method TEXT NOT NULL,         -- 'draw' | 'upload'
  payment_reference TEXT NOT NULL,        -- MEM-<nameslug>-<rand>; appears in PayNow QR
  payment_amount REAL NOT NULL DEFAULT 30,
  submitted_ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  member_id INTEGER REFERENCES members(id)
);

-- 2. Indexes ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_memapp_email ON membership_applications(email);
CREATE INDEX IF NOT EXISTS idx_memapp_ref ON membership_applications(payment_reference);

-- 3. memberships.application_id --------------------------------------------
-- Traces each paid period back to the original intake record (signature/NRIC
-- evidence). NOT idempotent — guard before running. Added in schema.sql at the
-- same time as the table above; included here for databases that pre-date it.
-- ALTER TABLE memberships ADD COLUMN application_id INTEGER REFERENCES membership_applications(id);

-- 4. members.nric -----------------------------------------------------------
-- Required to de-dupe renewals and match application → member. Same caveat.
-- ALTER TABLE members ADD COLUMN nric TEXT;
