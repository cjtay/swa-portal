// Integration tests for namecard auto-generation (2026-08-23 restore).
//
// Cards follow the member's category:
//   - created automatically when a member is created in (or promoted into)
//     committee/advisor
//   - darkened (has_namecard = 0) when a member is demoted out of the board
//
// All calls go through the real /api/members endpoints with an admin cookie,
// so the middleware + revalidation path is exercised too.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signHmac, base64urlEncode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME } from '../../../constants/portal';
import { applyMigrations, seedMember } from '../../../../test/db-helpers';

beforeAll(async () => {
  await applyMigrations(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM namecards').run();
  await env.DB.prepare("DELETE FROM members WHERE email LIKE 'autogen-test-%'").run();
  // Revalidation requires a live member row matching the cookie identity.
  await seedMember(env.DB, {
    name: 'AutoGen Admin',
    email: 'autogen-test-admin@example.com',
    category: 'admin',
  });
});

async function adminCookie(): Promise<string> {
  const payload = base64urlEncode(
    JSON.stringify({
      email: 'autogen-test-admin@example.com',
      name: 'AutoGen Admin',
      role: 'admin',
      regRole: null,
      exp: Date.now() + 60 * 60 * 1000,
    }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}`;
}

const jsonHeaders = async () => ({
  'Content-Type': 'application/json',
  Cookie: await adminCookie(),
});

describe('POST /api/members — auto-generation on create', () => {
  it('creates a visible card when a committee member is added', async () => {
    const res = await SELF.fetch('https://example.com/api/members', {
      method: 'POST',
      headers: await jsonHeaders(),
      body: JSON.stringify({
        name: 'Fiona Goh',
        role: 'Committee Member',
        email: 'autogen-test-fiona@example.com',
        category: 'committee',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();
    const card = await env.DB.prepare(
      'SELECT slug, has_namecard FROM namecards WHERE member_id = ?',
    )
      .bind(body.id)
      .first<{ slug: string; has_namecard: number }>();
    expect(card?.slug).toBe('fiona-goh');
    expect(card?.has_namecard).toBe(1);
  });

  it('creates a visible card when an advisor member is added', async () => {
    const res = await SELF.fetch('https://example.com/api/members', {
      method: 'POST',
      headers: await jsonHeaders(),
      body: JSON.stringify({
        name: 'Grace Ho',
        role: 'Advisor',
        email: 'autogen-test-grace@example.com',
        category: 'advisor',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();
    const card = await env.DB.prepare(
      'SELECT slug FROM namecards WHERE member_id = ?',
    )
      .bind(body.id)
      .first<{ slug: string }>();
    expect(card?.slug).toBe('grace-ho');
  });

  it('creates no card for an ordinary member', async () => {
    const res = await SELF.fetch('https://example.com/api/members', {
      method: 'POST',
      headers: await jsonHeaders(),
      body: JSON.stringify({
        name: 'Hana Ito',
        role: 'Member',
        email: 'autogen-test-hana@example.com',
        category: 'member',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();
    const card = await env.DB.prepare(
      'SELECT id FROM namecards WHERE member_id = ?',
    )
      .bind(body.id)
      .first();
    expect(card).toBeNull();
  });
});

describe('PATCH /api/members/:id — auto-generation on category change', () => {
  it('creates a card when a member is promoted to committee', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Iris Jay',
      email: 'autogen-test-iris@example.com',
      category: 'member',
    });
    const res = await SELF.fetch(`https://example.com/api/members/${memberId}`, {
      method: 'PATCH',
      headers: await jsonHeaders(),
      body: JSON.stringify({ category: 'committee' }),
    });
    expect(res.status).toBe(200);
    const card = await env.DB.prepare(
      'SELECT slug, has_namecard FROM namecards WHERE member_id = ?',
    )
      .bind(memberId)
      .first<{ slug: string; has_namecard: number }>();
    expect(card?.slug).toBe('iris-jay');
    expect(card?.has_namecard).toBe(1);
  });

  it('darkens the card when a board member is demoted to member', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Jane Koh',
      email: 'autogen-test-jane@example.com',
      category: 'committee',
    });
    await env.DB.prepare(
      'INSERT INTO namecards (member_id, slug) VALUES (?, ?)',
    )
      .bind(memberId, 'jane-koh')
      .run();

    const res = await SELF.fetch(`https://example.com/api/members/${memberId}`, {
      method: 'PATCH',
      headers: await jsonHeaders(),
      body: JSON.stringify({ category: 'member' }),
    });
    expect(res.status).toBe(200);
    const card = await env.DB.prepare(
      'SELECT has_namecard FROM namecards WHERE member_id = ?',
    )
      .bind(memberId)
      .first<{ has_namecard: number }>();
    expect(card?.has_namecard).toBe(0);
  });

  it('does not touch cards when the category is unchanged in the body', async () => {
    const memberId = await seedMember(env.DB, {
      name: 'Kelly Lam',
      email: 'autogen-test-kelly@example.com',
      category: 'committee',
    });
    await env.DB.prepare(
      'INSERT INTO namecards (member_id, slug) VALUES (?, ?)',
    )
      .bind(memberId, 'kelly-lam')
      .run();
    const before = await env.DB.prepare(
      "SELECT has_namecard, updated_at FROM namecards WHERE member_id = ?",
    )
      .bind(memberId)
      .first<{ has_namecard: number; updated_at: string }>();

    // Patch an unrelated field (job_title) without category in the body.
    const res = await SELF.fetch(`https://example.com/api/members/${memberId}`, {
      method: 'PATCH',
      headers: await jsonHeaders(),
      body: JSON.stringify({ job_title: 'Treasurer' }),
    });
    expect(res.status).toBe(200);
    const after = await env.DB.prepare(
      "SELECT has_namecard, updated_at FROM namecards WHERE member_id = ?",
    )
      .bind(memberId)
      .first<{ has_namecard: number; updated_at: string }>();
    expect(after?.has_namecard).toBe(before?.has_namecard);
    expect(after?.updated_at).toBe(before?.updated_at);
  });
});
