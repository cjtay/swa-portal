// Integration tests for the approvals finance-policy compliance build
// (docs/plans/approvals-finance-compliance-implementation-plan.md §11,
// Batch A cases 1-8): self-approval guard, office capture, the S$5,000
// two-stage force, and the invoice number with its duplicate warning.
//
// Same pattern as approvals.test.ts: SELF.fetch() against the Miniflare
// bindings, signed session cookies minted per role, schema.sql as the
// baseline. This file owns its own rotating admin-email list so the shared
// approvals:write:post bucket (10 per 15 minutes per email) never trips.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signHmac, base64urlEncode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME, IT_ADMIN_EMAILS } from '../../../constants/portal';
import { applyMigrations, seedMember } from '../../../../test/db-helpers';

const ADMIN_EMAILS = [
  'approvals-compliance-admin1@example.com',
  'approvals-compliance-admin2@example.com',
  'approvals-compliance-admin3@example.com',
  'approvals-compliance-admin4@example.com',
  'approvals-compliance-admin5@example.com',
  'approvals-compliance-admin6@example.com',
  'approvals-compliance-admin7@example.com',
  'approvals-compliance-admin8@example.com',
];
const PURCHASE_EMAIL = 'approval@singaporewomenassociation.org';
const FINANCE_EMAIL = 'finance@singaporewomenassociation.org';
const IT_ADMIN = IT_ADMIN_EMAILS[0]; // cjtay@ — purchase approver via the IT-admin union

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

/** Rotates admin identities so create+voucher writes stay under the
 *  approvals:write:post cap across the whole file. */
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

function pdfFile(name: string, content = '%PDF-1.4 test'): File {
  return new File([content], name, { type: 'application/pdf' });
}

interface CreateOptions {
  category?: string;
  title?: string;
  amount?: string;
  file?: boolean;
}

/** Create an item as a fresh rotating admin; returns the item id. */
async function createItem(opts: CreateOptions = {}): Promise<number> {
  const form = new FormData();
  form.append('category', opts.category ?? 'quotation');
  form.append('title', opts.title ?? 'Compliance test item');
  if (opts.amount !== undefined) form.append('requestedAmount', opts.amount);
  if (opts.file !== false) form.append('files', pdfFile('quote.pdf'));
  const res = await SELF.fetch('https://example.com/api/approvals', {
    method: 'POST',
    headers: { Cookie: await adminCookie() },
    body: form,
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ success: boolean; id: number }>();
  expect(body.success).toBe(true);
  return body.id;
}

async function purchaseApprove(id: number): Promise<void> {
  const res = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, {
    method: 'POST',
    headers: { Cookie: await purchaseCookie(), 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(200);
}

/** Purchase-approve the item then submit its voucher with an invoice number. */
async function approveAndVoucher(id: number, invoiceNo: string, adminCookieHeader: string): Promise<void> {
  await purchaseApprove(id);
  const res = await SELF.fetch(`https://example.com/api/approvals/${id}/voucher`, {
    method: 'POST',
    headers: { Cookie: adminCookieHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      voucherDate: '2026-09-05',
      lines: [{ no: 1, date: '2026-09-05', description: 'Test line', amount: 100 }],
      invoiceNo,
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json<{ success: boolean }>();
  expect(body.success).toBe(true);
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  for (const email of ADMIN_EMAILS) {
    await seedMember(env.DB, { name: 'Compliance Admin', email, category: 'admin' });
  }
  await seedMember(env.DB, { name: 'Purchase Approver', email: PURCHASE_EMAIL, category: 'committee' });
  await seedMember(env.DB, { name: 'Finance Approver', email: FINANCE_EMAIL, category: 'committee' });
  await seedMember(env.DB, { name: 'IT Admin', email: IT_ADMIN, category: 'admin' });
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM approval_audit_log').run();
  await env.DB.prepare('DELETE FROM approval_attachments').run();
  await env.DB.prepare('DELETE FROM approval_items').run();
});

describe('self-approval guard (plan §6.1)', () => {
  it('an IT admin who raised the item cannot approve it (403)', async () => {
    // IT admins are purchase approvers through the union, so this is the one
    // path the guard has to close.
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Raised by IT admin');
    form.append('files', pdfFile('quote.pdf'));
    const createRes = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await mintCookie(IT_ADMIN, 'admin') },
      body: form,
    });
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json<{ success: boolean; id: number }>();

    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: await mintCookie(IT_ADMIN, 'admin'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ message?: string }>();
    expect(body.message).toContain('cannot approve or reject');

    // The item must still be pending — no state change, no audit row.
    const item = await env.DB.prepare('SELECT status FROM approval_items WHERE id = ?').bind(id).first<{ status: string }>();
    expect(item?.status).toBe('pending');
  });

  it('a finance approver who raised the item cannot finance-approve it (403)', async () => {
    // Seeded directly: finance@ as creator, already at finance check.
    const insert = await env.DB.prepare(
      "INSERT INTO approval_items (category, title, status, voucher_no, voucher_date, voucher_lines, created_by) VALUES ('quotation', 'Raised by finance', 'finance_check', 'PV26-0901', '2026-09-05', '[]', ?)",
    )
      .bind(FINANCE_EMAIL)
      .run();
    const id = Number((insert.meta as { last_row_id?: number }).last_row_id);

    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-approve`, {
      method: 'POST',
      headers: { Cookie: await financeCookie() },
    });
    expect(res.status).toBe(403);
    const item = await env.DB.prepare('SELECT status FROM approval_items WHERE id = ?').bind(id).first<{ status: string }>();
    expect(item?.status).toBe('finance_check');
  });
});

describe('office capture (plan §6.2)', () => {
  it('records the purchase approver office and shows it in the detail view', async () => {
    const id = await createItem({ title: 'Office capture — purchase' });
    await purchaseApprove(id);

    const res = await SELF.fetch(`https://example.com/api/approvals/${id}`, {
      headers: { Cookie: await purchaseCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ item: { purchase_decision_office?: string | null } }>();
    expect(body.item.purchase_decision_office).toBe('President');

    const audit = await env.DB.prepare(
      "SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'purchase_approved'",
    )
      .bind(id)
      .first<{ note: string | null }>();
    expect(audit?.note).toBe('office=President');
  });

  it('records the finance approver office through the full create → approve → voucher → finance-approve flow', async () => {
    const cookie = await adminCookie();
    const id = await createItem({ title: 'Office capture — finance' });
    await approveAndVoucher(id, 'INV-OFFICE-001', cookie);

    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/finance-approve`, {
      method: 'POST',
      headers: { Cookie: await financeCookie() },
    });
    expect(res.status).toBe(200);

    const detail = await SELF.fetch(`https://example.com/api/approvals/${id}`, {
      headers: { Cookie: await financeCookie() },
    });
    const body = await detail.json<{ item: { finance_decision_office?: string | null; status: string } }>();
    expect(body.item.status).toBe('finance_approved');
    expect(body.item.finance_decision_office).toBe('Treasurer');
  });
});

describe('both stages forced at S$5,000 and above (plan §6.3)', () => {
  it('a payroll item at S$6,000 starts at pending with approval_required = 1', async () => {
    const id = await createItem({ category: 'payroll', amount: '6000', title: 'September payroll' });
    const item = await env.DB.prepare('SELECT status, approval_required FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; approval_required: number }>();
    expect(item?.status).toBe('pending');
    expect(item?.approval_required).toBe(1);
  });

  it('a payroll item at S$4,999.99 still skips the purchase stage', async () => {
    const id = await createItem({ category: 'payroll', amount: '4999.99', file: false, title: 'Small payroll' });
    const item = await env.DB.prepare('SELECT status, approval_required FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; approval_required: number }>();
    expect(item?.status).toBe('purchase_approved');
    expect(item?.approval_required).toBe(0);
  });
});

describe('invoice number and duplicate warning (plan §6.4)', () => {
  it('rejects a voucher without an invoice number (400)', async () => {
    const cookie = await adminCookie();
    const id = await createItem({ title: 'No invoice number' });
    await purchaseApprove(id);

    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/voucher`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voucherDate: '2026-09-05',
        lines: [{ no: 1, description: 'Test line', amount: 100 }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ message?: string }>();
    expect(body.message).toContain('invoice or receipt number');
  });

  it('warns on a repeated invoice number without blocking, and audits it', async () => {
    const cookieA = await adminCookie();
    const cookieB = await adminCookie();
    const idA = await createItem({ title: 'First invoice' });
    await approveAndVoucher(idA, 'INV-DUP-001', cookieA);

    const idB = await createItem({ title: 'Repeated invoice' });
    await purchaseApprove(idB);
    const res = await SELF.fetch(`https://example.com/api/approvals/${idB}/voucher`, {
      method: 'POST',
      headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voucherDate: '2026-09-05',
        lines: [{ no: 1, description: 'Repeat line', amount: 50 }],
        invoiceNo: 'inv-dup-001', // case-insensitive match
      }),
    });
    expect(res.status).toBe(200); // warns, never blocks
    const body = await res.json<{ success: boolean; duplicateInvoice: { id: number } | null }>();
    expect(body.duplicateInvoice?.id).toBe(idA);

    const audit = await env.DB.prepare(
      "SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'possible_duplicate_invoice'",
    )
      .bind(idB)
      .first<{ note: string | null }>();
    // The note carries the submitted value; the match itself is NOCASE.
    expect(audit?.note).toContain('invoice_no=inv-dup-001');
    expect(audit?.note).toContain(`matches item ${idA}`);

    // Detail on the second item carries the same warning for the payment step.
    const detail = await SELF.fetch(`https://example.com/api/approvals/${idB}`, {
      headers: { Cookie: cookieB },
    });
    const detailBody = await detail.json<{ duplicate_invoice: { id: number } | null }>();
    expect(detailBody.duplicate_invoice?.id).toBe(idA);
  });
});
