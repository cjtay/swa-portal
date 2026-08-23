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
import { SESSION_COOKIE_NAME } from '../../../constants/portal';
import { applyMigrations, seedMember } from '../../../../test/db-helpers';

const ADMIN_EMAILS = [
  'approvals-test-admin1@example.com',
  'approvals-test-admin2@example.com',
  'approvals-test-admin3@example.com',
  'approvals-test-admin4@example.com',
  'approvals-test-admin5@example.com',
  'approvals-test-admin6@example.com',
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
    expect(item?.purchase_decision_by).toBe(PURCHASE_EMAIL);

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
