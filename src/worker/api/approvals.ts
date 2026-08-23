import type { AppContext } from '../types';
import { handleApiError } from '../lib/error-handler';
import { logError } from '../lib/log-error';
import {
  sendApprovalRequestEmail,
  sendPurchaseDecisionEmail,
  type ApprovalEmailItem,
} from '../lib/email-approval';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_MAX_FILES_PER_ITEM,
  APPROVAL_MAX_FILE_BYTES,
  canRaiseApprovalItem,
  isPurchaseApprover,
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

  try {
    const baseSelect =
      'SELECT id, category, title, payee, requested_amount, approval_required, status, ' +
      'rejected_stage, rejection_reason, finance_rejection_reason, ' +
      'voucher_no, voucher_date, created_by, created_at, updated_at ' +
      'FROM approval_items';
    const listPromise = statusFilter
      ? c.env.DB.prepare(`${baseSelect} WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT 500`)
          .bind(statusFilter)
          .all()
      : c.env.DB.prepare(`${baseSelect} ORDER BY created_at DESC, id DESC LIMIT 500`).all();

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

    return c.json({ success: true, items: listResult.results || [], counts });
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
      return c.json(
        { success: false, error_code: 'UPLOAD_FAILED', message: 'Could not save the attached files. Please try again.' },
        500,
      );
    }
  }

  // --- 3. Attachment rows + the item_created audit row in one batch ---
  const actorName = getSessionName(c) || session.email;
  const auditNote = `category=${category.key}; files=${fileList.length}` + (requestedAmount !== null ? `; S$${requestedAmount.toFixed(2)}` : '');

  try {
    const statements = uploadedKeys.map(({ file, r2Key }) =>
      c.env.DB.prepare(
        'INSERT INTO approval_attachments (item_id, r2_key, filename, mime_type, size) VALUES (?, ?, ?, ?, ?)',
      ).bind(itemId, r2Key, file.name, file.type, file.size),
    );
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(itemId, 'item_created', session.email, actorName, auditNote),
    );
    const batchResults = await c.env.DB.batch(statements);

    // --- 4. Store the comparison rows with the real attachment ids ---
    if (comparisonRows.length > 0) {
      const attachmentIds = uploadedKeys.map(({ file }, i) => ({
        name: file.name,
        id: Number(batchResults[i].meta?.last_row_id),
      }));
      const stored = comparisonRows.map((row) => ({
        attachmentId: attachmentIds.find((a) => a.name === row.file)?.id ?? null,
        description: row.description,
      }));
      if (stored.some((s) => !s.attachmentId || Number.isNaN(s.attachmentId))) {
        throw new Error('comparison mapping failed');
      }
      await c.env.DB.prepare("UPDATE approval_items SET comparison = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(stored), itemId)
        .run();
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'The item was created but its attachments could not be recorded. Please contact an IT admin.', {
      error_type: 'D1_INSERT_APPROVAL_ATTACHMENTS',
      http_status: 500,
    });
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
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'purchase_approved', purchase_decision_by = ?, purchase_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
      ).bind(email, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, NULL)',
      ).bind(Number(id), 'purchase_approved', email, getSessionName(c) || email),
    ]);

    const changes = Number((res[0].meta as { changes?: number } | undefined)?.changes ?? 0);
    if (changes === 0) {
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
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE approval_items
            SET status = 'rejected', rejected_stage = 'purchase', rejection_reason = ?,
                purchase_decision_by = ?, purchase_decision_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
      ).bind(reason, email, Number(id)),
      c.env.DB.prepare(
        'INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(Number(id), 'purchase_rejected', email, getSessionName(c) || email, reason),
    ]);

    const changes = Number((res[0].meta as { changes?: number } | undefined)?.changes ?? 0);
    if (changes === 0) {
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
  if (status !== 'pending' && status !== 'rejected') {
    return c.json(
      { success: false, error_code: 'CONFLICT', message: 'Only pending or rejected items can be edited.' },
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
    // Routing per plan §4: purchase-stage rejection → pending;
    // finance-stage rejection → finance_check (Phase 4 will allow editing
    // vouchers there; the routing itself is decided here).
    newStatus = item.rejected_stage === 'finance' ? 'finance_check' : 'pending';
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

  // --- 4. Item update + audit rows in one batch ---
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
      // Rejections reset so the next decision overwrites cleanly.
      if (item.rejected_stage === 'finance') {
        setClauses.push('finance_rejection_reason = NULL', 'finance_decision_by = NULL', 'finance_decision_at = NULL');
      } else {
        setClauses.push('rejection_reason = NULL', 'purchase_decision_by = NULL', 'purchase_decision_at = NULL');
      }
    }

    const statements: D1PreparedStatement[] = [];
    if (setClauses.length > 0) {
      if (!resubmit) setClauses.push("updated_at = datetime('now')");
      statements.push(
        c.env.DB.prepare(`UPDATE approval_items SET ${setClauses.join(', ')} WHERE id = ?`).bind(...bindParams, Number(id)),
      );
      auditActions.push({ action: 'item_edited', note: null });
    }
    if (resubmit) {
      auditActions.push({ action: 'item_resubmitted', note: `to=${newStatus}` });
    }
    for (const a of auditActions) {
      statements.push(
        c.env.DB.prepare('INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)').bind(
          Number(id),
          a.action,
          session.email,
          actorName,
          a.note,
        ),
      );
    }
    if (statements.length > 0) {
      await c.env.DB.batch(statements);
    }
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not save the edit.', { error_type: 'D1_UPDATE_APPROVAL_EDIT', http_status: 500 });
  }

  // --- 4. Resubmission re-emails the purchase approvers (plan §10) ---
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

  return c.json({ success: true, status: resubmit ? newStatus : status, resubmitted: resubmit });
}

/* ----------------------------------------------------
   POST /api/approvals/:id/remind
   Admin only. Re-sends the request email for the current
   stage. Phase 3: purchase stage (pending) only; later
   stages extend this (plan §10). Rate-limited by the
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
  if (item.status !== 'pending') {
    return c.json({ success: false, error_code: 'CONFLICT', message: 'Reminders can only be sent while the item is waiting for a purchase decision.' }, 409);
  }

  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, ?, ?, ?, ?)').bind(
        Number(id),
        'reminder_sent',
        session.email,
        getSessionName(c) || session.email,
        'stage=purchase',
      ),
    ]);
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not record the reminder.', { error_type: 'D1_INSERT_APPROVAL_REMIND', http_status: 500 });
  }

  c.executionCtx.waitUntil(
    sendApprovalRequestEmail(c.env, await loadEmailItem(c, Number(id), item), 'reminder').catch(() => { /* logged inside */ }),
  );

  return c.json({ success: true });
}
