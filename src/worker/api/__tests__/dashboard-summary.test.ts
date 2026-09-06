// Integration tests for GET /api/dashboard/summary.
//
// Same pattern as approvals.test.ts: SELF.fetch() against the Miniflare
// bindings with signed session cookies minted per role, and live member rows
// so middleware revalidation resolves each identity from D1.
//
// The endpoint's whole job is role scoping — each test asserts which
// sections appear for which role, and that the counts inside them are right.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations, seedMember } from '../../../../test/db-helpers';
import { __resetFeatureFlagCacheForTests, FEATURE_FLAGS_KV_KEY } from '../../lib/feature-flags';
import { signHmac, base64urlEncode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME } from '../../../constants/portal';

const ADMIN_EMAIL = 'dash-admin@example.com';
const PURCHASE_EMAIL = 'approval@singaporewomenassociation.org';
const FINANCE_EMAIL = 'finance@singaporewomenassociation.org';
const AUDITOR_EMAIL = 'audit@singaporewomenassociation.org';
const COMMITTEE_EMAIL = 'dash-committee@example.com';
const VOLUNTEER_EMAIL = 'dash-volunteer@example.com';
const VOLUNTEER_REG_EMAIL = 'dash-volunteer-reg@example.com';

const ALL_ON = { namecards: true, office_booking: true, events: true };
const ALL_OFF = { namecards: false, office_booking: false, events: false };

async function mintCookie(email: string, role: string, regRole: string | null = null): Promise<string> {
  const payload = base64urlEncode(
    JSON.stringify({
      email,
      name: 'Dash Test',
      role,
      regRole,
      exp: Date.now() + 60 * 60 * 1000,
    }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}`;
}

async function getSummary(cookie: string): Promise<Record<string, any>> {
  const res = await SELF.fetch('https://example.com/api/dashboard/summary', {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  return await res.json();
}

async function seedApprovalItem(fields: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(fields);
  const placeholders = columns.map(() => '?').join(', ');
  await env.DB.prepare(
    `INSERT INTO approval_items (${columns.join(', ')}) VALUES (${placeholders})`,
  )
    .bind(...columns.map((col) => fields[col]))
    .run();
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedMember(env.DB, { name: 'Dash Admin', email: ADMIN_EMAIL, category: 'admin' });
  await seedMember(env.DB, { name: 'Dash Purchase', email: PURCHASE_EMAIL, category: 'committee' });
  await seedMember(env.DB, { name: 'Dash Finance', email: FINANCE_EMAIL, category: 'committee' });
  await seedMember(env.DB, { name: 'Dash Auditor', email: AUDITOR_EMAIL, category: 'committee' });
  await seedMember(env.DB, { name: 'Dash Committee', email: COMMITTEE_EMAIL, category: 'committee' });
  await seedMember(env.DB, { name: 'Dash Volunteer', email: VOLUNTEER_EMAIL, category: 'volunteer' });
  // A second volunteer holding the reg_volunteer reg role (event night).
  // regRole is re-resolved from D1 on every request (session revalidation),
  // so it lives on the member row, not just the cookie.
  await seedMember(env.DB, { name: 'Dash Volunteer Reg', email: VOLUNTEER_REG_EMAIL, category: 'volunteer' });
  await env.DB.prepare("UPDATE members SET reg_role = 'reg_volunteer' WHERE email = ?")
    .bind(VOLUNTEER_REG_EMAIL)
    .run();
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM approval_items').run();
  await env.DB.prepare('DELETE FROM membership_applications').run();
  await env.DB.prepare('DELETE FROM volunteer_registrations').run();
  await env.DB.prepare('DELETE FROM laughter_yoga_registrations').run();
  // Restore the suite-wide enabled flags (feature-flags.test.ts may have
  // left an override behind; cheap insurance either way).
  await env.SWA_CONFIG.put(FEATURE_FLAGS_KV_KEY, JSON.stringify(ALL_ON));
  __resetFeatureFlagCacheForTests();
});

describe('role scoping', () => {
  it('plain committee member gets forms + events but NEVER the approvals section', async () => {
    const body = await getSummary(await mintCookie(COMMITTEE_EMAIL, 'committee'));
    expect(body.success).toBe(true);
    expect(body.approvals).toBeUndefined();
    expect(body.forms).toBeDefined();
    expect(body.events).toBeDefined();
  });

  it('check-in volunteer gets no sections at all', async () => {
    const body = await getSummary(await mintCookie(VOLUNTEER_EMAIL, 'volunteer'));
    expect(body.success).toBe(true);
    expect(body.approvals).toBeUndefined();
    expect(body.forms).toBeUndefined();
    expect(body.events).toBeUndefined();
  });

  it('purchase approver (committee base) gets approvals and forms', async () => {
    const body = await getSummary(await mintCookie(PURCHASE_EMAIL, 'committee'));
    expect(body.approvals).toBeDefined();
    expect(body.forms).toBeDefined();
  });

  it('view-only auditor gets the approvals section', async () => {
    const body = await getSummary(await mintCookie(AUDITOR_EMAIL, 'committee'));
    expect(body.approvals).toBeDefined();
    expect(body.approvals.counts.all).toBe(0);
  });
});

describe('approvals counts', () => {
  beforeEach(async () => {
    await seedApprovalItem({ category: 'invoice', title: 'A', status: 'pending', requested_amount: 500, created_by: 'x', created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00' });
    await seedApprovalItem({ category: 'invoice', title: 'B', status: 'pending', requested_amount: 999.99, created_by: 'x', created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00' });
    await seedApprovalItem({ category: 'invoice', title: 'C', status: 'pending', requested_amount: 1000, created_by: 'x', created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00' });
    await seedApprovalItem({ category: 'invoice', title: 'D', status: 'pending', requested_amount: null, created_by: 'x', created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00' });
    await seedApprovalItem({ category: 'invoice', title: 'E', status: 'finance_check', requested_amount: 3000, created_by: 'x', created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00' });
    await seedApprovalItem({ category: 'invoice', title: 'F', status: 'paid', requested_amount: 100, created_by: 'x', created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00' });
  });

  it('admin sees correct per-status counts', async () => {
    const body = await getSummary(await mintCookie(ADMIN_EMAIL, 'admin'));
    expect(body.approvals.counts).toMatchObject({
      pending: 4,
      finance_check: 1,
      paid: 1,
      purchase_approved: 0,
      finance_approved: 0,
      rejected: 0,
      all: 6,
    });
  });

  it('pending_under_1000 counts only pending items strictly below S$1,000 with a known amount', async () => {
    const body = await getSummary(await mintCookie(FINANCE_EMAIL, 'committee'));
    // 500 and 999.99 count; 1000 (at threshold), the null amount (fails
    // closed) and the paid item do not.
    expect(body.approvals.pending_under_1000).toBe(2);
    expect(body.approvals.counts.pending).toBe(4);
  });
});

describe('forms counts', () => {
  beforeEach(async () => {
    const insertApp = env.DB.prepare(
      'INSERT INTO membership_applications (full_name, nric, address_line1, address_postal_code, email, membership_intent, signature_r2_key, signature_method, payment_reference, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    await insertApp.bind('App One', 'S1234567A', '1 Test Road', '123456', 'app1@example.com', 'services', 'uploads/sig1', 'draw', 'MEM-TEST-1', 'pending').run();
    await insertApp.bind('App Two', 'S1234567B', '2 Test Road', '123456', 'app2@example.com', 'services', 'uploads/sig2', 'draw', 'MEM-TEST-2', 'approved').run();
    await env.DB.prepare(
      'INSERT INTO volunteer_registrations (full_name, email, contact_number, nric_last4, emergency_contact, availability, is_18_plus, medical_conditions, roles_interest, affiliation, consent, declaration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('Vol One', 'vol1@example.com', '91234567', '123A', 'EC 91234567', 'Weekends', 1, 'None', 'Logistics', 'Self', 1, 1)
      .run();
    await env.DB.prepare(
      'INSERT INTO laughter_yoga_registrations (source, email, full_name, age, address, phone_number, emergency_contact, organisation_name, indemnity_pdpa, occupation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('website', 'ly1@example.com', 'LY One', '40', 'Somewhere', '91234567', 'EC 91234567', 'Org', 1, 'Teacher')
      .run();
  });

  it('membership_pending counts only pending applications', async () => {
    const body = await getSummary(await mintCookie(COMMITTEE_EMAIL, 'committee'));
    expect(body.forms.membership_pending).toBe(1);
    expect(body.forms.volunteer_recent).toBe(1);
    expect(body.forms.laughter_recent).toBe(1);
  });
});

describe('events section', () => {
  it('disappears when the events feature flag is off, other sections stay', async () => {
    await env.SWA_CONFIG.put(FEATURE_FLAGS_KV_KEY, JSON.stringify(ALL_OFF));
    __resetFeatureFlagCacheForTests();
    try {
      const body = await getSummary(await mintCookie(ADMIN_EMAIL, 'admin'));
      expect(body.events).toBeUndefined();
      expect(body.approvals).toBeDefined();
      expect(body.forms).toBeDefined();
    } finally {
      await env.SWA_CONFIG.put(FEATURE_FLAGS_KV_KEY, JSON.stringify(ALL_ON));
      __resetFeatureFlagCacheForTests();
    }
  });

  it('reg_volunteer reg role admits the events section for a volunteer base role', async () => {
    const body = await getSummary(await mintCookie(VOLUNTEER_REG_EMAIL, 'volunteer', 'reg_volunteer'));
    expect(body.events).toBeDefined();
    expect(body.events.total_expected).toBe(0);
    expect(body.approvals).toBeUndefined();
    expect(body.forms).toBeUndefined();
  });
});

describe('unauthenticated', () => {
  it('is rejected (401)', async () => {
    // localhost + the dev-logout marker: the same pattern approvals.test.ts
    // uses — under DEV_BYPASS_AUTH a bare request to example.com would hit
    // the bypass host guard's 500 instead of the auth 401.
    const res = await SELF.fetch('http://localhost:8787/api/dashboard/summary', {
      headers: { Cookie: 'swa_dev_logout=1' },
    });
    expect(res.status).toBe(401);
  });
});
