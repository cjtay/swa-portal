-- Migration: Registration module tables + reg_role column
-- Date: 2026-05-19

-- Add reg_role to members table
ALTER TABLE members ADD COLUMN reg_role TEXT DEFAULT NULL;

-- Table bookings: one row per table reservation (a buyer reserves N seats at a table)
CREATE TABLE IF NOT EXISTS reg_bookings (
  id               TEXT PRIMARY KEY,
  booking_ref      TEXT NOT NULL UNIQUE,
  buyer_name       TEXT NOT NULL,
  buyer_email      TEXT,
  buyer_phone      TEXT,
  table_id         TEXT NOT NULL,
  pax              INTEGER NOT NULL DEFAULT 1,
  notes            TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reg_bookings_ref    ON reg_bookings(booking_ref);
CREATE INDEX idx_reg_bookings_table  ON reg_bookings(table_id);
CREATE INDEX idx_reg_bookings_email  ON reg_bookings(buyer_email);

-- Guest records: one row per expected attendee
CREATE TABLE IF NOT EXISTS reg_guests (
  id               TEXT PRIMARY KEY,
  booking_id       TEXT,
  table_id         TEXT NOT NULL,
  seat_counter     INTEGER NOT NULL,
  ticket_code      TEXT NOT NULL UNIQUE,
  guest_name       TEXT,
  is_buyer         INTEGER NOT NULL DEFAULT 0,
  is_walk_in       INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  arrived_at       TEXT,
  arrived_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (booking_id) REFERENCES reg_bookings(id)
);

CREATE INDEX idx_reg_guests_booking    ON reg_guests(booking_id);
CREATE INDEX idx_reg_guests_table      ON reg_guests(table_id);
CREATE INDEX idx_reg_guests_name       ON reg_guests(guest_name);
CREATE INDEX idx_reg_guests_ticket     ON reg_guests(ticket_code);
CREATE INDEX idx_reg_guests_arrived    ON reg_guests(arrived_at);

-- Magic-link tokens: one per booking, for buyer-facing form access
CREATE TABLE IF NOT EXISTS reg_tokens (
  token            TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES reg_bookings(id)
);

CREATE INDEX idx_reg_tokens_booking ON reg_tokens(booking_id);