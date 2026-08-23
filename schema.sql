-- Members (core data, replaces markdown frontmatter for admin-managed data)
-- category values: 'admin', 'committee', 'advisor', 'member', 'volunteer'.
-- 'committee' is retained (the committee→exco rename was dropped on 15-07-2026).
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  email TEXT UNIQUE,
  mobile TEXT,
  job_title TEXT,
  category TEXT DEFAULT 'committee',
  can_login INTEGER DEFAULT 0,
  address_line1 TEXT,
  address_line2 TEXT,
  address_postal_code TEXT,
  address_country TEXT DEFAULT 'Singapore',
  sort_order INTEGER DEFAULT 0,
  -- Membership lifecycle fields (migration 005)
  membership_status TEXT DEFAULT 'active',
  fee_due_date TEXT,
  fee_waived INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Office Bookings (replaces Microsoft Forms + Power Automate)
CREATE TABLE IF NOT EXISTS office_bookings (
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
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Membership Fees (Phase 2 foundation — defined now for schema stability)
CREATE TABLE IF NOT EXISTS membership_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  fee_amount REAL NOT NULL,
  duration_months INTEGER NOT NULL DEFAULT 12,
  description TEXT,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER REFERENCES members(id),
  membership_type_id INTEGER REFERENCES membership_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  fee_amount REAL NOT NULL,
  payment_status TEXT DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'overdue', 'waived')),
  payment_method TEXT,
  payment_reference TEXT,
  payment_date TEXT,
  reminder_count INTEGER DEFAULT 0,
  last_reminder_sent TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Error Log
-- request_body added in migration 005 for post-incident forensics
-- (pattern adopted from gtw2026's gtw_error_log).
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at TEXT DEFAULT (datetime('now')),
  endpoint TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  http_status INTEGER,
  user_email TEXT,
  request_body TEXT
);

-- Membership Payments (append-only log — migration 005)
-- One row per payment. Replaces the memberships/membership_types tables
-- as the fee tracking source of truth. Those tables stay dormant in the DB.
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_can_login ON members(can_login);
CREATE INDEX IF NOT EXISTS idx_mempay_member ON membership_payments(member_id);
CREATE INDEX IF NOT EXISTS idx_mempay_date ON membership_payments(paid_date);

-- Volunteer Registrations (public form at /reg/volunteer/register)
-- Generic/reusable: event_key ties rows to a configured event in KV
--   (swa:volunteer_event_config). Falls back to baked-in default event config.
CREATE TABLE IF NOT EXISTS volunteer_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  contact_number TEXT NOT NULL,
  nric_last4 TEXT NOT NULL,
  emergency_contact TEXT NOT NULL,
  availability TEXT NOT NULL,
  is_18_plus INTEGER NOT NULL,
  medical_conditions TEXT NOT NULL,
  roles_interest TEXT NOT NULL,
  affiliation TEXT NOT NULL,
  corporate_company TEXT,
  referral TEXT,
  consent INTEGER NOT NULL,
  declaration INTEGER NOT NULL,
  submitted_ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_volreg_event ON volunteer_registrations(event_key);
CREATE INDEX IF NOT EXISTS idx_volreg_email ON volunteer_registrations(email);

-- Laughter Yoga Registrations (public form at /reg/laughter-yoga/register)
-- Mirrors the Certified Laughter Yoga Leader (CLYL) training MS Form at
-- https://singaporewomenassociation.org/forms/laughter-yoga-leader-form/.
-- event_key ties rows to a configured event in KV (swa:laughter_yoga_config);
-- falls back to baked-in default config.
CREATE TABLE IF NOT EXISTS laughter_yoga_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT,
  whatsapp_group INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  age TEXT NOT NULL,
  address TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  emergency_contact TEXT NOT NULL,
  organisation_name TEXT NOT NULL,
  indemnity_pdpa INTEGER NOT NULL DEFAULT 0,
  occupation TEXT NOT NULL,
  submitted_ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lyreg_event ON laughter_yoga_registrations(event_key);
CREATE INDEX IF NOT EXISTS idx_lyreg_email ON laughter_yoga_registrations(email);

-- Membership Applications (public form at /reg/membership/register)
-- Captures new-member applications with PayNow payment screenshot (R2) and
-- either a drawn or uploaded signature image (R2). Renewal flow is out of
-- scope for v1 — application_type is fixed to 'new'.
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
  pdpa_consent INTEGER NOT NULL DEFAULT 0, -- 1 = applicant ticked PDPA consent (added by migration 005)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memapp_email ON membership_applications(email);
CREATE INDEX IF NOT EXISTS idx_memapp_ref ON membership_applications(payment_reference);

-- Membership fee schedule (D1-backed so admins can change fees without a deploy).
-- Fixed ids (1, 2) so handlers reference them deterministically.
INSERT OR IGNORE INTO membership_types (id, name, fee_amount, duration_months, description, is_active)
VALUES
  (1, 'First Year', 30.00, 12, 'New member joining fee', 1),
  (2, 'Renewal',    20.00, 12, 'Annual renewal from year 2 onwards', 1);

-- Per-year membership period. application_id traces each paid period back to
-- the original intake record (signature/NRIC evidence).
ALTER TABLE memberships ADD COLUMN application_id INTEGER REFERENCES membership_applications(id);

-- members.nric — required to de-dupe renewals and match application → member.
ALTER TABLE members ADD COLUMN nric TEXT;

-- Approval gate: public applications are 'pending' until an admin reviews them.
-- member_id is populated when an application is approved (points at the new
-- members row created at approval).
ALTER TABLE membership_applications ADD COLUMN status TEXT DEFAULT 'pending'
  CHECK (status IN ('pending', 'approved', 'rejected'));
ALTER TABLE membership_applications ADD COLUMN reviewed_by TEXT;
ALTER TABLE membership_applications ADD COLUMN reviewed_at TEXT;
ALTER TABLE membership_applications ADD COLUMN member_id INTEGER REFERENCES members(id);

-- Renewal reminder cron looks up unpaid/overdue memberships approaching end_date.
CREATE INDEX IF NOT EXISTS idx_mem_enddate
  ON memberships(end_date)
  WHERE payment_status IN ('unpaid', 'overdue');

-- ============================================================
-- Registration module (backported from migration 002 so schema.sql is a
-- complete baseline for fresh local databases).
-- ============================================================

-- members.reg_role — registration volunteer/admin role
ALTER TABLE members ADD COLUMN reg_role TEXT DEFAULT NULL;

-- Table bookings: one row per table reservation (a buyer reserves N seats)
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

CREATE INDEX IF NOT EXISTS idx_reg_bookings_ref    ON reg_bookings(booking_ref);
CREATE INDEX IF NOT EXISTS idx_reg_bookings_table  ON reg_bookings(table_id);
CREATE INDEX IF NOT EXISTS idx_reg_bookings_email  ON reg_bookings(buyer_email);

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

CREATE INDEX IF NOT EXISTS idx_reg_guests_booking    ON reg_guests(booking_id);
CREATE INDEX IF NOT EXISTS idx_reg_guests_table      ON reg_guests(table_id);
CREATE INDEX IF NOT EXISTS idx_reg_guests_name       ON reg_guests(guest_name);
CREATE INDEX IF NOT EXISTS idx_reg_guests_ticket     ON reg_guests(ticket_code);
CREATE INDEX IF NOT EXISTS idx_reg_guests_arrived    ON reg_guests(arrived_at);

-- Magic-link tokens: one per booking, for buyer-facing form access
CREATE TABLE IF NOT EXISTS reg_tokens (
  token            TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES reg_bookings(id)
);

CREATE INDEX IF NOT EXISTS idx_reg_tokens_booking ON reg_tokens(booking_id);

-- ============================================================
-- Soft delete for members (backported from migration 003).
-- DELETE /api/members/:id sets deleted_at instead of removing the row, keeping
-- foreign keys intact and making the action reversible.
-- ============================================================
ALTER TABLE members ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_members_deleted_at ON members(deleted_at);

-- ============================================================
-- Namecards (backported from migration 007 so schema.sql is a complete
-- baseline for fresh local databases — 2026-08-23 restore).
--
-- Digital namecard presentation data. 1:1 with members(id). Core identity
-- (name, email, mobile, job_title) is NOT duplicated here; it is read from
-- members at render time. Public surface: /c/:slug, board members only
-- (members.category IN ('committee','advisor') — see NAMECARD_BOARD_CATEGORIES).
-- ============================================================
CREATE TABLE IF NOT EXISTS namecards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL UNIQUE REFERENCES members(id),
  slug            TEXT NOT NULL UNIQUE,
  has_namecard    INTEGER NOT NULL DEFAULT 1,
  template        TEXT NOT NULL DEFAULT 'default',
  photo_r2_key    TEXT,
  photo_alt       TEXT,
  bio             TEXT,
  name_family     TEXT,
  name_given      TEXT,
  whatsapp        TEXT,
  website         TEXT,
  facebook        TEXT,
  linkedin        TEXT,
  instagram       TEXT,
  tiktok          TEXT,
  youtube         TEXT,
  qr_variant      TEXT NOT NULL DEFAULT 'vcf',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_namecards_slug      ON namecards(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_namecards_member_id ON namecards(member_id);
CREATE INDEX        IF NOT EXISTS idx_namecards_visible   ON namecards(has_namecard) WHERE has_namecard = 1;

-- ============================================================
-- Approval workflow (backported from migration 009 so schema.sql is a
-- complete baseline for fresh local databases — Phase 1, 2026-08-23).
--
-- Two-stage payment approvals: purchase (Roxanne/Angela), then finance
-- (YS/Joyce). Spec: docs/plans/Approval-Workflow-Implementation-Plan.md.
-- approval_audit_log is insert-only: no UPDATE or DELETE endpoint exists.
-- ============================================================
CREATE TABLE IF NOT EXISTS approval_items (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  category                  TEXT NOT NULL,
  title                     TEXT NOT NULL,
  payee                     TEXT,
  requested_amount          REAL,
  approval_required         INTEGER NOT NULL DEFAULT 1,
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'purchase_approved', 'finance_check', 'finance_approved', 'rejected', 'paid')),
  rejected_stage            TEXT CHECK (rejected_stage IN ('purchase', 'finance') OR rejected_stage IS NULL),
  purchase_decision_by      TEXT,
  purchase_decision_at      TEXT,
  rejection_reason          TEXT,
  voucher_no                TEXT UNIQUE,
  voucher_date              TEXT,
  voucher_lines             TEXT,
  voucher_submitted_by      TEXT,
  voucher_submitted_at      TEXT,
  finance_decision_by       TEXT,
  finance_decision_at       TEXT,
  finance_rejection_reason  TEXT,
  paid_by                   TEXT,
  paid_at                   TEXT,
  payment_method            TEXT,
  payment_reference         TEXT,
  created_by                TEXT NOT NULL,
  comparison                TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_items_status     ON approval_items(status);
CREATE INDEX IF NOT EXISTS idx_approval_items_created_at ON approval_items(created_at);

CREATE TABLE IF NOT EXISTS approval_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES approval_items(id),
  r2_key      TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_attachments_item ON approval_attachments(item_id);

CREATE TABLE IF NOT EXISTS approval_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES approval_items(id),
  action      TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_name  TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_audit_item    ON approval_audit_log(item_id);
CREATE INDEX IF NOT EXISTS idx_approval_audit_created ON approval_audit_log(created_at);
