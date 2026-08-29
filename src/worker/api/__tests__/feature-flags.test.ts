// Feature availability gates — end-to-end tests.
//
// Covers the three enforcement layers of src/worker/lib/feature-flags.ts:
//   1. middleware 503 FEATURE_DISABLED on gated API prefixes (before auth
//      and before the public buyer bypass),
//   2. the /c/* public namecard surface 404ing when namecards is off,
//   3. the swa:feature_flags settings key (GET default fallback + POST
//      validation) and the /api/session `features` payload.
//
// The vitest setup file (test/feature-flags-setup.ts) seeds all-true so the
// rest of the suite runs against enabled features; these tests flip the KV
// override per scenario and reset the in-isolate cache between them.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations, seedMember, seedNamecard } from '../../../../test/db-helpers';
import {
  __resetFeatureFlagCacheForTests,
  FEATURE_FLAGS_KV_KEY,
} from '../../lib/feature-flags';
import { signHmac, base64urlEncode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME, IT_ADMIN_EMAILS } from '../../../constants/portal';

const ALL_ON = { namecards: true, office_booking: true, events: true };
const ALL_OFF = { namecards: false, office_booking: false, events: false };

beforeAll(async () => {
  await applyMigrations(env.DB);
});

beforeEach(async () => {
  // Restore the suite-wide enabled state after each scenario.
  await env.SWA_CONFIG.put(FEATURE_FLAGS_KV_KEY, JSON.stringify(ALL_ON));
  __resetFeatureFlagCacheForTests();
  await env.DB.prepare('DELETE FROM namecards').run();
  await env.DB.prepare("DELETE FROM members WHERE email LIKE 'ff-test-%'").run();
});

async function setFlags(flags: Record<string, boolean> | null, raw?: string): Promise<void> {
  if (raw !== undefined) {
    if (raw === null) await env.SWA_CONFIG.delete(FEATURE_FLAGS_KV_KEY);
    else await env.SWA_CONFIG.put(FEATURE_FLAGS_KV_KEY, raw);
  } else if (flags === null) {
    await env.SWA_CONFIG.delete(FEATURE_FLAGS_KV_KEY);
  } else {
    await env.SWA_CONFIG.put(FEATURE_FLAGS_KV_KEY, JSON.stringify(flags));
  }
  __resetFeatureFlagCacheForTests();
}

/** Mint an IT-admin session cookie (no members row needed — see
 * session-revalidation.test.ts for the same pattern). */
async function mintItAdminCookie(): Promise<string> {
  const payload = base64urlEncode(
    JSON.stringify({
      email: IT_ADMIN_EMAILS[0],
      name: 'FF IT Admin',
      role: 'admin',
      regRole: null,
      exp: Date.now() + 60 * 60 * 1000,
    }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}`;
}

async function seedBoardCard(): Promise<string> {
  const memberId = await seedMember(env.DB, {
    name: 'FF Test Card',
    email: 'ff-test-card@example.com',
  });
  const slug = 'ff-test-card';
  await seedNamecard(env.DB, memberId, { slug });
  return slug;
}

describe('feature availability — middleware 503 gates', () => {
  it('blocks gated APIs for every role (gate precedes auth — no cookie needed)', async () => {
    await setFlags(ALL_OFF);
    for (const path of [
      '/api/namecards',
      '/api/namecards/me',
      '/api/bookings',
      '/api/reg/dashboard/stats',
      '/api/reg/admin/bookings',
      // Public buyer path proves the gate runs before the token bypass.
      '/api/reg/buyer/some-token',
    ]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status, path).toBe(503);
      const body = (await res.json()) as { error_code?: string };
      expect(body.error_code, path).toBe('FEATURE_DISABLED');
    }
  });

  it('a missing KV key falls back to the production defaults (all disabled)', async () => {
    await setFlags(null);
    const res = await SELF.fetch('https://example.com/api/bookings');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error_code?: string };
    expect(body.error_code).toBe('FEATURE_DISABLED');
  });

  it('an unparseable KV value falls back to the defaults (fail closed)', async () => {
    await setFlags(null, 'not json at all');
    const res = await SELF.fetch('https://example.com/api/namecards');
    expect(res.status).toBe(503);
  });

  it('partial booleans in KV are ignored per-key (unknown/absent keys keep defaults)', async () => {
    await setFlags(null, JSON.stringify({ namecards: true, office_booking: 'yes' }));
    const cookie = await mintItAdminCookie();
    // namecards explicitly on → passes the feature gate and serves normally.
    const namecards = await SELF.fetch('https://example.com/api/namecards', {
      headers: { Cookie: cookie },
    });
    expect(namecards.status).toBe(200);
    // office_booking value invalid → default false → blocked.
    const bookings = await SELF.fetch('https://example.com/api/bookings');
    expect(bookings.status).toBe(503);
  });

  it('ungated APIs are unaffected (members, forms, membership stay live)', async () => {
    await setFlags(ALL_OFF);
    for (const path of ['/api/members', '/api/membership/config', '/api/volunteer/config']) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status, path).not.toBe(503);
    }
  });

  it('enabled features pass the gate and serve normally', async () => {
    await setFlags(ALL_ON);
    const res = await SELF.fetch('https://example.com/api/bookings', {
      headers: { Cookie: await mintItAdminCookie() },
    });
    expect(res.status).toBe(200);
  });
});

describe('feature availability — public /c/* namecard surface', () => {
  it('404s (branded) when namecards is disabled, before rate limiting', async () => {
    const slug = await seedBoardCard();
    await setFlags(ALL_OFF);
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not available');
  });

  it('serves the card when namecards is enabled', async () => {
    const slug = await seedBoardCard();
    await setFlags(ALL_ON);
    const res = await SELF.fetch(`https://example.com/c/${slug}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('FF Test Card');
  });
});

describe('feature availability — /api/session payload', () => {
  // Cookieless /api/session calls hit the dev-bypass host guard (500) in the
  // test env because .dev.vars is loaded, so assert on an authenticated call.
  it('surfaces the current flags on the session response', async () => {
    const cookie = await mintItAdminCookie();
    await setFlags(ALL_OFF);
    const off = (await (
      await SELF.fetch('https://example.com/api/session', { headers: { Cookie: cookie } })
    ).json()) as { authenticated: boolean; features?: Record<string, boolean> };
    expect(off.authenticated).toBe(true);
    expect(off.features).toEqual(ALL_OFF);

    await setFlags(ALL_ON);
    const on = (await (
      await SELF.fetch('https://example.com/api/session', { headers: { Cookie: cookie } })
    ).json()) as { features?: Record<string, boolean> };
    expect(on.features).toEqual(ALL_ON);
  });
});

describe('feature availability — swa:feature_flags settings key', () => {
  it('GET falls back to the code defaults with isDefault when the KV key is absent', async () => {
    await setFlags(null);
    const cookie = await mintItAdminCookie();
    const res = await SELF.fetch('https://example.com/api/admin/settings?key=swa:feature_flags', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; value: Record<string, boolean>; isDefault?: boolean };
    expect(body.success).toBe(true);
    expect(body.value).toEqual(ALL_OFF);
    expect(body.isDefault).toBe(true);
  });

  it('POST rejects partial objects (every known key required)', async () => {
    const cookie = await mintItAdminCookie();
    const res = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: 'swa:feature_flags', value: { namecards: true } }),
    });
    expect(res.status).toBe(400);
  });

  it('POST rejects unknown feature keys', async () => {
    const cookie = await mintItAdminCookie();
    const res = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        key: 'swa:feature_flags',
        value: { ...ALL_ON, e_tickets: true },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST with the full object round-trips and takes effect on the gates', async () => {
    const cookie = await mintItAdminCookie();
    const post = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: 'swa:feature_flags', value: ALL_OFF }),
    });
    expect(post.status).toBe(200);
    __resetFeatureFlagCacheForTests();
    const gated = await SELF.fetch('https://example.com/api/bookings');
    expect(gated.status).toBe(503);
  });
});
