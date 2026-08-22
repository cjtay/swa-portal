// Phase 1 (CRITICAL) — stale-session privilege escalation.
//
// Roles are baked into the HMAC session cookie at login; the middleware must
// re-check the members table on every authenticated request so demotions,
// can_login lock-outs and soft-deletes take effect immediately instead of
// after up to 30 days of cookie lifetime.
// See docs/plans/security-remediation-plan.md and
// docs/plans/stale-session-privilege-escalation-plan.md.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signHmac, base64urlEncode, base64urlDecode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME } from '../../../constants/portal';
import { applyMigrations, seedMember } from '../../../../test/db-helpers';

const IT_ADMIN_NO_ROW = 'system@singaporewomenassociation.org';

beforeAll(async () => {
  await applyMigrations(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM namecards').run();
  await env.DB.prepare("DELETE FROM members WHERE email LIKE 'reval-test-%'").run();
  // The IT-admin test relies on this email having NO members row.
  await env.DB.prepare('DELETE FROM members WHERE email = ?').bind(IT_ADMIN_NO_ROW).run();
});

/** Mint a signed session cookie exactly like verify-otp does. */
async function mintCookie(
  email: string,
  role: string,
  opts: { name?: string; regRole?: string | null; exp?: number } = {},
): Promise<{ header: string; exp: number }> {
  const exp = opts.exp ?? Date.now() + 60 * 60 * 1000;
  const payload = base64urlEncode(
    JSON.stringify({ email, name: opts.name ?? 'Reval Tester', role, regRole: opts.regRole ?? null, exp }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return { header: `${SESSION_COOKIE_NAME}=${payload}.${signature}`, exp };
}

/** Decode the payload of a swa_session cookie value (no signature check). */
function decodeCookie(setCookieHeader: string): { role: string; regRole: string | null; exp: number; name: string } {
  const value = setCookieHeader.split(';')[0].replace(`${SESSION_COOKIE_NAME}=`, '');
  const payload = value.substring(0, value.lastIndexOf('.'));
  return JSON.parse(base64urlDecode(payload));
}

function setCookieOf(res: Response): string | null {
  return res.headers.get('set-cookie');
}

describe('session revalidation — role downgrade', () => {
  it('a demoted admin acts as committee immediately and gets a re-signed cookie', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Reval Admin',
      email: 'reval-test-admin@example.com',
      category: 'admin',
    });
    const { header } = await mintCookie('reval-test-admin@example.com', 'admin', { name: 'Reval Admin' });

    // Baseline: the admin cookie can write.
    const before = await SELF.fetch(`https://example.com/api/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: header },
      body: JSON.stringify({ job_title: 'Before demotion' }),
    });
    expect(before.status).toBe(200);

    // Demote mid-session.
    await env.DB.prepare("UPDATE members SET category = 'committee' WHERE id = ?").bind(memberId).run();

    // Same cookie now gets 403 on admin writes — the downgrade is live.
    const after = await SELF.fetch(`https://example.com/api/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: header },
      body: JSON.stringify({ job_title: 'After demotion' }),
    });
    expect(after.status).toBe(403);

    // Reads still work, and the response re-signs the cookie with the fresh
    // committee role while preserving the original expiry.
    const read = await SELF.fetch('https://example.com/api/members', {
      headers: { Cookie: header },
    });
    expect(read.status).toBe(200);
    const setCookie = setCookieOf(read);
    expect(setCookie).not.toBeNull();
    const decoded = decodeCookie(setCookie!);
    expect(decoded.role).toBe('committee');
    const original = decodeCookie(header);
    expect(decoded.exp).toBe(original.exp);
  });

  it('/api/session reflects the downgraded role and re-signs the cookie', async () => {
    await seedMember(env.DB, {
      name: 'Reval Committee',
      email: 'reval-test-committee@example.com',
      category: 'committee',
    });
    // Cookie claims admin, but the member row says committee.
    const { header } = await mintCookie('reval-test-committee@example.com', 'admin', { name: 'Reval Committee' });

    const res = await SELF.fetch('https://example.com/api/session', { headers: { Cookie: header } });
    expect(res.status).toBe(200);
    const body = await res.json<{ authenticated: boolean; role: string; is_admin: boolean }>();
    expect(body.authenticated).toBe(true);
    expect(body.role).toBe('committee');
    expect(body.is_admin).toBe(false);
    expect(setCookieOf(res)).not.toBeNull();
  });
});

describe('session revalidation — revocation', () => {
  it('soft-deleted member mid-session → 401 and cookie cleared', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Reval Deleted',
      email: 'reval-test-deleted@example.com',
      category: 'committee',
    });
    const { header } = await mintCookie('reval-test-deleted@example.com', 'committee', { name: 'Reval Deleted' });

    const before = await SELF.fetch('https://example.com/api/members', { headers: { Cookie: header } });
    expect(before.status).toBe(200);

    await env.DB.prepare("UPDATE members SET deleted_at = datetime('now') WHERE id = ?").bind(memberId).run();

    const after = await SELF.fetch('https://example.com/api/members', { headers: { Cookie: header } });
    expect(after.status).toBe(401);
    const setCookie = setCookieOf(after);
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('can_login=0 mid-session → 401 and cookie cleared', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Reval Locked',
      email: 'reval-test-locked@example.com',
      category: 'committee',
    });
    const { header } = await mintCookie('reval-test-locked@example.com', 'committee', { name: 'Reval Locked' });

    await env.DB.prepare('UPDATE members SET can_login = 0 WHERE id = ?').bind(memberId).run();

    const res = await SELF.fetch('https://example.com/api/members', { headers: { Cookie: header } });
    expect(res.status).toBe(401);
    expect(setCookieOf(res)).toContain('Max-Age=0');
  });

  it('cookie for an email with no member row (non-IT-admin) → 401', async () => {
    const { header } = await mintCookie('reval-test-ghost@example.com', 'admin');
    const res = await SELF.fetch('https://example.com/api/members', { headers: { Cookie: header } });
    expect(res.status).toBe(401);
  });
});

describe('session revalidation — IT admins', () => {
  it('IT admin with no member row stays valid (governed by IT_ADMIN_EMAILS)', async () => {
    const { header } = await mintCookie(IT_ADMIN_NO_ROW, 'admin', { name: 'System Admin' });
    const res = await SELF.fetch('https://example.com/api/members', { headers: { Cookie: header } });
    expect(res.status).toBe(200);
    // No role change → no re-signed cookie needed.
    expect(setCookieOf(res)).toBeNull();
  });
});
