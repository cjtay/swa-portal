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