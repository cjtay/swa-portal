import type { Context } from 'hono';
import type { Env } from '../types';
import { IT_ADMIN_EMAILS, SESSION_COOKIE_NAME } from '../../constants/portal';
import { verifyHmac, base64urlDecode } from '../lib/crypto';

interface SessionData {
  email: string;
  name: string;
  role: string;
  exp: number;
}

export async function getSession(c: Context<{ Bindings: Env }>): Promise<SessionData | null> {
  const cookieHeader = c.req.header('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  const cookieValue = match[1];
  const dotIndex = cookieValue.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const payload = cookieValue.substring(0, dotIndex);
  const signature = cookieValue.substring(dotIndex + 1);

  const valid = await verifyHmac(payload, signature, c.env.OTP_SECRET);
  if (!valid) return null;

  try {
    const json = base64urlDecode(payload);
    const data: SessionData = JSON.parse(json);

    if (data.exp && data.exp < Date.now()) return null;

    return data;
  } catch {
    return null;
  }
}

export async function handleSession(c: Context<{ Bindings: Env }>) {
  const session = await getSession(c);

  if (!session) {
    return c.json({ authenticated: false, email: null, name: null, role: null, is_admin: false, is_it_admin: false });
  }

  return c.json({
    authenticated: true,
    email: session.email,
    name: session.name,
    role: session.role,
    is_admin: session.role === 'admin',
    is_it_admin: (IT_ADMIN_EMAILS as readonly string[]).includes(session.email),
  });
}

export async function handleLogout(c: Context<{ Bindings: Env }>) {
  return c.json({ success: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  });
}