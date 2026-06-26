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

export function buildVolunteerNotificationEmail(d: VolunteerNotificationData): string {
  const availabilityStr = d.availability.length > 0 ? d.availability.join(', ') : '';
  const rolesStr = d.rolesInterest.length > 0 ? d.rolesInterest.join(', ') : '';
  const medicalStr =
    d.medicalConditions === 'none'
      ? 'None'
      : d.medicalConditions === 'yes'
        ? 'Yes (not specified)'
        : d.medicalConditions;
  const rows = [
    row('Reference', d.reference),
    row('Event', d.eventTitle),
    row('Full Name', d.fullName),
    row('Email', d.email),
    row('Contact Number', d.contactNumber),
    row('NRIC / FIN (last 4)', d.nricLast4),
    row('Emergency Contact', d.emergencyContact),
    row('Availability', availabilityStr),
    row('18 years and above', d.is18Plus ? 'Yes' : 'No'),
    row('Medical Conditions', medicalStr),
    row('Roles of Interest', rolesStr),
    row('Affiliation', d.affiliation),
    row('Corporate Company', d.corporateCompany || ''),
    row('Referral', d.referral || ''),
    row('Consent', d.consent ? 'Agreed' : 'Not agreed'),
    row('Declaration', d.declaration ? 'Agreed' : 'Not agreed'),
    row('Submitted At', formatDateTime(d.submittedAt)),
    row('Submitter IP', d.submittedIp),
    row('User Agent', d.userAgent),
  ].join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>New Volunteer Registration — ${escapeHtml(d.reference)}</title>
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
            <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.7);font-family:'Montserrat',Arial,sans-serif;">New Volunteer Registration</p>
          </td>
        </tr>

        <tr>
          <td style="padding:24px;color:#1f2937;font-family:'Montserrat',Arial,sans-serif;">
            <p style="margin:0 0 8px;font-size:15px;color:#1f2937;">A new volunteer registration has been submitted.</p>
            <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#6b7280;">Reference <strong style="color:#70308c;">${escapeHtml(d.reference)}</strong> &middot; ${escapeHtml(formatDateTime(d.submittedAt))}</p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
              ${rows}
            </table>

            <p style="margin:24px 0 0;font-size:16px;line-height:1.5;color:#1f2937;">
              <a href="https://admin.singaporewomenassociation.org/admin/forms/volunteer/" style="color:#1f2937;font-weight:600;text-decoration:underline;">View all submissions in the SWA Admin Portal under Online Forms.</a>
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
