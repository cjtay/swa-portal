-- Members (core data, replaces markdown frontmatter for admin-managed data)
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  role TEXT NOT NULL,
  email TEXT UNIQUE,
  mobile TEXT,
  job_title TEXT,
  photo_url TEXT,
  photo_alt TEXT,
  description TEXT,
  category TEXT DEFAULT 'committee',
  can_login INTEGER DEFAULT 0,
  show_on_website INTEGER DEFAULT 1,
  has_namecard INTEGER DEFAULT 0,
  address_line1 TEXT,
  address_line2 TEXT,
  address_postal_code TEXT,
  address_country TEXT DEFAULT 'Singapore',
  facebook TEXT,
  linkedin TEXT,
  instagram TEXT,
  tiktok TEXT,
  youtube TEXT,
  sort_order INTEGER DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at TEXT DEFAULT (datetime('now')),
  endpoint TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  http_status INTEGER,
  user_email TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_slug ON members(slug);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_can_login ON members(can_login);

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
