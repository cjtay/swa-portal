-- Migration: Add created_by column and update status constraint
-- Date: 2026-05-12

-- Step 1: Since we cannot ALTER a CHECK constraint in D1, we recreate the table.
-- D1 does not support ALTER TABLE ... ALTER CONSTRAINT.

-- First, rename the old table
ALTER TABLE office_bookings RENAME TO office_bookings_old;

-- Create the new table with updated schema
CREATE TABLE office_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER REFERENCES members(id),
  booker_name TEXT NOT NULL,
  booker_email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  attendees INTEGER DEFAULT 1,
  start_datetime TEXT NOT NULL,
  end_datetime TEXT NOT NULL,
  notes TEXT,
  status TEXT DEFAULT 'approved' CHECK (status IN ('approved', 'cancelled')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Copy data from old table (map old status values)
INSERT INTO office_bookings (id, member_id, booker_name, booker_email, purpose, attendees, start_datetime, end_datetime, notes, status, created_by, created_at, updated_at)
SELECT
  id,
  member_id,
  booker_name,
  booker_email,
  purpose,
  attendees,
  start_datetime,
  end_datetime,
  notes,
  CASE
    WHEN status IN ('pending', 'approved') THEN 'approved'
    WHEN status IN ('rejected', 'cancelled') THEN 'cancelled'
    ELSE 'approved'
  END,
  '',
  created_at,
  updated_at
FROM office_bookings_old;

-- Drop the old table
DROP TABLE office_bookings_old;