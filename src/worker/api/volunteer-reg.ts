import type { Context } from 'hono';
import type { Env } from '../types';
import { handleApiError } from '../lib/error-handler';
import { logError } from '../lib/log-error';
import { buildVolunteerNotificationEmail } from '../lib/email-volunteer-notification';
import { VOLUNTEER_NOTIFY_EMAILS } from '../../constants/portal';

type AppContext = Context<{ Bindings: Env }>;

const KV_KEY = 'swa:volunteer_event_config';

const VOL_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const VOL_RATE_LIMIT_MAX_REQUESTS = 8;

/* ----------------------------------------------------
   Default event config (used when KV key is empty).
   Mirrors the source MS Form content, adjusted for
   the two Ren Ci / Bukit Batok dates.
   ---------------------------------------------------- */
const DEFAULT_CONFIG = {
  eventTitle: "Bringing National Day 2026 to Seniors at Ren Ci Community Hospital",
  introHtml:
    "<p class=\"lead\">We warmly invite you to volunteer as a Befriender for a meaningful day of celebration with our seniors.</p>" +
    "<p>A nostalgic National Day carnival with food and game booths, performances, and telecasts.</p>" +
    "<p><strong>Role of Befrienders:</strong></p>" +
    "<ul>" +
    "<li>Accompany seniors from wards to the event hall</li>" +
    "<li>Befriend and assist them during performances, games, photo-taking, and refreshments</li>" +
    "<li>Return them to wards after the event</li>" +
    "</ul>" +
    "<p><strong>Event dates:</strong> Please review the options below before filling up the form.</p>" +
    "<ul class=\"vf-dates\">" +
    "<li><strong>1st August (Saturday)</strong> &middot; 12:00 PM to 4:00 PM &middot; Ren Ci Community Hospital, Novena</li>" +
    "<li><strong>8th August (Saturday)</strong> &middot; 12:00 PM to 4:00 PM &middot; 31 Bukit Batok Street 52, Singapore 659251</li>" +
    "</ul>",
  timeText: "12:00 PM to 4:00 PM",
  dates: [
    { label: "1st August (Saturday)", date: "2025-08-01", venue: "Ren Ci Community Hospital, Novena" },
    { label: "8th August (Saturday)", date: "2025-08-08", venue: "31 Bukit Batok Street 52, Singapore 659251" },
  ],
  roles: ["Befriender", "Game Booth Helper", "Performance Support Crew", "Logistics Helper"],
  enquiry: {
    name: "Angela Wong",
    email: "angela.wong@singaporewomenassociation.org",
    phone: "9674 1022",
  },
  consentStatement:
    "I consent to having photos and videos of me taken during the event for publicity use by the Singapore Women\u2019s Association and Ren Ci Community Hospital.",
  declarationStatement:
    "I certify that I am physically fit to participate in this event and will not hold Singapore Women\u2019s Association, Ren Ci Community Hospital, or event organisers responsible for any injuries, losses, or damages sustained during the event.",
  formCutoffTime: null as string | null,
  isActive: true,
};

export function buildDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/* ----------------------------------------------------
   GET /api/volunteer/config  (public)
   ---------------------------------------------------- */
export async function handleVolunteerConfig(c: AppContext) {
  let config: Record<string, unknown> = buildDefaultConfig();
  try {
    const raw = await c.env.SWA_CONFIG.get(KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      config = { ...buildDefaultConfig(), ...parsed };
    }
  } catch {
    // ignore malformed KV, fall back to default
  }

  const isActive = config.isActive !== false;
  const cutoff = typeof config.formCutoffTime === 'string' && config.formCutoffTime ? config.formCutoffTime : null;
  const closed = !isActive || (cutoff !== null && new Date(cutoff).getTime() < Date.now());

  // Do not expose the cutoff as a write timestamp; provide a friendly formatted copy
  return c.json({
    success: true,
    closed,
    config,
  });
}

/* ----------------------------------------------------
   POST /api/volunteer/register  (public)
   ---------------------------------------------------- */
export async function handleVolunteerRegister(c: AppContext) {
  const endpoint = 'volunteer-register';
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

  // 3. Turnstile (required like login)
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

  // 4. Load config to confirm form open + capture event_key for record
  let config: { isActive?: boolean; formCutoffTime?: string | null; eventTitle?: string; notifyEmail?: string } = buildDefaultConfig();
  try {
    const raw = await env.SWA_CONFIG.get(KV_KEY);
    if (raw) config = { ...buildDefaultConfig(), ...(JSON.parse(raw) as Record<string, unknown>) } as typeof config;
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
      'INSERT INTO volunteer_registrations ' +
        '(event_key, full_name, email, contact_number, nric_last4, emergency_contact, availability, ' +
        'is_18_plus, medical_conditions, roles_interest, affiliation, corporate_company, referral, ' +
        'consent, declaration, submitted_ip, user_agent) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        eventKey,
        d.fullName,
        d.email,
        d.contactNumber,
        d.nricLast4,
        d.emergencyContact,
        JSON.stringify(d.availability),
        d.is18Plus ? 1 : 0,
        d.medicalConditions,
        JSON.stringify(d.rolesInterest),
        d.affiliation,
        d.corporateCompany || null,
        d.referral || null,
        d.consent ? 1 : 0,
        d.declaration ? 1 : 0,
        ip,
        userAgent,
      )
      .run();

    const id = result.meta?.last_row_id;
    const ref = 'VOL-' + String(id ?? 0).padStart(5, '0');

    // 7. Email notification to admin (non-blocking on failure — D1 write already succeeded)
    await sendNotification(env, {
      reference: ref,
      eventTitle: typeof config.eventTitle === 'string' && config.eventTitle ? config.eventTitle : 'Volunteer Registration',
      fullName: d.fullName,
      email: d.email,
      contactNumber: d.contactNumber,
      nricLast4: d.nricLast4,
      emergencyContact: d.emergencyContact,
      availability: d.availability,
      is18Plus: d.is18Plus,
      medicalConditions: d.medicalConditions,
      rolesInterest: d.rolesInterest,
      affiliation: d.affiliation,
      corporateCompany: d.corporateCompany || null,
      referral: d.referral || null,
      consent: d.consent,
      declaration: d.declaration,
      submittedAt: new Date().toISOString(),
      submittedIp: ip,
      userAgent,
    }).catch(() => { /* swallow — already logged inside */ });

    return c.json({ success: true, reference: ref });
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not save your registration. Please try again.', {
      error_type: 'D1_INSERT_VOL',
      http_status: 500,
    });
  }
}

/* ----------------------------------------------------
   GET /api/admin/forms/volunteer  (admin + committee)
   Returns all submissions, newest first.
   ---------------------------------------------------- */
export async function handleVolunteerSubmissions(c: AppContext) {
  const endpoint = 'admin-forms-volunteer';
  const search = (c.req.query('search') || '').trim();
  const eventKey = (c.req.query('event_key') || '').trim();

  let query = 'SELECT * FROM volunteer_registrations WHERE 1=1';
  const params: unknown[] = [];

  if (eventKey) {
    query += ' AND event_key = ?';
    params.push(eventKey);
  }
  if (search) {
    query += ' AND (full_name LIKE ? OR email LIKE ? OR contact_number LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  query += ' ORDER BY created_at DESC, id DESC LIMIT 500';

  try {
    const results = await c.env.DB.prepare(query).bind(...params).all();
    const rows = (results.results || []).map((r) => {
      const row = r as Record<string, unknown>;
      let availability: string[] = [];
      let rolesInterest: string[] = [];
      try {
        availability = typeof row.availability === 'string' ? JSON.parse(row.availability) : [];
      } catch { /* leave empty */ }
      try {
        rolesInterest = typeof row.roles_interest === 'string' ? JSON.parse(row.roles_interest) : [];
      } catch { /* leave empty */ }
      return { ...row, availability, roles_interest: rolesInterest };
    });
    return c.json({ success: true, submissions: rows });
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load submissions.', {
      error_type: 'D1_SELECT_VOL',
      http_status: 500,
    });
  }
}

/* ----------------------------------------------------
   GET /api/admin/forms/volunteer/export  (admin + committee)
   Returns a CSV download. One column per event date (Yes/No),
   all other fields included, created_at in Asia/Singapore time.
   ---------------------------------------------------- */
export async function handleVolunteerExport(c: AppContext) {
  const endpoint = 'admin-forms-volunteer-export';

  // Load event config to derive date columns (labels).
  let dateLabels: string[] = [];
  try {
    const raw = await c.env.SWA_CONFIG.get(KV_KEY);
    const cfg = raw ? { ...buildDefaultConfig(), ...(JSON.parse(raw) as Record<string, unknown>) } : buildDefaultConfig();
    const dates = (cfg as { dates?: { label: string }[] }).dates;
    if (Array.isArray(dates)) dateLabels = dates.map((d) => d.label).filter((l) => typeof l === 'string' && l.length > 0);
  } catch { /* fall back to empty date columns */ }
  if (dateLabels.length === 0) dateLabels = ['Availability'];

  let results: Record<string, unknown>[];
  try {
    const res = await c.env.DB.prepare(
      'SELECT * FROM volunteer_registrations ORDER BY created_at DESC, id DESC LIMIT 2000',
    ).all();
    results = (res.results || []) as Record<string, unknown>[];
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load submissions for export.', {
      error_type: 'D1_SELECT_VOL_EXPORT',
      http_status: 500,
    });
  }

  const staticHeaders = [
    'Reference',
    'Event',
    'Full Name',
    'Email',
    'Contact Number',
    'NRIC/FIN Last 4',
    'Emergency Contact',
    '18+',
    'Medical Conditions',
    'Roles of Interest',
    'Affiliation',
    'Corporate Company',
    'Referral',
    'Consent',
    'Declaration',
    'Submitted At (SG)',
    'Submitter IP',
    'User Agent',
  ];
  const headers = [
    staticHeaders.slice(0, 7), // before 18+
    dateLabels,                 // split date columns
    staticHeaders.slice(7),     // rest
  ].flat();

  const lines: string[] = [headers.map(csvEscape).join(',')];

  for (const row of results) {
    const availability = parseJsonArray(row.availability);
    const roles = parseJsonArray(row.roles_interest);
    const medical = row.medical_conditions;
    const medicalStr = medical === 'none' ? 'None' : medical === 'yes' ? 'Yes (not specified)' : String(medical || '');

    const ref = 'VOL-' + String(row.id ?? 0).padStart(5, '0');
    const submittedSg = formatSg(row.created_at);

    const dateCells = dateLabels.map((label) =>
      label === 'Availability' ? availability.join('; ') : availability.includes(label) ? 'Yes' : 'No',
    );

    const values = [
      ref,
      String(row.event_key || ''),
      String(row.full_name || ''),
      String(row.email || ''),
      String(row.contact_number || ''),
      String(row.nric_last4 || ''),
      String(row.emergency_contact || ''),
      ...dateCells,
      row.is_18_plus ? 'Yes' : 'No',
      medicalStr,
      roles.join('; '),
      String(row.affiliation || ''),
      String(row.corporate_company || ''),
      String(row.referral || ''),
      row.consent ? 'Agreed' : 'Not agreed',
      row.declaration ? 'Agreed' : 'Not agreed',
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
      'Content-Disposition': `attachment; filename="volunteer-registrations-${stamp}.csv"`,
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
  const key = `swa:rl:vol:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % VOL_RATE_LIMIT_WINDOW_SECONDS);

  const raw = await kv.get(key);
  let records: number[] = raw ? JSON.parse(raw) : [];
  records = records.filter((t) => t > windowStart);

  if (records.length >= VOL_RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }
  records.push(now);
  await kv.put(key, JSON.stringify(records), { expirationTtl: VOL_RATE_LIMIT_WINDOW_SECONDS + 60 });
  return { allowed: true, remaining: VOL_RATE_LIMIT_MAX_REQUESTS - records.length };
}

function str(b: Record<string, unknown>, k: string): string {
  const v = b[k];
  return typeof v === 'string' ? v.trim() : '';
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0);
}

function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
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
  fullName: string;
  email: string;
  contactNumber: string;
  nricLast4: string;
  emergencyContact: string;
  availability: string[];
  is18Plus: boolean;
  medicalConditions: string;
  rolesInterest: string[];
  affiliation: string;
  corporateCompany: string;
  referral: string;
  consent: boolean;
  declaration: boolean;
}

function validateSubmission(b: Record<string, unknown>): { data: Validated; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const fullName = str(b, 'fullName');
  if (!fullName) errors.fullName = 'Full name is required.';

  const email = str(b, 'email').toLowerCase();
  if (!email) errors.email = 'Email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';

  const contactNumber = str(b, 'contactNumber');
  if (!contactNumber) errors.contactNumber = 'Contact number is required.';
  else if (!/^[0-9+\-\s()]{6,}$/.test(contactNumber)) errors.contactNumber = 'Enter a valid contact number.';

  const nricLast4 = str(b, 'nricLast4').toUpperCase();
  if (!nricLast4) errors.nricLast4 = 'NRIC/FIN last 4 characters are required.';
  else if (!/^[0-9]{3}[A-Z]$/.test(nricLast4)) errors.nricLast4 = 'Enter the last 4 characters (e.g. 123A).';

  const emergencyContact = str(b, 'emergencyContact');
  if (!emergencyContact) errors.emergencyContact = 'Emergency contact is required.';

  const availability = asStringArray(b.availability);
  if (availability.length === 0) errors.availability = 'Select at least one date.';

  let is18Plus = false;
  if (b.is18Plus === true || b.is18Plus === 'true') is18Plus = true;
  else if (b.is18Plus === false || b.is18Plus === 'false') is18Plus = false;
  else {
    errors.is18Plus = 'Please confirm your age.';
  }

  const medicalChoice = str(b, 'medicalChoice'); // 'no' | 'yes' | 'other'
  const medicalOther = str(b, 'medicalOther');
  let medicalConditions = '';
  if (medicalChoice === 'no') medicalConditions = 'none';
  else if (medicalChoice === 'yes') medicalConditions = 'yes';
  else if (medicalChoice === 'other') {
    if (!medicalOther) errors.medical = 'Please describe your medical condition.';
    else medicalConditions = medicalOther.slice(0, 500);
  } else {
    errors.medical = 'Please answer this question.';
  }

  const rolesInterest = asStringArray(b.rolesInterest);
  if (rolesInterest.length === 0) errors.roles = 'Select at least one role.';

  const affiliationChoice = str(b, 'affiliationChoice'); // member_swa | laughter_yoga | new_volunteer | other
  const affiliationOther = str(b, 'affiliationOther');
  let affiliation = '';
  if (affiliationChoice === 'member_swa') affiliation = 'Member of Singapore Women\u2019s Association';
  else if (affiliationChoice === 'laughter_yoga') affiliation = 'Member of SWA Laughter Yoga Wellness Club';
  else if (affiliationChoice === 'new_volunteer') affiliation = 'New Volunteer';
  else if (affiliationChoice === 'other') {
    if (!affiliationOther) errors.affiliation = 'Please specify your affiliation.';
    else affiliation = affiliationOther.slice(0, 200);
  } else {
    errors.affiliation = 'Please select an option.';
  }

  const corporateCompany = str(b, 'corporateCompany');
  const referral = str(b, 'referral');

  const consent = b.consent === true;
  if (!consent) errors.consent = 'Consent is required to continue.';

  const declaration = b.declaration === true;
  if (!declaration) errors.declaration = 'Declaration is required to continue.';

  return {
    data: {
      fullName,
      email,
      contactNumber,
      nricLast4,
      emergencyContact,
      availability,
      is18Plus,
      medicalConditions,
      rolesInterest,
      affiliation,
      corporateCompany,
      referral,
      consent,
      declaration,
    },
    errors,
  };
}

/* ---------------- notification email ---------------- */

interface NotificationPayload {
  reference: string;
  eventTitle: string;
  fullName: string;
  email: string;
  contactNumber: string;
  nricLast4: string;
  emergencyContact: string;
  availability: string[];
  is18Plus: boolean;
  medicalConditions: string;
  rolesInterest: string[];
  affiliation: string;
  corporateCompany: string | null;
  referral: string | null;
  consent: boolean;
  declaration: boolean;
  submittedAt: string;
  submittedIp: string;
  userAgent: string;
}

async function sendNotification(env: Env, data: NotificationPayload): Promise<void> {
  // Resolve recipients: KV event config notifyEmail overrides defaults
  let recipients: string[] = [...VOLUNTEER_NOTIFY_EMAILS];
  try {
    const raw = await env.SWA_CONFIG.get(KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { notifyEmail?: string };
      if (typeof parsed.notifyEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.notifyEmail)) {
        recipients = [parsed.notifyEmail.trim().toLowerCase()];
      }
    }
  } catch { /* fall back to defaults */ }

  const html = buildVolunteerNotificationEmail(data);
  const subject = `New Volunteer Registration — ${data.reference}`;

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
      endpoint: 'volunteer-register-notify',
      error_type: 'RESEND_NOTIFY',
      error_message: err instanceof Error ? err.message : String(err),
      http_status: 502,
    });
  }
}