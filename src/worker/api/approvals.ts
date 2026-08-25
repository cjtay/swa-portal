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
  canRaiseApprovalItem,
  isPurchaseApprover,
  isFinanceApprover,
} from '../../constants/portal';

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
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_REQUESTED_AMOUNT) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: 'Requested amount must be a number between 0 and 10,000,000.' },
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

  // --- Validate comparison rows against the uploaded filenames ---
  interface ComparisonInput {
    file: string;
    description: string;
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
        comparisonRows.push({ file, description });
      }
    } catch {
      return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Comparison table is malformed.' }, 400);
    }
  }

  // --- 1. Insert the item (comparison stored after attachment ids exist) ---
  const status = approvalRequired ? 'pending' : 'purchase_approved';
  let itemId: number;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO approval_items (category, title, payee, description, requested_amount, approval_required, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(category.key, title, payeeRaw || null, descriptionRaw || null, requestedAmount, approvalRequired ? 1 : 0, status, session.email)
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
  const actorName = getSessionName(c) || session.email;
  const auditNote = `category=${category.key}; files=${fileList.length}` + (requestedAmount !== null ? `; S$${requestedAmount.toFixed(2)}` : '');
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

  // --- 5. Email the purchase approvers when the item needs a decision.
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
        'purchase_decision_by, purchase_decision_at, rejection_reason, ' +
        'voucher_no, voucher_date, voucher_lines, voucher_submitted_by, voucher_submitted_at, ' +
        'finance_decision_by, finance_decision_at, finance_rejection_reason, ' +
        'paid_by, paid_at, payment_method, payment_reference, created_by, comparison, created_at, updated_at ' +
        'FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();

    if (!item) {
      return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
    }

    const attachmentsResult = await c.env.DB.prepare(
      'SELECT id, filename, mime_type, size, created_at FROM approval_attachments WHERE item_id = ? ORDER BY id',
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

    return c.json({
      success: true,
      item: { ...item, comparison },
      attachments: attachmentsResult.results || [],
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
      'SELECT id, title, category, payee, description, requested_amount, created_by, approval_required FROM approval_items WHERE id = ?',
    )
      .bind(Number(id))
      .first<Record<string, unknown>>();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the item.', { error_type: 'D1_SELECT_APPROVAL_APPROVE', http_status: 500 });
  }
  if (!item) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Approval item not found.' }, 404);
  }

  try {
    // The item column stores the printed name (the voucher shows "Approved
    // by <name>"); the audit row keeps the email for traceability.
    const deciderName = getSessionName(c) || email;
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'purchase_approved', purchase_decision_by = ?, purchase_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
      ).bind(deciderName, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, NULL)',
      ).bind(Number(id), 'purchase_approved', email, deciderName),
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

  try {
    const deciderName = getSessionName(c) || email;
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'rejected', rejected_stage = 'purchase', rejection_reason = ?,
                purchase_decision_by = ?, purchase_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
      ).bind(reason, deciderName, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(Number(id), 'purchase_rejected', email, deciderName, reason),
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
      'SELECT id, status, rejected_stage, approval_required, category, created_by FROM approval_items WHERE id = ?',
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
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_REQUESTED_AMOUNT) {
        return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Requested amount must be a number between 0 and 10,000,000.' }, 400);
      }
      updates.push('requested_amount = ?');
      params.push(Math.round(parsed * 100) / 100);
    } else {
      updates.push('requested_amount = ?');
      params.push(null);
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
        const rows: Array<{ attachmentId: number; description: string }> = [];
        for (const row of parsed) {
          const attachmentId = Number((row as Record<string, unknown>)?.attachmentId);
          const description = String((row as Record<string, unknown>)?.description ?? '').trim();
          if (!Number.isInteger(attachmentId) || attachmentId <= 0) throw new Error('bad attachmentId');
          if (description.length < 1 || description.length > MAX_COMPARISON_DESCRIPTION_LENGTH) throw new Error('bad description');
          rows.push({ attachmentId, description });
        }
        // Every referenced id must belong to this item — verified AFTER the
        // new attachment rows exist (ids from this same request are valid too).
        comparisonJson = JSON.stringify(rows);
      } catch {
        return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Comparison table is malformed.' }, 400);
      }
    }
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
      auditActions.push({ action: 'item_edited', note: null });
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
      'SELECT id, title, payee, category, status, rejected_stage, voucher_no, created_by FROM approval_items WHERE id = ?',
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
                SET voucher_no = ?, voucher_date = ?, voucher_lines = ?,
                    voucher_submitted_by = ?, voucher_submitted_at = datetime('now'),
                    status = 'finance_check', rejected_stage = NULL,
                    finance_decision_by = NULL, finance_decision_at = NULL, finance_rejection_reason = NULL,
                    updated_at = datetime('now')
              WHERE id = ? AND (status = 'purchase_approved' OR (status = 'rejected' AND rejected_stage = 'finance'))`,
          ).bind(assignedNo, voucherDate, linesJson, actorName, Number(id)),
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

  return c.json({ success: true, voucher_no: assignedNo, status: 'finance_check', resubmitted: isResubmission });
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

  try {
    // Name for the voucher's "Payment approved by" line; audit keeps email.
    const deciderName = getSessionName(c) || email;
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'finance_approved', finance_decision_by = ?, finance_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'finance_check'`,
      ).bind(deciderName, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, NULL)',
      ).bind(Number(id), 'finance_approved', email, deciderName),
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

  try {
    const deciderName = getSessionName(c) || email;
    const changed = await applyTransition(
      c,
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'rejected', rejected_stage = 'finance', finance_rejection_reason = ?,
                finance_decision_by = ?, finance_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'finance_check'`,
      ).bind(reason, deciderName, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(Number(id), 'finance_rejected', email, deciderName, reason),
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
const PAYMENT_METHODS = ['paynow', 'bank_transfer', 'cheque', 'cash', 'other'] as const;
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
