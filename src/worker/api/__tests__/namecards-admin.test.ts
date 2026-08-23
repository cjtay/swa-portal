// Integration tests for the admin /api/namecards/* CRUD surface.
//
// These hit the real Hono app via SELF.fetch() against the Miniflare bindings
// (D1, R2, KV). Authentication is handled the same way the rest of the test
// suite does it: in dev, requests without a cookie get the DEV_BYPASS_AUTH
// IT-admin session, so write tests "just work" as admin. To exercise the
// non-admin 403 path we mint a real session cookie with a committee role and
// send it on the request — the real cookie takes precedence over the bypass
// (see session.ts:153).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signHmac, base64urlEncode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME } from '../../../constants/portal';
import { applyMigrations, seedMember, seedNamecard } from '../../../../test/db-helpers';

beforeAll(async () => {
  await applyMigrations(env.DB);
  // The D1 isolate is shared across all test files in the pool worker, so
  // rows left by other files (e.g. namecard-public.test.ts) would pollute
  // these tests. Wipe the lot before we start.
  await env.DB.prepare('DELETE FROM namecards').run();
  await env.DB.prepare("DELETE FROM members WHERE email LIKE 'admin-test-%' OR email LIKE 'public-test-%'").run();
});

beforeEach(async () => {
  // Order matters: namecards first (FK to members), then members. Wipe both
  // so slug collisions don't leak between tests in the shared isolate.
  await env.DB.prepare('DELETE FROM namecards').run();
  await env.DB.prepare("DELETE FROM members WHERE email LIKE 'admin-test-%'").run();
  // Session revalidation (security-remediation-plan Phase 1) rejects cookies
  // whose email has no live member row, so the minted cookie identities need
  // matching rows with the same category the cookie claims.
  await seedMember(env.DB, { name: 'Test Admin', email: 'admin-test-admin@example.com', category: 'admin' });
  await seedMember(env.DB, { name: 'Test Committee', email: 'admin-test-committee@example.com', category: 'committee' });
});

/** Mint a signed session cookie for a non-admin (committee) role. */
async function committeeCookie(): Promise<string> {
  const payload = base64urlEncode(
    JSON.stringify({
      email: 'admin-test-committee@example.com',
      name: 'Test Committee',
      role: 'committee',
      regRole: null,
      exp: Date.now() + 60 * 60 * 1000,
    }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}`;
}

async function adminCookie(): Promise<string> {
  // In dev the DEV_BYPASS_AUTH path already impersonates an IT-admin when no
  // cookie is sent, but a real signed cookie wins — mint one explicitly so
  // the test is robust against dev-bypass being toggled off.
  const payload = base64urlEncode(
    JSON.stringify({
      email: 'admin-test-admin@example.com',
      name: 'Test Admin',
      role: 'admin',
      regRole: null,
      exp: Date.now() + 60 * 60 * 1000,
    }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}`;
}

async function seedFixture(): Promise<{ memberId: number; namecardId: number; slug: string }> {
  const memberId = await seedMember(env.DB, {
    name: 'Alice Cheng',
    email: 'admin-test-alice@example.com',
    mobile: '+65 9123 4567',
    job_title: 'President',
  });
  const slug = 'alice-cheng';
  const namecardId = await seedNamecard(env.DB, memberId, { slug });
  return { memberId, namecardId, slug };
}

describe('GET /api/namecards — list', () => {
  it('returns the joined namecard + member rows', async () => {
    await seedFixture();
    const res = await SELF.fetch('https://example.com/api/namecards', {
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; namecards: Array<{ slug: string; member_name: string }> }>();
    expect(body.success).toBe(true);
    expect(body.namecards.length).toBeGreaterThanOrEqual(1);
    expect(body.namecards.some((n: { slug: string }) => n.slug === 'alice-cheng')).toBe(true);
    expect(body.namecards.find((n: { slug: string }) => n.slug === 'alice-cheng')!.member_name).toBe('Alice Cheng');
  });

  it('returns 401 when no session is provided AND the dev bypass is suppressed', async () => {
    // On a dev-bypass host (localhost), the `swa_dev_logout=1` marker
    // suppresses the bypass — without a real session cookie, the request
    // should 401. (On a non-dev host the bypass path doesn't apply at all,
    // so we must use localhost here to exercise the suppression branch.)
    const res = await SELF.fetch('http://localhost:8787/api/namecards', {
      headers: { Cookie: 'swa_dev_logout=1' },
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/namecards — create', () => {
  it('admin creates a namecard; slug is auto-derived from the member name', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Bob Tan',
      email: 'admin-test-bob@example.com',
    });
    const res = await SELF.fetch('https://example.com/api/namecards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ member_id: memberId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ success: boolean; id: number; slug: string }>();
    expect(body.success).toBe(true);
    expect(body.slug).toBe('bob-tan');
    // Row exists in D1.
    const row = await env.DB.prepare('SELECT slug FROM namecards WHERE id = ?')
      .bind(body.id)
      .first<{ slug: string }>();
    expect(row?.slug).toBe('bob-tan');
  });

  it('rejects a duplicate member_id with 409', async () => {
    const { memberId } = await seedFixture();
    const res = await SELF.fetch('https://example.com/api/namecards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ member_id: memberId }),
    });
    expect(res.status).toBe(409);
  });

  it('auto-resolves a slug collision by suggesting slug-2, -3, ...', async () => {
    // First "Bob Tan".
    const m1 = await seedMember(env.DB, { name: 'Bob Tan', email: 'admin-test-bob1@example.com' });
    await SELF.fetch('https://example.com/api/namecards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ member_id: m1 }),
    });
    // Second "Bob Tan" → should resolve to bob-tan-2.
    const m2 = await seedMember(env.DB, { name: 'Bob Tan', email: 'admin-test-bob2@example.com' });
    const res = await SELF.fetch('https://example.com/api/namecards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ member_id: m2 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ slug: string }>();
    expect(body.slug).toBe('bob-tan-2');
  });

  it('returns 403 for a non-admin session', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Carol Lim',
      email: 'admin-test-carol@example.com',
    });
    const res = await SELF.fetch('https://example.com/api/namecards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await committeeCookie() },
      body: JSON.stringify({ member_id: memberId }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a non-board member with 400 (board-only gate)', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Dana Ong',
      email: 'admin-test-dana@example.com',
      category: 'member',
    });
    const res = await SELF.fetch('https://example.com/api/namecards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ member_id: memberId }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ message: string }>();
    expect(body.message).toContain('board members');
  });
});

describe('POST /api/namecards/bulk — auto-generate board cards', () => {
  it('creates cards for board members lacking one, never for non-board members', async () => {
    // Alice has a card; Bob (committee) does not; Erin (member) does not.
    await seedFixture(); // Alice
    const bobId = await seedMember(env.DB, {
      name: 'Bob Bulk',
      email: 'admin-test-bobbulk@example.com',
    });
    const erinId = await seedMember(env.DB, {
      name: 'Erin Ordinary',
      email: 'admin-test-erin@example.com',
      category: 'member',
    });

    const res = await SELF.fetch('https://example.com/api/namecards/bulk', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      success: boolean;
      created: Array<{ member_id: number; slug: string }>;
      skipped: Array<{ member_id: number }>;
    }>();
    expect(body.success).toBe(true);
    expect(body.created.some((c: { member_id: number }) => c.member_id === bobId)).toBe(true);
    // Alice already had a card — must not appear in `created`.
    expect(body.created.length).toBeGreaterThanOrEqual(1);
    // Erin is an ordinary member — must never get a card.
    expect(body.created.some((c: { member_id: number }) => c.member_id === erinId)).toBe(false);
    const erinCard = await env.DB.prepare('SELECT id FROM namecards WHERE member_id = ?')
      .bind(erinId)
      .first();
    expect(erinCard).toBeNull();
  });

  it('leaves an admin-hidden card hidden (idempotent, no re-show)', async () => {
    const { namecardId } = await seedFixture(); // Alice, visible
    await env.DB.prepare('UPDATE namecards SET has_namecard = 0 WHERE id = ?')
      .bind(namecardId)
      .run();
    await SELF.fetch('https://example.com/api/namecards/bulk', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    });
    const row = await env.DB.prepare('SELECT has_namecard FROM namecards WHERE id = ?')
      .bind(namecardId)
      .first<{ has_namecard: number }>();
    expect(row?.has_namecard).toBe(0);
  });
});

describe('PATCH /api/namecards/:id — edit', () => {
  it('updates allow-listed fields and rejects unsafe URL schemes', async () => {
    const { namecardId } = await seedFixture();
    const ok = await SELF.fetch(`https://example.com/api/namecards/${namecardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({
        bio: 'New bio',
        website: 'https://example.com',
        whatsapp: '+65 9123 4567',
        qr_variant: 'page',
      }),
    });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare('SELECT bio, website, whatsapp, qr_variant FROM namecards WHERE id = ?')
      .bind(namecardId)
      .first<{ bio: string; website: string; whatsapp: string; qr_variant: string }>();
    expect(row?.bio).toBe('New bio');
    expect(row?.website).toBe('https://example.com');
    expect(row?.whatsapp).toBe('+6591234567');
    expect(row?.qr_variant).toBe('page');
  });

  it('rejects javascript: URLs server-side with 400', async () => {
    const { namecardId } = await seedFixture();
    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ website: 'javascript:alert(1)' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid qr_variant with 400', async () => {
    const { namecardId } = await seedFixture();
    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ qr_variant: 'unknown' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a WhatsApp number without a country code with 400', async () => {
    const { namecardId } = await seedFixture();
    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ whatsapp: '91234567' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/namecards/:id/slug — change slug', () => {
  it('updates the slug when free', async () => {
    const { namecardId } = await seedFixture();
    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}/slug`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ slug: 'alice-new' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ slug: string }>();
    expect(body.slug).toBe('alice-new');
  });

  it('returns 409 + suggestion when the slug is taken by another card', async () => {
    const { namecardId } = await seedFixture();
    // Make a second card that owns the slug we want.
    const m2 = await seedMember(env.DB, { name: 'Other', email: 'admin-test-other@example.com' });
    await seedNamecard(env.DB, m2, { slug: 'taken-slug' });

    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}/slug`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: JSON.stringify({ slug: 'taken-slug' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ suggestion: string }>();
    expect(body.suggestion).toBe('taken-slug-2');
  });
});

describe('POST /api/namecards/:id/photo — upload', () => {
  it('stores the photo in R2 and records the key', async () => {
    const { namecardId, memberId } = await seedFixture();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const form = new FormData();
    form.append('photo', blob, 'headshot.jpg');

    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}/photo`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ photo_r2_key: string }>();
    expect(body.photo_r2_key).toBe(`namecards/${memberId}/photo.jpg`);

    const obj = await env.R2_BUCKET.get(body.photo_r2_key);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('rejects a non-image content-type with 400', async () => {
    const { namecardId } = await seedFixture();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/gif' });
    const form = new FormData();
    form.append('photo', blob, 'headshot.gif');
    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}/photo`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an upload over 2 MB with 413', async () => {
    const { namecardId } = await seedFixture();
    // 3 MB of zeros, image/jpeg.
    const oversize = new Uint8Array(3 * 1024 * 1024);
    const blob = new Blob([oversize], { type: 'image/jpeg' });
    const form = new FormData();
    form.append('photo', blob, 'big.jpg');
    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}/photo`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(413);
  });
});

describe('PATCH /api/namecards/:id/toggle — visibility', () => {
  it('flips has_namecard from 1 to 0 when no body is supplied', async () => {
    const { namecardId } = await seedFixture();
    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ has_namecard: number }>();
    expect(body.has_namecard).toBe(0);
  });
});

describe('DELETE /api/namecards/:id — hard delete', () => {
  it('removes the row and its R2 photo', async () => {
    const { namecardId, memberId } = await seedFixture();
    const r2Key = `namecards/${memberId}/photo.jpg`;
    await env.R2_BUCKET.put(r2Key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await env.DB.prepare('UPDATE namecards SET photo_r2_key = ? WHERE id = ?')
      .bind(r2Key, namecardId)
      .run();

    const res = await SELF.fetch(`https://example.com/api/namecards/${namecardId}`, {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT id FROM namecards WHERE id = ?')
      .bind(namecardId)
      .first();
    expect(row).toBeNull();
    const obj = await env.R2_BUCKET.get(r2Key);
    expect(obj).toBeNull();
  });
});

describe('GET /api/namecards/me — self-service', () => {
  it("returns the caller's own namecard row", async () => {
    // Attach a namecard to the committee identity row seeded in beforeEach.
    const identity = await env.DB.prepare(
      "SELECT id FROM members WHERE email = 'admin-test-committee@example.com'",
    ).first<{ id: number }>();
    await seedNamecard(env.DB, identity!.id, { slug: 'test-committee' });

    const res = await SELF.fetch('https://example.com/api/namecards/me', {
      headers: { Cookie: await committeeCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; namecard: { slug: string } | null }>();
    expect(body.success).toBe(true);
    expect(body.namecard?.slug).toBe('test-committee');
  });

  it('returns success:true + namecard:null when the caller has no card', async () => {
    // The admin identity row exists (revalidation requires it) but has no
    // namecard attached → null, not an error.
    const res = await SELF.fetch('https://example.com/api/namecards/me', {
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; namecard: unknown }>();
    expect(body.success).toBe(true);
    expect(body.namecard).toBeNull();
  });
});
