-- 011: AI quotation comparison (docs/plans/AI-Quotation-Comparison-Plan.md §4.4)
-- Stores the AI-generated analysis JSON on the item itself: generated at/by,
-- models used, FX rates, per-file status, extracted quotations, summary
-- paragraph and one-line recommendation. Nullable — absent means the item
-- was raised without an analysis (feature off, or not used).
ALTER TABLE approval_items ADD COLUMN ai_comparison TEXT;
