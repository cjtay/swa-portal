/* Shared notification email builder for public form submission notifications.
   The generic builder takes a simple row list; volunteer and Laughter Yoga
   wrappers map their own data shapes onto it. */

export interface NotificationEmailOptions {
  heading: string;
  introLine: string;
  adminPath: string;
}

export interface NotificationEmailRow {
  label: string;
  value: string;
}

interface NotificationEmailData {
  reference: string;
  submittedAt: string;
  heading: string;
  introLine: string;
  adminPath: string;
  rows: NotificationEmailRow[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function row(label: string, value: string): string {
  const safe = value && value.length > 0 ? escapeHtml(value) : '&mdash;';
  return `<tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;vertical-align:top;width:170px;border-bottom:1px solid #f3f4f6;">${escapeHtml(label)}</td><td style="padding:8px 12px;color:#1f2937;font-size:14px;vertical-align:top;border-bottom:1px solid #f3f4f6;">${safe}</td></tr>`;
}

function formatDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildNotificationEmail(d: NotificationEmailData): string {
  const rows = d.rows.map((r) => row(r.label, r.value)).join('');
  const defaultRows = [
    row('Reference', d.reference),
    row('Submitted At', formatDateTime(d.submittedAt)),
  ].join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(d.heading)} — ${escapeHtml(d.reference)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;color:#1f2937;font-family:'Montserrat',Arial,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f9fafb" style="background-color:#f9fafb;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <!--[if mso]>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560"><tr><td>
      <![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" bgcolor="#ffffff" style="width:560px;max-width:100%;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">

        <tr>
          <td bgcolor="#450a5e" style="background-color:#450a5e;padding:24px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;font-size:22px;color:#ffffff;font-weight:700;font-family:'Montserrat',Arial,sans-serif;">SWA <span style="color:#f3d2ff;">Portal</span></h1>
            <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.7);font-family:'Montserrat',Arial,sans-serif;">${escapeHtml(d.heading)}</p>
          </td>
        </tr>

        <tr>
          <td style="padding:24px;color:#1f2937;font-family:'Montserrat',Arial,sans-serif;">
            <p style="margin:0 0 8px;font-size:15px;color:#1f2937;">${escapeHtml(d.introLine)}</p>
            <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#6b7280;">Reference <strong style="color:#70308c;">${escapeHtml(d.reference)}</strong> &middot; ${escapeHtml(formatDateTime(d.submittedAt))}</p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
              ${rows}
              ${defaultRows}
            </table>

            <p style="margin:24px 0 0;font-size:16px;line-height:1.5;color:#1f2937;">
              <a href="https://admin.singaporewomenassociation.org${escapeHtml(d.adminPath)}" style="color:#1f2937;font-weight:600;text-decoration:underline;">View all submissions in the SWA Admin Portal under Online Forms.</a>
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center;font-family:'Montserrat',Arial,sans-serif;">
            Singapore Women's Association<br>
            This is an automated notification — please do not reply.
          </td>
        </tr>

      </table>
      <!--[if mso]>
      </td></tr></table>
      <![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}

/* ---------------- volunteer wrapper ---------------- */

interface VolunteerNotificationData {
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

const DEFAULT_EMAIL_OPTIONS: NotificationEmailOptions = {
  heading: 'New Volunteer Registration',
  introLine: 'A new volunteer registration has been submitted.',
  adminPath: '/admin/forms/volunteer/',
};

export function buildVolunteerNotificationEmail(d: VolunteerNotificationData, opts?: Partial<NotificationEmailOptions>): string {
  const o = { ...DEFAULT_EMAIL_OPTIONS, ...opts };
  const availabilityStr = d.availability.length > 0 ? d.availability.join(', ') : '';
  const rolesStr = d.rolesInterest.length > 0 ? d.rolesInterest.join(', ') : '';
  const medicalStr =
    d.medicalConditions === 'none'
      ? 'None'
      : d.medicalConditions === 'yes'
        ? 'Yes (not specified)'
        : d.medicalConditions;
  const rows: NotificationEmailRow[] = [
    { label: 'Event', value: d.eventTitle },
    { label: 'Full Name', value: d.fullName },
    { label: 'Email', value: d.email },
    { label: 'Contact Number', value: d.contactNumber },
    { label: 'NRIC / FIN (last 4)', value: d.nricLast4 },
    { label: 'Emergency Contact', value: d.emergencyContact },
    { label: 'Availability', value: availabilityStr },
    { label: '18 years and above', value: d.is18Plus ? 'Yes' : 'No' },
    { label: 'Medical Conditions', value: medicalStr },
    { label: 'Roles of Interest', value: rolesStr },
    { label: 'Affiliation', value: d.affiliation },
    { label: 'Corporate Company', value: d.corporateCompany || '' },
    { label: 'Referral', value: d.referral || '' },
    { label: 'Consent', value: d.consent ? 'Agreed' : 'Not agreed' },
    { label: 'Declaration', value: d.declaration ? 'Agreed' : 'Not agreed' },
    { label: 'Submitter IP', value: d.submittedIp },
    { label: 'User Agent', value: d.userAgent },
  ];
  return buildNotificationEmail({
    reference: d.reference,
    submittedAt: d.submittedAt,
    heading: o.heading,
    introLine: o.introLine,
    adminPath: o.adminPath,
    rows,
  });
}

/* ---------------- Laughter Yoga wrapper ---------------- */

interface LaughterYogaNotificationData {
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

export function buildLaughterYogaNotificationEmail(d: LaughterYogaNotificationData, opts?: Partial<NotificationEmailOptions>): string {
  const o = { ...DEFAULT_EMAIL_OPTIONS, ...opts };
  const rows: NotificationEmailRow[] = [
    { label: 'Event', value: d.eventTitle },
    { label: 'Full Name', value: d.fullName },
    { label: 'Email', value: d.email },
    { label: 'Age', value: d.age },
    { label: 'Address', value: d.address },
    { label: 'Phone Number', value: d.phoneNumber },
    { label: 'Emergency Contact', value: d.emergencyContact },
    { label: 'Organisation Name', value: d.organisationName },
    { label: 'Occupation', value: d.occupation },
    { label: 'Where Did You Find Out', value: d.source },
    { label: 'WhatsApp Group', value: d.whatsappGroup ? 'Yes' : 'No' },
    { label: 'Indemnity & PDPA', value: d.indemnityPdpa ? 'Agreed' : 'Not agreed' },
    { label: 'Submitter IP', value: d.submittedIp },
    { label: 'User Agent', value: d.userAgent },
  ];
  return buildNotificationEmail({
    reference: d.reference,
    submittedAt: d.submittedAt,
    heading: o.heading,
    introLine: o.introLine,
    adminPath: o.adminPath,
    rows,
  });
}