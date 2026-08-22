// Per-request session revalidation against D1.
//
// Roles are baked into the HMAC session cookie at login (verify-otp.ts), but
// the members table is the source of truth. Without revalidation a demoted,
// locked-out (can_login=0) or soft-deleted member keeps their old privileges
// until the cookie expires — up to 30 days with "remember me".
// See docs/plans/security-remediation-plan.md (Phase 1).
//
// Cost: one indexed D1 read per authenticated request. Acceptable at this
// scale; a short-TTL KV cache is a documented future optimisation, not now.

import { IT_ADMIN_EMAILS } from '../../constants/portal';
import { resolveSessionRole } from './session-role';
import { signSessionCookie, type SessionPayload } from './session-cookie';

export type RevalidationResult =
  | { status: 'invalid' }
  | {
      status: 'valid';
      session: SessionPayload;
      /** Present when roles changed and the cookie was re-signed. */
      newCookie: { value: string; maxAgeSeconds: number } | null;
    };

interface MemberAuthRow {
  name: string | null;
  category: string | null;
  reg_role: string | null;
  can_login: number;
  deleted_at: string | null;
}

export async function revalidateSession(
  db: D1Database,
  sessionSecret: string,
  session: SessionPayload,
): Promise<RevalidationResult> {
  const email = session.email.toLowerCase();
  const isItAdmin = (IT_ADMIN_EMAILS as readonly string[]).includes(email);

  const member = await db
    .prepare('SELECT name, category, reg_role, can_login, deleted_at FROM members WHERE email = ?')
    .bind(email)
    .first<MemberAuthRow>();

  // IT admins are governed by the hardcoded IT_ADMIN_EMAILS list rather than
  // the members table — they may legitimately have no row. Everyone else must
  // hold a live, login-eligible member row *now*, not just at login time.
  if (!isItAdmin && (!member || member.can_login !== 1 || member.deleted_at !== null)) {
    return { status: 'invalid' };
  }

  const fresh = resolveSessionRole(email, member);
  // Keep the cookie's name when no member row exists (IT-admin-only case):
  // resolveSessionRole falls back to deriving a name from the email local
  // part, which would clobber the display name chosen at login.
  const name = member ? fresh.name : session.name;
  const refreshed: SessionPayload = {
    email: session.email,
    name,
    role: fresh.role,
    regRole: fresh.regRole,
    exp: session.exp,
  };

  const unchanged =
    refreshed.role === session.role &&
    refreshed.regRole === session.regRole &&
    refreshed.name === session.name;
  if (unchanged) {
    return { status: 'valid', session: refreshed, newCookie: null };
  }

  // Re-sign with fresh roles, preserving the original expiry so revalidation
  // can never extend a session.
  const value = await signSessionCookie(refreshed, sessionSecret);
  const maxAgeSeconds = Math.max(0, Math.floor((session.exp - Date.now()) / 1000));
  return { status: 'valid', session: refreshed, newCookie: { value, maxAgeSeconds } };
}
