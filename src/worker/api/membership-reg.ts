import type { Context } from 'hono';
import type { Env } from '../types';
import { handleApiError } from '../lib/error-handler';
import { logError } from '../lib/log-error';
import { buildMembershipNotificationEmail } from '../lib/email-membership-notification';
import { buildMembershipReference } from '../lib/paynow-qr';
import {
  MEMBERSHIP_NOTIFY_EMAILS,
  SWA_UEN,
  SWA_PAYNOW_MERCHANT_NAME,
  MEMBERSHIP_RATE_LIMIT_WINDOW_SECONDS,
  MEMBERSHIP_RATE_LIMIT_MAX_REQUESTS,
  MEMBERSHIP_MAX_FILE_BYTES,
} from '../../constants/portal';

type AppContext = Context<{ Bindings: Env }>;

/** Session vars are set by auth middleware; read via the request context.
 *  Cast keeps AppContext compatible with shared helpers (handleApiError) that
 *  use the bare `Context<{ Bindings: Env }>` signature. */
function getSessionEmail(c: AppContext): string {
  try { return (c as unknown as { get: (k: string) => unknown }).get('sessionEmail') as string || 'unknown'; }
  catch { return 'unknown'; }
}
function getSessionRole(c: AppContext): string {
  try { return (c as unknown as { get: (k: string) => unknown }).get('sessionRole') as string || ''; }
  catch { return ''; }
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/* Membership type ids — fixed by schema.sql so handlers reference them
   deterministically without a round-trip lookup on every request. */
const MEMBERSHIP_TYPE_FIRST_YEAR = 1;
const MEMBERSHIP_TYPE_RENEWAL = 2;

interface MembershipTypeRow {
  id: number;
  name: string;
  fee_amount: number;
  duration_months: number;
}

async function loadMembershipTypes(env: Env): Promise<{ firstYear?: MembershipTypeRow; renewal?: MembershipTypeRow }> {
  try {
    const res = await env.DB.prepare('SELECT id, name, fee_amount, duration_months FROM membership_types WHERE id IN (1, 2) AND is_active = 1').all();
    const rows = (res.results || []) as unknown as MembershipTypeRow[];
    return {
      firstYear: rows.find((r) => r.id === MEMBERSHIP_TYPE_FIRST_YEAR),
      renewal: rows.find((r) => r.id === MEMBERSHIP_TYPE_RENEWAL),
    };
  } catch {
    return {};
  }
}

/* ----------------------------------------------------
   GET /api/membership/config  (public)
   Returns fee + PayNow merchant info for client QR.
   ---------------------------------------------------- */
export async function handleMembershipConfig(c: AppContext) {
  const types = await loadMembershipTypes(c.env);
  const fee = types.firstYear?.fee_amount ?? 30;
  const renewalFee = types.renewal?.fee_amount ?? 20;
  return c.json({
    success: true,
    config: {
      fee,
      renewalFee,
      uen: SWA_UEN,
      merchantName: SWA_PAYNOW_MERCHANT_NAME,
      currency: 'SGD',
    },
  });
}

/* ----------------------------------------------------
   POST /api/membership/register  (public)
   Multipart form-data: text fields + 2 file blobs (paynow + signature).
   ---------------------------------------------------- */
export async function handleMembershipRegister(c: AppContext) {
  const endpoint = 'membership-register';
  const env = c.env;
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const userAgent = c.req.header('user-agent') || '';

  // 1. IP rate limit
  const rl = await checkRateLimit(env.SWA_SESSION, ip);
  if (!rl.allowed) {
    return c.json(
      { success: false, error_code: 'RATE_LIMITED', message: 'Too many submissions. Please try again later.' },
      429,
    );
  }

  // 2. Parse multipart body
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  // 3. Turnstile
  const turnstileToken = typeof form['turnstileToken'] === 'string' ? form['turnstileToken'].trim() : '';
  if (!turnstileToken) {
    return c.json({ success: false, error_code: 'TURNSTILE_MISSING', message: 'Security verification required.' }, 400);
  }
  if (!env.TURNSTILE_SECRET) {
    return c.json({ success: false, error_code: 'CONFIG_ERROR', message: 'Server configuration error.' }, 500);
  }
  const turnstileValid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
  if (!turnstileValid) {
    return c.json(
      { success: false, error_code: 'TURNSTILE_FAILED', message: 'Security verification failed. Please try again.' },
      403,
    );
  }

  // 4. Validate text fields
  const v = validateSubmission(form);
  if (Object.keys(v.errors).length > 0) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'Please correct the highlighted fields.', errors: v.errors },
      400,
    );
  }
  const d = v.data;

  // 4b. Look up the first-year fee from D1 (admins can change it without a
  //     redeploy). Falls back to the schema default if the row is missing.
  const types = await loadMembershipTypes(env);
  const firstYearFee = types.firstYear?.fee_amount ?? 30;

  // 5. Read + validate files
  const paynowFile = form['paynowScreenshot'];
  const signatureFile = form['signature'];

  let paynowR2Key: string | null = null;
  let signatureR2Key: string | null = null;
  let signatureMethod: 'draw' | 'upload' = 'draw';

  // PayNow screenshot — optional but recommended
  if (paynowFile instanceof File && paynowFile.size > 0) {
    const ext = imageExtension(paynowFile.type);
    if (!ext || !ALLOWED_MIME.has(paynowFile.type)) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: 'PayNow screenshot must be a JPG, PNG, WebP, or HEIC image.', errors: { paynow: 'Unsupported image format.' } },
        400,
      );
    }
    if (paynowFile.size > MEMBERSHIP_MAX_FILE_BYTES) {
      return c.json(
        { success: false, error_code: 'VALIDATION_ERROR', message: 'PayNow screenshot must be 10 MB or smaller.', errors: { paynow: 'File too large.' } },
        400,
      );
    }
  }

  // Signature — required. Method inferred from a hidden field.
  const declaredMethod = typeof form['signatureMethod'] === 'string' ? form['signatureMethod'] : '';
  if (!(signatureFile instanceof File) || signatureFile.size === 0) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'Signature is required.', errors: { signature: 'Please draw or upload your signature.' } },
      400,
    );
  }
  const sigExt = imageExtension(signatureFile.type);
  if (!sigExt || !ALLOWED_MIME.has(signatureFile.type)) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'Signature must be a PNG or JPG image.', errors: { signature: 'Unsupported image format.' } },
      400,
    );
  }
  if (signatureFile.size > MEMBERSHIP_MAX_FILE_BYTES) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'Signature image must be 10 MB or smaller.', errors: { signature: 'File too large.' } },
      400,
    );
  }
  signatureMethod = declaredMethod === 'upload' ? 'upload' : 'draw';

  // 6. Authoritative payment reference (server-generated). Slug from name +
  //    4 random base36 chars; the QR the user scanned used a client-side ref
  //    of the same shape — they're kept separate (we store the server one as
  //    the canonical record, while the user-visible ref on the form is also
  //    server-echoed back in the success response).
  const refSuffix = generateRandomSuffix();
  const paymentReference = buildMembershipReference(d.fullName, refSuffix);

  // 7. R2 uploads
  try {
    if (paynowFile instanceof File && paynowFile.size > 0) {
      const ext = imageExtension(paynowFile.type)!;
      paynowR2Key = `membership/paynow/${paymentReference}.${ext}`;
      await env.R2_BUCKET.put(paynowR2Key, paynowFile.stream(), {
        httpMetadata: { contentType: paynowFile.type },
        customMetadata: {
          payment_reference: paymentReference,
          applicant_name: d.fullName,
          uploaded_at: new Date().toISOString(),
        },
      });
    }

    const sigExtFinal = imageExtension(signatureFile.type)!;
    signatureR2Key = `membership/signature/${paymentReference}.${sigExtFinal}`;
    await env.R2_BUCKET.put(signatureR2Key, signatureFile.stream(), {
      httpMetadata: { contentType: signatureFile.type },
      customMetadata: {
        payment_reference: paymentReference,
        applicant_name: d.fullName,
        signature_method: signatureMethod,
        uploaded_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    await logError(env, {
      endpoint,
      error_type: 'R2_PUT',
      error_message: `membership-register r2: ${err instanceof Error ? err.message : String(err)}`,
      http_status: 500,
    });
    return c.json(
      { success: false, error_code: 'UPLOAD_FAILED', message: 'Could not save your uploaded files. Please try again.' },
      500,
    );
  }

  // 8. Insert into D1
  try {
    await env.DB.prepare(
      'INSERT INTO membership_applications ' +
        '(application_type, full_name, nric, address_line1, address_line2, address_postal_code, ' +
        'phone_home, phone_office, email, handphone, date_of_birth, place_of_birth, citizenship, occupation, ' +
        'hobbies, skills_experiences, other_associations, membership_intent, recommended_by, ' +
        'paynow_r2_key, signature_r2_key, signature_method, payment_reference, payment_amount, ' +
        'submitted_ip, user_agent) ' +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        'new',
        d.fullName,
        d.nric,
        d.addressLine1,
        d.addressLine2 || null,
        d.addressPostalCode,
        d.phoneHome || null,
        d.phoneOffice || null,
        d.email,
        d.handphone || null,
        d.dateOfBirth || null,
        d.placeOfBirth || null,
        d.citizenship || null,
        d.occupation || null,
        d.hobbies || null,
        d.skillsExperiences || null,
        d.otherAssociations || null,
        d.membershipIntent,
        d.recommendedBy || null,
        paynowR2Key,
        signatureR2Key,
        signatureMethod,
        paymentReference,
        firstYearFee,
        ip,
        userAgent,
      )
      .run();

    // 9. Email notification (non-blocking)
    await sendNotification(env, {
      reference: paymentReference,
      fullName: d.fullName,
      nric: d.nric,
      email: d.email,
      handphone: d.handphone,
      phoneHome: d.phoneHome,
      phoneOffice: d.phoneOffice,
      addressLine1: d.addressLine1,
      addressLine2: d.addressLine2,
      addressPostalCode: d.addressPostalCode,
      dateOfBirth: d.dateOfBirth,
      placeOfBirth: d.placeOfBirth,
      citizenship: d.citizenship,
      occupation: d.occupation,
      hobbies: d.hobbies,
      skillsExperiences: d.skillsExperiences,
      otherAssociations: d.otherAssociations,
      membershipIntent: d.membershipIntent,
      recommendedBy: d.recommendedBy,
      paymentReference,
      paymentAmount: firstYearFee,
      signatureMethod,
      paynowUploaded: paynowR2Key !== null,
      submittedAt: new Date().toISOString(),
      submittedIp: ip,
      userAgent,
      adminUrl: `https://${env.SWA_ADMIN_DOMAIN || 'admin.singaporewomenassociation.org'}/admin/forms/membership`,
    }).catch(() => { /* swallow — already logged inside */ });

    return c.json({ success: true, reference: paymentReference });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (isRetryableD1Error(errMsg)) {
      await logError(env, {
        endpoint,
        error_type: 'D1_WRITE_FAILED',
        error_message: `membership-register: ${errMsg}`,
        http_status: 503,
      });
      return c.json(
        {
          success: false,
          error_code: 'D1_WRITE_FAILED',
          message:
            'We couldn\u2019t save your application this time. Please click Submit again \u2014 your details are kept.',
        },
        503,
      );
    }

    return handleApiError(c, endpoint, err, 'Could not save your application. Please try again.', {
      error_type: 'D1_INSERT_MEM',
      http_status: 500,
    });
  }
}

/* ----------------------------------------------------
   GET /api/admin/forms/membership  (admin + committee)
   ---------------------------------------------------- */
export async function handleMembershipSubmissions(c: AppContext) {
  const endpoint = 'admin-forms-membership';
  const search = (c.req.query('search') || '').trim();

  let query = 'SELECT * FROM membership_applications WHERE 1=1';
  const params: unknown[] = [];

  if (search) {
    query += ' AND (full_name LIKE ? OR email LIKE ? OR payment_reference LIKE ? OR nric LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  query += ' ORDER BY created_at DESC, id DESC LIMIT 500';

  try {
    const results = await c.env.DB.prepare(query).bind(...params).all();
    const rows = (results.results || []) as Record<string, unknown>[];
    return c.json({ success: true, submissions: rows });
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load submissions.', {
      error_type: 'D1_SELECT_MEM',
      http_status: 500,
    });
  }
}

/* ----------------------------------------------------
   GET /api/admin/forms/membership/export  (admin + committee)
   ---------------------------------------------------- */
export async function handleMembershipExport(c: AppContext) {
  const endpoint = 'admin-forms-membership-export';

  let results: Record<string, unknown>[];
  try {
    const res = await c.env.DB.prepare(
      'SELECT * FROM membership_applications ORDER BY created_at DESC, id DESC LIMIT 2000',
    ).all();
    results = (res.results || []) as Record<string, unknown>[];
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load submissions for export.', {
      error_type: 'D1_SELECT_MEM_EXPORT',
      http_status: 500,
    });
  }

  const headers = [
    'Reference',
    'Full Name',
    'NRIC/FIN',
    'Email',
    'Mobile No.',
    'Telephone (Home)',
    'Telephone (Office)',
    'Address Line 1',
    'Address Line 2',
    'Postal Code',
    'Date of Birth',
    'Place of Birth',
    'Citizenship',
    'Occupation',
    'Membership Intent',
    'Recommended By',
    'Hobbies / Interests',
    'Skills / Experiences',
    'Other Associations',
    'PayNow Reference',
    'Payment Amount',
    'Signature Method',
    'PayNow Screenshot Uploaded',
    'Status',
    'Member ID',
    'Reviewed By',
    'Reviewed At (SG)',
    'Submitted At (SG)',
    'Submitter IP',
    'User Agent',
  ];

  const intentLabels: Record<string, string> = {
    administration: 'Administration',
    services: 'Services',
    supportive: 'Supportive',
  };

  const lines: string[] = [headers.map(csvEscape).join(',')];

  for (const row of results) {
    const values = [
      String(row.payment_reference || ''),
      String(row.full_name || ''),
      String(row.nric || ''),
      String(row.email || ''),
      String(row.handphone || ''),
      String(row.phone_home || ''),
      String(row.phone_office || ''),
      String(row.address_line1 || ''),
      String(row.address_line2 || ''),
      String(row.address_postal_code || ''),
      String(row.date_of_birth || ''),
      String(row.place_of_birth || ''),
      String(row.citizenship || ''),
      String(row.occupation || ''),
      intentLabels[String(row.membership_intent || '')] || String(row.membership_intent || ''),
      String(row.recommended_by || ''),
      String(row.hobbies || ''),
      String(row.skills_experiences || ''),
      String(row.other_associations || ''),
      String(row.payment_reference || ''),
      String(row.payment_amount || ''),
      row.signature_method === 'draw' ? 'Drawn' : 'Uploaded',
      row.paynow_r2_key ? 'Yes' : 'No',
      String(row.status || 'pending'),
      row.member_id ? String(row.member_id) : '',
      String(row.reviewed_by || ''),
      formatSg(row.reviewed_at),
      formatSg(row.created_at),
      String(row.submitted_ip || ''),
      String(row.user_agent || ''),
    ];
    lines.push(values.map(csvEscape).join(','));
  }

  const csv = '\uFEFF' + lines.join('\n');
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="membership-applications-${stamp}.csv"`,
    },
  });
}

/* ----------------------------------------------------
   GET /api/admin/forms/membership/image/:id/:kind  (admin + committee)
   Streams a PayNow screenshot or signature image from R2.
   ---------------------------------------------------- */
export async function handleMembershipImage(c: AppContext) {
  const endpoint = 'admin-forms-membership-image';
  const id = c.req.param('id') || '';
  const kind = c.req.param('kind') || '';

  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid id.' }, 400);
  }
  if (kind !== 'paynow' && kind !== 'signature') {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid image kind.' }, 400);
  }

  let row: Record<string, unknown> | null = null;
  try {
    const res = await c.env.DB.prepare('SELECT paynow_r2_key, signature_r2_key FROM membership_applications WHERE id = ?')
      .bind(Number(id))
      .first();
    row = (res as Record<string, unknown> | null) ?? null;
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load image.', {
      error_type: 'D1_SELECT_MEM_IMG',
      http_status: 500,
    });
  }

  if (!row) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Application not found.' }, 404);
  }

  const key = kind === 'paynow' ? row.paynow_r2_key : row.signature_r2_key;
  if (typeof key !== 'string' || key.length === 0) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'No image on file.' }, 404);
  }

  const obj = await c.env.R2_BUCKET.get(key);
  if (!obj) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Image missing from storage.' }, 404);
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

/* ----------------------------------------------------
   POST /api/admin/forms/membership/:id/approve  (admin only)
   Approves a pending application:
     a) creates a members row (category='member', can_login=0)
     b) creates a one-year memberships row (paid, links back via application_id)
     c) marks the application approved, captures reviewer + member_id
     d) sends a welcome email to the applicant
   Idempotent: re-approving a row that already has member_id returns the
   existing member without duplicating it.
   ---------------------------------------------------- */
export async function handleMembershipApprove(c: AppContext) {
  const endpoint = 'admin-forms-membership-approve';
  // ONLINE_FORMS_API allows committee to view, but creating members is admin-only.
  if (getSessionRole(c) !== 'admin') {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin access required to approve applications.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid application id.' }, 400);
  }
  const reviewer = getSessionEmail(c);

  // 1. Load application
  let app: Record<string, unknown> | null = null;
  try {
    app = await c.env.DB.prepare('SELECT * FROM membership_applications WHERE id = ?')
      .bind(Number(id))
      .first();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load application.', {
      error_type: 'D1_SELECT_MEM_APP',
      http_status: 500,
    });
  }
  if (!app) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Application not found.' }, 404);
  }

  // Idempotent: already approved — return the existing member.
  if (app.member_id) {
    return c.json({ success: true, member_id: app.member_id, already_approved: true });
  }
  if (app.status === 'rejected') {
    return c.json({ success: false, error_code: 'CONFLICT', message: 'Application was already rejected.' }, 409);
  }

  // 2. Resolve first-year fee + duration from D1.
  const types = await loadMembershipTypes(c.env);
  const fee = types.firstYear?.fee_amount ?? 30;
  const durationMonths = types.firstYear?.duration_months ?? 12;

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const end = new Date(today);
  end.setMonth(end.getMonth() + durationMonths);
  const endIso = end.toISOString().slice(0, 10);

  const fullName = String(app.full_name || '');
  const email = String(app.email || '').toLowerCase();
  const nric = String(app.nric || '').toUpperCase();
  const paymentRef = String(app.payment_reference || '');

  let memberId: number | undefined;
  let membershipId: number | undefined;

  try {
    // a) Insert members row. category='member' is distinct from 'committee'/
    //    'admin' (the auth tiers), so the new row has no portal access by
    //    default. show_on_website=0 — admin can list publicly later if desired.
    const memberRes = await c.env.DB.prepare(
      `INSERT INTO members (name, nric, email, mobile, role, category, can_login, show_on_website,
                            address_line1, address_line2, address_postal_code)
       VALUES (?, ?, ?, ?, ?, 'member', 0, 0, ?, ?, ?)`,
    )
      .bind(
        fullName || null,
        nric || null,
        email || null,
        String(app.handphone || app.phone_home || app.phone_office || '') || null,
        'Member',
        String(app.address_line1 || '') || null,
        String(app.address_line2 || '') || null,
        String(app.address_postal_code || '') || null,
      )
      .run();
    memberId = Number(memberRes.meta?.last_row_id);

    // b) Insert memberships row for the first year (paid at intake).
    const memRes = await c.env.DB.prepare(
      `INSERT INTO memberships
        (member_id, membership_type_id, application_id, start_date, end_date,
         fee_amount, payment_status, payment_method, payment_reference, payment_date)
       VALUES (?, ?, ?, ?, ?, ?, 'paid', 'paynow', ?, ?)`,
    )
      .bind(
        memberId,
        MEMBERSHIP_TYPE_FIRST_YEAR,
        Number(id),
        todayIso,
        endIso,
        fee,
        paymentRef,
        todayIso,
      )
      .run();
    membershipId = Number(memRes.meta?.last_row_id);

    // c) Mark application approved.
    await c.env.DB.prepare(
      `UPDATE membership_applications
         SET status = 'approved', member_id = ?, reviewed_by = ?, reviewed_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(memberId, reviewer, Number(id))
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isRetryableD1Error(msg)) {
      return c.json(
        { success: false, error_code: 'D1_WRITE_FAILED', message: 'Transient database error. Please retry.' },
        503,
      );
    }
    return handleApiError(c, endpoint, err, 'Could not approve application.', {
      error_type: 'D1_APPROVE',
      http_status: 500,
    });
  }

  // d) Welcome email to the applicant (non-blocking).
  await sendWelcomeEmail(c.env, {
    fullName,
    email,
    memberId: String(memberId),
    endDate: endIso,
    fee,
  }).catch(() => { /* swallow — already logged inside */ });

  return c.json({ success: true, member_id: memberId, membership_id: membershipId });
}

/* ----------------------------------------------------
   POST /api/admin/forms/membership/:id/reject  (admin only)
   Marks a pending application rejected. Does NOT touch members/memberships.
   ---------------------------------------------------- */
export async function handleMembershipReject(c: AppContext) {
  const endpoint = 'admin-forms-membership-reject';
  if (getSessionRole(c) !== 'admin') {
    return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin access required to reject applications.' }, 403);
  }
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid application id.' }, 400);
  }
  const reviewer = getSessionEmail(c);

  let app: Record<string, unknown> | null = null;
  try {
    app = await c.env.DB.prepare('SELECT status, member_id FROM membership_applications WHERE id = ?')
      .bind(Number(id))
      .first();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load application.', {
      error_type: 'D1_SELECT_MEM_APP',
      http_status: 500,
    });
  }
  if (!app) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: 'Application not found.' }, 404);
  }
  if (app.status === 'approved' || app.member_id) {
    return c.json(
      { success: false, error_code: 'CONFLICT', message: 'Application already approved. Cannot reject.' },
      409,
    );
  }

  try {
    await c.env.DB.prepare(
      `UPDATE membership_applications
         SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(reviewer, Number(id))
      .run();
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not reject application.', {
      error_type: 'D1_REJECT',
      http_status: 500,
    });
  }

  return c.json({ success: true });
}

/* ---------------- helpers ---------------- */

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<{ allowed: boolean; remaining: number }> {
  const key = `swa:rl:mem:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % MEMBERSHIP_RATE_LIMIT_WINDOW_SECONDS);

  const raw = await kv.get(key);
  let records: number[] = raw ? JSON.parse(raw) : [];
  records = records.filter((t) => t > windowStart);

  if (records.length >= MEMBERSHIP_RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }
  records.push(now);
  await kv.put(key, JSON.stringify(records), { expirationTtl: MEMBERSHIP_RATE_LIMIT_WINDOW_SECONDS + 60 });
  return { allowed: true, remaining: MEMBERSHIP_RATE_LIMIT_MAX_REQUESTS - records.length };
}

function str(b: Record<string, unknown>, k: string): string {
  const v = b[k];
  return typeof v === 'string' ? v.trim() : '';
}

function imageExtension(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
    case 'image/heif':
      return 'heic';
    default:
      return null;
  }
}

function generateRandomSuffix(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  // base36 from each byte → 6 chars, take 4
  return Array.from(bytes, (b) => (b % 36).toString(36))
    .join('')
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, '0');
}

function isRetryableD1Error(msg: string): boolean {
  return (
    msg.includes('storage caused object to be reset') ||
    msg.includes('reset because its code was updated') ||
    msg.includes('Internal error while starting up D1 DB storage') ||
    msg.includes('Network connection lost')
  );
}

function csvEscape(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function formatSg(v: unknown): string {
  if (!v) return '';
  let s = String(v);
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Singapore',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

interface Validated {
  fullName: string;
  nric: string;
  addressLine1: string;
  addressLine2: string;
  addressPostalCode: string;
  phoneHome: string;
  phoneOffice: string;
  email: string;
  handphone: string;
  dateOfBirth: string;
  placeOfBirth: string;
  citizenship: string;
  occupation: string;
  hobbies: string;
  skillsExperiences: string;
  otherAssociations: string;
  membershipIntent: string;
  recommendedBy: string;
}

function validateSubmission(b: Record<string, unknown>): { data: Validated; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const fullName = str(b, 'fullName');
  if (!fullName) errors.fullName = 'Full name is required.';
  else if (fullName.length < 2) errors.fullName = 'Please enter your full name.';

  const nric = str(b, 'nric').toUpperCase();
  if (!nric) errors.nric = 'NRIC/FIN is required.';
  else if (!/^\d{3}[A-Z]$/.test(nric)) errors.nric = 'Enter the last 4 characters of your NRIC/FIN (3 digits + final letter, e.g. 567D).';

  const addressLine1 = str(b, 'addressLine1');
  if (!addressLine1) errors.addressLine1 = 'Address is required.';

  const addressLine2 = str(b, 'addressLine2');

  const addressPostalCode = str(b, 'addressPostalCode');
  if (!addressPostalCode) errors.addressPostalCode = 'Postal code is required.';
  else if (!/^\d{6}$/.test(addressPostalCode)) errors.addressPostalCode = 'Enter a 6-digit Singapore postal code.';

  const phoneHome = str(b, 'phoneHome');
  const phoneOffice = str(b, 'phoneOffice');

  const email = str(b, 'email').toLowerCase();
  if (!email) errors.email = 'Email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';

  const handphone = str(b, 'handphone');
  if (!handphone) errors.handphone = 'Mobile number is required.';

  const dateOfBirth = str(b, 'dateOfBirth');
  const placeOfBirth = str(b, 'placeOfBirth');
  const citizenship = str(b, 'citizenship');
  const occupation = str(b, 'occupation');

  const hobbies = str(b, 'hobbies');
  const skillsExperiences = str(b, 'skillsExperiences');
  const otherAssociations = str(b, 'otherAssociations');

  const membershipIntent = str(b, 'membershipIntent');
  if (!['administration', 'services', 'supportive'].includes(membershipIntent)) {
    errors.membershipIntent = 'Please select your membership intent.';
  }

  const recommendedBy = str(b, 'recommendedBy');
  if (!recommendedBy) errors.recommendedBy = 'Please state who recommended you.';

  return {
    data: {
      fullName,
      nric,
      addressLine1,
      addressLine2,
      addressPostalCode,
      phoneHome,
      phoneOffice,
      email,
      handphone,
      dateOfBirth,
      placeOfBirth,
      citizenship,
      occupation,
      hobbies,
      skillsExperiences,
      otherAssociations,
      membershipIntent,
      recommendedBy,
    },
    errors,
  };
}

/* ---------------- notification email ---------------- */

interface NotificationPayload {
  reference: string;
  fullName: string;
  nric: string;
  email: string;
  handphone: string;
  phoneHome: string;
  phoneOffice: string;
  addressLine1: string;
  addressLine2: string;
  addressPostalCode: string;
  dateOfBirth: string;
  placeOfBirth: string;
  citizenship: string;
  occupation: string;
  hobbies: string;
  skillsExperiences: string;
  otherAssociations: string;
  membershipIntent: string;
  recommendedBy: string;
  paymentReference: string;
  paymentAmount: number;
  signatureMethod: string;
  paynowUploaded: boolean;
  submittedAt: string;
  submittedIp: string;
  userAgent: string;
  adminUrl: string;
}

async function sendNotification(env: Env, data: NotificationPayload): Promise<void> {
  const recipients = [...MEMBERSHIP_NOTIFY_EMAILS];
  const html = buildMembershipNotificationEmail(data);
  const subject = `New Membership Application: ${data.reference}`;

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SWA Portal <contactus@singaporewomenassociation.org>',
        to: recipients,
        subject,
        html,
      }),
    });
    if (!resendRes.ok) {
      const errText = await resendRes.text();
      throw new Error(`Resend returned ${resendRes.status}: ${errText}`);
    }
  } catch (err) {
    await logError(env, {
      endpoint: 'membership-register-notify',
      error_type: 'RESEND_NOTIFY',
      error_message: err instanceof Error ? err.message : String(err),
      http_status: 502,
    });
  }
}

/* ---------------- welcome email (sent on approval) ---------------- */

interface WelcomePayload {
  fullName: string;
  email: string;
  memberId: string;
  endDate: string;
  fee: number;
}

function buildWelcomeEmailHtml(d: WelcomePayload): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;">' +
    '<div style="background:#70308c;padding:24px;color:#ffffff;font-size:20px;font-weight:600;">Welcome to the Singapore Women&rsquo;s Association</div>' +
    '<div style="padding:24px;color:#1f2937;font-size:14px;line-height:1.6;">' +
    '<p>Dear ' + esc(d.fullName) + ',</p>' +
    '<p>Your membership application has been approved. We are delighted to welcome you as a member of the Singapore Women&rsquo;s Association.</p>' +
    '<p style="background:#faf5ff;border:1px solid #f3d2ff;border-radius:6px;padding:12px;">' +
    '<strong>Member ID:</strong> ' + esc(d.memberId) + '<br />' +
    '<strong>Membership valid until:</strong> ' + esc(d.endDate) + '<br />' +
    '<strong>Annual fee:</strong> $' + d.fee.toFixed(2) +
    '</p>' +
    '<p>From next year, your renewal fee will be $20.00. We will send you a reminder before your membership expires.</p>' +
    '<p>If you have any questions, please contact us at <a href="mailto:contactus@singaporewomenassociation.org" style="color:#70308c;">contactus@singaporewomenassociation.org</a>.</p>' +
    '<p style="margin-top:1.5rem;color:#6b7280;font-size:12px;">Singapore Women&rsquo;s Association &middot; Block 409 Serangoon Central, #01-303, Singapore 550409</p>' +
    '</div></div></body></html>'
  );
}

async function sendWelcomeEmail(env: Env, d: WelcomePayload): Promise<void> {
  if (!d.email) return;
  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SWA Portal <contactus@singaporewomenassociation.org>',
        to: [d.email],
        subject: 'Welcome to the Singapore Women\u2019s Association',
        html: buildWelcomeEmailHtml(d),
      }),
    });
    if (!resendRes.ok) {
      const errText = await resendRes.text();
      throw new Error(`Resend returned ${resendRes.status}: ${errText}`);
    }
  } catch (err) {
    await logError(env, {
      endpoint: 'membership-approve-welcome',
      error_type: 'RESEND_WELCOME',
      error_message: err instanceof Error ? err.message : String(err),
      http_status: 502,
    });
  }
}
