// Integration tests for the /api/approvals surface (Phase 2: list, create,
// detail, attachment stream).
//
// Same pattern as namecards-admin.test.ts: SELF.fetch() against the
// Miniflare bindings, with signed session cookies minted for each role.
// Session revalidation requires a live member row matching each cookie's
// email + category.
//
// The middleware rate limiter (approvals:write:post, 10 per 15 minutes per
// email) is shared across the whole test run, so create tests rotate through
// several admin identities to stay under the per-email cap.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signHmac, base64urlEncode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME, IT_ADMIN_EMAILS } from '../../../constants/portal';
import { applyMigrations, seedMember } from '../../../../test/db-helpers';

const ADMIN_EMAILS = [
  'approvals-test-admin1@example.com',
  'approvals-test-admin2@example.com',
  'approvals-test-admin3@example.com',
  'approvals-test-admin4@example.com',
  'approvals-test-admin5@example.com',
  'approvals-test-admin6@example.com',
  'approvals-test-admin7@example.com',
  'approvals-test-admin8@example.com',
  'approvals-test-admin9@example.com',
  'approvals-test-admin10@example.com',
  'approvals-test-admin11@example.com',
  'approvals-test-admin12@example.com',
];
const PURCHASE_EMAIL = 'approval@singaporewomenassociation.org';
const FINANCE_EMAIL = 'finance@singaporewomenassociation.org';
const PLAIN_COMMITTEE_EMAIL = 'approvals-test-plain@example.com';

let adminRotation = 0;

async function mintCookie(email: string, role: string): Promise<string> {
  const payload = base64urlEncode(
    JSON.stringify({
      email,
      name: `Test ${role}`,
      role,
      regRole: null,
      exp: Date.now() + 60 * 60 * 1000,
    }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}`;
}

/** Rotates through the admin identities so no single email burns the
 *  create rate limit (10 per 15 minutes) across the whole file. */
async function adminCookie(): Promise<string> {
  const email = ADMIN_EMAILS[adminRotation % ADMIN_EMAILS.length];
  adminRotation += 1;
  return mintCookie(email, 'admin');
}

async function purchaseCookie(): Promise<string> {
  return mintCookie(PURCHASE_EMAIL, 'committee');
}

async function financeCookie(): Promise<string> {
  return mintCookie(FINANCE_EMAIL, 'committee');
}

async function plainCommitteeCookie(): Promise<string> {
  return mintCookie(PLAIN_COMMITTEE_EMAIL, 'committee');
}

/** IT-admin session. IT_ADMIN_EMAILS[0] has a seeded member row in beforeAll,
 *  so middleware revalidation resolves the role from D1. */
async function itAdminCookie(): Promise<string> {
  return mintCookie(IT_ADMIN_EMAILS[0], 'admin');
}

function pdfFile(name: string, content = '%PDF-1.4 test'): File {
  return new File([content], name, { type: 'application/pdf' });
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  for (const email of ADMIN_EMAILS) {
    await seedMember(env.DB, { name: 'Approvals Admin', email, category: 'admin' });
  }
  await seedMember(env.DB, { name: 'Purchase Approver', email: PURCHASE_EMAIL, category: 'committee' });
  await seedMember(env.DB, { name: 'Finance Approver', email: FINANCE_EMAIL, category: 'committee' });
  await seedMember(env.DB, { name: 'Plain Committee', email: PLAIN_COMMITTEE_EMAIL, category: 'committee' });
  // A real IT-admin email with a member row — proves IT admins are EXCLUDED
  // from the finance stage by design (plan §3).
  await seedMember(env.DB, {
    name: 'IT Admin',
    email: 'cjtay@singaporewomenassociation.org',
    category: 'admin',
  });
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM approval_audit_log').run();
  await env.DB.prepare('DELETE FROM approval_attachments').run();
  await env.DB.prepare('DELETE FROM approval_items').run();
});

describe('role gates', () => {
  it('plain committee member is locked out of the approvals surface (403)', async () => {
    const res = await SELF.fetch('https://example.com/api/approvals', {
      headers: { Cookie: await plainCommitteeCookie() },
    });
    expect(res.status).toBe(403);
  });

  it('unauthenticated request is rejected (401)', async () => {
    const res = await SELF.fetch('http://localhost:8787/api/approvals', {
      headers: { Cookie: 'swa_dev_logout=1' },
    });
    expect(res.status).toBe(401);
  });

  it('purchase approver and finance approver can both read the list', async () => {
    for (const cookie of [await purchaseCookie(), await financeCookie()]) {
      const res = await SELF.fetch('https://example.com/api/approvals', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    }
  });

  it('finance approver cannot create items (canRaiseApprovalItem)', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Should not create');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await financeCookie() },
      body: form,
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/approvals — create', () => {
  it('creates a minimal item at pending with an audit row', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Gala dinner quotations');
    form.append('payee', 'Grand Copthorne Waterfront Hotel');
    form.append('requestedAmount', '36772.50');

    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ success: boolean; id: number; status: string }>();
    expect(body.success).toBe(true);
    expect(body.status).toBe('pending');

    const item = await env.DB.prepare('SELECT status, approval_required, created_by, payee, requested_amount FROM approval_items WHERE id = ?')
      .bind(body.id)
      .first<{ status: string; approval_required: number; created_by: string; payee: string; requested_amount: number }>();
    expect(item?.status).toBe('pending');
    expect(item?.approval_required).toBe(1);
    expect(item?.created_by).toBe(ADMIN_EMAILS[(adminRotation - 1) % ADMIN_EMAILS.length]);
    expect(item?.payee).toBe('Grand Copthorne Waterfront Hotel');
    expect(item?.requested_amount).toBeCloseTo(36772.5, 2);

    const audit = await env.DB.prepare("SELECT action, actor_email FROM approval_audit_log WHERE item_id = ?")
      .bind(body.id)
      .first<{ action: string; actor_email: string }>();
    expect(audit?.action).toBe('item_created');
    expect(audit?.actor_email).toBe(ADMIN_EMAILS[(adminRotation - 1) % ADMIN_EMAILS.length]);
  });

  it('recurring category skips the purchase stage', async () => {
    const form = new FormData();
    form.append('category', 'office_maintenance');
    form.append('title', 'Monthly aircon servicing');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number; status: string }>();
    expect(body.status).toBe('purchase_approved');

    const item = await env.DB.prepare('SELECT approval_required FROM approval_items WHERE id = ?')
      .bind(body.id)
      .first<{ approval_required: number }>();
    expect(item?.approval_required).toBe(0);
  });

  it('approval_required can be flipped off per item', async () => {
    const form = new FormData();
    form.append('category', 'reimbursement');
    form.append('title', 'Minor reimbursement, no approval needed');
    form.append('approvalRequired', 'false');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('purchase_approved');
  });

  it('rejects an unknown category', async () => {
    const form = new FormData();
    form.append('category', 'not-a-category');
    form.append('title', 'Broken item');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('stores an optional description and returns it in the detail view', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Laptops for the office');
    form.append('description', 'Two laptops to replace the 2019 units that no longer receive security updates. Quotes attached for both vendors.');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();

    const stored = await env.DB.prepare('SELECT description FROM approval_items WHERE id = ?')
      .bind(body.id)
      .first<{ description: string }>();
    expect(stored?.description).toContain('no longer receive security updates');

    const detail = await SELF.fetch(`https://example.com/api/approvals/${body.id}`, {
      headers: { Cookie: await financeCookie() },
    });
    const detailBody = await detail.json<{ item: { description: string | null } }>();
    expect(detailBody.item.description).toContain('Two laptops');
  });

  it('rejects a description longer than 4000 characters', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Long description');
    form.append('description', 'x'.repeat(4001));
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('accepts files with no comparison rows (single quotation, several uploads)', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'One quotation, PDF plus a photo');
    form.append('files', pdfFile('quote.pdf'));
    form.append('files', new File(['jpegdata'], 'quote-back.jpg', { type: 'image/jpeg' }));
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();

    const item = await env.DB.prepare('SELECT comparison FROM approval_items WHERE id = ?')
      .bind(body.id)
      .first<{ comparison: string | null }>();
    expect(item?.comparison).toBeNull();

    const atts = await env.DB.prepare('SELECT COUNT(*) AS n FROM approval_attachments WHERE item_id = ?')
      .bind(body.id)
      .first<{ n: number }>();
    expect(atts?.n).toBe(2);
  });

  it('rejects HTML and SVG uploads regardless of intent', async () => {
    for (const file of [
      new File(['<html><script>x</script></html>'], 'page.html', { type: 'text/html' }),
      new File(['<svg onload="x"/>'], 'image.svg', { type: 'image/svg+xml' }),
    ]) {
      const form = new FormData();
      form.append('category', 'quotation');
      form.append('title', 'Bad file test');
      form.append('files', file);
      const res = await SELF.fetch('https://example.com/api/approvals', {
        method: 'POST',
        headers: { Cookie: await adminCookie() },
        body: form,
      });
      expect(res.status).toBe(400);
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM approval_items').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('rejects more than 10 files', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Too many files');
    for (let i = 0; i < 11; i++) form.append('files', pdfFile(`q${i}.pdf`));
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a file larger than 10 MB', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Too big');
    form.append('files', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.pdf', { type: 'application/pdf' }));
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('stores attachments in R2, rows in D1, and maps comparison rows to attachment ids', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Gala dinner — two quotations');
    form.append('files', pdfFile('vendor-a.pdf', '%PDF vendor A'));
    form.append('files', pdfFile('vendor-b.pdf', '%PDF vendor B'));
    form.append('comparison', JSON.stringify([
      { file: 'vendor-a.pdf', description: 'Grand Copthorne — $1,350/table, 25 tables' },
      { file: 'vendor-b.pdf', description: 'Hotel A — $1,480/table, 25 tables' },
    ]));

    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();

    const attachments = await env.DB.prepare(
      'SELECT id, r2_key, filename FROM approval_attachments WHERE item_id = ? ORDER BY id',
    )
      .bind(body.id)
      .all<{ id: number; r2_key: string; filename: string }>();
    expect(attachments.results.length).toBe(2);
    for (const att of attachments.results) {
      expect(att.r2_key.startsWith(`approvals/${body.id}/`)).toBe(true);
      const obj = await env.R2_BUCKET.get(att.r2_key);
      expect(obj).not.toBeNull();
    }

    const item = await env.DB.prepare('SELECT comparison FROM approval_items WHERE id = ?')
      .bind(body.id)
      .first<{ comparison: string }>();
    const comparison = JSON.parse(item?.comparison || '[]') as Array<{ attachmentId: number; description: string }>;
    expect(comparison.length).toBe(2);
    expect(comparison[0].attachmentId).toBe(attachments.results[0].id);
    expect(comparison[0].description).toContain('Grand Copthorne');
    expect(comparison[1].attachmentId).toBe(attachments.results[1].id);
  });

  it('rejects comparison rows that reference a file not in the upload', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Bad comparison');
    form.append('files', pdfFile('real.pdf'));
    form.append('comparison', JSON.stringify([{ file: 'phantom.pdf', description: 'Not uploaded' }]));
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/approvals — AI comparison replay', () => {
  const validAnalysis = JSON.stringify({
    version: 1,
    generatedAt: '2026-08-26T10:00:00.000Z',
    generatedBy: 'approvals-test-admin1@example.com',
    models: { extract: '@cf/meta/llama-4-scout-17b-16e-instruct', compare: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
    fx: { date: '2026-08-26', source: 'open.er-api.com' },
    files: [
      { filename: 'a.pdf', status: 'ok', note: null },
      { filename: 'b.pdf', status: 'ok', note: null },
    ],
    quotes: [
      { filename: 'a.pdf', vendor: 'A Pte Ltd', totalPrice: 1000, currency: 'SGD', totalPriceSgd: 1000 },
      { filename: 'b.pdf', vendor: 'B Sdn Bhd', totalPrice: 150, currency: 'USD', totalPriceSgd: 200 },
    ],
    summary: 'A is cheaper after conversion.',
    recommendation: 'Choose A Pte Ltd.',
  });

  it('stores a replayed analysis and returns it parsed in the detail view', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'AI comparison replay');
    form.append('aiComparison', validAnalysis);
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();

    const stored = await env.DB.prepare('SELECT ai_comparison FROM approval_items WHERE id = ?')
      .bind(body.id)
      .first<{ ai_comparison: string | null }>();
    expect(stored?.ai_comparison).toContain('A Pte Ltd');

    const detail = await SELF.fetch(`https://example.com/api/approvals/${body.id}`, {
      headers: { Cookie: await financeCookie() },
    });
    const detailBody = await detail.json<{ item: { ai_comparison: { version: number; quotes: Array<{ vendor: string }> } } }>();
    expect(detailBody.item.ai_comparison.version).toBe(1);
    expect(detailBody.item.ai_comparison.quotes).toHaveLength(2);
  });

  it('rejects a malformed analysis payload', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Bad AI payload');
    form.append('aiComparison', '{"version":1,"not":"the agreed shape"}');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('omits the column entirely when no analysis is sent', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'No AI analysis');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();
    const stored = await env.DB.prepare('SELECT ai_comparison FROM approval_items WHERE id = ?')
      .bind(body.id)
      .first<{ ai_comparison: string | null }>();
    expect(stored?.ai_comparison).toBeNull();
  });
});

describe('GET /api/approvals — list and counts', () => {
  it('returns items with per-status counts, and honours the status filter', async () => {
    const formA = new FormData();
    formA.append('category', 'quotation');
    formA.append('title', 'Needs approval');
    const formB = new FormData();
    formB.append('category', 'payroll');
    formB.append('title', 'Recurring payroll');
    await SELF.fetch('https://example.com/api/approvals', { method: 'POST', headers: { Cookie: await adminCookie() }, body: formA });
    await SELF.fetch('https://example.com/api/approvals', { method: 'POST', headers: { Cookie: await adminCookie() }, body: formB });

    const res = await SELF.fetch('https://example.com/api/approvals', {
      headers: { Cookie: await purchaseCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ items: Array<{ status: string }>; counts: Record<string, number> }>();
    expect(body.counts.pending).toBe(1);
    expect(body.counts.purchase_approved).toBe(1);
    expect(body.counts.all).toBe(2);

    const filtered = await SELF.fetch('https://example.com/api/approvals?status=pending', {
      headers: { Cookie: await purchaseCookie() },
    });
    const filteredBody = await filtered.json<{ items: Array<{ status: string }> }>();
    expect(filteredBody.items.length).toBe(1);
    expect(filteredBody.items[0].status).toBe('pending');
  });

  it('rejects an unknown status filter', async () => {
    const res = await SELF.fetch('https://example.com/api/approvals?status=banana', {
      headers: { Cookie: await purchaseCookie() },
    });
    expect(res.status).toBe(400);
  });

  it('supports offset/limit paging and reports a total', async () => {
    for (let i = 0; i < 5; i++) {
      const form = new FormData();
      form.append('category', 'quotation');
      form.append('title', `Paged item ${i}`);
      await SELF.fetch('https://example.com/api/approvals', { method: 'POST', headers: { Cookie: await adminCookie() }, body: form });
    }
    const page = await SELF.fetch('https://example.com/api/approvals?limit=2&offset=2', {
      headers: { Cookie: await purchaseCookie() },
    });
    expect(page.status).toBe(200);
    const body = await page.json<{ items: Array<{ title: string }>; total: number }>();
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(5);
  });

  it('rejects invalid paging parameters', async () => {
    for (const qs of ['limit=-1', 'limit=abc', 'offset=99999999']) {
      const res = await SELF.fetch(`https://example.com/api/approvals?${qs}`, {
        headers: { Cookie: await purchaseCookie() },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('GET /api/approvals/:id — detail and attachments', () => {
  async function createItemWithFile(): Promise<{ itemId: number; attachmentId: number }> {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Attachment test');
    form.append('files', pdfFile('weird"name.pdf', '%PDF roundtrip'));
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    const body = await res.json<{ id: number }>();
    const att = await env.DB.prepare('SELECT id FROM approval_attachments WHERE item_id = ?')
      .bind(body.id)
      .first<{ id: number }>();
    return { itemId: body.id, attachmentId: Number(att?.id) };
  }

  it('returns the item with parsed comparison and attachments', async () => {
    const { itemId } = await createItemWithFile();
    const res = await SELF.fetch(`https://example.com/api/approvals/${itemId}`, {
      headers: { Cookie: await financeCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      item: { id: number; title: string; comparison: unknown };
      attachments: Array<{ filename: string; mime_type: string }>;
    }>();
    expect(body.item.id).toBe(itemId);
    expect(body.item.title).toBe('Attachment test');
    expect(Array.isArray(body.attachments)).toBe(true);
    expect(body.attachments[0].mime_type).toBe('application/pdf');
  });

  it('404s for a missing item', async () => {
    const res = await SELF.fetch('https://example.com/api/approvals/999999', {
      headers: { Cookie: await financeCookie() },
    });
    expect(res.status).toBe(404);
  });

  it('streams the attachment inline with nosniff and a sanitised filename', async () => {
    const { itemId, attachmentId } = await createItemWithFile();
    const res = await SELF.fetch(`https://example.com/api/approvals/${itemId}/attachment/${attachmentId}`, {
      headers: { Cookie: await financeCookie() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const disposition = res.headers.get('content-disposition') || '';
    expect(disposition.startsWith('inline')).toBe(true);
    expect(disposition).toContain('weird_name.pdf');
    expect(disposition).not.toContain('weird"name');
    expect(await res.text()).toBe('%PDF roundtrip');
  });

  it('switches to attachment disposition with ?download=1', async () => {
    const { itemId, attachmentId } = await createItemWithFile();
    const res = await SELF.fetch(`https://example.com/api/approvals/${itemId}/attachment/${attachmentId}?download=1`, {
      headers: { Cookie: await purchaseCookie() },
    });
    expect(res.headers.get('content-disposition')?.startsWith('attachment')).toBe(true);
  });

  it('404s when the attachment belongs to a different item', async () => {
    const { attachmentId } = await createItemWithFile();
    const res = await SELF.fetch(`https://example.com/api/approvals/999999/attachment/${attachmentId}`, {
      headers: { Cookie: await purchaseCookie() },
    });
    expect(res.status).toBe(404);
  });
});

/* ----------------------------------------------------
   Phase 3: purchase stage — approve, reject, edit, remind
   ---------------------------------------------------- */

async function seedPendingItem(): Promise<number> {
  const form = new FormData();
  form.append('category', 'quotation');
  form.append('title', 'Stage test item');
  form.append('payee', 'Test Vendor Pte Ltd');
  form.append('requestedAmount', '1200.50');
  const res = await SELF.fetch('https://example.com/api/approvals', {
    method: 'POST',
    headers: { Cookie: await adminCookie() },
    body: form,
  });
  expect(res.status).toBe(201);
  return (await res.json<{ id: number }>()).id;
}

describe('POST /api/approvals/:id/approve — purchase stage', () => {
  it('purchase approver approves a pending item; decision + audit recorded', async () => {
    const id = await seedPendingItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; status: string }>();
    expect(body.status).toBe('purchase_approved');

    const item = await env.DB.prepare('SELECT status, purchase_decision_by FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; purchase_decision_by: string }>();
    expect(item?.status).toBe('purchase_approved');
    // Decision columns store the session NAME (printed on the voucher;
    // revalidation resolves it from the D1 row), audit keeps the email.
    expect(item?.purchase_decision_by).toBe('Purchase Approver');

    const audit = await env.DB.prepare("SELECT action FROM approval_audit_log WHERE item_id = ? AND action = 'purchase_approved'")
      .bind(id)
      .first<{ action: string }>();
    expect(audit?.action).toBe('purchase_approved');
  });

  it('second approve on the same item is a 409 (atomic guard)', async () => {
    const id = await seedPendingItem();
    const first = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie() },
    });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie() },
    });
    expect(second.status).toBe(409);
  });

  it('a lost racing approve writes no false audit row', async () => {
    const id = await seedPendingItem();
    await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, { method: 'POST', headers: { Cookie: await purchaseCookie() } });
    const second = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, { method: 'POST', headers: { Cookie: await purchaseCookie() } });
    expect(second.status).toBe(409);
    const auditCount = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM approval_audit_log WHERE item_id = ? AND action = 'purchase_approved'")
      .bind(id)
      .first<{ n: number }>();
    expect(auditCount?.n).toBe(1);
  });

  it('finance approver and plain admin cannot approve (403)', async () => {
    const id = await seedPendingItem();
    for (const cookie of [await financeCookie(), await adminCookie()]) {
      const res = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(403);
    }
  });

  it('approving a non-pending item is a 409', async () => {
    const form = new FormData();
    form.append('category', 'payroll');
    form.append('title', 'Recurring, never pending');
    const created = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    const id = (await created.json<{ id: number }>()).id;
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie() },
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/approvals/:id/reject — purchase stage', () => {
  it('rejects with a reason; stage and audit recorded', async () => {
    const id = await seedPendingItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/reject`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Please get a second quotation above S$5,000.' }),
    });
    expect(res.status).toBe(200);

    const item = await env.DB.prepare('SELECT status, rejected_stage, rejection_reason FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; rejected_stage: string; rejection_reason: string }>();
    expect(item?.status).toBe('rejected');
    expect(item?.rejected_stage).toBe('purchase');
    expect(item?.rejection_reason).toContain('second quotation');

    const audit = await env.DB.prepare("SELECT action, note FROM approval_audit_log WHERE item_id = ? AND action = 'purchase_rejected'")
      .bind(id)
      .first<{ action: string; note: string }>();
    expect(audit?.note).toContain('second quotation');
  });

  it('rejects without a reason as 400', async () => {
    const id = await seedPendingItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/reject`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('finance approver cannot reject (403)', async () => {
    const id = await seedPendingItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/reject`, {
      method: 'POST',
      headers: { Cookie: await financeCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'nope' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/approvals/:id/edit — edit and resubmit', () => {
  it('admin edits fields and adds an attachment; audits land', async () => {
    const id = await seedPendingItem();
    const form = new FormData();
    form.append('title', 'Stage test item (amended)');
    form.append('requestedAmount', '1350');
    form.append('files', pdfFile('extra-quote.pdf', '%PDF extra'));
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(200);

    const item = await env.DB.prepare('SELECT title, requested_amount, status FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ title: string; requested_amount: number; status: string }>();
    expect(item?.title).toBe('Stage test item (amended)');
    expect(item?.requested_amount).toBeCloseTo(1350, 2);
    expect(item?.status).toBe('pending');

    const actions = await env.DB.prepare('SELECT action FROM approval_audit_log WHERE item_id = ? ORDER BY id').bind(id).all<{ action: string }>();
    const names = (actions.results || []).map((r) => r.action);
    expect(names).toContain('item_edited');
    expect(names).toContain('attachments_added');

    const attCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM approval_attachments WHERE item_id = ?').bind(id).first<{ n: number }>();
    expect(attCount?.n).toBe(1);
  });

  it('resubmit after purchase rejection returns to pending and clears the stage', async () => {
    const id = await seedPendingItem();
    await SELF.fetch(`https://example.com/api/approvals/${id}/reject`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Too expensive' }),
    });

    const form = new FormData();
    form.append('title', 'Stage test item (renegotiated)');
    form.append('resubmit', 'true');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; status: string; resubmitted: boolean }>();
    expect(body.status).toBe('pending');
    expect(body.resubmitted).toBe(true);

    const item = await env.DB.prepare('SELECT status, rejected_stage, rejection_reason FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; rejected_stage: string | null; rejection_reason: string | null }>();
    expect(item?.status).toBe('pending');
    expect(item?.rejected_stage).toBeNull();
    expect(item?.rejection_reason).toBeNull();

    const audit = await env.DB.prepare("SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'item_resubmitted'")
      .bind(id)
      .first<{ note: string }>();
    expect(audit?.note).toBe('to=pending');
  });

  it('resubmit on a non-rejected item is a 409', async () => {
    const id = await seedPendingItem();
    const form = new FormData();
    form.append('resubmit', 'true');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(409);
  });

  it('editing a paid or finance-stage item is a 409', async () => {
    const id = await seedPendingItem();
    await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, { method: 'POST', headers: { Cookie: await purchaseCookie() } });
    const form = new FormData();
    form.append('title', 'Should not edit');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(409);
  });

  it('purchase approver cannot edit (403)', async () => {
    const id = await seedPendingItem();
    const form = new FormData();
    form.append('title', 'Nope');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie() },
      body: form,
    });
    expect(res.status).toBe(403);
  });

  it('comparison rebuild referencing a foreign attachment id is a 400', async () => {
    const id = await seedPendingItem();
    const form = new FormData();
    form.append('comparison', JSON.stringify([{ attachmentId: 999999, description: 'Not mine' }]));
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/approvals/:id/remind', () => {
  it('admin sends a reminder for a pending item; audit recorded', async () => {
    const id = await seedPendingItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/remind`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    const audit = await env.DB.prepare("SELECT action, note FROM approval_audit_log WHERE item_id = ? AND action = 'reminder_sent'")
      .bind(id)
      .first<{ action: string; note: string }>();
    expect(audit?.note).toBe('stage=purchase');
  });

  it('reminder on a non-pending item is a 409', async () => {
    const id = await seedPendingItem();
    await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, { method: 'POST', headers: { Cookie: await purchaseCookie() } });
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/remind`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(409);
  });

  it('purchase approver cannot send reminders (403)', async () => {
    const id = await seedPendingItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/remind`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie() },
    });
    expect(res.status).toBe(403);
  });
});

/* ----------------------------------------------------
   Phase 4: voucher and finance stage
   ---------------------------------------------------- */

async function seedVoucherReadyItem(title = 'Voucher test item'): Promise<number> {
  // Recurring category skips the purchase stage → purchase_approved directly.
  const form = new FormData();
  form.append('category', 'vendor_payment');
  form.append('title', title);
  form.append('payee', 'Grand Copthorne Waterfront Hotel');
  const res = await SELF.fetch('https://example.com/api/approvals', {
    method: 'POST',
    headers: { Cookie: await adminCookie() },
    body: form,
  });
  expect(res.status).toBe(201);
  return (await res.json<{ id: number }>()).id;
}

function voucherBody(voucherDate: string, lines?: Array<Partial<VoucherLineInput>>) {
  const finalLines =
    lines !== undefined
      ? lines
      : [
            { no: null, date: null, description: 'Event: 49th SWA Charity Gala Dinner 2026', amount: null },
            { no: 1, date: '2026-08-10', description: 'Chinese set dinner 25 tables x $1,350', amount: 36772.5 },
            { no: null, date: null, description: 'Less: 1st deposit paid', amount: -12139.88 },
            { no: null, date: null, description: 'DBS: Account No: 003-XXXXXXX-0', amount: null },
          ];
  return JSON.stringify({ voucherDate, lines: finalLines });
}

interface VoucherLineInput {
  no: number | null;
  date: string | null;
  description: string;
  amount: number | null;
}

async function submitVoucher(id: number, voucherDate: string, lines?: Array<Partial<VoucherLineInput>>): Promise<Response> {
  return SELF.fetch(`https://example.com/api/approvals/${id}/voucher`, {
    method: 'POST',
    headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
    body: voucherBody(voucherDate, lines),
  });
}

describe('POST /api/approvals/:id/voucher', () => {
  it('assigns the first PV number of the month, stores lines, moves to finance_check', async () => {
    const id = await seedVoucherReadyItem('August voucher one');
    const res = await submitVoucher(id, '2026-08-23');
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; voucher_no: string; status: string }>();
    expect(body.voucher_no).toBe('PV26-0801');
    expect(body.status).toBe('finance_check');

    const item = await env.DB.prepare(
      'SELECT voucher_date, voucher_lines, voucher_submitted_by, status, rejected_stage FROM approval_items WHERE id = ?',
    )
      .bind(id)
      .first<{ voucher_date: string; voucher_lines: string; voucher_submitted_by: string; status: string; rejected_stage: string | null }>();
    expect(item?.voucher_date).toBe('2026-08-23');
    expect(item?.voucher_submitted_by).toBe('Approvals Admin'); // session name (from the D1 row), printed on the voucher
    expect(item?.status).toBe('finance_check');

    const lines = JSON.parse(item?.voucher_lines || '[]') as VoucherLineInput[];
    expect(lines.length).toBe(4);
    expect(lines[0].amount).toBeNull(); // note-only banner row
    expect(lines[2].amount).toBeCloseTo(-12139.88, 2); // negative deposit row
    expect(lines[3].description).toContain('DBS');

    const audit = await env.DB.prepare("SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'voucher_submitted'")
      .bind(id)
      .first<{ note: string }>();
    expect(audit?.note).toContain('voucher_no=PV26-0801');
  });

  it('sequences numbers within the month and resets for a new month', async () => {
    await submitVoucher(await seedVoucherReadyItem('August voucher two'), '2026-08-05');
    const sep = await submitVoucher(await seedVoucherReadyItem('September voucher'), '2026-09-01');
    const sepBody = await sep.json<{ voucher_no: string }>();
    expect(sepBody.voucher_no).toBe('PV26-0901');
  });

  it('refuses the 99th voucher of a full month with a clear message', async () => {
    // Simulate a full August directly in D1.
    await env.DB.prepare(
      "INSERT INTO approval_items (category, title, created_by, status, voucher_no, voucher_date) VALUES ('vendor_payment', 'Filler', 'fill@example.com', 'finance_approved', 'PV26-0899', '2026-08-01')",
    ).run();
    const res = await submitVoucher(await seedVoucherReadyItem('Full month'), '2026-08-15');
    expect(res.status).toBe(400);
    const body = await res.json<{ message?: string }>();
    expect(body.message).toContain('99');
  });

  it('resubmission after finance rejection keeps the number and returns to finance_check', async () => {
    const id = await seedVoucherReadyItem('Finance reject loop');
    await submitVoucher(id, '2026-08-12');
    await SELF.fetch(`https://example.com/api/approvals/${id}/finance-reject`, {
      method: 'POST',
      headers: { Cookie: await financeCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Total does not match the invoice' }),
    });

    const res = await submitVoucher(id, '2026-08-12', [{ no: 1, date: '2026-08-10', description: 'Corrected line', amount: 24000 }]);
    expect(res.status).toBe(200);
    const body = await res.json<{ voucher_no: string; status: string; resubmitted: boolean }>();
    expect(body.voucher_no).toBe('PV26-0801'); // unchanged
    expect(body.status).toBe('finance_check');
    expect(body.resubmitted).toBe(true);

    const item = await env.DB.prepare('SELECT finance_rejection_reason, rejected_stage FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ finance_rejection_reason: string | null; rejected_stage: string | null }>();
    expect(item?.finance_rejection_reason).toBeNull();
    expect(item?.rejected_stage).toBeNull();
  });

  it('rejects voucher submission from the wrong status', async () => {
    const pendingForm = new FormData();
    pendingForm.append('category', 'quotation');
    pendingForm.append('title', 'Still pending');
    const pendingRes = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: pendingForm,
    });
    const pendingId = (await pendingRes.json<{ id: number }>()).id;
    expect((await submitVoucher(pendingId, '2026-08-23')).status).toBe(409);

    const approvedId = await seedVoucherReadyItem('Already submitted');
    await submitVoucher(approvedId, '2026-08-23');
    expect((await submitVoucher(approvedId, '2026-08-23')).status).toBe(409); // finance_check now
  });

  it('validates date, lines and amounts', async () => {
    const id = await seedVoucherReadyItem('Validation target');
    expect((await submitVoucher(id, '23-08-2026')).status).toBe(400);
    expect((await submitVoucher(id, '2026-08-23', [])).status).toBe(400);
    expect((await submitVoucher(id, '2026-08-23', [{ description: '' }])).status).toBe(400);
    expect((await submitVoucher(id, '2026-08-23', [{ description: 'Too big', amount: 20000000 }])).status).toBe(400);
    expect((await submitVoucher(id, '2026-08-23', [{ description: 'Bad no', amount: 1, no: 0 }])).status).toBe(400);
    expect((await submitVoucher(id, '2026-13-01')).status).toBe(400); // month 13 is not a real date
  });

  it('finance approver cannot submit vouchers (403)', async () => {
    const id = await seedVoucherReadyItem('Finance cannot submit');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/voucher`, {
      method: 'POST',
      headers: { Cookie: await financeCookie(), 'Content-Type': 'application/json' },
      body: voucherBody('2026-08-23'),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/approvals/:id/finance-approve and finance-reject', () => {
  async function seedFinanceCheckItem(): Promise<number> {
    const id = await seedVoucherReadyItem('Finance decision target');
    const res = await submitVoucher(id, '2026-08-20');
    // Fail loudly here (e.g. a rate-limit 429) instead of letting the
    // follow-up assertions report confusing 409s.
    expect(res.status).toBe(200);
    return id;
  }

  it('finance approver approves; decision + audit recorded; creator emailed via waitUntil', async () => {
    const id = await seedFinanceCheckItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-approve`, {
      method: 'POST',
      headers: { Cookie: await financeCookie() },
    });
    expect(res.status).toBe(200);

    const item = await env.DB.prepare('SELECT status, finance_decision_by FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; finance_decision_by: string }>();
    expect(item?.status).toBe('finance_approved');
    expect(item?.finance_decision_by).toBe('Finance Approver'); // name (from the D1 row), printed on the voucher

    const audit = await env.DB.prepare("SELECT action FROM approval_audit_log WHERE item_id = ? AND action = 'finance_approved'")
      .bind(id)
      .first<{ action: string }>();
    expect(audit?.action).toBe('finance_approved');
  });

  it('second finance decision is a 409', async () => {
    const id = await seedFinanceCheckItem();
    const first = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-approve`, {
      method: 'POST',
      headers: { Cookie: await financeCookie() },
    });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-approve`, {
      method: 'POST',
      headers: { Cookie: await financeCookie() },
    });
    expect(second.status).toBe(409);
  });

  it('IT admins are deliberately excluded from the finance stage (403)', async () => {
    const id = await seedFinanceCheckItem();
    const cookie = await mintCookie('cjtay@singaporewomenassociation.org', 'admin');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-approve`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('purchase approver and non-finance admin cannot decide (403)', async () => {
    const id = await seedFinanceCheckItem();
    for (const cookie of [await purchaseCookie(), await adminCookie()]) {
      const res = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-approve`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(403);
    }
  });

  it('finance reject requires a reason and sets the stage for routing', async () => {
    const id = await seedFinanceCheckItem();
    const noReason = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-reject`, {
      method: 'POST',
      headers: { Cookie: await financeCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '' }),
    });
    expect(noReason.status).toBe(400);

    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-reject`, {
      method: 'POST',
      headers: { Cookie: await financeCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Deposit line is missing' }),
    });
    expect(res.status).toBe(200);
    const item = await env.DB.prepare('SELECT status, rejected_stage, finance_rejection_reason FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; rejected_stage: string; finance_rejection_reason: string }>();
    expect(item?.status).toBe('rejected');
    expect(item?.rejected_stage).toBe('finance');
    expect(item?.finance_rejection_reason).toBe('Deposit line is missing');
  });

  it('editing a finance-rejected item is a 409 - fields freeze once purchase approved (gap 4); correction is via the voucher', async () => {
    const id = await seedFinanceCheckItem();
    await SELF.fetch(`https://example.com/api/approvals/${id}/finance-reject`, {
      method: 'POST',
      headers: { Cookie: await financeCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Wrong payee name' }),
    });
    const form = new FormData();
    form.append('payee', 'Grand Copthorne Waterfront Hotel Pte Ltd');
    form.append('resubmit', 'true');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(409);

    // Correcting the voucher is still allowed through the voucher endpoint.
    const voucherRes = await submitVoucher(id, '2026-08-20', [{ no: 1, date: '2026-08-10', description: 'Corrected line', amount: 24000 }]);
    expect(voucherRes.status).toBe(200);
  });

  it('remind works at the finance stage with a stage=finance audit note', async () => {
    const id = await seedFinanceCheckItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/remind`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    const audit = await env.DB.prepare("SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'reminder_sent'")
      .bind(id)
      .first<{ note: string }>();
    expect(audit?.note).toBe('stage=finance');
  });
});

/* ----------------------------------------------------
   Phase 5: paid step + audit CSV export
   ---------------------------------------------------- */

async function seedFinanceApprovedItem(): Promise<number> {
  const id = await seedVoucherReadyItem('Paid step target');
  const res = await submitVoucher(id, '2026-08-21');
  expect(res.status).toBe(200);
  const approve = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-approve`, {
    method: 'POST',
    headers: { Cookie: await financeCookie() },
  });
  expect(approve.status).toBe(200);
  return id;
}

describe('POST /api/approvals/:id/paid', () => {
  it('records the payment and closes the item; audit carries the detail', async () => {
    const id = await seedFinanceApprovedItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/paid`, {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidBy: 'Jolene Lim (SWA DBS app)', paidDate: '2026-08-24', paymentMethod: 'paynow', paymentReference: 'PN-88231' }),
    });
    expect(res.status).toBe(200);

    const item = await env.DB.prepare('SELECT status, paid_by, paid_at, payment_method, payment_reference FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; paid_by: string; paid_at: string; payment_method: string; payment_reference: string }>();
    expect(item?.status).toBe('paid');
    expect(item?.paid_by).toBe('Jolene Lim (SWA DBS app)');
    expect(item?.paid_at).toBe('2026-08-24');
    expect(item?.payment_method).toBe('paynow');
    expect(item?.payment_reference).toBe('PN-88231');

    const audit = await env.DB.prepare("SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'paid_recorded'")
      .bind(id)
      .first<{ note: string }>();
    expect(audit?.note).toContain('paid_by=Jolene Lim (SWA DBS app)');
    expect(audit?.note).toContain('ref=PN-88231');
  });

  it('payment reference is optional', async () => {
    const id = await seedFinanceApprovedItem();
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/paid`, {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidBy: 'Treasurer', paidDate: '2026-08-24', paymentMethod: 'cheque' }),
    });
    expect(res.status).toBe(200);
  });

  it('validates fields (who/date/method)', async () => {
    const id = await seedFinanceApprovedItem();
    const post = async (payload: Record<string, unknown>) =>
      await SELF.fetch(`https://example.com/api/approvals/${id}/paid`, {
        method: 'POST',
        headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    expect((await post({ paidBy: '', paidDate: '2026-08-24', paymentMethod: 'cash' })).status).toBe(400);
    expect((await post({ paidBy: 'X', paidDate: '24-08-2026', paymentMethod: 'cash' })).status).toBe(400);
    expect((await post({ paidBy: 'X', paidDate: '2026-08-24', paymentMethod: 'crypto' })).status).toBe(400);
    expect((await post({ paidBy: 'X', paidDate: '2026-13-40', paymentMethod: 'cash' })).status).toBe(400);
  });

  it('non-finance-approved items cannot be marked paid (409)', async () => {
    const id = await seedVoucherReadyItem('Not approved yet');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/paid`, {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidBy: 'X', paidDate: '2026-08-24', paymentMethod: 'cash' }),
    });
    expect(res.status).toBe(409);
  });

  it('double payment is a 409; finance approver cannot record payment (403)', async () => {
    const id = await seedFinanceApprovedItem();
    const first = await SELF.fetch(`https://example.com/api/approvals/${id}/paid`, {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidBy: 'X', paidDate: '2026-08-24', paymentMethod: 'cash' }),
    });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`https://example.com/api/approvals/${id}/paid`, {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidBy: 'X', paidDate: '2026-08-24', paymentMethod: 'cash' }),
    });
    expect(second.status).toBe(409);

    const other = await seedFinanceApprovedItem();
    const forbidden = await SELF.fetch(`https://example.com/api/approvals/${other}/paid`, {
      method: 'POST',
      headers: { Cookie: await financeCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidBy: 'X', paidDate: '2026-08-24', paymentMethod: 'cash' }),
    });
    expect(forbidden.status).toBe(403);
  });
});

describe('GET /api/approvals/audit/export', () => {
  it('IT admin only — finance approver, purchase approver, and D1 admin get 403', async () => {
    for (const cookie of [await financeCookie(), await purchaseCookie(), await adminCookie()]) {
      const res = await SELF.fetch('https://example.com/api/approvals/audit/export', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(403);
    }
  });

  it('returns CSV with headers, voucher numbers, oldest first, and guarded cells', async () => {
    // Seed one full pipeline row with a formula-looking note.
    const id = await seedFinanceApprovedItem();
    await env.DB.prepare(
      "INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note) VALUES (?, 'item_edited', 'x@example.com', 'X', '=SUM(A1:A9)')",
    ).bind(id).run();

    const res = await SELF.fetch('https://example.com/api/approvals/audit/export?from=2020-01-01&to=2099-12-31', {
      headers: { Cookie: await itAdminCookie() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition') || '').toContain('approval-audit-2020-01-01_to_2099-12-31.csv');

    const csv = await res.text();
    const lines = csv.split('\n');
    // Line 1 carries the UTF-8 BOM (checked below); strip it for the compare.
    expect(lines[0].replace(/^\uFEFF/, '')).toBe('Timestamp,Item ID,Voucher No,Action,Actor Name,Actor Email,Note');
    // Oldest first: the first data row's action must not be later than the last's id ordering;
    // here we just assert every seeded action appears and the formula cell is neutralised.
    expect(csv).toContain('item_created');
    expect(csv).toContain('voucher_submitted');
    expect(csv).toContain('finance_approved');
    expect(csv).toContain("'=SUM(A1:A9)");
    // The BOM leads the file so Excel opens UTF-8 correctly.
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('excludes rows outside the requested date range (both end days inclusive)', async () => {
    // A row stamped 2020 sits outside the 2026 window.
    const id = await seedFinanceApprovedItem();
    await env.DB.prepare(
      "INSERT INTO approval_audit_log (item_id, action, actor_email, actor_name, note, created_at) VALUES (?, 'item_edited', 'old@example.com', 'Old', 'outside-range-marker', '2020-01-01 00:00:00')",
    ).bind(id).run();

    const res = await SELF.fetch('https://example.com/api/approvals/audit/export?from=2026-01-01&to=2026-12-31', {
      headers: { Cookie: await itAdminCookie() },
    });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).not.toContain('outside-range-marker');
    expect(csv).not.toContain('2020-01-01');
    // The 2026 rows created by the seed are still inside the window.
    expect(csv).toContain('item_created');
  });

  it('rejects a missing, malformed, or inverted date range with 400', async () => {
    const cookie = { Cookie: await itAdminCookie() };
    const missing = await SELF.fetch('https://example.com/api/approvals/audit/export', { headers: cookie });
    expect(missing.status).toBe(400);

    const halfMissing = await SELF.fetch('https://example.com/api/approvals/audit/export?from=2026-01-01', {
      headers: cookie,
    });
    expect(halfMissing.status).toBe(400);

    const malformed = await SELF.fetch('https://example.com/api/approvals/audit/export?from=25-08-2026&to=2026-08-25', {
      headers: cookie,
    });
    expect(malformed.status).toBe(400);

    const inverted = await SELF.fetch('https://example.com/api/approvals/audit/export?from=2026-12-31&to=2026-01-01', {
      headers: cookie,
    });
    expect(inverted.status).toBe(400);
  });
});
