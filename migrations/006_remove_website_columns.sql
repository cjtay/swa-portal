-- 006_remove_website_columns.sql
--
-- Drops the members columns that existed only to feed the public swa2024
-- website integration. swa-portal is now isolated from the public website
-- for risk segregation — namecard data, photos, slugs, and social links
-- are no longer managed here.
--
-- Columns dropped (11):
--   slug, photo_url, photo_alt, description,
--   show_on_website, has_namecard,
--   facebook, linkedin, instagram, tiktok, youtube
--
-- None of these are read by any admin-portal code (verified via grep on
-- 19-07-2026). The /namecards page, /api/sync-website plumbing, and
-- POST /api/members/:id/photo handler were removed in the same change set.
--
-- SQLite >= 3.35 supports ALTER TABLE DROP COLUMN (D1 qualifies).
-- Existing data in these columns is lost on apply — that is intentional
-- and safe; nothing in this codebase consumes it.
--
-- Apply order on prod:
--   1. wrangler d1 export swa-portal --remote --output=backup.sql
--   2. migrations/005_membership_lifecycle.sql   (if not yet applied)
--   3. migrations/006_remove_website_columns.sql (this file)
--   4. Deploy worker

ALTER TABLE members DROP COLUMN slug;
ALTER TABLE members DROP COLUMN photo_url;
ALTER TABLE members DROP COLUMN photo_alt;
ALTER TABLE members DROP COLUMN description;
ALTER TABLE members DROP COLUMN show_on_website;
ALTER TABLE members DROP COLUMN has_namecard;
ALTER TABLE members DROP COLUMN facebook;
ALTER TABLE members DROP COLUMN linkedin;
ALTER TABLE members DROP COLUMN instagram;
ALTER TABLE members DROP COLUMN tiktok;
ALTER TABLE members DROP COLUMN youtube;

DROP INDEX IF EXISTS idx_members_slug;
