-- 007_namecards.sql
--
-- Date: 2026-07-25
--
-- Namecard presentation data. 1:1 with members(id).
--
-- Core identity (name, email, mobile, job_title, address_*) is NOT duplicated
-- here; it is read from members at render time. This keeps auth/identity data
-- clean (see migration 006) and lets the feature be dropped without touching
-- login, bookings, or membership.
--
-- This is the data plane for the digital namecard feature specified in
-- docs/NAMECARD.md (v2.1). Public surface: /c/:slug on this Worker.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-applying is safe. On a
-- fresh local D1 (created from schema.sql) this is the only migration that
-- needs to run, because schema.sql does NOT include the namecards table.
--
-- Apply (OWNER, MANUAL, after a D1 backup):
--   1. wrangler d1 export swa-portal --remote --output=backup.sql
--   2. wrangler d1 execute swa-portal --remote --file=migrations/007_namecards.sql
--   3. Deploy worker (with /c/* in run_worker_first)
--
-- Local dev:
--   wrangler d1 execute swa-portal --local --file=migrations/007_namecards.sql

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
