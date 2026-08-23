// Integration tests for the public /c/* routes.
//
// Uses the canonical @cloudflare/vitest-pool-workers pattern: import the Hono
// `app` from the worker entry, mount it as `SELF`, then call `SELF.fetch()`
// to exercise routes against the real Miniflare D1/KV/R2 bindings.
//
// Each test seeds fixture rows via the shared helpers in test/db-helpers.ts
// and asserts end-to-end behaviour. The photo round-trip test also exercises
// the R2 binding.
//
// Board-only gate (2026-08-23 restore): cards serve committee/advisor members
// only, and every card shows the SWA office address rather than any personal
// address. These tests pin both rules.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import * as appModule from '../../index';
import { applyMigrations, seedMember, seedNamecard } from '../../../../test/db-helpers';

const TEST_PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xa1, 0xb2]);

// SELF is the request dispatcher; the actual Hono app is the default export
// of src/worker/index.ts. The pool wires SELF to the entry automatically, but
// we import the module to assert it exists and to keep the test honest about
// what is being exercised.
const app = (appModule as { default: { fetch: typeof fetch } }).default;

beforeAll(async () => {
  await applyMigrations(env.DB);
});

beforeEach(async () => {
  // Wipe the test rows so each test starts clean. The D1 isolate is shared
  // across tests in the same worker, so we cannot drop+recreate the schema
  // every time (too slow) — targeted deletes suffice.
  await env.DB.prepare('DELETE FROM namecards').run();
  await env.DB.prepare("DELETE FROM members WHERE email LIKE 'public-test-%'").run();
});

async function seedFixtures(): Promise<{ memberId: number; slug: string }> {
  const memberId = await seedMember(env.DB, {
    name: 'Sarah Chen',
    email: 'public-test-sarah@example.com',
    mobile: '+65 9123 4567',
    job_title: 'Chief Innovation Officer',
  });
  const slug = 'sarah-chen';
  await seedNamecard(env.DB, memberId, { slug });
  return { memberId, slug };
}

describe('GET /c/:slug — public HTML card page', () => {
  it('returns 200 + branded HTML for a visible card', async () => {
    const { slug } = await seedFixtures();
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=600');
    const html = await res.text();
    expect(html).toContain('Sarah Chen');
    expect(html).toContain('Chief Innovation Officer');
    expect(html).toContain("Singapore Women's Association");
    expect(html).toContain('<title>Sarah Chen');
    expect(html).toContain('og:image');
    expect(html).toContain('application/ld+json');
  });

  it('returns a branded 404 for an unknown slug', async () => {
    const res = await SELF.fetch('https://example.com/c/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not available');
  });

  it('returns a branded 404 when has_namecard = 0 (admin disabled the card)', async () => {
    const { slug } = await seedFixtures();
    await env.DB.prepare('UPDATE namecards SET has_namecard = 0 WHERE slug = ?').bind(slug).run();
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.status).toBe(404);
  });

  it('returns a branded 404 when the member is soft-deleted', async () => {
    const { slug, memberId } = await seedFixtures();
    await env.DB
      .prepare("UPDATE members SET deleted_at = datetime('now') WHERE id = ?")
      .bind(memberId)
      .run();
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.status).toBe(404);
  });

  it('returns a branded 404 for a non-board member (category gate)', async () => {
    const { slug, memberId } = await seedFixtures();
    await env.DB.prepare("UPDATE members SET category = 'member' WHERE id = ?")
      .bind(memberId)
      .run();
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.status).toBe(404);
  });

  it('returns a branded 404 for a volunteer-category member (category gate)', async () => {
    const { slug, memberId } = await seedFixtures();
    await env.DB.prepare("UPDATE members SET category = 'volunteer' WHERE id = ?")
      .bind(memberId)
      .run();
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.status).toBe(404);
  });

  it('serves an advisor member (advisor is a board category)', async () => {
    const { slug, memberId } = await seedFixtures();
    await env.DB.prepare("UPDATE members SET category = 'advisor' WHERE id = ?")
      .bind(memberId)
      .run();
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.status).toBe(200);
  });

  it('shows the SWA office address, never the member personal address', async () => {
    const { slug, memberId } = await seedFixtures();
    await env.DB
      .prepare(
        "UPDATE members SET address_line1 = '12 Private Home Road', address_postal_code = '999999' WHERE id = ?",
      )
      .bind(memberId)
      .run();
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    const html = await res.text();
    expect(html).toContain('409 Serangoon Central, #01-303');
    expect(html).toContain('Singapore 550409');
    expect(html).not.toContain('12 Private Home Road');
    expect(html).not.toContain('999999');
  });

  it('sends the hardened X-Robots-Tag + meta robots block', async () => {
    const { slug } = await seedFixtures();
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.headers.get('X-Robots-Tag')).toBe(
      'noindex, nofollow, noarchive, nosnippet, notranslate, noimageindex',
    );
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, notranslate, noimageindex">');
  });
});

describe('GET /c/:slug/contact.vcf — vCard download', () => {
  it('returns text/vcard with attachment + nosniff headers', async () => {
    const { slug } = await seedFixtures();
    const res = await SELF.fetch(`https://example.com/c/${slug}/contact.vcf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/vcard; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain('_SWA.vcf');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const vcf = await res.text();
    expect(vcf.startsWith('BEGIN:VCARD\r\n')).toBe(true);
    expect(vcf).toContain('FN:Sarah Chen\r\n');
    expect(vcf).toContain('TEL;TYPE=CELL:+65 9123 4567');
    // Office ADR — comma is vCard-escaped and the line folds at 75 octets.
    expect(vcf).toContain('ADR;TYPE=WORK:;;409 Serangoon Central\\, #01-303;Singapore;;Singapore 550409\r\n ;Singapore');
  });

  it('returns 404 for a hidden card (no leak that the row exists)', async () => {
    const { slug } = await seedFixtures();
    await env.DB.prepare('UPDATE namecards SET has_namecard = 0 WHERE slug = ?').bind(slug).run();
    const res = await SELF.fetch(`https://example.com/c/${slug}/contact.vcf`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-board member even with a photo attached (photo gate)', async () => {
    const { slug, memberId } = await seedFixtures();
    const r2Key = `namecards/${memberId}/photo.jpg`;
    await env.R2_BUCKET.put(r2Key, TEST_PHOTO_BYTES, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await env.DB.prepare('UPDATE namecards SET photo_r2_key = ? WHERE slug = ?')
      .bind(r2Key, slug)
      .run();
    await env.DB.prepare("UPDATE members SET category = 'member' WHERE id = ?")
      .bind(memberId)
      .run();
    const res = await SELF.fetch(`https://example.com/c/${slug}/photo`);
    expect(res.status).toBe(404);
  });
});

describe('GET /c/:slug/card.svg — branded SVG card image', () => {
  it('returns image/svg+xml with no external resource references', async () => {
    const { slug } = await seedFixtures();
    const res = await SELF.fetch(`https://example.com/c/${slug}/card.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    const svg = await res.text();
    expect(svg.startsWith('<svg')).toBe(true);
    // The card has no URL on it (design spec).
    expect(svg).not.toContain('/c/sarah-chen');
    // Every href must be a data: or same-document # ref so the client-side
    // canvas PNG export is not tainted.
    const refs = svg.match(/(?:xlink:href|href|src)\s*=\s*"([^"]*)"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const value = ref.replace(/^.*?"([^"]*)"$/, '$1');
      const safe = value.startsWith('data:') || value.startsWith('#');
      expect(safe).toBe(true);
    }
  });
});

describe('GET /c/:slug/photo.:ext — raw photo stream from R2', () => {
  it('returns 200 with the photo content-type and immutable public cache headers', async () => {
    const { slug, memberId } = await seedFixtures();
    const r2Key = `namecards/${memberId}/photo.jpg`;
    await env.R2_BUCKET.put(r2Key, TEST_PHOTO_BYTES, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await env.DB.prepare('UPDATE namecards SET photo_r2_key = ? WHERE slug = ?')
      .bind(r2Key, slug)
      .run();

    const res = await SELF.fetch(`https://example.com/c/${slug}/photo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    // Public + immutable cache — DIFFERENT from the membership image's
    // private/1h (docs/NAMECARD.md §8.3).
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, s-maxage=2592000');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(TEST_PHOTO_BYTES);
  });

  it('returns 404 when the card has no photo_r2_key', async () => {
    const { slug } = await seedFixtures();
    const res = await SELF.fetch(`https://example.com/c/${slug}/photo`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the member is soft-deleted (no leak)', async () => {
    const { slug, memberId } = await seedFixtures();
    const r2Key = `namecards/${memberId}/photo.jpg`;
    await env.R2_BUCKET.put(r2Key, TEST_PHOTO_BYTES, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await env.DB.prepare('UPDATE namecards SET photo_r2_key = ? WHERE slug = ?')
      .bind(r2Key, slug)
      .run();
    await env.DB
      .prepare("UPDATE members SET deleted_at = datetime('now') WHERE id = ?")
      .bind(memberId)
      .run();
    const res = await SELF.fetch(`https://example.com/c/${slug}/photo`);
    expect(res.status).toBe(404);
  });
});

// Reference the app to satisfy the import linter — the pool wires SELF to the
// worker entry automatically, but this also fails the test loudly if the
// default export ever changes shape.
void app;
