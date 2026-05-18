import type { Env } from '../../types';
import { logError } from '../log-error';

interface MagicLinkParams {
  buyerEmail: string;
  buyerName: string;
  bookingRef: string;
  paxCount: number;
  tableLabel: string;
  magicLinkUrl: string;
  formCutoffFormatted: string;
}

function buildMagicLinkEmail(params: MagicLinkParams): string {
  const {
    buyerEmail,
    buyerName,
    bookingRef,
    paxCount,
    tableLabel,
    magicLinkUrl,
    formCutoffFormatted,
  } = params;

  const seats = paxCount === 1 ? '1 seat' : `${paxCount} seats`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>49th SWA Annual Charity Dinner 2026 - Guest Registration</title>
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;color:#1f2937;font-family:'Montserrat',Arial,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f9fafb" style="background-color:#f9fafb;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <!--[if mso]>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480"><tr><td>
      <![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480" bgcolor="#ffffff" style="width:480px;max-width:100%;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">

        <tr>
          <td bgcolor="#450a5e" style="background-color:#450a5e;padding:24px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;font-size:22px;color:#ffffff;font-weight:700;font-family:'Montserrat',Arial,sans-serif;">SWA <span style="color:#f3d2ff;">Charity Dinner</span></h1>
            <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.7);font-family:'Montserrat',Arial,sans-serif;">49th Annual Charity Dinner 2026</p>
          </td>
        </tr>

        <tr>
          <td style="padding:24px;color:#1f2937;font-family:'Montserrat',Arial,sans-serif;">
            <p style="margin:0 0 16px;font-size:15px;color:#1f2937;">Dear ${buyerName},</p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">
              Thank you for your support of the 49th SWA Annual Charity Dinner 2026.
            </p>
            <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#6b7280;">
              You have reserved ${seats} at ${tableLabel} (Booking Reference: ${bookingRef}). To help us prepare for your arrival, please let us know the names of your guests using the link below.
            </p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
              <tr><td bgcolor="#874ba1" style="background-color:#874ba1;padding:14px 32px;border-radius:6px;text-align:center;">
                <a href="${magicLinkUrl}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;font-family:'Montserrat',Arial,sans-serif;">Register My Guests</a>
              </td></tr>
            </table>

            <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#9ca3af;text-align:center;">
              This link is unique to your booking and will remain active until ${formCutoffFormatted}.
            </p>

            <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#9ca3af;text-align:center;">
              If you have any questions, please contact SWA directly.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center;font-family:'Montserrat',Arial,sans-serif;">
            Singapore Women's Association<br>
            This is an automated message — please do not reply.
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

export async function sendMagicLink(env: Env, params: MagicLinkParams): Promise<void> {
  const html = buildMagicLinkEmail(params);

  const emailPayload = {
    from: 'SWA Portal <contactus@singaporewomenassociation.org>',
    to: [params.buyerEmail],
    subject: '49th SWA Annual Charity Dinner 2026 - Please register your guests',
    html,
  };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`[REG EMAIL] Resend API error: ${res.status} ${errorBody}`);
    }
  } catch (err) {
    console.error('[REG EMAIL] Failed to send magic link email:', err);
  }
}