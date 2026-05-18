import type { Context, Next } from 'hono';
import type { Env } from './types';
import { getSession } from './api/session';
import { IT_ADMIN_EMAILS } from '../constants/portal';
import { checkApiRateLimit, getEndpointKey } from './lib/rate-limit';

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/session',
  '/api/send-otp',
  '/api/verify-otp',
  '/api/turnstile-config',
]);

const IT_ADMIN_ONLY_API = new Set([
  '/api/sync-website',
]);

const ADMIN_WRITE_API = new Set([
  '/api/members',
]);

const REG_BUYER_API = new Set([
  '/api/reg/buyer',
]);

const REG_VOLUNTEER_API = new Set([
  '/api/reg/volunteer',
]);

const REG_ADMIN_API = new Set([
  '/api/reg/admin',
]);

function getBasePath(path: string): string {
  const parts = path.split('/');
  return '/' + parts.slice(1, 3).join('/');
}

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const path = c.req.path;
  const basePath = getBasePath(path);
  const method = c.req.method;

  // 1. Non-API routes bypass auth middleware
  if (!path.startsWith('/api/')) {
    return next();
  }

  // 2. Public paths bypass auth
  if (PUBLIC_PATHS.has(path) || PUBLIC_PATHS.has(basePath)) {
    return next();
  }

  // 3. Registration buyer routes — bypass session auth, token validation in handler
  if (REG_BUYER_API.has(basePath)) {
    return next();
  }

  // 4. Require authentication for all remaining API routes
  const session = await getSession(c);
  if (!session) {
    return c.json({ success: false, error_code: 'UNAUTHORIZED', message: 'Login required.' }, 401);
  }

  // Attach session vars to context for downstream handlers
  c.set('sessionEmail', session.email);
  c.set('sessionName', session.name);
  c.set('sessionRole', session.role);
  c.set('sessionRegRole', session.regRole ?? null);

  // 4. IT Admin only — all methods
  if (IT_ADMIN_ONLY_API.has(path) || IT_ADMIN_ONLY_API.has(basePath)) {
    if (!(IT_ADMIN_EMAILS as readonly string[]).includes(session.email)) {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'IT Admin access required.' }, 403);
    }
  }

  // 5. Admin-write API — write methods require admin role, reads allow any authenticated user
  if (ADMIN_WRITE_API.has(path) || ADMIN_WRITE_API.has(basePath)) {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && session.role !== 'admin') {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin access required.' }, 403);
    }
  }

  // 6. Registration volunteer routes — require reg_volunteer, reg_admin, or admin
  if (REG_VOLUNTEER_API.has(basePath)) {
    const regRole = session.regRole ?? null;
    if (session.role !== 'admin' && regRole !== 'reg_admin' && regRole !== 'reg_volunteer') {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Registration volunteer access required.' }, 403);
    }
  }

  // 7. Registration admin routes — require reg_admin or admin
  if (REG_ADMIN_API.has(basePath)) {
    const regRole = session.regRole ?? null;
    if (session.role !== 'admin' && regRole !== 'reg_admin') {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Registration admin access required.' }, 403);
    }
  }

  // 8. General-purpose rate limiting for authenticated write endpoints
  const endpointKey = getEndpointKey(path, method);
  if (endpointKey) {
    const rlResult = await checkApiRateLimit(c.env.SWA_SESSION, endpointKey, session.email);
    if (!rlResult.allowed) {
      return c.json(
        { success: false, error_code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
        429,
      );
    }
  }

  return next();
}
