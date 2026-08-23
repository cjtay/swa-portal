import type { AppContext } from '../types';
import { handleApiError } from '../lib/error-handler';
import { logError } from '../lib/log-error';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_MAX_FILES_PER_ITEM,
  APPROVAL_MAX_FILE_BYTES,
  canRaiseApprovalItem,
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
