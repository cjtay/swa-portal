import type { Next } from 'hono';
import type { AppContext } from './types';
import { getSession, getDevBypassSession } from './api/session';
import { IT_ADMIN_EMAILS, isPurchaseApprover, isFinanceApprover } from '../constants/portal';
import { checkApiRateLimit, getEndpointKey } from './lib/rate-limit';
import { revalidateSession } from './lib/session-revalidation';
import { sessionCookieHeader, clearedSessionCookieHeader } from './lib/session-cookie';

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/session',
  '/api/send-otp',
  '/api/verify-otp',
  '/api/turnstile-config',
  // Dev-only role-picker login. Reachable when logged out (so the user can
  // pick an identity from /login). Both handlers self-guard via
  // isDevBypassActive and 404 in production.
  '/api/dev/login',
  '/api/dev/members',
]);

// Full paths only. A basePath entry would lock every route under that
// prefix (e.g. '/api/approvals' would lock the whole approvals API).
const IT_ADMIN_ONLY_API = new Set([
  '/api/admin/settings',
  // Audit CSV — owner decision 24-08-2026: IT-admin eyes only.
  '/api/approvals/audit/export',
]);

const ADMIN_WRITE_API = new Set([
  '/api/members',
  // Namecard writes (POST/PATCH/DELETE) are admin-only. GET stays open to
  // every authenticated role so committee/volunteer/advisor can use the
  // self-service download panel (docs/specs/features/namecards.md §5.5, §17.5).
  '/api/namecards',
]);

const REG_BUYER_API = new Set([
  '/api/reg/buyer',
]);

const VOLUNTEER_API = new Set([
  '/api/volunteer',
]);

const MEMBERSHIP_API = new Set([
  '/api/membership',
]);

const LAUGHTER_YOGA_API = new Set([
  '/api/laughter-yoga',
]);

const REG_VOLUNTEER_API = new Set([
  '/api/reg/volunteer',
]);

const REG_ADMIN_API = new Set([
  '/api/reg/admin',
]);

const ONLINE_FORMS_API = new Set([
  '/api/admin/forms',
]);

// Approval workflow — entry requires admin, purchase approver, or finance
// approver for ALL methods (plan §8). Each handler then enforces its finer
// rule (e.g. finance approve/reject re-checks isFinanceApprover). Ordinary
// committee members see nothing: this is financial data.
const APPROVALS_API = new Set([
  '/api/approvals',
]);

function getBasePath(path: string): string {
  const parts = path.split('/');
  return '/' + parts.slice(1, 3).join('/');
}

function pathStartsWithAny(path: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(prefix + '/')) return true;
  }
  return false;
}

export async function authMiddleware(c: AppContext, next: Next) {
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
  if (pathStartsWithAny(path, REG_BUYER_API)) {
    return next();
  }

  // 3b. Volunteer registration routes — public, Turnstile-verified in handler
  if (pathStartsWithAny(path, VOLUNTEER_API)) {
    return next();
  }

  // 3d. Membership application routes — public, Turnstile-verified in handler
  if (pathStartsWithAny(path, MEMBERSHIP_API)) {
    return next();
  }

  // 3e. Laughter Yoga registration routes — public, Turnstile-verified in handler
  if (pathStartsWithAny(path, LAUGHTER_YOGA_API)) {
    return next();
  }

  // 4. Require authentication for all remaining API routes.
  // Real cookie wins over the dev-bypass injection — this lets
  // /api/dev/login switch identities even while the bypass flag is on.
  let session = await getSession(c);

  if (session) {
    // 4b. Revalidate the session against D1 on every request. The cookie was
    // minted at login; demotions, can_login lock-outs and soft-deletes since
    // then must take effect immediately (security-remediation-plan.md Phase 1).
    const revalidated = await revalidateSession(c.env.DB, c.env.SESSION_SECRET, session);
    if (revalidated.status === 'invalid') {
      c.header('Set-Cookie', clearedSessionCookieHeader(), { append: true });
      return c.json(
        { success: false, error_code: 'UNAUTHORIZED', message: 'Session no longer valid. Please log in again.' },
        401,
      );
    }
    session = revalidated.session;
    if (revalidated.newCookie) {
      c.header(
        'Set-Cookie',
        sessionCookieHeader(revalidated.newCookie.value, revalidated.newCookie.maxAgeSeconds),
        { append: true },
      );
    }
    c.set('sessionEmail', session.email);
    c.set('sessionName', session.name);
    c.set('sessionRole', session.role);
    c.set('sessionRegRole', session.regRole ?? null);
  } else {
    // 4a. Dev-only auth bypass fallback. When DEV_BYPASS_AUTH==='true' (set in
    // .dev.vars for `npm run dev:worker` only) and no real session cookie is
    // present and no explicit dev-logout marker is set, inject a fake
    // IT-admin session. Production never sets the flag, so this block is
    // unreachable there. Rate limiter intentionally skipped in dev-bypass
    // mode: local testing often needs bulk writes, and the bypass is
    // unreachable in prod (flag is .dev.vars-only, host must be localhost,
    // SESSION_SECRET must start with "local-dev-").
    const dev = getDevBypassSession(c);
    if (dev?.kind === 'abort') {
      return c.json(
        { success: false, error_code: 'DEV_BYPASS_MISCONFIG', message: 'DEV_BYPASS_AUTH set on non-localhost host.' },
        500,
      );
    }
    if (dev?.kind === 'session') {
      c.set('sessionEmail', dev.data.email);
      c.set('sessionName', dev.data.name);
      c.set('sessionRole', dev.data.role);
      c.set('sessionRegRole', dev.data.regRole);
      return next();
    }

    return c.json({ success: false, error_code: 'UNAUTHORIZED', message: 'Login required.' }, 401);
  }

  // 5. IT Admin only — all methods
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
  if (pathStartsWithAny(path, REG_VOLUNTEER_API)) {
    const regRole = session.regRole ?? null;
    if (session.role !== 'admin' && session.role !== 'committee' && regRole !== 'reg_admin' && regRole !== 'reg_volunteer') {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Registration volunteer access required.' }, 403);
    }
  }

  // 7. Registration admin routes — require reg_admin or admin
  if (pathStartsWithAny(path, REG_ADMIN_API)) {
    const regRole = session.regRole ?? null;
    if (session.role !== 'admin' && regRole !== 'reg_admin') {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Registration admin access required.' }, 403);
    }
  }

  // 7b. Online Forms admin routes — require admin or committee
  if (pathStartsWithAny(path, ONLINE_FORMS_API)) {
    if (session.role !== 'admin' && session.role !== 'committee') {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Admin or committee access required.' }, 403);
    }
  }

  // 7c. Approval workflow routes — entry requires admin, purchase approver,
  // or finance approver (all methods). Handlers enforce the finer rules.
  if (pathStartsWithAny(path, APPROVALS_API)) {
    if (session.role !== 'admin' && !isPurchaseApprover(session.email) && !isFinanceApprover(session.email)) {
      return c.json({ success: false, error_code: 'FORBIDDEN', message: 'Approval workflow access required.' }, 403);
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
