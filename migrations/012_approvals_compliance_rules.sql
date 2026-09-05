-- 012_approvals_compliance_rules.sql
--
-- Date: 2026-09-05
--
-- Batch A of the finance-policy compliance build
-- (docs/plans/approvals-finance-compliance-implementation-plan.md §4.1)
-- plus the R7 tax-invoice column from §17.1:
--   approval_items.purchase_decision_office / finance_decision_office
--     — the office held by whoever decided (President, Treasurer, …),
--       null when the signer holds no mapped office
--   approval_items.invoice_no — invoice/receipt number, required at voucher
--     submission; indexed but NOT unique because a repeat warns, never
--       blocks (settled decision 5)
--   approval_attachments.is_tax_invoice — 0/1, ticked via the "This is the
--     Tax Invoice" checkbox; the ticked document always displays first
--
-- The feature has not shipped to the board (settled decision 7), so no old
-- rows need converting.
--
-- Apply (OWNER, MANUAL, after a D1 backup):
--   1. wrangler d1 export swa-portal --remote --output=backup.sql
--   2. wrangler d1 execute swa-portal --remote --file=migrations/012_approvals_compliance_rules.sql
--
-- Local dev:
--   node ./node_modules/wrangler/bin/wrangler.js d1 execute swa-portal --local --file=migrations/012_approvals_compliance_rules.sql
--
-- The same columns are backported into schema.sql in the same commit, so
-- fresh local databases (and the test suite, which applies schema.sql only)
-- never need this file.

ALTER TABLE approval_items ADD COLUMN purchase_decision_office TEXT;
ALTER TABLE approval_items ADD COLUMN finance_decision_office TEXT;
ALTER TABLE approval_items ADD COLUMN invoice_no TEXT;

CREATE INDEX IF NOT EXISTS idx_approval_items_invoice_no ON approval_items(invoice_no);

ALTER TABLE approval_attachments ADD COLUMN is_tax_invoice INTEGER NOT NULL DEFAULT 0;
