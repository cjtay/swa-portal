import type { Context } from 'hono';
import type { Env } from '../types';
import { buildOtpEmail } from '../lib/email-otp';
import { signHmac } from '../lib/crypto';
import { handleApiError } from '../lib/error-handler';
import { OTP_TTL_SECONDS, IT_ADMIN_EMAILS } from '../../constants/portal';

function generateOtp(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const num = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  return String(num % 1000000).padStart(6, '0');
}

export async function handleSendOtp(c: Context<{ Bindings: Env }>) {
  const endpoint = 'send-otp';
  const env = c.env;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ success: false, message: 'Valid email address required.' }, 400);
  }

  const adminDomain = env.SWA_ADMIN_DOMAIN || 'singaporewomenassociation.org';
  const isAdmin = email.endsWith(`@${adminDomain}`);

  // Non-admin users must be in D1 members table with can_login = 1
  if (!isAdmin) {
    const member = await env.DB.prepare(
      'SELECT id FROM members WHERE email = ? AND can_login = 1'
    ).bind(email).first();

    if (!member) {
      return c.json(
        { success: false, error_code: 'NOT_REGISTERED', message: 'Not registered. Contact SWA admin for access.' },
        403,
      );
    }
  }

  const otp = generateOtp();
  const otpSignature = await signHmac(`${otp}:${email.toLowerCase()}`, env.OTP_SECRET);

  await env.SWA_SESSION.put(`swa:otp:${email}`, JSON.stringify({ otp, sig: otpSignature }), { expirationTtl: OTP_TTL_SECONDS });

  const emailHtml = buildOtpEmail(otp);

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SWA Portal <contactus@singaporewomenassociation.org>',
        to: email,
        subject: 'Your Login Code — SWA Admin Portal',
        html: emailHtml,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      throw new Error(`Resend returned ${resendRes.status}: ${errText}`);
    }

    return c.json({ success: true, message: 'OTP sent.' });
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not send OTP email. Please try again.', { error_type: 'RESEND_OTP', http_status: 502 });
  }
}