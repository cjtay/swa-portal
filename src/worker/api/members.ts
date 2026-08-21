import type { Context } from 'hono';
import type { Env, AppContext } from '../types';
import { IT_ADMIN_EMAILS } from '../../constants/portal';


export async function handleMembers(c: AppContext) {
  if (c.req.method === 'GET') {
    const category = c.req.query('category');
    const search = c.req.query('search');

    // Soft-deleted members are hidden everywhere this endpoint feeds:
    // the directory, the namecards page, and the roles page.
    let query = 'SELECT * FROM members WHERE deleted_at IS NULL';
    const params: unknown[] = [];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    if (search) {
      query += ' AND (name LIKE ? OR email LIKE ? OR role LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    query += ' ORDER BY sort_order ASC, name ASC';

    const results = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, members: results.results });
  }

  if (c.req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const category = String(body.category || 'committee').trim();
    // Fee waiver auto-derivation: advisors/admins/volunteers don't pay.
    // Body value still wins so the admin can override per-row if needed.
    const bodyWaived = body.fee_waived === undefined ? null : Number(body.fee_waived);
    const derivedWaived =
      bodyWaived !== null
        ? bodyWaived
        : category === 'advisor' || category === 'admin' || category === 'volunteer'
          ? 1
          : 0;

    const result = await c.env.DB.prepare(
`INSERT INTO members (name, role, email, mobile, job_title, category, can_login,
                      address_line1, address_line2, address_postal_code, address_country,
                      sort_order, membership_status, fee_due_date, fee_waived)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      String(body.name || '').trim() || null,
      String(body.role || '').trim() || null,
      String(body.email || '').trim().toLowerCase() || null,
      String(body.mobile || '').trim() || null,
      String(body.job_title || '').trim() || null,
      category,
      Number(body.can_login ?? 0),
      String(body.address_line1 || '').trim() || null,
      String(body.address_line2 || '').trim() || null,
      String(body.address_postal_code || '').trim() || null,
      String(body.address_country || 'Singapore').trim(),
      Number(body.sort_order || 0),
      String(body.membership_status || 'active').trim(),
      String(body.fee_due_date || '').trim() || null,
      derivedWaived,
    ).run();

    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

export async function handleMemberById(c: AppContext) {
  const id = c.req.param('id');

  if (c.req.method === 'GET') {
    const member = await c.env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
    if (!member) {
      return c.json({ success: false, message: 'Member not found.' }, 404);
    }
    return c.json({ success: true, member });
  }

  if (c.req.method === 'PATCH') {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const allowedFields = ['name', 'role', 'email', 'mobile', 'job_title', 'category', 'can_login', 'address_line1', 'address_line2', 'address_postal_code', 'address_country', 'sort_order', 'reg_role', 'membership_status', 'fee_due_date', 'fee_waived'];
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const field of allowedFields) {
      if (field in body) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    if (updates.length === 0) {
      return c.json({ success: false, message: 'No fields to update.' }, 400);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await c.env.DB.prepare(`UPDATE members SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    return c.json({ success: true, id: Number(id) });
  }

  if (c.req.method === 'DELETE') {
    // Soft delete: mark the row instead of removing it so memberships,
    // membership_applications, and office_bookings foreign keys stay intact.
    const member = await c.env.DB.prepare('SELECT email FROM members WHERE id = ?').bind(id).first<{ email: string | null }>();
    if (!member) {
      return c.json({ success: false, message: 'Member not found.' }, 404);
    }

    const email = member.email ?? '';
    const sessionEmail = c.get('sessionEmail') as string | undefined;

    // Guardrail: cannot delete your own account.
    if (sessionEmail && email.toLowerCase() === sessionEmail.toLowerCase()) {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'You cannot delete your own account.' }, 403);
    }
    // Guardrail: IT-admin accounts are protected.
    if (email && (IT_ADMIN_EMAILS as readonly string[]).includes(email)) {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'IT Admin accounts cannot be deleted.' }, 403);
    }

    // Atomic transaction: soft-delete the member AND dark their namecard in a
    // single D1 batch so the public /c/:slug surface goes 404 the instant the
    // member is deleted (docs/NAMECARD.md §9.4). D1 executes a `batch()` as a
    // single transaction — either both UPDATEs land or neither does. The
    // namecards UPDATE is a no-op when the member has no card.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE members SET deleted_at = datetime('now'), can_login = 0, updated_at = datetime('now') WHERE id = ?`,
      ).bind(id),
      c.env.DB.prepare(
        `UPDATE namecards SET has_namecard = 0, updated_at = datetime('now') WHERE member_id = ?`,
      ).bind(id),
    ]);

    // Kill any in-flight OTP so it cannot be exchanged for a new session.
    if (email) {
      await c.env.SWA_SESSION.delete(`swa:otp:${email}`);
    }

    return c.json({ success: true, id: Number(id) });
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

// Pre-flight dependency counts shown in the delete confirm dialog.
// Admin-only — GET /api/members is open to any authenticated user, so this
// re-checks the role before exposing membership/booking numbers.
export async function handleMemberDependencies(c: AppContext) {
  if (c.get('sessionRole') !== 'admin') {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin access required.' }, 403);
  }

  const id = c.req.param('id');

  const [payments, bookings, applications] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as n FROM membership_payments WHERE member_id = ?').bind(id).first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM office_bookings WHERE member_id = ?').bind(id).first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM membership_applications WHERE member_id = ?').bind(id).first<{ n: number }>(),
  ]);

  return c.json({
    success: true,
    payments: payments?.n ?? 0,
    bookings: bookings?.n ?? 0,
    applications: applications?.n ?? 0,
  });
}

/**
 * Compute the next 31 January (ISO date) from the given date.
 * Per plan §3: all members' fee_due_date anchored to 31 January each year.
 */
function nextFeeDueDate(from: Date = new Date()): string {
  const year = from.getFullYear();
  const thisYearJan31 = new Date(year, 0, 31);
  if (from <= thisYearJan31) {
    return `${year}-01-31`;
  }
  return `${year + 1}-01-31`;
}

/* ----------------------------------------------------
   GET  /api/members/:id/payments  (admin/committee)
   POST /api/members/:id/payments  (admin only)
   ---------------------------------------------------- */
export async function handleMemberPayments(c: AppContext) {
  const id = c.req.param('id');
  const sessionRole = c.get('sessionRole') as string;

  if (c.req.method === 'GET') {
    try {
      const res = await c.env.DB.prepare(
        'SELECT * FROM membership_payments WHERE member_id = ? ORDER BY paid_date DESC, id DESC',
      ).bind(id).all();
      return c.json({ success: true, payments: res.results });
    } catch {
      return c.json({ success: false, message: 'Could not load payments.' }, 500);
    }
  }

  if (c.req.method === 'POST') {
    if (sessionRole !== 'admin') {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin access required to record payments.' }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const amount = Number(body.amount);
    const method = String(body.method || 'paynow').trim();
    const reference = String(body.reference || '').trim() || null;
    const paidDate = String(body.paid_date || '').trim() || new Date().toISOString().slice(0, 10);
    const recordedBy = (c.get('sessionEmail') as string) || 'unknown';

    if (!amount || amount <= 0 || isNaN(amount)) {
      return c.json({ success: false, message: 'A valid amount is required.' }, 400);
    }
    if (!['paynow', 'cash', 'cheque', 'other'].includes(method)) {
      return c.json({ success: false, message: 'Invalid payment method.' }, 400);
    }

    const feeDueDate = nextFeeDueDate();

    try {
      // Atomic batch: INSERT payment + UPDATE member fee_due_date/status.
      // Recording any payment reactivates an inactive member (plan §3).
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO membership_payments (member_id, paid_date, amount, method, reference, recorded_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(Number(id), paidDate, amount, method, reference, recordedBy),
        c.env.DB.prepare(
          `UPDATE members SET fee_due_date = ?, membership_status = 'active', updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(feeDueDate, Number(id)),
      ]);
    } catch {
      return c.json({ success: false, message: 'Could not record payment.' }, 500);
    }

    return c.json({ success: true, fee_due_date: feeDueDate });
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}