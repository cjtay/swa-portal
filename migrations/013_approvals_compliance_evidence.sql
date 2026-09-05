-- 013_approvals_compliance_evidence.sql
--
-- Date: 2026-09-05
--
-- Batch B of the finance-policy compliance build
-- (docs/plans/approvals-finance-compliance-implementation-plan.md §4.2):
-- the S$1,000-and-above evidence columns. All nullable — the thresholds in
-- src/constants/portal.ts do the gating, so nothing is required at the
-- database level.
--
--   board_approval_ref       — board decision reference, required by the
--                              purchase-approve guard above S$10,000
--   quotation_waiver_reason  — why fewer than two quotations are attached
--   supplier_is_cheapest     — 0/1 answer to "is the chosen supplier the
--                              cheapest of the quotations?"
--   supplier_choice_reason   — required when the answer is No
--   budget_approved / budget_amount / budget_officer / budget_date
--                            — the budget declaration (budget approvers are
--                              not portal users, so the amount is typed text)
--   coi_declared             — conflict-of-interest tick
--   no_split_declared        — no-splitting-to-avoid-limits tick
--
-- The feature has not shipped to the board (settled decision 7), so no old
-- rows need converting.
--
-- Apply (OWNER, MANUAL, after a D1 backup):
--   1. wrangler d1 export swa-portal --remote --output=backup.sql
--   2. wrangler d1 execute swa-portal --remote --file=migrations/013_approvals_compliance_evidence.sql
--
-- Local dev:
--   node ./node_modules/wrangler/bin/wrangler.js d1 execute swa-portal --local --file=migrations/013_approvals_compliance_evidence.sql
--
-- The same columns are backported into schema.sql in the same commit, so
-- fresh local databases (and the test suite, which applies schema.sql only)
-- never need this file.

ALTER TABLE approval_items ADD COLUMN board_approval_ref TEXT;       -- <=500 chars
ALTER TABLE approval_items ADD COLUMN quotation_waiver_reason TEXT;  -- <=1000 chars
ALTER TABLE approval_items ADD COLUMN supplier_is_cheapest INTEGER;  -- 0/1, required >=1000
ALTER TABLE approval_items ADD COLUMN supplier_choice_reason TEXT;   -- <=1000 chars
ALTER TABLE approval_items ADD COLUMN budget_approved INTEGER;       -- 0/1 tick
ALTER TABLE approval_items ADD COLUMN budget_amount TEXT;            -- text, <=50 chars
ALTER TABLE approval_items ADD COLUMN budget_officer TEXT;           -- <=200 chars
ALTER TABLE approval_items ADD COLUMN budget_date TEXT;              -- YYYY-MM-DD
ALTER TABLE approval_items ADD COLUMN coi_declared INTEGER;          -- 0/1 tick
ALTER TABLE approval_items ADD COLUMN no_split_declared INTEGER;     -- 0/1 tick
