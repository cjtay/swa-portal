import type { Context } from 'hono';
import type { Env } from '../types';
import { IT_ADMIN_EMAILS, SESSION_COOKIE_NAME } from '../../constants/portal';
import { verifyHmac, base64urlDecode } from '../lib/crypto';

interface SessionData {
  email: string;
  name: string;
  role: string;
  regRole: string | null;
  exp: number;
}

// --- Dev-only auth bypass -------------------------------------------------
// See `DEV_BYPASS_AUTH` in `Env`. This block lets `npm run dev:worker` skip
// OTP login by impersonating a fake IT-admin session. It is dead code in any
// environment where `DEV_BYPASS_AUTH !== 'true'` (production never sets it).

// Hosts on which the dev bypass may run. Anything else (tunnels, unknown
// domains) is treated as a misconfiguration and aborted with a 500.
// `SWA_ADMIN_DOMAIN` and *.workers.dev are included because `wrangler dev`
// resolves `c.req.url` against the configured `routes` domain rather than the
// localhost origin the browser actually used.
export const DEV_BYPASS_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function isDevBypassHost(host: string, adminDomain?: string): boolean {
  if (DEV_BYPASS_HOSTS.includes(host)) return true;
  if (adminDomain && host === adminDomain) return true;
  if (host.endsWith('.workers.dev')) return true;
  return false;
}

export type DevBypassResult =
  | { kind: 'abort' }
  | { kind: 'session'; data: SessionData }
  | null;

export function getDevBypassSession(c: Context<{ Bindings: Env }>): DevBypassResult {
  if (c.env.DEV_BYPASS_AUTH !== 'true') return null;

  // Second trust anchor: prod's real SESSION_SECRET is a high-entropy value
  // set via `wrangler secret put`; it will never start with this prefix.
  // Belt-and-suspenders against an accidental DEV_BYPASS_AUTH leak — even if
  // the flag somehow ended up in prod vars or secrets, the real SESSION_SECRET
  // won't match and the bypass stays inert.
  if (!c.env.SESSION_SECRET || !c.env.SESSION_SECRET.startsWith('local-dev-')) {
    console.error(
      '[DEV_BYPASS] DEV_BYPASS_AUTH is set but SESSION_SECRET does not start with "local-dev-". Refusing to bypass.',
    );
    return { kind: 'abort' };
  }

  let host = '';
  try {
    host = new URL(c.req.url).hostname;
  } catch {
    host = '';
  }
  if (!isDevBypassHost(host, c.env.SWA_ADMIN_DOMAIN)) {
    console.error(
      `[DEV_BYPASS] DEV_BYPASS_AUTH is enabled on non-localhost host "${host}". Refusing to serve.`,
    );
    return { kind: 'abort' };
  }

  return {
    kind: 'session',
    data: {
      // Impersonate the first IT-admin email so is_it_admin is true.
      email: IT_ADMIN_EMAILS[0],
      name: 'Dev Admin',
      role: 'admin',
      regRole: null,
      exp: Date.now() + 24 * 60 * 60 * 1000,
    },
  };
}
// --------------------------------------------------------------------------

export async function getSession(c: Context<{ Bindings: Env }>): Promise<SessionData | null> {
  const cookieHeader = c.req.header('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  const cookieValue = match[1];
  const dotIndex = cookieValue.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const payload = cookieValue.substring(0, dotIndex);
  const signature = cookieValue.substring(dotIndex + 1);

  const valid = await verifyHmac(payload, signature, c.env.SESSION_SECRET);
  if (!valid) return null;

  try {
    const json = base64urlDecode(payload);
    const parsed = JSON.parse(json);

    if (parsed.exp && parsed.exp < Date.now()) return null;

    const data: SessionData = {
      email: parsed.email,
      name: parsed.name,
      role: parsed.role,
      regRole: parsed.regRole ?? null,
      exp: parsed.exp,
    };

    return data;
  } catch {
    return null;
  }
}

export async function handleSession(c: Context<{ Bindings: Env }>) {
  // Dev-only bypass: short-circuit before touching the real cookie/HMAC path.
  const dev = getDevBypassSession(c);
  if (dev?.kind === 'abort') {
    return c.json(
      { success: false, error_code: 'DEV_BYPASS_MISCONFIG', message: 'DEV_BYPASS_AUTH set on non-localhost host.' },
      500,
    );
  }
  if (dev?.kind === 'session') {
    const s = dev.data;
    return c.json({
      authenticated: true,
      email: s.email,
      name: s.name,
      role: s.role,
      regRole: s.regRole,
      is_admin: true,
      is_it_admin: (IT_ADMIN_EMAILS as readonly string[]).includes(s.email),
    });
  }

  const session = await getSession(c);

  if (!session) {
    return c.json({ authenticated: false, email: null, name: null, role: null, regRole: null, is_admin: false, is_it_admin: false });
  }

  return c.json({
    authenticated: true,
    email: session.email,
    name: session.name,
    role: session.role,
    regRole: session.regRole,
    is_admin: session.role === 'admin',
    is_it_admin: (IT_ADMIN_EMAILS as readonly string[]).includes(session.email),
  });
}

export async function handleLogout(c: Context<{ Bindings: Env }>) {
  return c.json({ success: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  });
}