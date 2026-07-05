interface MembershipNotificationData {
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
  return `<tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;vertical-align:top;width:180px;border-bottom:1px solid #f3f4f6;">${escapeHtml(label)}</td><td style="padding:8px 12px;color:#1f2937;font-size:14px;vertical-align:top;border-bottom:1px solid #f3f4f6;">${safe}</td></tr>`;
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

const INTENT_LABELS: Record<string, string> = {
  administration: 'Take an active part in the administration of the Association',
  services: 'Render services to the Association',
  supportive: 'Be a supportive member only',
};

export function buildMembershipNotificationEmail(data: MembershipNotificationData): string {
  const intentLabel = INTENT_LABELS[data.membershipIntent] || data.membershipIntent;
  const fullAddress = [data.addressLine1, data.addressLine2, data.addressPostalCode]
    .filter((x) => x && x.length > 0)
    .join(', ');

  return (
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;">' +
    '<div style="background:#70308c;padding:20px 24px;color:#ffffff;">' +
    '<div style="font-size:18px;font-weight:600;">New Membership Application</div>' +
    '<div style="font-size:13px;opacity:0.9;margin-top:4px;">Reference ' + escapeHtml(data.reference) + '</div>' +
    '</div>' +
    '<div style="padding:20px 24px;">' +
    '<p style="margin:0 0 12px 0;color:#374151;font-size:14px;">A new membership application has been submitted via the public form.</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:8px 0 20px 0;">' +
    row('Full Name', data.fullName) +
    row('NRIC/FIN', data.nric) +
    row('Email', data.email) +
    row('Handphone', data.handphone) +
    row('Telephone (Home)', data.phoneHome) +
    row('Telephone (Office)', data.phoneOffice) +
    row('Address', fullAddress) +
    row('Date of Birth', data.dateOfBirth) +
    row('Place of Birth', data.placeOfBirth) +
    row('Citizenship', data.citizenship) +
    row('Occupation', data.occupation) +
    row('Membership Intent', intentLabel) +
    row('Recommended By', data.recommendedBy) +
    row('Hobbies / Interests', data.hobbies) +
    row('Skills / Experiences', data.skillsExperiences) +
    row('Other Associations', data.otherAssociations) +
    row('PayNow Reference', data.paymentReference) +
    row('Payment Amount', '$' + data.paymentAmount.toFixed(2)) +
    row('PayNow Screenshot Uploaded', data.paynowUploaded ? 'Yes' : 'No') +
    row('Signature Method', data.signatureMethod === 'draw' ? 'Drawn on screen' : 'Uploaded image') +
    row('Submitted At', formatDateTime(data.submittedAt)) +
    row('Submitter IP', data.submittedIp) +
    row('User Agent', data.userAgent) +
    '</table>' +
    '<a href="' + escapeHtml(data.adminUrl) + '" style="display:inline-block;background:#70308c;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:4px;font-size:14px;font-weight:500;">View in admin portal</a>' +
    '</div>' +
    '<div style="padding:12px 24px;color:#9ca3af;font-size:11px;border-top:1px solid #f3f4f6;">' +
    'Sent automatically by the SWA Portal. Please do not reply directly to this email.' +
    '</div>' +
    '</div></body></html>'
  );
}
