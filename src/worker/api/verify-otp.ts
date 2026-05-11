import type { Context } from 'hono';
import type { Env } from '../types';
import { signHmac, verifyHmac, base64urlEncode } from '../lib/crypto';
import { IT_ADMIN_EMAILS, SESSION_COOKIE_NAME, SESSION_DEFAULT_EXPIRY_MS, SESSION_EXTENDED_EXPIRY_MS } from '../../constants/portal';

export async function handleVerifyOtp(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const otp = typeof body.otp === 'string' ? body.otp.trim() : '';
  const remember = body.remember === true;

  if (!email || !otp) {
    return c.json({ success: false, message: 'Email and OTP code are required.' }, 400);
  }

  if (!/^\d{6}$/.test(otp)) {
    return c.json({ success: false, message: 'OTP must be a 6-digit code.' }, 400);
  }

  const stored = await env.SWA_SESSION.get(`swa:otp:${email}`);
  if (!stored) {
    return c.json({ success: false, error_code: 'OTP_EXPIRED', message: 'OTP has expired. Please request a new one.' }, 401);
  }

  let parsed: { otp: string; sig: string };
  try {
    parsed = JSON.parse(stored);
  } catch {
    return c.json({ success: false, message: 'Invalid OTP data. Please request a new one.' }, 401);
  }

  if (parsed.otp !== otp) {
    return c.json({ success: false, message: 'Incorrect OTP code.' }, 401);
  }

  const sigValid = await verifyHmac(`${otp}:${email.toLowerCase()}`, parsed.sig, env.OTP_SECRET);
  if (!sigValid) {
    return c.json({ success: false, message: 'OTP verification failed.' }, 401);
  }

  await env.SWA_SESSION.delete(`swa:otp:${email}`);

  // Determine role and get name from D1 members table or admin domain
  const adminDomain = env.SWA_ADMIN_DOMAIN || 'singaporewomenassociation.org';
  const isAdmin = email.endsWith(`@${adminDomain}`);
  const isItAdmin = (IT_ADMIN_EMAILS as readonly string[]).includes(email);

  let role: string;
  let name: string;

  if (isItAdmin) {
    role = 'admin';
  } else if (isAdmin) {
    role = 'admin';
  } else {
    role = 'committee';
  }

  // Look up name from members table
  const member = await env.DB.prepare(
    'SELECT name FROM members WHERE email = ? AND can_login = 1'
  ).bind(email).first();

  if (member && member.name) {
    name = member.name as string;
  } else {
    name = email.split('@')[0].replace(/[._-]/g, ' ');
  }

  const exp = remember
    ? Date.now() + SESSION_EXTENDED_EXPIRY_MS
    : Date.now() + SESSION_DEFAULT_EXPIRY_MS;
  const payload = base64urlEncode(JSON.stringify({ email, name, role, exp }));
  const signature = await signHmac(payload, env.OTP_SECRET);
  const cookieValue = `${payload}.${signature}`;

  const maxAge = remember
    ? Math.max(0, Math.floor(SESSION_EXTENDED_EXPIRY_MS / 1000))
    : Math.max(0, Math.floor(SESSION_DEFAULT_EXPIRY_MS / 1000));

  return c.json(
    { success: true, email, name, role },
    200,
    {
      'Set-Cookie': `${SESSION_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
    },
  );
}