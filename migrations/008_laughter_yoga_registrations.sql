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
