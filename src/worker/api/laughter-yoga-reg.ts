import type { Context } from 'hono';
import type { Env, AppContext } from '../types';
import { handleApiError } from '../lib/error-handler';
import { logError } from '../lib/log-error';
import { csvEscape } from '../lib/csv';
import { buildLaughterYogaNotificationEmail } from '../lib/email-volunteer-notification';
import { isDevBypassActive } from './session';
import { LAUGHTER_YOGA_NOTIFY_EMAILS } from '../../constants/portal';


const KV_KEY = 'swa:laughter_yoga_config';

const LY_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const LY_RATE_LIMIT_MAX_REQUESTS = 8;

/* ----------------------------------------------------
   Default config (used when KV key is empty).
   Mirrors the Certified Laughter Yoga Leader (CLYL) training
   MS Form at singaporewomenassociation.org/forms/laughter-yoga-leader-form/.
   Placeholder content is editable via KV (swa:laughter_yoga_config)
   without a deploy.
   ---------------------------------------------------- */
const DEFAULT_CONFIG = {
  eventTitle: 'Certified Laughter Yoga Leader Training Oct 2026',
  introHtml:
    '<p class="lead">Join us for the Certified Laughter Yoga Leader (CLYL) Training.</p>' +
    '<p><strong>Date:</strong> 24 &amp; 25 Oct, 2026</p>' +
    '<p><strong>Time:</strong> Sat (9.30am&ndash;5.30pm), Sun (9.30am&ndash;1.00pm)</p>' +
    '<p><strong>Venue:</strong> 409 Serangoon Central #01-303 (550409)</p>' +
    '<p><strong>Fee:</strong> SGD 290 (inclusive of CLYL Manual, International Certified Laughter Yoga Leader Certificate, 1 lunch, tea-breaks, CLYL T-shirt).</p>' +
    '<p><strong>Payment:</strong> Please make payment via PayNow to Singapore Women\u2019s Association using UEN S54SS0010L and indicate CLYL and your name [CLYL-NAME] in the reference field.</p>' +
    '<p><strong>Organiser:</strong> Singapore Women\u2019s Association Laughter Yoga Wellness Club</p>' +
    '<p><strong>Closing Date:</strong> 20 Oct 2026</p>' +
    '<p>Upon receipt of this registration and payment, participants will receive an email confirmation with further instructions. A reminder email will be sent a week before the training and further details. If you have any questions, please contact Angela Wong at 96741022 via WhatsApp.</p>',
  enquiry: {
    name: 'Angela Wong',
    email: '',
    phone: '96741022',
  },
  formCutoffTime: '2026-10-20T15:45:00.000Z',
  isActive: true,
};

export function buildLaughterYogaDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/* ----------------------------------------------------
   GET /api/laughter-yoga/config  (public)
   ---------------------------------------------------- */
export async function handleLaughterYogaConfig(c: AppContext) {
  let config: Record<string, unknown> = buildLaughterYogaDefaultConfig();
  try {
    const raw = await c.env.SWA_CONFIG.get(KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      config = { ...buildLaughterYogaDefaultConfig(), ...parsed };
    }
  } catch {
    // ignore malformed KV, fall back to default
  }

  const isActive = config.isActive !== false;
  const cutoff = typeof config.formCutoffTime === 'string' && config.formCutoffTime ? config.formCutoffTime : null;
  const closed = !isActive || (cutoff !== null && new Date(cutoff).getTime() < Date.now());

  return c.json({
    success: true,
    closed,
    config,
  });
}

/* ----------------------------------------------------
   POST /api/laughter-yoga/register  (public)
   ---------------------------------------------------- */
export async function handleLaughterYogaRegister(c: AppContext) {
  const endpoint = 'laughter-yoga-register';
  const env = c.env;
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const userAgent = c.req.header('user-agent') || '';

  // 1. IP rate limit (abuse guard before heavy work)
  const rl = await checkRateLimit(env.SWA_SESSION, ip);
  if (!rl.allowed) {
    return c.json(
      { success: false, error_code: 'RATE_LIMITED', message: 'Too many submissions. Please try again later.' },
      429,
    );
  }

  // 2. Parse body
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  // 3. Turnstile (skipped in local dev — see isDevBypassActive in session.ts)
  if (!isDevBypassActive(env, c.req.url)) {
    const turnstileToken = typeof body.turnstileToken === 'string' ? body.turnstileToken.trim() : '';
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
  }

  // 4. Load config to confirm form open + capture event_key for record
  let config: { isActive?: boolean; formCutoffTime?: string | null; eventTitle?: string; notifyEmail?: string } = buildLaughterYogaDefaultConfig();
  try {
    const raw = await env.SWA_CONFIG.get(KV_KEY);
    if (raw) config = { ...buildLaughterYogaDefaultConfig(), ...(JSON.parse(raw) as Record<string, unknown>) } as typeof config;
  } catch {
    // ignore
  }
  if (config.isActive === false) {
    return c.json({ success: false, error_code: 'FORM_CLOSED', message: 'Registrations are closed.' }, 403);
  }
  if (config.formCutoffTime && new Date(config.formCutoffTime).getTime() < Date.now()) {
    return c.json({ success: false, error_code: 'FORM_CLOSED', message: 'Registrations are closed.' }, 403);
  }
  const eventKey = typeof config.eventTitle === 'string' && config.eventTitle ? config.eventTitle : 'default';

  // 5. Validate + coerce fields
  const v = validateSubmission(body);
  if (Object.keys(v.errors).length > 0) {
    return c.json(
      { success: false, error_code: 'VALIDATION_ERROR', message: 'Please correct the highlighted fields.', errors: v.errors },
      400,
    );
  }
  const d = v.data;

  // 6. Insert
  try {
    const result = await env.DB.prepare(
      'INSERT INTO laughter_yoga_registrations ' +
        '(event_key, whatsapp_group, source, email, full_name, age, address, phone_number, ' +
        'emergency_contact, organisation_name, indemnity_pdpa, occupation, submitted_ip, user_agent) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        eventKey,
        d.whatsappGroup ? 1 : 0,
        d.source,
        d.email,
        d.fullName,
        d.age,
        d.address,
        d.phoneNumber,
        d.emergencyContact,
        d.organisationName,
        d.indemnityPdpa ? 1 : 0,
        d.occupation,
        ip,
        userAgent,
      )
      .run();

    const id = result.meta?.last_row_id;
    const ref = 'LY-' + String(id ?? 0).padStart(5, '0');

    // 7. Email notification to admin (non-blocking on failure — D1 write already succeeded)
    await sendNotification(env, {
      reference: ref,
      eventTitle: typeof config.eventTitle === 'string' && config.eventTitle ? config.eventTitle : 'Laughter Yoga Registration',
      whatsappGroup: d.whatsappGroup,
      source: d.source,
      email: d.email,
      fullName: d.fullName,
      age: d.age,
      address: d.address,
      phoneNumber: d.phoneNumber,
      emergencyContact: d.emergencyContact,
      organisationName: d.organisationName,
      indemnityPdpa: d.indemnityPdpa,
      occupation: d.occupation,
      submittedAt: new Date().toISOString(),
      submittedIp: ip,
      userAgent,
    }).catch(() => { /* swallow — already logged inside */ });

    return c.json({ success: true, reference: ref });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Transient D1 platform-side errors — surface as retry-safe 503s; the
    // visitor's form data is preserved client-side, so a manual re-submit is safe.
    if (isRetryableD1Error(errMsg)) {
      await logError(env, {
        endpoint,
        error_type: 'D1_WRITE_FAILED',
        error_message: `laughter-yoga-register: ${errMsg}`,
        http_status: 503,
      });
      return c.json(
        {
          success: false,
          error_code: 'D1_WRITE_FAILED',
          message:
            'We couldn\u2019t save your registration this time. Please click Submit again \u2014 your details are kept.',
        },
        503,
      );
    }

    return handleApiError(c, endpoint, err, 'Could not save your registration. Please try again.', {
      error_type: 'D1_INSERT_LY',
      http_status: 500,
    });
  }
}

/* D1 retryable transient-error matcher.
   Mirrors Cloudflare's own `shouldRetry` example (D1 Retry queries best-practices
   page). D1 auto-retries read-only queries but NOT writes, so writes need
   application-level signalling to the client for a safe manual retry. */
function isRetryableD1Error(msg: string): boolean {
  return (
    msg.includes('storage caused object to be reset') ||
    msg.includes('reset because its code was updated') ||
    msg.includes('Internal error while starting up D1 DB storage') ||
    msg.includes('Network connection lost')
  );
}

/* ----------------------------------------------------
   GET /api/admin/forms/laughter-yoga  (admin + committee)
   Returns all submissions, newest first.
   ---------------------------------------------------- */
export async function handleLaughterYogaSubmissions(c: AppContext) {
  const endpoint = 'admin-forms-laughter-yoga';
  const search = (c.req.query('search') || '').trim();
  const eventKey = (c.req.query('event_key') || '').trim();

  let query = 'SELECT * FROM laughter_yoga_registrations WHERE 1=1';
  const params: unknown[] = [];

  if (eventKey) {
    query += ' AND event_key = ?';
    params.push(eventKey);
  }
  if (search) {
    query += ' AND (full_name LIKE ? OR email LIKE ? OR phone_number LIKE ? OR organisation_name LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  query += ' ORDER BY created_at DESC, id DESC LIMIT 500';

  try {
    const results = await c.env.DB.prepare(query).bind(...params).all();
    const rows = (results.results || []).map((r) => r as Record<string, unknown>);
    return c.json({ success: true, submissions: rows });
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load submissions.', {
      error_type: 'D1_SELECT_LY',
      http_status: 500,
    });
  }
}

/* ----------------------------------------------------
   GET /api/admin/forms/laughter-yoga/export  (admin + committee)
   Returns a CSV download, created_at in Asia/Singapore time.
   ---------------------------------------------------- */
export async function handleLaughterYogaExport(c: AppContext) {
  const endpoint = 'admin-forms-laughter-yoga-export';

  let results: Record<string, unknown>[];
  try {
    const query = 'SELECT * FROM laughter_yoga_registrations ORDER BY created_at DESC, id DESC LIMIT 2000';
    const res = await c.env.DB.prepare(query).all();
    results = (res.results || []) as Record<string, unknown>[];
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load submissions for export.', {
      error_type: 'D1_SELECT_LY_EXPORT',
      http_status: 500,
    });
  }

  const headers = [
    'Reference',
    'Event',
    'WhatsApp Group',
    'Where Did You Find Out',
    'Full Name',
    'Email',
    'Age',
    'Address',
    'Mobile Number',
    'Emergency Contact',
    'Organisation Name',
    'Occupation',
    'Indemnity & PDPA',
    'Submitted At (SG)',
    'Submitter IP',
    'User Agent',
  ];

  const lines: string[] = [headers.map(csvEscape).join(',')];

  for (const row of results) {
    const ref = 'LY-' + String(row.id ?? 0).padStart(5, '0');
    const submittedSg = formatSg(row.created_at);

    const values = [
      ref,
      String(row.event_key || ''),
      row.whatsapp_group ? 'Yes' : 'No',
      String(row.source || ''),
      String(row.full_name || ''),
      String(row.email || ''),
      String(row.age || ''),
      String(row.address || ''),
      String(row.phone_number || ''),
      String(row.emergency_contact || ''),
      String(row.organisation_name || ''),
      String(row.occupation || ''),
      row.indemnity_pdpa ? 'Agreed' : 'Not agreed',
      submittedSg,
      String(row.submitted_ip || ''),
      String(row.user_agent || ''),
    ];

    lines.push(values.map(csvEscape).join(','));
  }

  // UTF-8 BOM so Excel renders non-ASCII names correctly.
  const csv = '\uFEFF' + lines.join('\n');

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="laughter-yoga-registrations-${stamp}.csv"`,
    },
  });
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
  const key = `swa:rl:ly:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % LY_RATE_LIMIT_WINDOW_SECONDS);

  const raw = await kv.get(key);
  let records: number[] = raw ? JSON.parse(raw) : [];
  records = records.filter((t) => t > windowStart);

  if (records.length >= LY_RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }
  records.push(now);
  await kv.put(key, JSON.stringify(records), { expirationTtl: LY_RATE_LIMIT_WINDOW_SECONDS + 60 });
  return { allowed: true, remaining: LY_RATE_LIMIT_MAX_REQUESTS - records.length };
}

function str(b: Record<string, unknown>, k: string): string {
  const v = b[k];
  return typeof v === 'string' ? v.trim() : '';
}

function formatSg(v: unknown): string {
  if (!v) return '';
  let s = String(v);
  // D1 stores datetime('now') as UTC in "YYYY-MM-DD HH:MM:SS" (no Z).
  // Normalise to an explicit UTC instant before converting to Asia/Singapore.
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
  whatsappGroup: boolean;
  source: string;
  email: string;
  fullName: string;
  age: string;
  address: string;
  phoneNumber: string;
  emergencyContact: string;
  organisationName: string;
  indemnityPdpa: boolean;
  occupation: string;
}

function validateSubmission(b: Record<string, unknown>): { data: Validated; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const whatsappGroup = b.whatsappGroup === true;
  if (!whatsappGroup) errors.whatsappGroup = 'Please check this box to continue.';

  const sourceChoice = str(b, 'source');
  const sourceOther = str(b, 'sourceOther');
  let source = '';
  if (sourceChoice === 'Other') {
    if (!sourceOther) errors.source = 'Please specify how you found out about this training programme.';
    else source = sourceOther.slice(0, 200);
  } else if (sourceChoice) {
    source = sourceChoice.slice(0, 200);
  } else {
    errors.source = 'Please select an option.';
  }

  const email = str(b, 'email').toLowerCase();
  if (!email) errors.email = 'Email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';

  const fullName = str(b, 'fullName');
  if (!fullName) errors.fullName = 'Full name is required.';

  const age = str(b, 'age');
  if (!age) errors.age = 'Age is required.';
  else if (!/^\d{1,3}$/.test(age)) errors.age = 'Enter a valid age.';

  const address = str(b, 'address');
  if (!address) errors.address = 'Address is required.';

  const phoneNumber = str(b, 'phoneNumber');
  if (!phoneNumber) errors.phoneNumber = 'Mobile number is required.';
  else if (!/^[0-9+\-\s()]{6,}$/.test(phoneNumber)) errors.phoneNumber = 'Enter a valid mobile number.';

  const emergencyContact = str(b, 'emergencyContact');
  if (!emergencyContact) errors.emergencyContact = 'Emergency contact is required.';

  const organisationName = str(b, 'organisationName');
  if (!organisationName) errors.organisationName = 'Organisation name is required.';

  const indemnityPdpa = b.indemnityPdpa === true;
  if (!indemnityPdpa) errors.indemnityPdpa = 'Please check this box to continue.';
  const occupation = str(b, 'occupation');
  if (!occupation) errors.occupation = 'Occupation is required.';

  return {
    data: {
      whatsappGroup,
      source,
      email,
      fullName,
      age,
      address,
      phoneNumber,
      emergencyContact,
      organisationName,
      indemnityPdpa,
      occupation,
    },
    errors,
  };
}

/* ---------------- notification email ---------------- */

interface NotificationPayload {
  reference: string;
  eventTitle: string;
  whatsappGroup: boolean;
  source: string;
  email: string;
  fullName: string;
  age: string;
  address: string;
  phoneNumber: string;
  emergencyContact: string;
  organisationName: string;
  indemnityPdpa: boolean;
  occupation: string;
  submittedAt: string;
  submittedIp: string;
  userAgent: string;
}

async function sendNotification(env: Env, data: NotificationPayload): Promise<void> {
  // Resolve recipients: KV event config notifyEmail overrides defaults
  let recipients: string[] = [...LAUGHTER_YOGA_NOTIFY_EMAILS];
  try {
    const raw = await env.SWA_CONFIG.get(KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { notifyEmail?: string };
      if (typeof parsed.notifyEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.notifyEmail)) {
        recipients = [parsed.notifyEmail.trim().toLowerCase()];
      }
    }
  } catch { /* fall back to defaults */ }

  const html = buildLaughterYogaNotificationEmail(data, {
    heading: 'New Certified Laughter Yoga Leader Registration',
    introLine: 'A new Certified Laughter Yoga Leader (CLYL) training registration has been submitted.',
    adminPath: '/admin/forms/laughter-yoga/',
  });
  const subject = `New Laughter Yoga Registration — ${data.reference}`;

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
    // Email failure must NOT fail the submission — D1 write already succeeded.
    await logError(env, {
      endpoint: 'laughter-yoga-register-notify',
      error_type: 'RESEND_NOTIFY',
      error_message: err instanceof Error ? err.message : String(err),
      http_status: 502,
    });
  }
}