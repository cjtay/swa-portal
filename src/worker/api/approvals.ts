import type { AppContext } from '../types';
import { handleApiError } from '../lib/error-handler';
import { logError } from '../lib/log-error';
import { csvEscape } from '../lib/csv';
import {
  sendApprovalRequestEmail,
  sendPurchaseDecisionEmail,
  sendVoucherEmail,
  sendFinanceDecisionEmail,
  type ApprovalEmailItem,
  type VoucherEmailItem,
} from '../lib/email-approval';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_MAX_FILES_PER_ITEM,
  APPROVAL_MAX_FILE_BYTES,
  APPROVAL_QUOTE_RULE_THRESHOLD,
  APPROVAL_TWO_STAGE_THRESHOLD,
  APPROVAL_BOARD_APPROVAL_THRESHOLD,
  canRaiseApprovalItem,
  isPurchaseApprover,
  isFinanceApprover,
  approvalOfficeFor,
} from '../../constants/portal';
import {
  isAiComparisonEnabled,
  consumeDailyAnalysisQuota,
  runAiComparison,
  parseAiComparisonJson,
  type AiComparison,
  type AiComparisonInput,
} from '../lib/ai-comparison';

// Approval workflow API — docs/plans/Approval-Workflow-Implementation-Plan.md §8.
//
// Phase 2 scope: list (with per-status counts), create (multipart, files +
// comparison rows), detail, and the attachment stream route. Approve/reject,
// voucher, paid and the audit CSV export arrive with later phases.
//
// Entry gate: middleware.ts gate 7c already restricts ALL /api/approvals
// methods to admin, purchase approver, or finance approver. Each handler
// below re-checks its finer rule (e.g. create needs canRaiseApprovalItem).

const APPROVAL_STATUSES = [
  'pending',
  'purchase_approved',
  'finance_check',
  'finance_approved',
  'rejected',
  'paid',
] as const;

// Plan §9 file allowlist. image/jpg is accepted as an alias of image/jpeg —
// some Android WebViews send it (same precedent as membership-reg.ts).
// text/html and image/svg+xml are never accepted: browsers can run scripts
// inside both when viewed inline.
const ALLOWED_ATTACHMENT_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const MIME_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const MAX_TITLE_LENGTH = 300;
const MAX_PAYEE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_COMPARISON_ROWS = 20;
const MAX_COMPARISON_DESCRIPTION_LENGTH = 500;
const MAX_AI_SUMMARY_LENGTH = 4000;
const MAX_AI_RECOMMENDATION_LENGTH = 1000;
const MAX_REJECTION_REASON_LENGTH = 1000;
const MAX_REQUESTED_AMOUNT = 10_000_000;
const MAX_VOUCHER_LINES = 50;
const MAX_VOUCHER_LINE_DESCRIPTION = 500;
const VOUCHER_NO_RETRY_ATTEMPTS = 3;
const LIST_DEFAULT_LIMIT = 500;
const LIST_MAX_LIMIT = 500;

// Gap 6: a gross date typo (e.g. year 2206) must fail even though the date is
// otherwise real. Bound the year to a plausible financial-record range.
const MIN_SANE_YEAR = 1900;
const MAX_SANE_YEAR = 2100;

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, mo, d] = s.split('-').map(Number);
  if (y < MIN_SANE_YEAR || y > MAX_SANE_YEAR) return false;
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
}

/** Parse a non-negative integer query parameter with a default and a max. */
function parsePageParam(raw: string | null | undefined, defaultValue: number, max: number): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

function getSessionEmail(c: AppContext): string {
  try {
    return (c.get as unknown as (k: string) => unknown)('sessionEmail') as string || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getSessionName(c: AppContext): string {
  try {
    return (c.get as unknown as (k: string) => unknown)('sessionName') as string || '';
  } catch {
    return '';
  }
}

function getSessionRole(c: AppContext): string {
  try {
    return (c.get as unknown as (k: string) => unknown)('sessionRole') as string || '';
  } catch {
    return '';
  }
}

/**
 * Run a state change guarded by a WHERE status rule, then write the audit row
 * only if the row actually changed.
 *
 * These are two separate writes, not one D1 batch. If they were one batch, a
 * lost race (two approvers acting at once) would still insert its audit row
 * even though the UPDATE matched nothing, writing a false entry into the
 * insert-only financial audit log. Keeping them separate means a lost race
 * returns early with no audit row at all.
 *
 * The audit write is best-effort: an audit insert failure is logged and never
 * rolls the decision back. The state change is the source of truth.
 * Returns true when the item moved to the new state, false when it had already
 * been actioned by someone else.
 */
async function applyTransition(
  c: AppContext,
  updateStmt: D1PreparedStatement,
  auditStmt: D1PreparedStatement,
): Promise<boolean> {
  const res = await updateStmt.run();
  const changes = Number((res.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (changes === 0) return false;
  try {
    await auditStmt.run();
  } catch (err) {
    await logError(c.env, {
      endpoint: 'approvals-state-change',
      error_type: 'D1_AUDIT',
      error_message: `audit insert for state change failed: ${err instanceof Error ? err.message : String(err)}`,
      http_status: 500,
      user_email: getSessionEmail(c),
    });
  }
  return true;
}

/** Strip quotes, backslashes, control chars and non-ASCII for the
 *  Content-Disposition filename parameter; non-safe characters become _.
 *  Multipart filenames may arrive percent-encoded (browsers encode `"` as
 *  %22), so decode first — guarded, because legitimate names like
 *  "50%off.pdf" contain invalid escapes and keep their raw form. */
function sanitizeAsciiFilename(name: string): string {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // keep raw
  }
  const cleaned = decoded.replace(/[^\w.\- ]+/g, '_').replace(/_+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 150) : 'file';
}

function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  let decoded = filename;
  try {
    decoded = decodeURIComponent(filename);
  } catch {
    // keep raw
  }
  const ascii = sanitizeAsciiFilename(decoded);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(decoded)}`;
}

/* ----------------------------------------------------
   Compliance helpers (Batch B, plan §7)
   ---------------------------------------------------- */

// Multipart tick parsing: a checkbox sends 'on' (or 'true'/'1') when ticked
// and nothing when not.
function formTick(form: Record<string, unknown>, key: string): boolean {
  const v = form[key];
  if (v === undefined || v === null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === 'on' || s === 'true' || s === '1';
}

// Yes/No radio: 'yes'/'true' → true, 'no'/'false' → false, absent → null
// (the question is unanswered — an error at S$1,000 and above).
function formYesNo(form: Record<string, unknown>, key: string): boolean | null {
  const v = form[key];
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'yes' || s === 'true' || s === '1') return true;
  if (s === 'no' || s === 'false' || s === '0') return false;
  return null;
}

interface EvidenceInput {
  boardApprovalRef: string | null;
  quotationWaiverReason: string | null;
  supplierIsCheapest: boolean | null;
  supplierChoiceReason: string | null;
  budgetApproved: boolean;
  budgetAmount: string | null;
  budgetOfficer: string | null;
  budgetDate: string | null;
  coiDeclared: boolean;
  noSplitDeclared: boolean;
}

/** Parse the evidence fields from a multipart form. Every field optional. */
function parseEvidenceForm(form: Record<string, unknown>): EvidenceInput {
  const str = (key: string): string | null => {
    const v = form[key];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s.length > 0 ? s : null;
  };
  return {
    boardApprovalRef: str('boardApprovalRef'),
    quotationWaiverReason: str('quotationWaiverReason'),
    supplierIsCheapest: formYesNo(form, 'supplierIsCheapest'),
    supplierChoiceReason: str('supplierChoiceReason'),
    budgetApproved: formTick(form, 'budgetApproved'),
    budgetAmount: str('budgetAmount'),
    budgetOfficer: str('budgetOfficer'),
    budgetDate: str('budgetDate'),
    coiDeclared: formTick(form, 'coiDeclared'),
    noSplitDeclared: formTick(form, 'noSplitDeclared'),
  };
}

/** Stored evidence off an item row, normalised to the EvidenceInput shape
 *  (booleans from 0/1, nulls for absent). */
function storedEvidence(row: Record<string, unknown> | null): EvidenceInput {
  if (!row) {
    return {
      boardApprovalRef: null, quotationWaiverReason: null, supplierIsCheapest: null,
      supplierChoiceReason: null, budgetApproved: false, budgetAmount: null,
      budgetOfficer: null, budgetDate: null, coiDeclared: false, noSplitDeclared: false,
    };
  }
  const str = (k: string): string | null => (row[k] === null || row[k] === undefined ? null : String(row[k]));
  return {
    boardApprovalRef: str('board_approval_ref'),
    quotationWaiverReason: str('quotation_waiver_reason'),
    supplierIsCheapest: row.supplier_is_cheapest === null || row.supplier_is_cheapest === undefined ? null : Number(row.supplier_is_cheapest) === 1,
    supplierChoiceReason: str('supplier_choice_reason'),
    budgetApproved: Number(row.budget_approved) === 1,
    budgetAmount: str('budget_amount'),
    budgetOfficer: str('budget_officer'),
    budgetDate: str('budget_date'),
    coiDeclared: Number(row.coi_declared) === 1,
    noSplitDeclared: Number(row.no_split_declared) === 1,
  };
}

/**
 * Validate the evidence fields (plan §7.1). Cap checks run whenever a value
 * is provided; the required-field checks run only when the EFFECTIVE
 * requested amount is S$1,000 or above ("effective" = the form value when
 * provided, otherwise the stored value — the caller merges before calling
 * with an already-effective input).
 */
function validateEvidence(
  input: EvidenceInput,
  comparisonRowCount: number,
  effectiveAmount: number | null,
): { ok: true } | { ok: false; message: string } {
  if (input.boardApprovalRef !== null && input.boardApprovalRef.length > 500) {
    return { ok: false, message: 'Board approval reference must be 500 characters or fewer.' };
  }
  if (input.quotationWaiverReason !== null && input.quotationWaiverReason.length > 1000) {
    return { ok: false, message: 'Quotation waiver reason must be 1,000 characters or fewer.' };
  }
  if (input.supplierChoiceReason !== null && input.supplierChoiceReason.length > 1000) {
    return { ok: false, message: 'Supplier choice reason must be 1,000 characters or fewer.' };
  }
  if (input.budgetAmount !== null && input.budgetAmount.length > 50) {
    return { ok: false, message: 'Budget amount must be 50 characters or fewer.' };
  }
  if (input.budgetOfficer !== null && input.budgetOfficer.length > 200) {
    return { ok: false, message: 'Budget approving officer must be 200 characters or fewer.' };
  }
  if (input.budgetDate !== null && !isRealDate(input.budgetDate)) {
    return { ok: false, message: 'Budget approval date must be a valid date (YYYY-MM-DD).' };
  }

  if (effectiveAmount === null || effectiveAmount < APPROVAL_QUOTE_RULE_THRESHOLD) {
    return { ok: true };
  }

  if (comparisonRowCount < 2 && input.quotationWaiverReason === null) {
    return { ok: false, message: 'Attach at least two quotations in the comparison table, or give a waiver reason.' };
  }
  if (!input.budgetApproved) return { ok: false, message: 'Tick "Payment within the approved budget".' };
  if (input.budgetAmount === null) return { ok: false, message: 'Enter the budget amount.' };
  if (input.budgetOfficer === null) return { ok: false, message: 'Enter the budget approving officer.' };
  if (input.budgetDate === null) return { ok: false, message: 'Enter the budget approval date (YYYY-MM-DD).' };
  if (!input.coiDeclared) return { ok: false, message: 'Tick the conflict-of-interest declaration.' };
  if (!input.noSplitDeclared) return { ok: false, message: 'Tick the declaration that the purchase is not split to avoid approval limits.' };
  if (input.supplierIsCheapest === null) {
    return { ok: false, message: 'Answer whether the chosen supplier is the cheapest of the quotations.' };
  }
  if (input.supplierIsCheapest === false && input.supplierChoiceReason === null) {
    return { ok: false, message: 'Give a reason for choosing a supplier that is not the cheapest.' };
  }
  return { ok: true };
}

/** Merge form evidence over stored evidence: the form value when provided,
 *  otherwise the stored value (plan §7.1 "effective" rule at edit). */
function mergeEvidence(form: EvidenceInput, stored: EvidenceInput): EvidenceInput {
  return {
    boardApprovalRef: form.boardApprovalRef ?? stored.boardApprovalRef,
    quotationWaiverReason: form.quotationWaiverReason ?? stored.quotationWaiverReason,
    supplierIsCheapest: form.supplierIsCheapest ?? stored.supplierIsCheapest,
    supplierChoiceReason: form.supplierChoiceReason ?? stored.supplierChoiceReason,
    budgetApproved: form.budgetApproved || stored.budgetApproved,
    budgetAmount: form.budgetAmount ?? stored.budgetAmount,
    budgetOfficer: form.budgetOfficer ?? stored.budgetOfficer,
    budgetDate: form.budgetDate ?? stored.budgetDate,
    coiDeclared: form.coiDeclared || stored.coiDeclared,
    noSplitDeclared: form.noSplitDeclared || stored.noSplitDeclared,
  };
}

/** R1: one `field: old → new` audit pair, or null when unchanged. Values
 *  truncate at 60 chars so a 4,000-char description cannot flood the note. */
function auditPair(field: string, oldVal: unknown, newVal: unknown): string | null {
  const norm = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '(none)';
    const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
    return s.length > 60 ? s.slice(0, 59) + '\u2026' : s;
  };
  const a = norm(oldVal);
  const b = norm(newVal);
  return a === b ? null : `${field}: ${a} \u2192 ${b}`;
}

/** R7: mark one attachment as the Tax Invoice and clear any other — a single
 *  UPDATE, so ticking one unticks the rest atomically. */
async function setTaxInvoiceFlag(db: D1Database, itemId: number, attachmentId: number): Promise<void> {
  await db
    .prepare('UPDATE approval_attachments SET is_tax_invoice = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE item_id = ?')
    .bind(attachmentId, itemId)
    .run();
}

/** Build the finance-stage email payload: voucher number + computed total
 *  from the stored line JSON. */
async function loadVoucherEmailItem(c: AppContext, itemId: number, row: Record<string, unknown>): Promise<VoucherEmailItem> {
  let total: number | null = null;
  if (typeof row.voucher_lines === 'string' && row.voucher_lines.length > 0) {
    try {
      const lines = JSON.parse(row.voucher_lines) as Array<{ amount?: number | null }>;
      // Sum in integer cents to avoid floating-point drift on the total.
      const totalCents = lines.reduce((sum, line) => sum + (typeof line.amount === 'number' ? Math.round(line.amount * 100) : 0), 0);
      total = totalCents / 100;    } catch {
      total = null;
    }
  }
  return {
    id: itemId,
    title: String(row.title || ''),
    payee: row.payee ? String(row.payee) : null,
    voucherNo: String(row.voucher_no || ''),
    voucherDate: String(row.voucher_date || ''),
    total,
    createdBy: String(row.created_by || ''),
  };
}

/** Next voucher number for a voucher_date's month: PV<YY>-<MM><NN>, NN from
 *  the existing maximum + 1 (plan §7). Two digits cap at 99 — returns null
 *  when the month is full. */
async function nextVoucherNo(db: D1Database, voucherDate: string): Promise<string | null> {
  const m = voucherDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  // PV26-0801 = prefix 'PV26-08' + two-digit sequence, no dash before NN.
  const prefix = `PV${m[1].slice(2)}-${m[2]}`;
  const res = await db
    .prepare('SELECT MAX(voucher_no) AS mx FROM approval_items WHERE voucher_no LIKE ?')
    .bind(prefix + '%')
    .first<{ mx: string | null }>();
  const last = res?.mx ? Number(res.mx.slice(prefix.length)) : 0;
  const next = last + 1;
  if (!Number.isFinite(last) || next > 99) return null;
  return `${prefix}${String(next).padStart(2, '0')}`;
}
/** Build the email payload for an item: category label + attachment count
 *  come from extra reads, so decision emails match what the board shows. */
async function loadEmailItem(c: AppContext, itemId: number, row: Record<string, unknown>): Promise<ApprovalEmailItem> {
  const category = APPROVAL_CATEGORIES.find((cat) => cat.key === String(row.category));
  const countRes = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM approval_attachments WHERE item_id = ?')
    .bind(itemId)
    .first<{ n: number }>();
  return {
    id: itemId,
    title: String(row.title || ''),
    categoryLabel: category?.label || String(row.category || ''),
    payee: row.payee ? String(row.payee) : null,
    requestedAmount: row.requested_amount === null || row.requested_amount === undefined ? null : Number(row.requested_amount),
    description: row.description ? String(row.description) : null,
    createdBy: String(row.created_by || ''),
    fileCount: Number(countRes?.n || 0),
  };
}

/* ----------------------------------------------------
   GET /api/approvals?status=<status>
   Board list + per-status counts for the tab badges.
   Financial data — gate 7c already kept out non-approvers.
   ---------------------------------------------------- */
export async function handleApprovalsList(c: AppContext) {
  const endpoint = 'approvals-list';
  const statusFilter = (c.req.query('status') || '').trim();
  if (statusFilter && !(APPROVAL_STATUSES as readonly string[]).includes(statusFilter)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid status filter.' }, 400);
  }

  // Gap 6: server-side paging so items beyond the first 500 are reachable.
  const limit = parsePageParam(c.req.query('limit'), LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const offset = parsePageParam(c.req.query('offset'), 0, 100_000);
  if (limit === null || offset === null) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid paging parameters.' }, 400);
  }

  try {
    const baseSelect =
      'SELECT id, category, title, payee, requested_amount, approval_required, status, ' +
      'rejected_stage, rejection_reason, finance_rejection_reason, ' +
      'voucher_no, voucher_date, created_by, created_at, updated_at ' +
      'FROM approval_items';
    const listPromise = statusFilter
      ? c.env.DB.prepare(`${baseSelect} WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
          .bind(statusFilter, limit, offset)
          .all()
      : c.env.DB.prepare(`${baseSelect} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(limit, offset).all();

    const [listResult, countResult] = await Promise.all([
      listPromise,
      c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM approval_items GROUP BY status').all(),
    ]);

    const counts: Record<string, number> = {
      pending: 0,
      purchase_approved: 0,
      finance_check: 0,
      finance_approved: 0,
      rejected: 0,
      paid: 0,
    };
    let all = 0;
    for (const row of (countResult.results || []) as Array<{ status: string; n: number }>) {
      if (row.status in counts) counts[row.status] = Number(row.n);
      all += Number(row.n);
    }
    counts.all = all;

    const total = statusFilter ? (counts[statusFilter] ?? 0) : all;

    return c.json({ success: true, items: listResult.results || [], counts, total });
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load approvals.', {
      error_type: 'D1_SELECT_APPROVALS',
      http_status: 500,
    });
  }
}

/* ----------------------------------------------------
   POST /api/approvals  (multipart)
   Fields: category, title, payee?, requestedAmount?,
           approvalRequired? ('true'|'false'), comparison? (JSON)
   Files:  `files` (0..10, allowlist + 10 MB each).

   comparison JSON arrives as [{ file: "<original filename>",
   description: "..." }] and is stored as [{ attachmentId, description }]
   (plan §6) once the attachment ids exist.

   Flow: INSERT item → R2 uploads → one batch of attachment rows + the
   item_created audit row → comparison UPDATE. If a later step fails the
   item row can be orphaned (visible on the board, fixable by Phase 3
   edit); the audit row only ever lands in the same batch as the
   attachment rows.
   ---------------------------------------------------- */
export async function handleApprovalsCreate(c: AppContext) {
  const endpoint = 'approvals-create';
  const session = { email: getSessionEmail(c), role: getSessionRole(c) };
  if (!canRaiseApprovalItem(session)) {
    return c.json(
      { success: false, error_code: 'FORBIDDEN', message: 'Only the office admin can create approval items.' },
      403,
    );
  }

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  // --- Validate text fields ---
  const categoryKey = typeof form['category'] === 'string' ? form['category'].trim() : '';
  const category = APPROVAL_CATEGORIES.find((cat) => cat.key === categoryKey);
  if (!category) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid category.' }, 400);
  }

  const title = typeof form['title'] === 'string' ? form['title'].trim() : '';
  if (title.length < 1 || title.length > MAX_TITLE_LENGTH) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: `Title is required (1–${MAX_TITLE_LENGTH} characters).` },
      400,
    );
  }

  const payeeRaw = typeof form['payee'] === 'string' ? form['payee'].trim() : '';
  if (payeeRaw.length > MAX_PAYEE_LENGTH) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Payee is too long.' }, 400);
  }

  const descriptionRaw = typeof form['description'] === 'string' ? form['description'].trim() : '';
  if (descriptionRaw.length > MAX_DESCRIPTION_LENGTH) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` },
      400,
    );
  }

  let requestedAmount: number | null = null;
  const amountRaw = typeof form['requestedAmount'] === 'string' ? form['requestedAmount'].trim() : '';
  if (amountRaw.length > 0) {
    const parsed = Number(amountRaw);
    // Optional field, but zero/negative makes no sense for a payment request
    // (owner decision 29-08-2026) — any category, approval or not.
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_REQUESTED_AMOUNT) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: 'Requested amount must be greater than 0 and at most 10,000,000.' },
        400,
      );
    }
    requestedAmount = Math.round(parsed * 100) / 100;
  }

  // approvalRequired: absent → category default; otherwise parse the flag.
  let approvalRequired = category.requiresApproval;
  if (form['approvalRequired'] !== undefined) {
    const flag = String(form['approvalRequired']).trim().toLowerCase();
    if (flag === 'true' || flag === '1' || flag === 'on') approvalRequired = true;
    else if (flag === 'false' || flag === '0') approvalRequired = false;
  }

  // Manual money rule (plan §6.3): at S$5,000 and above both stages are
  // forced on, even for recurring categories. Runs before the document
  // check below, so a forced item also needs its documents.
  if (requestedAmount !== null && requestedAmount >= APPROVAL_TWO_STAGE_THRESHOLD) {
    approvalRequired = true;
  }

  // --- Validate files ---
  const filesRaw = form['files'];
  const fileList: File[] = [];
  if (Array.isArray(filesRaw)) {
    for (const f of filesRaw) if (f instanceof File && f.size > 0) fileList.push(f);
  } else if (filesRaw instanceof File && filesRaw.size > 0) {
    fileList.push(filesRaw);
  }

  if (fileList.length > APPROVAL_MAX_FILES_PER_ITEM) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: `At most ${APPROVAL_MAX_FILES_PER_ITEM} files per item.` },
      400,
    );
  }

  for (const file of fileList) {
    if (!ALLOWED_ATTACHMENT_MIME.has(file.type)) {
      return c.json(
        {
          success: false,
          error_code: 'VALIDATION_ERROR',
          message: `"${file.name}" is not an accepted type. Only PDF, JPG, PNG, WebP, HEIC and HEIF files are allowed.`,
        },
        400,
      );
    }
    if (file.size > APPROVAL_MAX_FILE_BYTES) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: `"${file.name}" is larger than 10 MB.` },
        400,
      );
    }
  }

  // Owner decision 29-08-2026: purchase approvers decide remotely from the
  // uploaded files, so an approval-required item must carry at least one
  // document. Recurring items (approval_required = 0) may be paperless.
  if (approvalRequired && fileList.length === 0) {
    return c.json(
      {
        success: false,
        error_code: 'VALIDATION_ERROR',
        message: 'Attach at least one document (quotation, invoice or photo) when approval is required — approvers decide from the uploaded files. Uncheck "Approval required" for paperless recurring items.',
      },
      400,
    );
  }

  // --- Validate comparison rows against the uploaded filenames ---
  interface ComparisonInput {
    file: string;
    description: string;
    quoteDate: string | null;
  }
  let comparisonRows: ComparisonInput[] = [];
  const comparisonRaw = typeof form['comparison'] === 'string' ? form['comparison'].trim() : '';
  if (comparisonRaw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(comparisonRaw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      if (parsed.length > MAX_COMPARISON_ROWS) {
        return c.json(
          { success: false, error_code: 'VALIDATION_ERROR', message: `At most ${MAX_COMPARISON_ROWS} comparison rows.` },
          400,
        );
      }
      const uploadedNames = new Set(fileList.map((f) => f.name));
      for (const row of parsed) {
        const file = typeof (row as Record<string, unknown>)?.file === 'string' ? String((row as Record<string, unknown>).file) : '';
        const description =
          typeof (row as Record<string, unknown>)?.description === 'string'
            ? String((row as Record<string, unknown>).description).trim()
            : '';
        // Optional quotation date (plan §7.2): validated when present; the
        // twelve-month staleness warning lives in the drawer, not here.
        const quoteDateRaw =
          typeof (row as Record<string, unknown>)?.quoteDate === 'string' ? String((row as Record<string, unknown>).quoteDate).trim() : '';
        if (quoteDateRaw.length > 0 && !isRealDate(quoteDateRaw)) {
          return c.json(
            { success: false, error_code: 'VALIDATION_ERROR', message: 'Quotation dates must be valid dates (YYYY-MM-DD) or empty.' },
            400,
          );
        }
        if (!file || !uploadedNames.has(file)) {
          return c.json(
            {
              success: false,
              error_code: 'VALIDATION_ERROR',
              message: 'Every comparison row must link to one of the uploaded files.',
            },
            400,
          );
        }
        if (description.length < 1 || description.length > MAX_COMPARISON_DESCRIPTION_LENGTH) {
          return c.json(
            {
              success: false,
              error_code: 'VALIDATION_ERROR',
              message: `Comparison descriptions must be 1–${MAX_COMPARISON_DESCRIPTION_LENGTH} characters.`,
            },
            400,
          );
        }
        comparisonRows.push({ file, description, quoteDate: quoteDateRaw || null });
      }
    } catch {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Comparison table is malformed.' }, 400);
    }
  }

  // --- Compliance evidence (plan §7.1): parsed at every amount, enforced at
  //     S$1,000 and above. A null amount triggers nothing. ---
  const evidence = parseEvidenceForm(form);
  const evidenceCheck = validateEvidence(evidence, comparisonRows.length, requestedAmount);
  if (!evidenceCheck.ok) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: evidenceCheck.message }, 400);
  }

  // --- Optional AI analysis produced by /api/approvals/analyse-preview ---
  //     Treated as untrusted form input: strict shape validation + hard caps
  //     in parseAiComparisonJson. Stored verbatim (normalised) on the item.
  let aiComparisonJson: string | null = null;
  const aiRaw = typeof form['aiComparison'] === 'string' ? form['aiComparison'].trim() : '';
  if (aiRaw.length > 0) {
    const parsedAnalysis = parseAiComparisonJson(aiRaw);
    if (!parsedAnalysis) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: 'The AI comparison data is malformed. Run the analysis again.' },
        400,
      );
    }
    aiComparisonJson = JSON.stringify(parsedAnalysis);
  }

  // --- 1. Insert the item (comparison stored after attachment ids exist) ---
  const status = approvalRequired ? 'pending' : 'purchase_approved';
  let itemId: number;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO approval_items (category, title, payee, description, requested_amount, approval_required, status, created_by, ai_comparison,
         board_approval_ref, quotation_waiver_reason, supplier_is_cheapest, supplier_choice_reason,
         budget_approved, budget_amount, budget_officer, budget_date, coi_declared, no_split_declared)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        category.key,
        title,
        payeeRaw || null,
        descriptionRaw || null,
        requestedAmount,
        approvalRequired ? 1 : 0,
        status,
        session.email,
        aiComparisonJson,
        evidence.boardApprovalRef,
        evidence.quotationWaiverReason,
        evidence.supplierIsCheapest === null ? null : evidence.supplierIsCheapest ? 1 : 0,
        evidence.supplierChoiceReason,
        evidence.budgetApproved ? 1 : 0,
        evidence.budgetAmount,
        evidence.budgetOfficer,
        evidence.budgetDate,
        evidence.coiDeclared ? 1 : 0,
        evidence.noSplitDeclared ? 1 : 0,
      )
      .run();
    itemId = Number(res.meta?.last_row_id);
    if (!itemId) throw new Error('Failed to get item ID from insert');
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not create the approval item.', {
      error_type: 'D1_INSERT_APPROVAL_ITEM',
      http_status: 500,
    });
  }

  // --- 1b. Write the item_created audit row now, before any file work.
  //     A later R2 or attachment failure must never leave an item on the board
  //     that the insert-only audit log never recorded. If this write itself
  //     fails, roll the item back so no un-audited item survives.
  //     R1: every field change is captured as `field: old → new` pairs — for a
  //     create the old side is always (none). Attachments stay excluded
  //     (their own attachments_added rows cover them); the file count rides
  //     along for continuity.
  const actorName = getSessionName(c) || session.email;
  const auditNote =
    [
      auditPair('category', null, category.key),
      auditPair('title', null, title),
      auditPair('payee', null, payeeRaw || null),
      auditPair('description', null, descriptionRaw || null),
      auditPair('requested_amount', null, requestedAmount),
      auditPair('approval_required', null, approvalRequired ? 1 : 0),
    ]
      .filter(Boolean)
      .join('; ') + `; files=${fileList.length}`;
  try {
    await c.env.DB.prepare(
      'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(itemId, 'item_created', session.email, actorName, auditNote)
      .run();
  } catch (err) {
    await c.env.DB.prepare('DELETE FROM approval_items WHERE id = ?').bind(itemId).run().catch(() => {});
    return handleApiError(c, endpoint, err, 'Could not record the item creation. Nothing was saved.', {
      error_type: 'D1_INSERT_APPROVAL_AUDIT',
      http_status: 500,
    });
  }

  // --- 2. Upload files to R2 under approvals/<itemId>/ ---
  const uploadedKeys: Array<{ file: File; r2Key: string }> = [];
  if (fileList.length > 0) {
    try {
      for (const file of fileList) {
        const ext = MIME_EXTENSION[file.type] || 'bin';
        const r2Key = `approvals/${itemId}/${crypto.randomUUID()}.${ext}`;
        await c.env.R2_BUCKET.put(r2Key, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: {
            item_id: String(itemId),
            original_filename: file.name,
            uploaded_by: session.email,
            uploaded_at: new Date().toISOString(),
          },
        });
        uploadedKeys.push({ file, r2Key });
      }
    } catch (err) {
      await logError(c.env, {
        endpoint,
        error_type: 'R2_PUT',
        error_message: `approvals-create r2: ${err instanceof Error ? err.message : String(err)}`,
        http_status: 500,
        user_email: session.email,
      });
      // Clean up anything already written so no orphaned objects linger.
      await Promise.allSettled(uploadedKeys.map(({ r2Key }) => c.env.R2_BUCKET.delete(r2Key)));
      return c.json(
        {
          success: false,
          error_code: 'UPLOAD_FAILED',
          message: 'The item was created but its attachments could not be saved. It is on the board without files; reopen it and attach the files again.',
        },
        500,
      );
    }
  }

  // --- 3. Attachment rows (their item_created audit row was written above) ---
  let batchResults: Array<{ meta?: { last_row_id?: number } }> = [];
  if (uploadedKeys.length > 0) {
    try {
      const statements = uploadedKeys.map(({ file, r2Key }) =>
        c.env.DB.prepare(
          'INSERT INTO approval_attachments (item_id, r2_key, filename, mime_type, size) VALUES (?, ?, ?, ?, ?)',
        ).bind(itemId, r2Key, file.name, file.type, file.size),
      );
      batchResults = await c.env.DB.batch(statements);
    } catch (err) {
      // Clean up the files just written to R2 so nothing is left orphaned.
      await Promise.allSettled(uploadedKeys.map(({ r2Key }) => c.env.R2_BUCKET.delete(r2Key)));
      return handleApiError(
        c,
        endpoint,
        err,
        'The item was created but its attachments could not be recorded. It is on the board without files; try the upload again.',
        { error_type: 'D1_INSERT_APPROVAL_ATTACHMENTS', http_status: 500 },
      );
    }
  }

  // --- 4. Store the comparison rows with the real attachment ids ---
  if (comparisonRows.length > 0) {
    const attachmentIds = uploadedKeys.map(({ file }, i) => ({
      name: file.name,
      id: Number(batchResults[i]?.meta?.last_row_id),
    }));
    const stored = comparisonRows.map((row) => ({
      attachmentId: attachmentIds.find((a) => a.name === row.file)?.id ?? null,
      description: row.description,
      ...(row.quoteDate ? { quoteDate: row.quoteDate } : {}),
    }));
    if (stored.some((s) => !s.attachmentId || Number.isNaN(s.attachmentId))) {
      return handleApiError(
        c,
        endpoint,
        new Error('comparison mapping failed'),
        'The item was created but its comparison table could not be recorded. Open the item and rebuild the table.',
        { error_type: 'D1_MAP_APPROVAL_COMPARISON', http_status: 500 },
      );
    }
    try {
      await c.env.DB.prepare("UPDATE approval_items SET comparison = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(stored), itemId)
        .run();
    } catch (err) {
      return handleApiError(
        c,
        endpoint,
        err,
        'The item was created and its attachments saved, but the comparison table could not be stored. Open the item and rebuild the table.',
        { error_type: 'D1_UPDATE_APPROVAL_COMPARISON', http_status: 500 },
      );
    }
  }

  // --- 5. R7: mark the ticked Tax Invoice (at most one per item — the flag
  //     UPDATE clears any other). The form sends the chosen file's name.
  //     Best-effort: a failure never rolls the item back.
  const taxInvoiceName = typeof form['taxInvoice'] === 'string' ? form['taxInvoice'].trim() : '';
  if (taxInvoiceName && uploadedKeys.length > 0) {
    const idx = uploadedKeys.findIndex(({ file }) => file.name === taxInvoiceName);
    const attId = idx >= 0 ? Number(batchResults[idx]?.meta?.last_row_id) : 0;
    if (Number.isInteger(attId) && attId > 0) {
      try {
        await setTaxInvoiceFlag(c.env.DB, itemId, attId);
      } catch (err) {
        await logError(c.env, {
          endpoint,
          error_type: 'D1_UPDATE_TAX_INVOICE_FLAG',
          error_message: `create tax-invoice flag failed: ${err instanceof Error ? err.message : String(err)}`,
          http_status: 500,
          user_email: session.email,
        });
      }
    }
  }

  // --- 6. Email the purchase approvers when the item needs a decision.
  //     Recurring items (approval_required = 0) email nobody (plan §10).
  //     Non-blocking: an email failure never fails the create.
  if (approvalRequired) {
    const emailItem: ApprovalEmailItem = {
      id: itemId,
      title,
      categoryLabel: category.label,
      payee: payeeRaw || null,
      requestedAmount,
      description: descriptionRaw || null,
      createdBy: session.email,
      fileCount: fileList.length,
    };
    c.executionCtx.waitUntil(sendApprovalRequestEmail(c.env, emailItem, 'new').catch(() => { /* logged inside */ }));
  }

  return c.json({ success: true, id: itemId, status }, 201);
}

/* ----------------------------------------------------
   POST /api/approvals/analyse-preview  (multipart, form-time)
   Docs/plans/AI-Quotation-Comparison-Plan.md §4.3.
   Admin only (item-creator tier). Reads the ticked
   quotation files with Workers AI and returns the
   analysis JSON; stores nothing. The form replays it to
   POST /api/approvals as the aiComparison field.

   Guard order: role → kill-switch → daily circuit breaker
   → validation, so no AI quota is spent on a request that
   cannot run. Rate limit: approvals:analyse:post (10/hour
   per email) in middleware gate 8.
   ---------------------------------------------------- */
export async function handleApprovalAnalysePreview(c: AppContext) {
  const endpoint = 'approvals-analyse-preview';
  const session = { email: getSessionEmail(c), role: getSessionRole(c) };
  if (!canRaiseApprovalItem(session)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only the office admin can analyse quotations.' }, 403);
  }
  if (!(await isAiComparisonEnabled(c.env.SWA_CONFIG))) {
    return c.json({ success: false, error_code: 'FEATURE_DISABLED', message: 'AI comparison is disabled by an IT administrator.' }, 503);
  }
  if (!(await consumeDailyAnalysisQuota(c.env.SWA_SESSION))) {
    return c.json({ success: false, error_code: 'RATE_LIMITED', message: 'The portal-wide daily AI analysis limit is exhausted. Try again tomorrow.' }, 429);
  }

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  const filesRaw = form['files'];
  const fileList: File[] = [];
  if (Array.isArray(filesRaw)) {
    for (const f of filesRaw) if (f instanceof File && f.size > 0) fileList.push(f);
  } else if (filesRaw instanceof File && filesRaw.size > 0) {
    fileList.push(filesRaw);
  }

  if (fileList.length < 2) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Select at least two quotation documents to compare.' }, 400);
  }
  if (fileList.length > APPROVAL_MAX_FILES_PER_ITEM) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: `At most ${APPROVAL_MAX_FILES_PER_ITEM} files per item.` },
      400,
    );
  }
  for (const file of fileList) {
    if (!ALLOWED_ATTACHMENT_MIME.has(file.type)) {
      return c.json(
        {
          success: false,
          error_code: 'VALIDATION_ERROR',
          message: `"${file.name}" is not an accepted type. Only PDF, JPG, PNG, WebP, HEIC and HEIF files are allowed.`,
        },
        400,
      );
    }
    if (file.size > APPROVAL_MAX_FILE_BYTES) {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `"${file.name}" is larger than 10 MB.` }, 400);
    }
  }

  const inputs: AiComparisonInput[] = [];
  for (const file of fileList) {
    inputs.push({ filename: file.name, mime: file.type, bytes: await file.arrayBuffer() });
  }

  let analysis: AiComparison;
  try {
    analysis = await runAiComparison(c.env, inputs, session.email);
  } catch (err) {
    return handleApiError(c, endpoint, err, 'The AI analysis failed. Please try again in a moment.', {
      error_type: 'AI_RUN',
      http_status: 502,
    });
  }
  if (analysis.quotes.length === 0) {
    const reasons = analysis.files.map((f) => `${f.filename}: ${f.note || 'could not be read'}`).join('; ');
    return c.json(
      { success: false, error_code: 'AI_READ_FAILED', message: `None of the documents could be read. ${reasons}` },
      502,
    );
  }
  return c.json({ success: true, analysis });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/analyse  (regenerate)
   Admin only, reached from the edit form (owner decision
   26-08-2026 — the drawer Regenerate button was removed).
   Only while the item is editable (pending, or rejected at
   the purchase stage): fields freeze at purchase approval,
   and the AI comparison derives from those fields. Reads
   the item's ticked comparison attachments from R2, runs
   the same pipeline, stores the result in
   approval_items.ai_comparison and writes an
   ai_comparison_generated audit row.
   ---------------------------------------------------- */
export async function handleApprovalAnalyseItem(c: AppContext) {
  const endpoint = 'approvals-analyse-item';
  const session = { email: getSessionEmail(c), role: getSessionRole(c) };
  if (!canRaiseApprovalItem(session)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only the office admin can analyse quotations.' }, 403);
  }
  if (!(await isAiComparisonEnabled(c.env.SWA_CONFIG))) {
    return c.json({ success: false, error_code: 'FEATURE_DISABLED', message: 'AI comparison is disabled by an IT administrator.' }, 503);
  }
  if (!(await consumeDailyAnalysisQuota(c.env.SWA_SESSION))) {
    return c.json({ success: false, error_code: 'RATE_LIMITED', message: 'The portal-wide daily AI analysis limit is exhausted. Try again tomorrow.' }, 429);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare('SELECT id, title, status, rejected_stage, comparison FROM approval_items WHERE id = ?')
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_ANALYSE', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }
  const status = String(item.status);
  const rejectedStage = item.rejected_stage ? String(item.rejected_stage) : '';
  const editable = status === 'pending' || (status === 'rejected' && rejectedStage === 'purchase');
  if (!editable) {
    return c.json(
      {
        success: false,
        error_code: 'CONFLICT',
        message: 'AI comparison can only be regenerated while the item is editable (pending, or rejected at the purchase stage). Fields freeze at purchase approval.',
      },
      409,
    );
  }

  // Which attachments are quotations comes from the ticked comparison rows —
  // the same set the form-time preview analysed.
  let comparisonRows: Array<{ attachmentId: number }> = [];
  if (typeof item.comparison === 'string' && item.comparison.length > 0) {
    try {
      const parsed = JSON.parse(item.comparison);
      if (Array.isArray(parsed)) {
        comparisonRows = parsed
          .map((row) => Number((row as Record<string, unknown>)?.attachmentId))
          .filter((attachmentId) => Number.isInteger(attachmentId) && attachmentId > 0)
          .map((attachmentId) => ({ attachmentId }));
      }
    } catch {
      comparisonRows = [];
    }
  }
  if (comparisonRows.length < 2) {
    return c.json(
      {
        success: false,
        error_code: 'VALIDATION_ERROR',
        message: 'Tick at least two quotations in the comparison table first, then analyse again.',
      },
      400,
    );
  }

  const wantedIds = new Set(comparisonRows.map((r) => r.attachmentId));
  const attRows = await c.env.DB.prepare(
    'SELECT id, r2_key, filename, mime_type FROM approval_attachments WHERE item_id = ?',
  )
    .bind(Number(id))
    .all<{ id: number; r2_key: string; filename: string; mime_type: string }>();
  const attachments = (attRows.results || []).filter((a) => wantedIds.has(Number(a.id)));

  // Fetch from R2 and buffer. Quotation sets are small (2–10 files); the
  // 10-file cap bounds memory well under the isolate limit.
  const inputs: AiComparisonInput[] = [];
  const missing: Array<{ filename: string; status: 'error'; note: string }> = [];
  const byId = new Map(attachments.map((a) => [Number(a.id), a]));
  for (const wanted of wantedIds) {
    const att = byId.get(wanted);
    if (!att) {
      missing.push({ filename: `attachment ${wanted}`, status: 'error', note: 'Attachment record missing.' });
      continue;
    }
    const obj = await c.env.R2_BUCKET.get(att.r2_key);
    if (!obj) {
      missing.push({ filename: att.filename, status: 'error', note: 'Attachment missing from storage.' });
      continue;
    }
    inputs.push({ filename: att.filename, mime: att.mime_type, bytes: await obj.arrayBuffer() });
  }

  let analysis: AiComparison;
  try {
    analysis = await runAiComparison(c.env, inputs, session.email);
  } catch (err) {
    return handleApiError(c, endpoint, err, 'The AI analysis failed. Please try again in a moment.', {
      error_type: 'AI_RUN',
      http_status: 502,
    });
  }
  analysis.files = [...missing, ...analysis.files];
  if (analysis.quotes.length === 0) {
    const reasons = analysis.files.map((f) => `${f.filename}: ${f.note || 'could not be read'}`).join('; ');
    return c.json({ success: false, error_code: 'AI_READ_FAILED', message: `None of the documents could be read. ${reasons}` }, 502);
  }

  // Store the analysis; the audit row is best-effort (the state column is the
  // source of truth — same philosophy as applyTransition).
  try {
    await c.env.DB.prepare("UPDATE approval_items SET ai_comparison = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(analysis), Number(id))
      .run();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not save the analysis.', {
      error_type: 'D1_UPDATE_APPROVAL_AI_COMPARISON',
      http_status: 500,
    });
  }
  const okCount = analysis.files.filter((f) => f.status === 'ok').length;
  try {
    await c.env.DB.prepare('INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)')
      .bind(Number(id), 'ai_comparison_generated', session.email, getSessionName(c) || session.email, `read=${okCount} of ${analysis.files.length}`)
      .run();
  } catch (err) {
    await logError(c.env, {
      endpoint: 'approvals-analyse-audit',
      error_type: 'D1_AUDIT',
      error_message: `ai comparison audit insert failed: ${err instanceof Error ? err.message : String(err)}`,
      http_status: 500,
      user_email: session.email,
    });
  }

  return c.json({ success: true, analysis });
}

/* ----------------------------------------------------
   GET /api/approvals/:id
   Detail: item fields, attachments, parsed comparison.
   ---------------------------------------------------- */
export async function handleApprovalDetail(c: AppContext) {
  const endpoint = 'approvals-detail';
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  try {
    const item = await c.env.DB.prepare(
      'SELECT id, category, title, payee, description, requested_amount, approval_required, status, rejected_stage, ' +
        'purchase_decision_by, purchase_decision_at, purchase_decision_office, rejection_reason, ' +
        'voucher_no, voucher_date, voucher_lines, voucher_submitted_by, voucher_submitted_at, invoice_no, ' +
        'finance_decision_by, finance_decision_at, finance_decision_office, finance_rejection_reason, ' +
        'paid_by, paid_at, payment_method, payment_reference, created_by, comparison, ai_comparison, ' +
        'board_approval_ref, quotation_waiver_reason, supplier_is_cheapest, supplier_choice_reason, ' +
        'budget_approved, budget_amount, budget_officer, budget_date, coi_declared, no_split_declared, ' +
        'created_at, updated_at ' +
        'FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();

    if (!item) {
      return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
    }

    // R7: the ticked Tax Invoice always renders first, then upload order.
    const attachmentsResult = await c.env.DB.prepare(
      'SELECT id, filename, mime_type, size, is_tax_invoice, created_at FROM approval_attachments WHERE item_id = ? ORDER BY is_tax_invoice DESC, id',
    )
      .bind(Number(id))
      .all();

    let comparison: unknown[] | null = null;
    if (typeof item.comparison === 'string' && item.comparison.length > 0) {
      try {
        const parsed = JSON.parse(item.comparison);
        if (Array.isArray(parsed)) comparison = parsed;
      } catch {
        comparison = null;
      }
    }

    let aiComparison: unknown = null;
    if (typeof item.ai_comparison === 'string' && item.ai_comparison.length > 0) {
      try {
        aiComparison = JSON.parse(item.ai_comparison);
      } catch {
        aiComparison = null;
      }
    }

    // Same duplicate-invoice warning as the voucher step (plan §6.4), so the
    // drawer and the payment form can warn without an extra call.
    let duplicateInvoice: { id: number; voucherNo: string | null } | null = null;
    if (item.invoice_no) {
      const dup = await c.env.DB.prepare(
        'SELECT id, voucher_no FROM approval_items WHERE invoice_no = ? COLLATE NOCASE AND id != ? LIMIT 1',
      )
        .bind(String(item.invoice_no), Number(id))
        .first<{ id: number; voucher_no: string | null }>();
      if (dup) {
        duplicateInvoice = { id: Number(dup.id), voucherNo: dup.voucher_no ? String(dup.voucher_no) : null };
      }
    }

    // R6: the category's most recent paid method, so the paid form can
    // pre-select it (remembered by category, not by payee).
    let lastPaidMethod: string | null = null;
    const lastPaid = await c.env.DB.prepare(
      "SELECT payment_method FROM approval_items WHERE category = ? AND status = 'paid' AND payment_method IS NOT NULL ORDER BY paid_at DESC, id DESC LIMIT 1",
    )
      .bind(String(item.category))
      .first<{ payment_method: string }>();
    if (lastPaid) lastPaidMethod = String(lastPaid.payment_method);

    return c.json({
      success: true,
      item: { ...item, comparison, ai_comparison: aiComparison },
      attachments: attachmentsResult.results || [],
      duplicate_invoice: duplicateInvoice,
      last_paid_method: lastPaidMethod,
    });
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the approval item.', {
      error_type: 'D1_SELECT_APPROVAL_DETAIL',
      http_status: 500,
    });
  }
}

/* ----------------------------------------------------
   GET /api/approvals/:id/attachment/:attId[?download=1]
   Streams an attachment from R2 for in-page viewing.
   Plan §9: nosniff, inline disposition with sanitised
   filename, attachment disposition when ?download=1.
   ---------------------------------------------------- */
export async function handleApprovalAttachment(c: AppContext) {
  const endpoint = 'approvals-attachment';
  const id = c.req.param('id') || '';
  const attId = c.req.param('attId') || '';
  if (!/^\d+$/.test(id) || !/^\d+$/.test(attId)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid attachment id.' }, 400);
  }

  let row: { r2_key: string; filename: string; mime_type: string } | null = null;
  try {
    row = await c.env.DB.prepare(
      'SELECT r2_key, filename, mime_type FROM approval_attachments WHERE id = ? AND item_id = ?',
    )
      .bind(Number(attId), Number(id))
      .first();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the attachment.', {
      error_type: 'D1_SELECT_APPROVAL_ATTACHMENT',
      http_status: 500,
    });
  }

  if (!row) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Attachment not found.' }, 404);
  }

  const obj = await c.env.R2_BUCKET.get(row.r2_key);
  if (!obj) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Attachment missing from storage.' }, 404);
  }

  const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline';
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mime_type || obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': contentDisposition(disposition, row.filename),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/approve  (purchase stage)
   Purchase approvers only (re-checked here — plan §3).
   Atomic UPDATE … WHERE status='pending' so two approvers
   clicking at once cannot both decide (membership pattern).
   Audit row lands in the same D1 batch as the state change.
   ---------------------------------------------------- */
export async function handleApprovalPurchaseApprove(c: AppContext) {
  const endpoint = 'approvals-purchase-approve';
  const email = getSessionEmail(c);
  if (!isPurchaseApprover(email)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only purchase approvers can approve at this stage.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare(
      'SELECT id, title, category, payee, description, requested_amount, created_by, approval_required, board_approval_ref FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_APPROVE', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }
  // Manual rule (plan §6.1): the requestor cannot decide their own request.
  // Closes the IT-admin path — an IT admin who creates an item is also a
  // purchase approver through the IT-admin union.
  if (String(item.created_by || '').toLowerCase() === email.toLowerCase()) {
    return c.json(
      { success: false, error_code: 'FORBIDDEN', message: 'You raised this request, so you cannot approve or reject it. Another approver must decide.' },
      403,
    );
  }
  // Manual 3.3 / plan §7.3: above S$10,000 the board's approval — a recorded
  // reference plus at least one attached document (the minutes or approval
  // email PDF) — must exist before the purchase decision. The reference
  // points the approver to the evidence; the approver's eyes confirm it.
  const approveAmount = item.requested_amount === null || item.requested_amount === undefined ? null : Number(item.requested_amount);
  if (approveAmount !== null && approveAmount >= APPROVAL_BOARD_APPROVAL_THRESHOLD) {
    if (!item.board_approval_ref || String(item.board_approval_ref).trim().length === 0) {
      return c.json(
        {
          success: false,
          error_code: 'CONFLICT',
          message: 'This purchase is S$10,000 or more. Record the board approval reference (for example \u2018Board meeting 12 Aug 2026, item 4\u2019) on the request first.',
        },
        409,
      );
    }
    const attCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM approval_attachments WHERE item_id = ?')
      .bind(Number(id))
      .first<{ n: number }>();
    if (Number(attCount?.n || 0) === 0) {
      return c.json({ success: false, error_code: 'CONFLICT', message: 'Attach the board minutes or the approval email before approving.' }, 409);
    }
  }

  try {
    // The item column stores the printed name (the voucher shows "Approved
    // by <name>"); the audit row keeps the email for traceability. The office
    // column records the signer's office (President, Treasurer, …) — null
    // when the address holds no mapped office (plan §6.2).
    const deciderName = getSessionName(c) || email;
    const deciderOffice = approvalOfficeFor(email);
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'purchase_approved', purchase_decision_by = ?, purchase_decision_office = ?, purchase_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
      ).bind(deciderName, deciderOffice, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(Number(id), 'purchase_approved', email, deciderName, deciderOffice ? `office=${deciderOffice}` : null),
    );
    if (!changed) {
      return c.json(
        { success: false, error_code: 'CONFLICT', message: 'Item is no longer pending. It may have been actioned by another approver.' },
        409,
      );
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not approve the item.', { error_type: 'D1_UPDATE_APPROVAL_APPROVE', http_status: 500 });
  }

  c.executionCtx.waitUntil(
    sendPurchaseDecisionEmail(c.env, await loadEmailItem(c, Number(id), item), {
      approved: true,
      decidedBy: getSessionName(c) || email,
      decidedByOffice: approvalOfficeFor(email) ?? undefined,
    }).catch(() => { /* logged inside */ }),
  );

  return c.json({ success: true, status: 'purchase_approved' });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/reject  (purchase stage)
   Body: { reason } — required, ≤1000 chars.
   Sets rejected_stage='purchase' so resubmission routes
   back to pending (plan §4).
   ---------------------------------------------------- */
export async function handleApprovalPurchaseReject(c: AppContext) {
  const endpoint = 'approvals-purchase-reject';
  const email = getSessionEmail(c);
  if (!isPurchaseApprover(email)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only purchase approvers can reject at this stage.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }
  const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
  if (reason.length < 1 || reason.length > MAX_REJECTION_REASON_LENGTH) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: `A rejection reason is required (1–${MAX_REJECTION_REASON_LENGTH} characters).` },
      400,
    );
  }

  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare(
      'SELECT id, title, category, payee, description, requested_amount, created_by FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_REJECT', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }
  if (String(item.created_by || '').toLowerCase() === email.toLowerCase()) {
    return c.json(
      { success: false, error_code: 'FORBIDDEN', message: 'You raised this request, so you cannot approve or reject it. Another approver must decide.' },
      403,
    );
  }

  try {
    const deciderName = getSessionName(c) || email;
    const deciderOffice = approvalOfficeFor(email);
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'rejected', rejected_stage = 'purchase', rejection_reason = ?,
                purchase_decision_by = ?, purchase_decision_office = ?, purchase_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
      ).bind(reason, deciderName, deciderOffice, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(Number(id), 'purchase_rejected', email, deciderName, reason + (deciderOffice ? `; office=${deciderOffice}` : '')),
    );
    if (!changed) {
      return c.json(
        { success: false, error_code: 'CONFLICT', message: 'Item is no longer pending. It may have been actioned by another approver.' },
        409,
      );
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not reject the item.', { error_type: 'D1_UPDATE_APPROVAL_REJECT', http_status: 500 });
  }

  c.executionCtx.waitUntil(
    sendPurchaseDecisionEmail(c.env, await loadEmailItem(c, Number(id), item), {
      approved: false,
      reason,
      decidedBy: getSessionName(c) || email,
      decidedByOffice: approvalOfficeFor(email) ?? undefined,
    }).catch(() => { /* logged inside */ }),
  );

  return c.json({ success: true, status: 'rejected', rejected_stage: 'purchase' });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/edit
   Admin only (canRaiseApprovalItem). Multipart:
   title/payee/description/requestedAmount, optional new
   `files`, optional `comparison` JSON referencing
   attachment ids (existing or newly added), and
   resubmit=true to return a rejected item to the stage
   that rejected it (plan §4 routing).
   Editable while status IN (pending, rejected).
   ---------------------------------------------------- */
export async function handleApprovalEdit(c: AppContext) {
  const endpoint = 'approvals-edit';
  const session = { email: getSessionEmail(c), role: getSessionRole(c) };
  if (!canRaiseApprovalItem(session)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only the office admin can edit approval items.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare(
      'SELECT id, status, rejected_stage, approval_required, category, created_by, ai_comparison, requested_amount, ' +
        'title, payee, description, comparison, ' +
        'board_approval_ref, quotation_waiver_reason, supplier_is_cheapest, supplier_choice_reason, ' +
        'budget_approved, budget_amount, budget_officer, budget_date, coi_declared, no_split_declared ' +
        'FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_EDIT', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }
  const status = String(item.status);
  const rejectedStage = item.rejected_stage ? String(item.rejected_stage) : '';
  const editable = status === 'pending' || (status === 'rejected' && rejectedStage === 'purchase');
  if (!editable) {
    // Owner decision (gap 4): once purchase has approved an item, its fields
    // are frozen. A finance-stage rejection must be corrected through the
    // voucher, not the item edit form.
    return c.json(
      {
        success: false,
        error_code: 'CONFLICT',
        message: 'Only pending items, or items rejected at the purchase stage, can be edited. Once an item is purchase approved its fields are locked; after a finance rejection, edit the voucher instead.',
      },
      409,
    );
  }

  // --- Field validation (same rules as create; every field optional) ---
  const updates: string[] = [];
  const params: unknown[] = [];

  if (form['title'] !== undefined) {
    const title = String(form['title']).trim();
    if (title.length < 1 || title.length > MAX_TITLE_LENGTH) {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `Title must be 1–${MAX_TITLE_LENGTH} characters.` }, 400);
    }
    updates.push('title = ?');
    params.push(title);
  }
  if (form['payee'] !== undefined) {
    const payee = String(form['payee']).trim();
    if (payee.length > MAX_PAYEE_LENGTH) {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Payee is too long.' }, 400);
    }
    updates.push('payee = ?');
    params.push(payee || null);
  }
  if (form['description'] !== undefined) {
    const description = String(form['description']).trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` }, 400);
    }
    updates.push('description = ?');
    params.push(description || null);
  }
  if (form['requestedAmount'] !== undefined) {
    const raw = String(form['requestedAmount']).trim();
    if (raw.length > 0) {
      const parsed = Number(raw);
      // Same rule as create: > 0 when present (owner decision 29-08-2026).
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_REQUESTED_AMOUNT) {
        return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Requested amount must be greater than 0 and at most 10,000,000.' }, 400);
      }
      updates.push('requested_amount = ?');
      params.push(Math.round(parsed * 100) / 100);
    } else {
      updates.push('requested_amount = ?');
      params.push(null);
    }
  }

  // Manual money rule (plan §6.3): at S$5,000 and above both stages are
  // forced on, even for recurring categories. "Effective" = the form value
  // when provided, otherwise the stored value. Edit only runs while the
  // item is pending or purchase-rejected, so this can never flip a decided
  // item. No bind param — the clause is a literal.
  const storedAmount = item.requested_amount === null || item.requested_amount === undefined ? null : Number(item.requested_amount);
  const formAmountProvided = form['requestedAmount'] !== undefined && String(form['requestedAmount']).trim().length > 0;
  const effectiveAmount = formAmountProvided ? Number(String(form['requestedAmount']).trim()) : storedAmount;
  if (effectiveAmount !== null && effectiveAmount >= APPROVAL_TWO_STAGE_THRESHOLD) {
    updates.push('approval_required = 1');
  }

  // --- AI analysis text edits (owner decision 26-08-2026) ---
  //     The summary/recommendation are editable fields like the others:
  //     changeable while the item is editable (the UPDATE's WHERE clause
  //     re-checks that), frozen after purchase approval. Undefined = field
  //     not sent (form hides the textareas when no analysis exists); empty
  //     string = cleared (stores null).
  let aiSummary: string | null | undefined;
  if (form['aiSummary'] !== undefined) {
    const v = String(form['aiSummary']).trim();
    if (v.length > MAX_AI_SUMMARY_LENGTH) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: `AI summary must be ${MAX_AI_SUMMARY_LENGTH} characters or fewer.` },
        400,
      );
    }
    aiSummary = v.length === 0 ? null : v;
  }
  let aiRecommendation: string | null | undefined;
  if (form['aiRecommendation'] !== undefined) {
    const v = String(form['aiRecommendation']).trim();
    if (v.length > MAX_AI_RECOMMENDATION_LENGTH) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: `AI recommendation must be ${MAX_AI_RECOMMENDATION_LENGTH} characters or fewer.` },
        400,
      );
    }
    aiRecommendation = v.length === 0 ? null : v;
  }
  if ((aiSummary !== undefined || aiRecommendation !== undefined) && (typeof item.ai_comparison !== 'string' || item.ai_comparison.length === 0)) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'This item has no AI analysis to edit. Run Analyse with AI first.' },
      400,
    );
  }
  let aiComparisonUpdate: string | null = null;
  if (aiSummary !== undefined || aiRecommendation !== undefined) {
    try {
      const storedAnalysis = JSON.parse(String(item.ai_comparison)) as Record<string, unknown>;
      if (aiSummary !== undefined) storedAnalysis['summary'] = aiSummary;
      if (aiRecommendation !== undefined) storedAnalysis['recommendation'] = aiRecommendation;
      aiComparisonUpdate = JSON.stringify(storedAnalysis);
    } catch {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'The stored AI analysis is unreadable and cannot be edited. Re-run Analyse with AI.' }, 400);
    }
  }

  // --- Resubmit flag ---
  const resubmit = String(form['resubmit'] ?? '').toLowerCase() === 'true';
  let newStatus = '';
  if (resubmit) {
    if (status !== 'rejected') {
      return c.json({ success: false, error_code: 'CONFLICT', message: 'Only rejected items can be resubmitted.' }, 409);
    }
    // Only a purchase-stage rejection can reach this form (the gate above
    // excludes finance-stage rejections). Routing per plan §4: a purchase
    // rejection always returns the item to pending.
    newStatus = 'pending';
  }

  // --- New files (same allowlist/caps as create; count existing too) ---
  const filesRaw = form['files'];
  const fileList: File[] = [];
  if (Array.isArray(filesRaw)) {
    for (const f of filesRaw) if (f instanceof File && f.size > 0) fileList.push(f);
  } else if (filesRaw instanceof File && filesRaw.size > 0) {
    fileList.push(filesRaw);
  }

  let existingCount = 0;
  if (fileList.length > 0) {
    try {
      const countRes = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM approval_attachments WHERE item_id = ?')
        .bind(Number(id))
        .first<{ n: number }>();
      existingCount = Number(countRes?.n || 0);
    } catch (err) {
      return handleApiError(c, endpoint, err, 'Could not check existing attachments.', { error_type: 'D1_COUNT_APPROVAL_ATT', http_status: 500 });
    }
    if (existingCount + fileList.length > APPROVAL_MAX_FILES_PER_ITEM) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: `At most ${APPROVAL_MAX_FILES_PER_ITEM} files per item (this item already has ${existingCount}).` },
        400,
      );
    }
    for (const file of fileList) {
      if (!ALLOWED_ATTACHMENT_MIME.has(file.type)) {
        return c.json(
          { success: false, error_code: 'VALIDATION_ERROR', message: `"${file.name}" is not an accepted type. Only PDF, JPG, PNG, WebP, HEIC and HEIF files are allowed.` },
          400,
        );
      }
      if (file.size > APPROVAL_MAX_FILE_BYTES) {
        return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `"${file.name}" is larger than 10 MB.` }, 400);
      }
    }
  }

  // --- Optional comparison rebuild, referencing attachment ids ---
  let comparisonJson: string | null = null;
  if (form['comparison'] !== undefined) {
    const comparisonRaw = typeof form['comparison'] === 'string' ? form['comparison'].trim() : '';
    if (comparisonRaw.length === 0) {
      comparisonJson = null; // explicit clear
    } else {
      try {
        const parsed: unknown = JSON.parse(comparisonRaw);
        if (!Array.isArray(parsed) || parsed.length > MAX_COMPARISON_ROWS) throw new Error('bad shape');
        const rows: Array<{ attachmentId: number; description: string; quoteDate?: string }> = [];
        for (const row of parsed) {
          const attachmentId = Number((row as Record<string, unknown>)?.attachmentId);
          const description = String((row as Record<string, unknown>)?.description ?? '').trim();
          if (!Number.isInteger(attachmentId) || attachmentId <= 0) throw new Error('bad attachmentId');
          if (description.length < 1 || description.length > MAX_COMPARISON_DESCRIPTION_LENGTH) throw new Error('bad description');
          // Optional quotation date (plan §7.2), same rule as create.
          const quoteDateRaw =
            typeof (row as Record<string, unknown>)?.quoteDate === 'string' ? String((row as Record<string, unknown>).quoteDate).trim() : '';
          if (quoteDateRaw.length > 0 && !isRealDate(quoteDateRaw)) throw new Error('bad quoteDate');
          const rowOut: { attachmentId: number; description: string; quoteDate?: string } = { attachmentId, description };
          if (quoteDateRaw) rowOut.quoteDate = quoteDateRaw;
          rows.push(rowOut);
        }
        // Every referenced id must belong to this item — verified AFTER the
        // new attachment rows exist (ids from this same request are valid too).
        comparisonJson = JSON.stringify(rows);
      } catch {
        return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Comparison table is malformed.' }, 400);
      }
    }
  }

  // --- Compliance evidence (plan §7.1): "effective" = the form value when
  //     provided, otherwise the stored value. The comparison-row count for
  //     the quotes-or-waiver rule is the table AFTER this edit (sent or
  //     stored). Validated only when the effective amount is S$1,000+. ---
  const evidenceForm = parseEvidenceForm(form);
  const evidenceStored = storedEvidence(item);
  const effectiveEvidence = mergeEvidence(evidenceForm, evidenceStored);
  let storedComparisonCount = 0;
  if (typeof item.comparison === 'string' && item.comparison.length > 0) {
    try {
      const parsedStored = JSON.parse(item.comparison);
      if (Array.isArray(parsedStored)) storedComparisonCount = parsedStored.length;
    } catch {
      storedComparisonCount = 0;
    }
  }
  const effectiveComparisonCount = form['comparison'] !== undefined ? (comparisonJson ? JSON.parse(comparisonJson).length : 0) : storedComparisonCount;
  const evidenceCheck = validateEvidence(effectiveEvidence, effectiveComparisonCount, effectiveAmount);
  if (!evidenceCheck.ok) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: evidenceCheck.message }, 400);
  }
  // Store whichever evidence fields the form actually sent (absent = keep).
  if (form['boardApprovalRef'] !== undefined) {
    updates.push('board_approval_ref = ?');
    params.push(evidenceForm.boardApprovalRef);
  }
  if (form['quotationWaiverReason'] !== undefined) {
    updates.push('quotation_waiver_reason = ?');
    params.push(evidenceForm.quotationWaiverReason);
  }
  if (evidenceForm.supplierIsCheapest !== null) {
    updates.push('supplier_is_cheapest = ?');
    params.push(evidenceForm.supplierIsCheapest ? 1 : 0);
  }
  if (form['supplierChoiceReason'] !== undefined) {
    updates.push('supplier_choice_reason = ?');
    params.push(evidenceForm.supplierChoiceReason);
  }
  if (form['budgetApproved'] !== undefined) {
    updates.push('budget_approved = ?');
    params.push(evidenceForm.budgetApproved ? 1 : 0);
  }
  if (form['budgetAmount'] !== undefined) {
    updates.push('budget_amount = ?');
    params.push(evidenceForm.budgetAmount);
  }
  if (form['budgetOfficer'] !== undefined) {
    updates.push('budget_officer = ?');
    params.push(evidenceForm.budgetOfficer);
  }
  if (form['budgetDate'] !== undefined) {
    updates.push('budget_date = ?');
    params.push(evidenceForm.budgetDate);
  }
  if (form['coiDeclared'] !== undefined) {
    updates.push('coi_declared = ?');
    params.push(evidenceForm.coiDeclared ? 1 : 0);
  }
  if (form['noSplitDeclared'] !== undefined) {
    updates.push('no_split_declared = ?');
    params.push(evidenceForm.noSplitDeclared ? 1 : 0);
  }

  // --- 1. Upload new files to R2 (before the UPDATE so ids exist) ---
  const uploadedKeys: Array<{ file: File; r2Key: string }> = [];
  if (fileList.length > 0) {
    try {
      for (const file of fileList) {
        const ext = MIME_EXTENSION[file.type] || 'bin';
        const r2Key = `approvals/${Number(id)}/${crypto.randomUUID()}.${ext}`;
        await c.env.R2_BUCKET.put(r2Key, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: {
            item_id: String(id),
            original_filename: file.name,
            uploaded_by: session.email,
            uploaded_at: new Date().toISOString(),
          },
        });
        uploadedKeys.push({ file, r2Key });
      }
    } catch (err) {
      await logError(c.env, {
        endpoint,
        error_type: 'R2_PUT',
        error_message: `approvals-edit r2: ${err instanceof Error ? err.message : String(err)}`,
        http_status: 500,
        user_email: session.email,
      });
      return c.json({ success: false, error_code: 'UPLOAD_FAILED', message: 'Could not save the attached files. Please try again.' }, 500);
    }
  }

  // --- 2. Attachment batch first, so comparison rows can reference the new ids ---
  const actorName = getSessionName(c) || session.email;
  const newAttachmentIds: number[] = [];
  try {
    if (uploadedKeys.length > 0) {
      const statements: D1PreparedStatement[] = uploadedKeys.map(({ file, r2Key }) =>
        c.env.DB.prepare('INSERT INTO approval_attachments (item_id, r2_key, filename, mime_type, size) VALUES (?, ?, ?, ?, ?)').bind(
          Number(id),
          r2Key,
          file.name,
          file.type,
          file.size,
        ),
      );
      statements.push(
        c.env.DB.prepare('INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)').bind(
          Number(id),
          'attachments_added',
          session.email,
          actorName,
          `files=${uploadedKeys.length}`,
        ),
      );
      const results = await c.env.DB.batch(statements);
      for (let i = 0; i < uploadedKeys.length; i++) {
        newAttachmentIds.push(Number((results[i].meta as { last_row_id?: number }).last_row_id));
      }
    }
  } catch (err) {
    // Clean up the files just written to R2 so nothing is left orphaned.
    await Promise.allSettled(uploadedKeys.map(({ r2Key }) => c.env.R2_BUCKET.delete(r2Key)));
    return handleApiError(c, endpoint, err, 'The attachments could not be recorded. Please try again.', {
      error_type: 'D1_INSERT_APPROVAL_ATTACHMENTS',
      http_status: 500,
    });
  }

  // --- 3. Comparison attachment-id validation (existing ∪ new ids) ---
  if (comparisonJson !== null) {
    const rows = JSON.parse(comparisonJson) as Array<{ attachmentId: number }>;
    const valid = await c.env.DB.prepare('SELECT id FROM approval_attachments WHERE item_id = ?').bind(Number(id)).all();
    const validIds = new Set<number>([...(valid.results || []).map((r) => Number((r as { id: number }).id)), ...newAttachmentIds]);
    if (!rows.every((r) => validIds.has(r.attachmentId))) {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Comparison rows must reference this item\u2019s attachments.' }, 400);
    }
  }

  // --- 3b. R7: Tax Invoice tick — at most one per item (the flag UPDATE
  //     clears any other). Accepts an existing attachment id or the name of
  //     a file added in this request. Best-effort. ---
  const taxInvoiceAttRaw = typeof form['taxInvoiceAttachmentId'] === 'string' ? form['taxInvoiceAttachmentId'].trim() : '';
  const taxInvoiceFilename = typeof form['taxInvoiceFilename'] === 'string' ? form['taxInvoiceFilename'].trim() : '';
  let taxInvoiceTargetId = 0;
  if (taxInvoiceAttRaw && /^\d+$/.test(taxInvoiceAttRaw)) {
    taxInvoiceTargetId = Number(taxInvoiceAttRaw);
  } else if (taxInvoiceFilename && newAttachmentIds.length > 0) {
    const idx = uploadedKeys.findIndex(({ file }) => file.name === taxInvoiceFilename);
    if (idx >= 0) taxInvoiceTargetId = newAttachmentIds[idx];
  }
  if (taxInvoiceTargetId > 0) {
    try {
      const own = await c.env.DB.prepare('SELECT id FROM approval_attachments WHERE item_id = ? AND id = ?')
        .bind(Number(id), taxInvoiceTargetId)
        .first();
      if (own) await setTaxInvoiceFlag(c.env.DB, Number(id), taxInvoiceTargetId);
    } catch (err) {
      await logError(c.env, {
        endpoint,
        error_type: 'D1_UPDATE_TAX_INVOICE_FLAG',
        error_message: `edit tax-invoice flag failed: ${err instanceof Error ? err.message : String(err)}`,
        http_status: 500,
        user_email: session.email,
      });
    }
  }

  // --- 4. Item update, then audit rows. Two writings, so a lost race (an
  //     approver acts on the item between the read above and this write) never
  //     writes a false audit entry. The WHERE re-checks the editable states. ---
  let finalStatus = status;
  try {
    const setClauses = [...updates];
    const bindParams = [...params];
    if (form['comparison'] !== undefined) {
      setClauses.push('comparison = ?');
      bindParams.push(comparisonJson);
    }
    if (aiComparisonUpdate !== null) {
      setClauses.push('ai_comparison = ?');
      bindParams.push(aiComparisonUpdate);
    }
    const auditActions: Array<{ action: string; note: string | null }> = [];

    if (resubmit) {
      setClauses.push('status = ?', 'rejected_stage = NULL', "updated_at = datetime('now')");
      bindParams.push(newStatus);
      finalStatus = newStatus;
      // Only a purchase-stage rejection reaches the edit form, so reset the
      // purchase decision columns for a clean re-approval.
      setClauses.push('rejection_reason = NULL', 'purchase_decision_by = NULL', 'purchase_decision_at = NULL');
    }

    if (setClauses.length > 0) {
      if (!resubmit) setClauses.push("updated_at = datetime('now')");
      const updateRes = await c.env.DB
        .prepare(
          `UPDATE approval_items SET ${setClauses.join(', ')}
            WHERE id = ? AND (status = 'pending' OR (status = 'rejected' AND rejected_stage = 'purchase'))`,
        )
        .bind(...bindParams, Number(id))
        .run();
      const changes = Number((updateRes.meta as { changes?: number } | undefined)?.changes ?? 0);
      if (changes === 0) {
        return c.json(
          { success: false, error_code: 'CONFLICT', message: 'Item is no longer editable. It may have been actioned by another approver.' },
          409,
        );
      }
      // R1: field-level audit — every changed field as `field: old → new`.
      // Attachments stay excluded (their own attachments_added rows cover
      // them); the AI texts diff against the stored analysis; the comparison
      // table is summarised by row count.
      let oldAiSummaryText: unknown = null;
      let oldAiRecoText: unknown = null;
      if (typeof item.ai_comparison === 'string' && item.ai_comparison.length > 0) {
        try {
          const parsedOld = JSON.parse(item.ai_comparison) as Record<string, unknown>;
          oldAiSummaryText = parsedOld['summary'] ?? null;
          oldAiRecoText = parsedOld['recommendation'] ?? null;
        } catch {
          // unreadable analysis — diff against (none)
        }
      }
      const auditPairs: string[] = [];
      const pushPair = (p: string | null): void => {
        if (p) auditPairs.push(p);
      };
      pushPair(auditPair('title', item.title, form['title'] !== undefined ? String(form['title']).trim() : item.title));
      pushPair(auditPair('payee', item.payee, form['payee'] !== undefined ? String(form['payee']).trim() || null : item.payee));
      pushPair(auditPair('description', item.description, form['description'] !== undefined ? String(form['description']).trim() || null : item.description));
      pushPair(auditPair('requested_amount', item.requested_amount, formAmountProvided ? effectiveAmount : item.requested_amount));
      if (effectiveAmount !== null && effectiveAmount >= APPROVAL_TWO_STAGE_THRESHOLD && Number(item.approval_required) !== 1) {
        pushPair(auditPair('approval_required', item.approval_required, 1));
      }
      pushPair(auditPair('board_approval_ref', evidenceStored.boardApprovalRef, effectiveEvidence.boardApprovalRef));
      pushPair(auditPair('quotation_waiver_reason', evidenceStored.quotationWaiverReason, effectiveEvidence.quotationWaiverReason));
      pushPair(
        auditPair(
          'supplier_is_cheapest',
          evidenceStored.supplierIsCheapest === null ? null : evidenceStored.supplierIsCheapest ? 'yes' : 'no',
          effectiveEvidence.supplierIsCheapest === null ? null : effectiveEvidence.supplierIsCheapest ? 'yes' : 'no',
        ),
      );
      pushPair(auditPair('supplier_choice_reason', evidenceStored.supplierChoiceReason, effectiveEvidence.supplierChoiceReason));
      pushPair(auditPair('budget_approved', evidenceStored.budgetApproved, effectiveEvidence.budgetApproved));
      pushPair(auditPair('budget_amount', evidenceStored.budgetAmount, effectiveEvidence.budgetAmount));
      pushPair(auditPair('budget_officer', evidenceStored.budgetOfficer, effectiveEvidence.budgetOfficer));
      pushPair(auditPair('budget_date', evidenceStored.budgetDate, effectiveEvidence.budgetDate));
      pushPair(auditPair('coi_declared', evidenceStored.coiDeclared, effectiveEvidence.coiDeclared));
      pushPair(auditPair('no_split_declared', evidenceStored.noSplitDeclared, effectiveEvidence.noSplitDeclared));
      if (form['comparison'] !== undefined) {
        pushPair(auditPair('comparison', `${storedComparisonCount} rows`, `${effectiveComparisonCount} rows`));
      }
      if (aiSummary !== undefined) pushPair(auditPair('ai_summary', oldAiSummaryText, aiSummary));
      if (aiRecommendation !== undefined) pushPair(auditPair('ai_recommendation', oldAiRecoText, aiRecommendation));
      auditActions.push({ action: 'item_edited', note: auditPairs.length > 0 ? auditPairs.join('; ') : null });
    }
    if (resubmit) {
      auditActions.push({ action: 'item_resubmitted', note: `to=${newStatus}` });
    }
    // Best-effort audit: an insert failure is logged, never rolls the edit back.
    for (const a of auditActions) {
      try {
        await c.env.DB.prepare('INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)').bind(
          Number(id),
          a.action,
          session.email,
          actorName,
          a.note,
        ).run();
      } catch (err) {
        await logError(c.env, {
          endpoint: 'approvals-edit-audit',
          error_type: 'D1_AUDIT',
          error_message: `edit audit insert failed: ${err instanceof Error ? err.message : String(err)}`,
          http_status: 500,
          user_email: session.email,
        });
      }
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not save the edit.', { error_type: 'D1_UPDATE_APPROVAL_EDIT', http_status: 500 });
  }

  // --- 4. Resubmission re-emails the next stage (plan §10) ---
  if (resubmit && newStatus === 'pending' && item.approval_required === 1) {
    const fresh = await c.env.DB.prepare(
      'SELECT id, title, category, payee, description, requested_amount, created_by FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
    if (fresh) {
      c.executionCtx.waitUntil(
        sendApprovalRequestEmail(c.env, await loadEmailItem(c, Number(id), fresh), 'resubmitted').catch(() => { /* logged inside */ }),
      );
    }
  }
  if (resubmit && newStatus === 'finance_check') {
    // Finance-stage rejection: the item returns to finance check, never to
    // the purchase approvers (plan §4 routing).
    try {
      const fresh = await c.env.DB.prepare(
        'SELECT id, title, payee, voucher_no, voucher_date, voucher_lines, created_by FROM approval_items WHERE id = ?',
      )
        .bind(Number(id))
        .first<Record<string, unknown>>();
      if (fresh) {
        c.executionCtx.waitUntil(
          sendVoucherEmail(c.env, await loadVoucherEmailItem(c, Number(id), fresh), 'resubmitted').catch(() => { /* logged inside */ }),
        );
      }
    } catch {
      // Voucher fields unreadable — the edit itself is saved; do not fail.
    }
  }

  return c.json({ success: true, status: resubmit ? newStatus : status, resubmitted: resubmit });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/remind
   Admin only. Re-sends whichever email the current stage
   needs: purchase request while pending, voucher while in
   finance check (plan §10). Rate-limited by the
   approvals:remind:post key (5/hour per email).
   ---------------------------------------------------- */
export async function handleApprovalRemind(c: AppContext) {
  const endpoint = 'approvals-remind';
  const session = { email: getSessionEmail(c), role: getSessionRole(c) };
  if (!canRaiseApprovalItem(session)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only the office admin can send reminders.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare(
      'SELECT id, title, category, payee, description, requested_amount, created_by, status, approval_required FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_REMIND', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }
  if (item.status !== 'pending' && item.status !== 'finance_check') {
    return c.json(
      { success: false, error_code: 'CONFLICT', message: 'Reminders can only be sent while the item is waiting for a decision (purchase or finance).' },
      409,
    );
  }

  const remindStage = item.status === 'finance_check' ? 'finance' : 'purchase';
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)').bind(
        Number(id),
        'reminder_sent',
        session.email,
        getSessionName(c) || session.email,
        `stage=${remindStage}`,
      ),
    ]);
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not record the reminder.', { error_type: 'D1_INSERT_APPROVAL_REMIND', http_status: 500 });
  }

  if (remindStage === 'finance') {
    const fresh = await c.env.DB.prepare(
      'SELECT id, title, payee, voucher_no, voucher_date, voucher_lines, created_by FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
    if (fresh) {
      c.executionCtx.waitUntil(
        sendVoucherEmail(c.env, await loadVoucherEmailItem(c, Number(id), fresh), 'reminder').catch(() => { /* logged inside */ }),
      );
    }
  } else {
    c.executionCtx.waitUntil(
      sendApprovalRequestEmail(c.env, await loadEmailItem(c, Number(id), item), 'reminder').catch(() => { /* logged inside */ }),
    );
  }

  return c.json({ success: true });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/voucher  (Phase 4)
   Admin only. JSON: { voucherDate, lines: [{ no?, date?,
   description, amount? }] }. Amounts may be negative
   (deposits); rows may omit the amount entirely (bank-note
   rows) — the total sums what exists (plan §7).

   Allowed from: purchase_approved (first submission) or
   rejected+finance (resubmission). Assigns the PV number at
   first submission from the voucher's own month; the number
   then survives rejection and resubmission unchanged. The
   UNIQUE index refuses a racing duplicate; the handler takes
   the next free number and retries, up to 3 attempts.
   Status → finance_check; emails the finance approvers.
   ---------------------------------------------------- */
interface VoucherLine {
  no: number | null;
  date: string | null;
  description: string;
  amount: number | null;
}

export async function handleApprovalVoucher(c: AppContext) {
  const endpoint = 'approvals-voucher';
  const session = { email: getSessionEmail(c), role: getSessionRole(c) };
  if (!canRaiseApprovalItem(session)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only the office admin can prepare vouchers.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  // --- Voucher date ---
  const voucherDate = typeof body['voucherDate'] === 'string' ? body['voucherDate'].trim() : '';
  if (!isRealDate(voucherDate)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Voucher date must be a valid date (YYYY-MM-DD).' }, 400);
  }

  // --- Invoice/receipt number (plan §6.4) ---
  const MAX_INVOICE_NO_LENGTH = 100;
  const invoiceNoRaw = typeof body['invoiceNo'] === 'string' ? body['invoiceNo'].trim() : '';
  if (invoiceNoRaw.length > MAX_INVOICE_NO_LENGTH) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: `Invoice/receipt number must be ${MAX_INVOICE_NO_LENGTH} characters or fewer.` },
      400,
    );
  }

  // --- Lines ---
  const rawLines = body['lines'];
  if (!Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > MAX_VOUCHER_LINES) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `The voucher needs 1–${MAX_VOUCHER_LINES} lines.` }, 400);
  }
  const lines: VoucherLine[] = [];
  for (const raw of rawLines) {
    const rec = (raw ?? {}) as Record<string, unknown>;
    const description = typeof rec['description'] === 'string' ? rec['description'].trim() : '';
    if (description.length < 1 || description.length > MAX_VOUCHER_LINE_DESCRIPTION) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: `Every line needs a description (1–${MAX_VOUCHER_LINE_DESCRIPTION} characters).` },
        400,
      );
    }
    const dateRaw = typeof rec['date'] === 'string' ? rec['date'].trim() : '';
    if (dateRaw.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Line dates must be YYYY-MM-DD or empty.' }, 400);
    }
    let amount: number | null = null;
    if (rec['amount'] !== undefined && rec['amount'] !== null && rec['amount'] !== '') {
      const parsed = Number(rec['amount']);
      if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_REQUESTED_AMOUNT) {
        return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Line amounts must be numbers between -10,000,000 and 10,000,000.' }, 400);
      }
      amount = Math.round(parsed * 100) / 100;
    }
    const no = rec['no'] === undefined || rec['no'] === null || rec['no'] === '' ? null : Number(rec['no']);
    if (no !== null && (!Number.isInteger(no) || no < 1 || no > 99)) {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Line item numbers must be whole numbers from 1 to 99.' }, 400);
    }
    lines.push({ no, date: dateRaw || null, description, amount });
  }

  // --- Item + status guard ---
  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare(
      'SELECT id, title, payee, category, status, rejected_stage, voucher_no, invoice_no, created_by FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_VOUCHER', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }
  const status = String(item.status);
  const isResubmission = status === 'rejected' && item.rejected_stage === 'finance';
  if (status !== 'purchase_approved' && !isResubmission) {
    return c.json(
      { success: false, error_code: 'CONFLICT', message: 'Vouchers can be submitted once the purchase stage is approved, or resubmitted after a finance rejection.' },
      409,
    );
  }

  // --- Invoice number: required on first submission; a resubmission may
  //     omit it and keeps the stored value (plan §6.4). ---
  if (!isResubmission && invoiceNoRaw.length === 0) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'An invoice or receipt number is required with the voucher.' },
      400,
    );
  }
  const invoiceNo = invoiceNoRaw.length > 0 ? invoiceNoRaw : item.invoice_no ? String(item.invoice_no) : '';

  // --- Duplicate-invoice check: warns, never blocks (settled decision 5 —
  //     suppliers legitimately reuse invoice numbers monthly). The flag rides
  //     the response so the payment step can warn without another call. ---
  let duplicateInvoice: { id: number; voucherNo: string | null } | null = null;
  if (invoiceNo) {
    try {
      const dup = await c.env.DB.prepare(
        'SELECT id, voucher_no FROM approval_items WHERE invoice_no = ? COLLATE NOCASE AND id != ? LIMIT 1',
      )
        .bind(invoiceNo, Number(id))
        .first<{ id: number; voucher_no: string | null }>();
      if (dup) {
        duplicateInvoice = { id: Number(dup.id), voucherNo: dup.voucher_no ? String(dup.voucher_no) : null };
      }
    } catch (err) {
      return handleApiError(c, endpoint, err, 'Could not check the invoice number.', { error_type: 'D1_SELECT_APPROVAL_INVOICE_DUP', http_status: 500 });
    }
  }

  // --- Save (with number assignment + UNIQUE retry) ---
  //   The UPDATE repeats the status rule in its WHERE clause (gap 1): if a
  //   concurrent submit already moved the item out of a ready state, the
  //   write matches nothing and the caller gets a 409 instead of the loser's
  //   lines silently replacing the winner's.
  const linesJson = JSON.stringify(lines);
  const actorName = getSessionName(c) || session.email;
  let assignedNo = item.voucher_no ? String(item.voucher_no) : '';

  try {
    let saved = false;
    for (let attempt = 0; attempt < VOUCHER_NO_RETRY_ATTEMPTS && !saved; attempt++) {
      if (!assignedNo) {
        const next = await nextVoucherNo(c.env.DB, voucherDate);
        if (!next) {
          return c.json(
            { success: false, error_code: 'VALIDATION_ERROR', message: 'This month has reached its voucher limit (99). Use next month\u2019s date or contact an IT admin.' },
            400,
          );
        }
        assignedNo = next;
      }
      try {
        const changed = await applyTransition(
          c,
          c.env.DB.prepare(
            `UPDATE approval_items
                SET voucher_no = ?, voucher_date = ?, voucher_lines = ?, invoice_no = ?,
                    voucher_submitted_by = ?, voucher_submitted_at = datetime('now'),
                    status = 'finance_check', rejected_stage = NULL,
                    finance_decision_by = NULL, finance_decision_at = NULL, finance_rejection_reason = NULL,
                    updated_at = datetime('now')
              WHERE id = ? AND (status = 'purchase_approved' OR (status = 'rejected' AND rejected_stage = 'finance'))`,
          ).bind(assignedNo, voucherDate, linesJson, invoiceNo || null, actorName, Number(id)),
          c.env.DB.prepare(
            'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
          ).bind(Number(id), 'voucher_submitted', session.email, actorName, `voucher_no=${assignedNo}; resubmitted=${isResubmission ? 1 : 0}`),
        );
        if (!changed) {
          return c.json(
            { success: false, error_code: 'CONFLICT', message: 'Item is no longer ready for a voucher. It may have been submitted or actioned already.' },
            409,
          );
        }
        saved = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Two admins racing for the same number: the UNIQUE index refuses
        // the loser, who takes the next free number and retries (plan §7).
        if (msg.includes('UNIQUE constraint failed') && msg.includes('voucher_no') && !item.voucher_no) {
          assignedNo = '';
          continue;
        }
        throw err;
      }
    }
    if (!saved) {
      throw new Error('voucher number assignment failed after retries');
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not save the voucher.', { error_type: 'D1_UPDATE_APPROVAL_VOUCHER', http_status: 500 });
  }

  // --- Duplicate-invoice audit row (best-effort, same philosophy as the
  //     other audit writes: the state change is the source of truth). ---
  if (duplicateInvoice) {
    try {
      await c.env.DB.prepare('INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)').bind(
        Number(id),
        'possible_duplicate_invoice',
        session.email,
        actorName,
        `invoice_no=${invoiceNo}; matches item ${duplicateInvoice.id} (${duplicateInvoice.voucherNo || 'no voucher'})`,
      ).run();
    } catch (err) {
      await logError(c.env, {
        endpoint: 'approvals-voucher-audit',
        error_type: 'D1_AUDIT',
        error_message: `duplicate-invoice audit insert failed: ${err instanceof Error ? err.message : String(err)}`,
        http_status: 500,
        user_email: session.email,
      });
    }
  }

  // --- Email the finance approvers (plan §10) ---
  try {
    const fresh = await c.env.DB.prepare(
      'SELECT id, title, payee, voucher_no, voucher_date, voucher_lines, created_by FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
    if (fresh) {
      const voucherItem = await loadVoucherEmailItem(c, Number(id), fresh);
      c.executionCtx.waitUntil(sendVoucherEmail(c.env, voucherItem, isResubmission ? 'resubmitted' : 'new').catch(() => { /* logged inside */ }));
    }
  } catch {
    // Email payload read failed — the voucher itself is saved; do not fail.
  }

  return c.json({ success: true, voucher_no: assignedNo, status: 'finance_check', resubmitted: isResubmission, duplicateInvoice });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/finance-approve  (Phase 4)
   Finance approvers ONLY — isFinanceApprover excludes IT
   admins by design (plan §3): an IT account can never
   approve a payment voucher.
   Atomic UPDATE … WHERE status='finance_check'.
   ---------------------------------------------------- */
export async function handleFinanceApprove(c: AppContext) {
  const endpoint = 'approvals-finance-approve';
  const email = getSessionEmail(c);
  if (!isFinanceApprover(email)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only finance approvers can approve vouchers.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare(
      'SELECT id, title, payee, voucher_no, voucher_date, voucher_lines, created_by FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_FAPP', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }
  if (String(item.created_by || '').toLowerCase() === email.toLowerCase()) {
    return c.json(
      { success: false, error_code: 'FORBIDDEN', message: 'You raised this request, so you cannot approve or reject it. Another approver must decide.' },
      403,
    );
  }

  try {
    // Name for the voucher's "Payment approved by" line; audit keeps email.
    const deciderName = getSessionName(c) || email;
    const deciderOffice = approvalOfficeFor(email);
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'finance_approved', finance_decision_by = ?, finance_decision_office = ?, finance_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'finance_check'`,
      ).bind(deciderName, deciderOffice, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(Number(id), 'finance_approved', email, deciderName, deciderOffice ? `office=${deciderOffice}` : null),
    );
    if (!changed) {
      return c.json(
        { success: false, error_code: 'CONFLICT', message: 'Item is not awaiting a finance decision. It may have been actioned already.' },
        409,
      );
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not approve the voucher.', { error_type: 'D1_UPDATE_APPROVAL_FAPP', http_status: 500 });
  }

  c.executionCtx.waitUntil(
    sendFinanceDecisionEmail(c.env, await loadVoucherEmailItem(c, Number(id), item), {
      approved: true,
      decidedBy: getSessionName(c) || email,
      decidedByOffice: approvalOfficeFor(email) ?? undefined,
    }).catch(() => { /* logged inside */ }),
  );

  return c.json({ success: true, status: 'finance_approved' });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/finance-reject  (Phase 4)
   Finance approvers only. Body: { reason } — required.
   Sets rejected_stage='finance' so resubmission (item edit
   or voucher resubmit) returns straight to finance_check,
   never back to the purchase approvers (plan §4).
   ---------------------------------------------------- */
export async function handleFinanceReject(c: AppContext) {
  const endpoint = 'approvals-finance-reject';
  const email = getSessionEmail(c);
  if (!isFinanceApprover(email)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only finance approvers can reject vouchers.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }
  const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
  if (reason.length < 1 || reason.length > MAX_REJECTION_REASON_LENGTH) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: `A rejection reason is required (1–${MAX_REJECTION_REASON_LENGTH} characters).` },
      400,
    );
  }

  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare(
      'SELECT id, title, payee, voucher_no, voucher_date, voucher_lines, created_by FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_FREJ', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }
  if (String(item.created_by || '').toLowerCase() === email.toLowerCase()) {
    return c.json(
      { success: false, error_code: 'FORBIDDEN', message: 'You raised this request, so you cannot approve or reject it. Another approver must decide.' },
      403,
    );
  }

  try {
    const deciderName = getSessionName(c) || email;
    const deciderOffice = approvalOfficeFor(email);
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'rejected', rejected_stage = 'finance', finance_rejection_reason = ?,
                finance_decision_by = ?, finance_decision_office = ?, finance_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'finance_check'`,
      ).bind(reason, deciderName, deciderOffice, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(Number(id), 'finance_rejected', email, deciderName, reason + (deciderOffice ? `; office=${deciderOffice}` : '')),
    );
    if (!changed) {
      return c.json(
        { success: false, error_code: 'CONFLICT', message: 'Item is not awaiting a finance decision. It may have been actioned already.' },
        409,
      );
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not reject the voucher.', { error_type: 'D1_UPDATE_APPROVAL_FREJ', http_status: 500 });
  }

  c.executionCtx.waitUntil(
    sendFinanceDecisionEmail(c.env, await loadVoucherEmailItem(c, Number(id), item), {
      approved: false,
      reason,
      decidedBy: getSessionName(c) || email,
      decidedByOffice: approvalOfficeFor(email) ?? undefined,
    }).catch(() => { /* logged inside */ }),
  );

  return c.json({ success: true, status: 'rejected', rejected_stage: 'finance' });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/paid  (Phase 5)
   Admin only. Records the payment: who paid, when, how,
   and an optional reference. Allowed only from
   finance_approved — the final state change to 'paid'.
   ---------------------------------------------------- */
// R4 (owner discussion 2026-08-29): GIRO replaces Cheque. Approvals only —
// the members fee-payment page keeps its own options. Nothing has shipped,
// so no old rows need converting.
const PAYMENT_METHODS = ['paynow', 'bank_transfer', 'giro', 'cash', 'other'] as const;
const MAX_PAID_BY_LENGTH = 200;
const MAX_PAYMENT_REFERENCE_LENGTH = 200;

export async function handleApprovalPaid(c: AppContext) {
  const endpoint = 'approvals-paid';
  const session = { email: getSessionEmail(c), role: getSessionRole(c) };
  if (!canRaiseApprovalItem(session)) {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Only the office admin can record payments.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid item id.' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  const paidBy = typeof body['paidBy'] === 'string' ? body['paidBy'].trim() : '';
  if (paidBy.length < 1 || paidBy.length > MAX_PAID_BY_LENGTH) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `Record who made the payment (1–${MAX_PAID_BY_LENGTH} characters).` }, 400);
  }
  const paidDate = typeof body['paidDate'] === 'string' ? body['paidDate'].trim() : '';
  if (!isRealDate(paidDate)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Payment date must be a valid date (YYYY-MM-DD).' }, 400);
  }
  const paymentMethod = typeof body['paymentMethod'] === 'string' ? body['paymentMethod'].trim() : '';
  if (!(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Choose a payment method.' }, 400);
  }
  const paymentReference = typeof body['paymentReference'] === 'string' ? body['paymentReference'].trim() : '';
  if (paymentReference.length > MAX_PAYMENT_REFERENCE_LENGTH) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `Payment reference must be ${MAX_PAYMENT_REFERENCE_LENGTH} characters or fewer.` }, 400);
  }

  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB.prepare('SELECT id, voucher_no, status FROM approval_items WHERE id = ?')
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_PAID', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }

  try {
    const actorName = getSessionName(c) || session.email;
    const auditNote = `paid_by=${paidBy}; method=${paymentMethod}` + (paymentReference ? `; ref=${paymentReference}` : '');
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'paid', paid_by = ?, paid_at = ?, payment_method = ?, payment_reference = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'finance_approved'`,
      ).bind(paidBy, paidDate, paymentMethod, paymentReference || null, Number(id)),
      c.env.DB.prepare('INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)').bind(
        Number(id),
        'paid_recorded',
        session.email,
        actorName,
        auditNote,
      ),
    );
    if (!changed) {
      return c.json(
        { success: false, error_code: 'CONFLICT', message: 'Only finance-approved items can be marked as paid.' },
        409,
      );
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not record the payment.', { error_type: 'D1_UPDATE_APPROVAL_PAID', http_status: 500 });
  }

  return c.json({ success: true, status: 'paid' });
}

/* ----------------------------------------------------
   GET /api/approvals/export?status=<status>   (R3)
   CSV of the board list itself — one row per item with
   the voucher number, title, payee, category, amount,
   status, dates and decision makers. Exports the
   currently open status tab (`status` optional = all).
   Admin tier only (IT admins hold the admin role through
   resolveSessionRole); the R2 auditor cannot export.
   Separate from the IT-admin-only audit CSV. Newest
   first, capped at 5000 rows; reuses the shared
   formula-injection-guarded csvEscape.
   ---------------------------------------------------- */
export async function handleApprovalListExport(c: AppContext) {
  const endpoint = 'approvals-list-export';
  if (getSessionRole(c) !== 'admin') {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin access required.' }, 403);
  }

  const statusFilter = (c.req.query('status') || '').trim();
  if (statusFilter && statusFilter !== 'all' && !(APPROVAL_STATUSES as readonly string[]).includes(statusFilter)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid status filter.' }, 400);
  }

  let rows: Array<Record<string, unknown>>;
  try {
    const baseSelect =
      'SELECT id, voucher_no, title, payee, category, requested_amount, status, ' +
      'created_at, voucher_date, purchase_decision_by, purchase_decision_at, ' +
      'finance_decision_by, finance_decision_at, paid_by, paid_at ' +
      'FROM approval_items';
    const res = statusFilter && statusFilter !== 'all'
      ? await c.env.DB.prepare(`${baseSelect} WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT 5000`).bind(statusFilter).all()
      : await c.env.DB.prepare(`${baseSelect} ORDER BY created_at DESC, id DESC LIMIT 5000`).all();
    rows = (res.results || []) as Array<Record<string, unknown>>;
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the approvals list.', {
      error_type: 'D1_SELECT_APPROVAL_EXPORT',
      http_status: 500,
    });
  }

  const labelFor = (key: unknown): string => {
    const cat = APPROVAL_CATEGORIES.find((c2) => c2.key === String(key || ''));
    return cat?.label || String(key || '');
  };

  const lines: string[] = [
    ['Item ID', 'Voucher No', 'Title', 'Payee', 'Category', 'Requested Amount (S$)', 'Status', 'Created At (UTC)', 'Voucher Date', 'Purchase Decision By', 'Purchase Decision At (UTC)', 'Finance Decision By', 'Finance Decision At (UTC)', 'Paid By', 'Paid At (UTC)']
      .map(csvEscape)
      .join(','),
  ];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.voucher_no,
        row.title,
        row.payee,
        labelFor(row.category),
        row.requested_amount === null || row.requested_amount === undefined ? null : Number(row.requested_amount).toFixed(2),
        row.status,
        row.created_at,
        row.voucher_date,
        row.purchase_decision_by,
        row.purchase_decision_at,
        row.finance_decision_by,
        row.finance_decision_at,
        row.paid_by,
        row.paid_at,
      ]
        .map(csvEscape)
        .join(','),
    );
  }

  const csv = '\uFEFF' + lines.join('\n');
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="approval-list-${statusFilter || 'all'}-${stamp}.csv"`,
    },
  });
}

/* ----------------------------------------------------
   GET /api/approvals/audit/export?from=YYYY-MM-DD&to=YYYY-MM-DD
   IT admin only (owner decision 24-08-2026). Enforced by the
   middleware IT_ADMIN_ONLY_API set; the role check below stays
   as belt-and-braces. The date range is required (owner
   decision 25-08-2026) so exports stay small. created_at is
   UTC 'YYYY-MM-DD HH:MM:SS', so a padded text-range compare
   is exact and includes both end days. CSV oldest first,
   capped at 5000 rows (plan §12). Reuses the shared
   formula-injection-guarded csvEscape.
   ---------------------------------------------------- */
export async function handleApprovalAuditExport(c: AppContext) {
  const endpoint = 'approvals-audit-export';
  if (getSessionRole(c) !== 'admin') {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin access required.' }, 403);
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = (s: string): boolean => dateRe.test(s) && !Number.isNaN(Date.parse(s));
  const from = (c.req.query('from') || '').trim();
  const to = (c.req.query('to') || '').trim();
  if (!validDate(from) || !validDate(to)) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'A from and to date (YYYY-MM-DD) are required.' },
      400,
    );
  }
  if (from > to) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'The from date must be on or before the to date.' },
      400,
    );
  }

  let rows: Array<Record<string, unknown>>;
  try {
    const res = await c.env.DB.prepare(
      `SELECT a.created_at, a.item_id, i.voucher_no, a.action, a.actor_name, a.actor_email, a.note
         FROM approval_audit_log a
         LEFT JOIN approval_items i ON i.id = a.item_id
        WHERE a.created_at >= ? AND a.created_at <= ?
        ORDER BY a.id ASC
        LIMIT 5000`,
    )
      .bind(`${from} 00:00:00`, `${to} 23:59:59`)
      .all();
    rows = (res.results || []) as Array<Record<string, unknown>>;
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the audit log.', {
      error_type: 'D1_SELECT_APPROVAL_AUDIT',
      http_status: 500,
    });
  }

  const lines: string[] = [
    ['Timestamp', 'Item ID', 'Voucher No', 'Action', 'Actor Name', 'Actor Email', 'Note'].map(csvEscape).join(','),
  ];
  for (const row of rows) {
    lines.push(
      [row.created_at, row.item_id, row.voucher_no, row.action, row.actor_name, row.actor_email, row.note]
        .map(csvEscape)
        .join(','),
    );
  }

  const csv = '\uFEFF' + lines.join('\n');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="approval-audit-${from}_to_${to}.csv"`,
    },
  });
}
