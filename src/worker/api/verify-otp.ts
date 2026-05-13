import type { Context } from 'hono';
import type { Env } from '../types';
import { signHmac, timingSafeEqual, base64urlEncode } from '../lib/crypto';
import { IT_ADMIN_EMAILS, SESSION_COOKIE_NAME, SESSION_DEFAULT_EXPIRY_MS, SESSION_EXTENDED_EXPIRY_MS, OTP_TTL_SECONDS, VERIFY_RATE_LIMIT_WINDOW_SECONDS, VERIFY_RATE_LIMIT_MAX_ATTEMPTS_IP, VERIFY_RATE_LIMIT_MAX_ATTEMPTS_EMAIL, VERIFY_MAX_FAILURES_PER_OTP } from '../../constants/portal';

async function checkVerifyRateLimit(kv: KVNamespace, ip: string, email: string): Promise<{ allowed: boolean; message?: string }> {
  const ipKey = `swa:rl:verify:ip:${ip}`;
  const ipRaw = await kv.get(ipKey);
  const ipAttempts = ipRaw ? parseInt(ipRaw, 10) : 0;
  if (ipAttempts >= VERIFY_RATE_LIMIT_MAX_ATTEMPTS_IP) {
    return { allowed: false, message: 'Too many attempts. Please try again later.' };
  }

  const emailKey = `swa:rl:verify:email:${email}`;
  const emailRaw = await kv.get(emailKey);
  const emailAttempts = emailRaw ? parseInt(emailRaw, 10) : 0;
  if (emailAttempts >= VERIFY_RATE_LIMIT_MAX_ATTEMPTS_EMAIL) {
    return { allowed: false, message: 'Too many attempts. Please request a new code.' };
  }

  return { allowed: true };
}

async function incrementVerifyAttempts(kv: KVNamespace, ip: string, email: string): Promise<void> {
  const ipKey = `swa:rl:verify:ip:${ip}`;
  const ipRaw = await kv.get(ipKey);
  const ipAttempts = ipRaw ? parseInt(ipRaw, 10) + 1 : 1;
  await kv.put(ipKey, String(ipAttempts), { expirationTtl: VERIFY_RATE_LIMIT_WINDOW_SECONDS });

  const emailKey = `swa:rl:verify:email:${email}`;
  const emailRaw = await kv.get(emailKey);
  const emailAttempts = emailRaw ? parseInt(emailRaw, 10) + 1 : 1;
  await kv.put(emailKey, String(emailAttempts), { expirationTtl: OTP_TTL_SECONDS + 60 });
}

export async function handleVerifyOtp(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';

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

  const rlResult = await checkVerifyRateLimit(env.SWA_SESSION, ip, email);
  if (!rlResult.allowed) {
    return c.json({ success: false, error_code: 'RATE_LIMITED', message: rlResult.message }, 429);
  }

  const stored = await env.SWA_SESSION.get(`swa:otp:${email}`);
  if (!stored) {
    return c.json({ success: false, error_code: 'INVALID_OR_EXPIRED', message: 'Invalid or expired code. Please request a new one.' }, 401);
  }

  let parsed: { sig: string };
  try {
    parsed = JSON.parse(stored);
  } catch {
    return c.json({ success: false, error_code: 'INVALID_OR_EXPIRED', message: 'Invalid or expired code. Please request a new one.' }, 401);
  }

  const candidateSig = await signHmac(`${otp}:${email.toLowerCase()}`, env.OTP_SECRET);
  if (!timingSafeEqual(candidateSig, parsed.sig)) {
    await incrementVerifyAttempts(env.SWA_SESSION, ip, email);

    const failKey = `swa:rl:verify:fail:${email}`;
    const failRaw = await env.SWA_SESSION.get(failKey);
    const failures = failRaw ? parseInt(failRaw, 10) + 1 : 1;
    if (failures >= VERIFY_MAX_FAILURES_PER_OTP) {
      await env.SWA_SESSION.delete(`swa:otp:${email}`);
      await env.SWA_SESSION.delete(failKey);
      return c.json({ success: false, error_code: 'TOO_MANY_ATTEMPTS', message: 'Too many incorrect attempts. Please request a new code.' }, 429);
    }
    await env.SWA_SESSION.put(failKey, String(failures), { expirationTtl: OTP_TTL_SECONDS + 60 });

    return c.json({ success: false, error_code: 'INVALID_OR_EXPIRED', message: 'Invalid or expired code. Please request a new one.' }, 401);
  }

  await env.SWA_SESSION.delete(`swa:otp:${email}`);
  await env.SWA_SESSION.delete(`swa:rl:verify:email:${email}`);
  await env.SWA_SESSION.delete(`swa:rl:verify:fail:${email}`);

  const isItAdmin = (IT_ADMIN_EMAILS as readonly string[]).includes(email);

  const member = await env.DB.prepare(
    'SELECT name, category FROM members WHERE email = ? AND can_login = 1'
  ).bind(email).first();

  const name = (member && member.name) ? member.name as string : email.split('@')[0].replace(/[._-]/g, ' ');

  let role: string;
  if (isItAdmin) {
    role = 'admin';
  } else if (member && member.category === 'admin') {
    role = 'admin';
  } else {
    role = 'committee';
  }

  const exp = remember
    ? Date.now() + SESSION_EXTENDED_EXPIRY_MS
    : Date.now() + SESSION_DEFAULT_EXPIRY_MS;
  const payload = base64urlEncode(JSON.stringify({ email, name, role, exp }));
  const signature = await signHmac(payload, env.SESSION_SECRET);
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