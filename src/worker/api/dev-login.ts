import type { Context } from 'hono';
import type { Env } from '../types';
import { signHmac, base64urlEncode } from '../lib/crypto';
import { resolveSessionRole } from '../lib/session-role';
import { isDevBypassActive } from './session';
import {
  SESSION_COOKIE_NAME,
  SESSION_DEFAULT_EXPIRY_MS,
  DEV_LOGOUT_COOKIE_NAME,
} from '../../constants/portal';

// Dev-only role-picker login. Both handlers are inert in production:
// isDevBypassActive requires DEV_BYPASS_AUTH==='true' (only ever in .dev.vars),
// a `local-dev-` SESSION_SECRET prefix (prod's real secret never matches), and
// a localhost / *.workers.dev / SWA_ADMIN_DOMAIN host. The endpoints return
// 404 otherwise, and the login page's dev panel stays hidden (it gates on a
// successful /api/dev/members response).

function devGuard(c: Context<{ Bindings: Env }>): boolean {
  return isDevBypassActive(c.env, c.req.url);
}

// GET /api/dev/members — lists login-capable members with their resolved
// session role so the login page can render a one-click picker.
export async function handleDevMembers(c: Context<{ Bindings: Env }>) {
  if (!devGuard(c)) {
    return c.json({ success: false, error_code: 'NOT_FOUND' }, 404);
  }

  const result = await c.env.DB.prepare(
    'SELECT id, name, email, category, reg_role FROM members WHERE can_login = 1 AND deleted_at IS NULL ORDER BY category, name'
  ).all();

  const members = (result.results || []).map((m) => {
    const { role, isItAdmin } = resolveSessionRole(String(m.email), m);
    return {
      id: m.id,
      name: m.name,
      email: m.email,
      category: m.category,
      reg_role: m.reg_role,
      role,
      is_it_admin: isItAdmin,
    };
  });

  return c.json({ success: true, members });
}

// POST /api/dev/login { email } — signs a real `swa_session` cookie for the
// chosen member (same shape/secret/TTL as verify-otp) and clears the
// dev-logout marker so the bypass fallback doesn't immediately overwrite the
// picked identity. Skips OTP, Turnstile, and rate limiting entirely.
export async function handleDevLogin(c: Context<{ Bindings: Env }>) {
  if (!devGuard(c)) {
    return c.json({ success: false, error_code: 'NOT_FOUND' }, 404);
  }

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

  const member = await c.env.DB.prepare(
    'SELECT name, category, reg_role FROM members WHERE email = ? AND can_login = 1 AND deleted_at IS NULL'
  ).bind(email).first();

  if (!member) {
    return c.json({ success: false, message: 'Member not found or login is disabled.' }, 404);
  }

  const { name, role, regRole } = resolveSessionRole(email, member);

  const exp = Date.now() + SESSION_DEFAULT_EXPIRY_MS;
  const payload = base64urlEncode(JSON.stringify({ email, name, role, regRole, exp }));
  const signature = await signHmac(payload, c.env.SESSION_SECRET);
  const cookieValue = `${payload}.${signature}`;
  const maxAge = Math.max(0, Math.floor(SESSION_DEFAULT_EXPIRY_MS / 1000));

  // Two Set-Cookie headers: the real session cookie, plus clearing the
  // dev-logout marker so the bypass fallback doesn't fire on the next
  // request and clobber the chosen identity. Hono's append option lets us
  // emit both in a single response.
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
    { append: true },
  );
  c.header(
    'Set-Cookie',
    `${DEV_LOGOUT_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    { append: true },
  );

  return c.json({ success: true, email, name, role, regRole });
}
