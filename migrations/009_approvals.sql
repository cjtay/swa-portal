-- 009_approvals.sql
--
-- Date: 2026-08-23
--
-- Approval workflow: two-stage (purchase, then finance) payment approvals.
-- Spec: docs/plans/Approval-Workflow-Implementation-Plan.md (v2).
--
-- Three tables:
--   approval_items       — one row per purchase/payment request, including
--                          the voucher fields and the comparison-table JSON
--   approval_attachments — uploaded documents (R2 object keys); add-only in v1
--   approval_audit_log   — insert-only action log. No UPDATE or DELETE
--                          endpoint exists for it, and no code path writes
--                          anything but INSERT.
--
-- voucher_no is UNIQUE so the PV<YY>-<MM><NN> numbering cannot collide; the
-- voucher handler catches the constraint error and retries (plan §7).
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-applying is safe. The
-- same tables are backported into schema.sql in the same commit, so fresh
-- local databases built by `npm run db:setup` match production.
--
-- Apply (OWNER, MANUAL, after a D1 backup):
--   1. wrangler d1 export swa-portal --remote --output=backup.sql
--   2. wrangler d1 execute swa-portal --remote --file=migrations/009_approvals.sql
--
-- Local dev:
--   node ./node_modules/wrangler/bin/wrangler.js d1 execute swa-portal --local --file=migrations/009_approvals.sql

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
