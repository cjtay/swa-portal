// Phase 4 — atomic member soft-delete → namecard darks.
//
// Verifies the §9.4 refactor: DELETE /api/members/:id runs a D1 batch that
// flips BOTH members.deleted_at AND namecards.has_namecard in the same
// transaction, so the public /c/:slug surface goes 404 the instant the
// member is deleted.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signHmac, base64urlEncode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME } from '../../../constants/portal';
import { applyMigrations, seedMember, seedNamecard } from '../../../../test/db-helpers';

beforeAll(async () => {
  await applyMigrations(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM namecards').run();
  await env.DB.prepare("DELETE FROM members WHERE email LIKE 'soft-delete-test-%'").run();
});

async function adminCookie(): Promise<string> {
  const payload = base64urlEncode(
    JSON.stringify({
      email: 'soft-delete-test-admin@example.com',
      name: 'Admin',
      role: 'admin',
      regRole: null,
      exp: Date.now() + 60 * 60 * 1000,
    }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}`;
}

describe('DELETE /api/members/:id — atomic namecard dark', () => {
  it("darks the deleted member's namecard in the same transaction", async () => {
    // Seed a member with a visible namecard.
    const memberId = await seedMember(env.DB, {
      name: 'Soft Delete Target',
      email: 'soft-delete-test-target@example.com',
      job_title: 'Treasurer',
    });
    const slug = 'soft-delete-target';
    await seedNamecard(env.DB, memberId, { slug, has_namecard: 1 });

    // Sanity: the card is live before the delete.
    const before = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(before.status).toBe(200);

    // Soft-delete the member.
    const del = await SELF.fetch(`https://example.com/api/members/${memberId}`, {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    });
    expect(del.status).toBe(200);

    // The card must be dark immediately — no cache window, no eventual
    // consistency, because the darkening happened in the same batch.
    const after = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(after.status).toBe(404);

    // And the namecard row's has_namecard column is 0 in D1.
    const row = await env.DB.prepare('SELECT has_namecard FROM namecards WHERE member_id = ?')
      .bind(memberId)
      .first<{ has_namecard: number }>();
    expect(row?.has_namecard).toBe(0);
    // The member is soft-deleted (deleted_at set), not removed.
    const member = await env.DB.prepare('SELECT deleted_at FROM members WHERE id = ?')
      .bind(memberId)
      .first<{ deleted_at: string | null }>();
    expect(member?.deleted_at).not.toBeNull();
  });

  it("still succeeds when the member has no namecard row (the second UPDATE is a no-op)", async () => {
    const memberId = await seedMember(env.DB, {
      name: 'No Card Person',
      email: 'soft-delete-test-nocard@example.com',
    });
    const del = await SELF.fetch(`https://example.com/api/members/${memberId}`, {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    });
    expect(del.status).toBe(200);
    const member = await env.DB.prepare('SELECT deleted_at FROM members WHERE id = ?')
      .bind(memberId)
      .first<{ deleted_at: string | null }>();
    expect(member?.deleted_at).not.toBeNull();
  });
});
