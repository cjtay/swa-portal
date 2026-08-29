import type { Context } from 'hono';
import type { AppContext } from '../types';
import { buildOtpEmail } from '../lib/email-otp';
import { signHmac } from '../lib/crypto';
import { handleApiError } from '../lib/error-handler';
import { isResendSuppressed } from '../lib/resend';
import { isDevBypassActive } from './session';
import { IT_ADMIN_EMAILS, OTP_TTL_SECONDS, OTP_RATE_LIMIT_WINDOW_SECONDS, OTP_RATE_LIMIT_MAX_REQUESTS } from '../../constants/portal';

function generateOtp(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const num = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  return String(num % 1000000).padStart(6, '0');
}

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const data = await res.json() as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<{ allowed: boolean; remaining: number }> {
  const key = `swa:rl:otp:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % OTP_RATE_LIMIT_WINDOW_SECONDS);

  const raw = await kv.get(key);
  let records: number[] = raw ? JSON.parse(raw) : [];
  records = records.filter((t) => t > windowStart);

  if (records.length >= OTP_RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }

  records.push(now);
  await kv.put(key, JSON.stringify(records), { expirationTtl: OTP_RATE_LIMIT_WINDOW_SECONDS + 60 });
  return { allowed: true, remaining: OTP_RATE_LIMIT_MAX_REQUESTS - records.length };
}

export async function handleSendOtp(c: AppContext) {
  const endpoint = 'send-otp';
  const env = c.env;

  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';

  const rlResult = await checkRateLimit(env.SWA_SESSION, ip);
  if (!rlResult.allowed) {
    return c.json(
      { success: false, error_code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      429,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  // Turnstile (skipped in local dev — see isDevBypassActive in session.ts).
  // Note: in dev, DEV_BYPASS_AUTH short-circuits login entirely, so this
  // endpoint is rarely reached locally. The guard keeps the layers consistent.
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

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ success: false, message: 'Valid email address required.' }, 400);
  }

  // IT admins are governed by the hardcoded IT_ADMIN_EMAILS list, not the
  // members table — they may hold no member row (e.g. system@). Everyone
  // else must hold a live, login-eligible member row.
  const isItAdmin = (IT_ADMIN_EMAILS as readonly string[]).includes(email);
  if (!isItAdmin) {
    const member = await env.DB.prepare(
      'SELECT id FROM members WHERE email = ? AND can_login = 1 AND deleted_at IS NULL'
    ).bind(email).first();

    if (!member) {
      return c.json({ success: true, message: 'If this email is registered, a code has been sent.' });
    }
  }

  const otp = generateOtp();
  const otpSignature = await signHmac(`${otp}:${email.toLowerCase()}`, env.OTP_SECRET);

  await env.SWA_SESSION.put(`swa:otp:${email}`, JSON.stringify({ sig: otpSignature }), { expirationTtl: OTP_TTL_SECONDS });

  const emailHtml = buildOtpEmail(otp);

  // Test runs never email — the OTP is already stored above, so the login
  // flow stays fully exercisable in the suite (see lib/resend.ts).
  if (isResendSuppressed(env)) {
    console.log(`[resend] suppressed (test run): OTP -> ${email}`);
    return c.json({ success: true, message: 'If this email is registered, a code has been sent.' });
  }

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

    return c.json({ success: true, message: 'If this email is registered, a code has been sent.' });
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not send OTP email. Please try again.', { error_type: 'RESEND_OTP', http_status: 502 });
  }
}