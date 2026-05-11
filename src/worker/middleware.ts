import type { Context, Next } from 'hono';
import type { Env } from './types';
import { getSession } from './api/session';
import { IT_ADMIN_EMAILS } from '../constants/portal';

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/session',
  '/api/send-otp',
  '/api/verify-otp',
]);

const ADMIN_ONLY_API = new Set([
  '/api/members',
  '/api/bookings/approve',
  '/api/sync-website',
]);

const IT_ADMIN_ONLY_API = new Set([
  '/api/sync-website',
]);

function getBasePath(path: string): string {
  const parts = path.split('/');
  return '/' + parts.slice(1, 3).join('/');
}

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const path = c.req.path;
  const basePath = getBasePath(path);

  if (!path.startsWith('/api/')) {
    return next();
  }

  if (PUBLIC_PATHS.has(path) || PUBLIC_PATHS.has(basePath)) {
    return next();
  }

  const session = await getSession(c);
  if (!session) {
    return c.json({ success: false, error_code: 'UNAUTHORIZED', message: 'Login required.' }, 401);
  }

  c.set('sessionEmail', session.email);
  c.set('sessionName', session.name);
  c.set('sessionRole', session.role);

  if (ADMIN_ONLY_API.has(path) || ADMIN_ONLY_API.has(basePath)) {
    const adminDomain = c.env.SWA_ADMIN_DOMAIN || 'singaporewomenassociation.org';
    if (!session.email.endsWith(`@${adminDomain}`)) {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin access required.' }, 403);
    }
  }

  if (IT_ADMIN_ONLY_API.has(path) || IT_ADMIN_ONLY_API.has(basePath)) {
    if (!(IT_ADMIN_EMAILS as readonly string[]).includes(session.email)) {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'IT Admin access required.' }, 403);
    }
  }

  return next();
}