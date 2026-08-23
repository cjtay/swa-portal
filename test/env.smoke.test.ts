// Smoke test: confirm @cloudflare/vitest-pool-workers exposes the real
// bindings (D1, KV, R2) to tests. If this test fails, every binding-aware
// test in the suite will fail too — so we fail fast here.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './db-helpers';

describe('env bindings smoke', () => {
  it('exposes a working D1 binding (SELECT 1)', async () => {
    const r = await env.DB.prepare('SELECT 1 AS n').first<{ n: number }>();
    expect(r?.n).toBe(1);
  });

  it('exposes a working KV binding (put/get round-trip)', async () => {
    await env.SWA_SESSION.put('swa:test:smoke', 'ok');
    const v = await env.SWA_SESSION.get('swa:test:smoke');
    expect(v).toBe('ok');
  });

  it('exposes a working R2 binding (put/get round-trip)', async () => {
    await env.R2_BUCKET.put('smoke-test.txt', new TextEncoder().encode('ok'));
    const obj = await env.R2_BUCKET.get('smoke-test.txt');
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    expect(text).toBe('ok');
  });

  it('applies the schema.sql baseline cleanly (members + namecards tables present)', async () => {
    await applyMigrations(env.DB);
    const r = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('members', 'namecards') ORDER BY name`,
    ).all<{ name: string }>();
    expect(r.results.map((row: { name: string }) => row.name)).toEqual(['members', 'namecards']);
  });

  it('the namecards table enforces the 1:1 relationship and slug uniqueness', async () => {
    await applyMigrations(env.DB);
    // Insert a member to attach namecards to.
    const member = await env.DB.prepare(
      `INSERT INTO members (name, role) VALUES ('Test', 'Board')`,
    ).run();
    const memberId = Number(member.meta.last_row_id);

    // First namecard for this member succeeds.
    await env.DB.prepare(
      `INSERT INTO namecards (member_id, slug) VALUES (?, 'test-slug')`,
    )
      .bind(memberId)
      .run();

    // Second namecard for the same member throws (UNIQUE on member_id).
    await expect(
      env.DB.prepare(
        `INSERT INTO namecards (member_id, slug) VALUES (?, 'other-slug')`,
      )
        .bind(memberId)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: namecards\.member_id/);

    // Same slug on a different member also throws (UNIQUE on slug).
    const other = await env.DB.prepare(
      `INSERT INTO members (name, role) VALUES ('Other', 'Board')`,
    ).run();
    const otherId = Number(other.meta.last_row_id);
    await expect(
      env.DB.prepare(
        `INSERT INTO namecards (member_id, slug) VALUES (?, 'test-slug')`,
      )
        .bind(otherId)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: namecards\.slug/);
  });
});
