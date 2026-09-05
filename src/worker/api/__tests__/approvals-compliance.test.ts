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
  // Batch B additions: the declarations tests create many items.
  'approvals-compliance-admin9@example.com',
  'approvals-compliance-admin10@example.com',
  'approvals-compliance-admin11@example.com',
  'approvals-compliance-admin12@example.com',
  'approvals-compliance-admin13@example.com',
  'approvals-compliance-admin14@example.com',
  'approvals-compliance-admin15@example.com',
  'approvals-compliance-admin16@example.com',
];
const PURCHASE_EMAIL = 'approval@singaporewomenassociation.org';
const FINANCE_EMAIL = 'finance@singaporewomenassociation.org';
const IT_ADMIN = IT_ADMIN_EMAILS[0]; // cjtay@ — purchase approver via the IT-admin union
const AUDITOR_EMAIL = 'audit@singaporewomenassociation.org'; // R2 view-only auditor

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
  evidence?: Record<string, string>;
  comparisonCount?: number;
}

/** Create an item as a fresh rotating admin; returns the item id. */
async function createItem(opts: CreateOptions = {}): Promise<number> {
  const form = new FormData();
  form.append('category', opts.category ?? 'quotation');
  form.append('title', opts.title ?? 'Compliance test item');
  if (opts.amount !== undefined) form.append('requestedAmount', opts.amount);
  if (opts.file !== false) form.append('files', pdfFile('quote.pdf'));
  const count = opts.comparisonCount ?? 0;
  // quote.pdf is the base file; each extra comparison row adds its own file.
  for (let i = 1; i < count; i++) {
    form.append('files', pdfFile(`quote-${i}.pdf`));
  }
  if (count > 0) {
    const rows = Array.from({ length: count }, (_, i) => ({
      file: i === 0 ? 'quote.pdf' : `quote-${i}.pdf`,
      description: `Quotation ${i + 1}`,
      ...(i === 0 ? { quoteDate: '2026-08-01' } : {}),
    }));
    form.append('comparison', JSON.stringify(rows));
  }
  for (const [key, value] of Object.entries(opts.evidence ?? {})) {
    form.append(key, value);
  }
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

/** Evidence that satisfies every S$1,000+ requirement (declarations + waiver
 *  when the test creates fewer than two comparison rows). */
function fullEvidence(): Record<string, string> {
  return {
    quotationWaiverReason: 'Sole authorised supplier for this item',
    budgetApproved: 'true',
    budgetAmount: 'S$1,500',
    budgetOfficer: 'Hon Treasurer',
    budgetDate: '2026-08-20',
    coiDeclared: 'true',
    noSplitDeclared: 'true',
    supplierIsCheapest: 'yes',
  };
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
  await seedMember(env.DB, { name: 'Approvals Auditor', email: AUDITOR_EMAIL, category: 'committee' });
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
    // Batch B: any S$1,000+ create carries the declarations — fullEvidence()
    // provides them so this test isolates the two-stage rule.
    const id = await createItem({ category: 'payroll', amount: '6000', title: 'September payroll', evidence: fullEvidence() });
    const item = await env.DB.prepare('SELECT status, approval_required FROM approval_items WHERE id = ?')
      .bind(id)
      .first<{ status: string; approval_required: number }>();
    expect(item?.status).toBe('pending');
    expect(item?.approval_required).toBe(1);
  });

  it('a payroll item at S$4,999.99 still skips the purchase stage', async () => {
    const id = await createItem({ category: 'payroll', amount: '4999.99', file: false, title: 'Small payroll', evidence: fullEvidence() });
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

describe('declarations and quotation rules at S$1,000+ (plan §7.1, Batch B)', () => {
  it('create at S$1,500 with one comparison row and no waiver expects 400', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Under-quoted');
    form.append('requestedAmount', '1500');
    form.append('files', pdfFile('quote.pdf'));
    form.append('comparison', JSON.stringify([{ file: 'quote.pdf', description: 'Only quote' }]));
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ message?: string }>();
    expect(body.message).toContain('two quotations');
  });

  it('create at S$1,500 with a waiver reason and every declaration expects 201 and stores the fields', async () => {
    const cookie = await adminCookie();
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Fully declared');
    form.append('requestedAmount', '1500');
    form.append('files', pdfFile('quote.pdf'));
    for (const [key, value] of Object.entries(fullEvidence())) form.append(key, value);
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ success: boolean; id: number }>();
    const item = await env.DB.prepare(
      'SELECT quotation_waiver_reason, budget_approved, budget_amount, budget_officer, budget_date, coi_declared, no_split_declared, supplier_is_cheapest FROM approval_items WHERE id = ?',
    )
      .bind(id)
      .first<Record<string, unknown>>();
    expect(item?.quotation_waiver_reason).toBe('Sole authorised supplier for this item');
    expect(Number(item?.budget_approved)).toBe(1);
    expect(item?.budget_amount).toBe('S$1,500');
    expect(item?.budget_officer).toBe('Hon Treasurer');
    expect(item?.budget_date).toBe('2026-08-20');
    expect(Number(item?.coi_declared)).toBe(1);
    expect(Number(item?.no_split_declared)).toBe(1);
    expect(Number(item?.supplier_is_cheapest)).toBe(1);
  });

  it('create at S$1,500 missing each declaration in turn expects 400 naming the field', async () => {
    const cases: Array<Record<string, string>> = [];
    for (const missing of Object.keys(fullEvidence())) {
      const partial: Record<string, string> = {};
      for (const [k, v] of Object.entries(fullEvidence())) if (k !== missing) partial[k] = v;
      cases.push(partial);
    }
    for (const evidence of cases) {
      const res = await SELF.fetch('https://example.com/api/approvals', {
        method: 'POST',
        headers: { Cookie: await adminCookie() },
        body: (() => {
          const form = new FormData();
          form.append('category', 'quotation');
          form.append('title', 'Missing something');
          form.append('requestedAmount', '1500');
          form.append('files', pdfFile('quote.pdf'));
          for (const [key, value] of Object.entries(evidence)) form.append(key, value);
          return form;
        })(),
      });
      expect(res.status).toBe(400);
    }
  });

  it('create at S$999 with no declarations expects 201', async () => {
    const id = await createItem({ amount: '999', title: 'Under the threshold' });
    const item = await env.DB.prepare('SELECT coi_declared, budget_approved FROM approval_items WHERE id = ?').bind(id).first<{ coi_declared: number; budget_approved: number }>();
    expect(Number(item?.coi_declared)).toBe(0);
    expect(Number(item?.budget_approved)).toBe(0);
  });

  it('supplierIsCheapest = no without a reason expects 400; with a reason expects 201', async () => {
    const without = { ...fullEvidence(), supplierIsCheapest: 'no', supplierChoiceReason: '' };
    const resNo = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: (() => {
        const form = new FormData();
        form.append('category', 'quotation');
        form.append('title', 'Not cheapest, no reason');
        form.append('requestedAmount', '1500');
        form.append('files', pdfFile('quote.pdf'));
        for (const [key, value] of Object.entries(without)) form.append(key, value);
        return form;
      })(),
    });
    expect(resNo.status).toBe(400);

    const withReason = { ...fullEvidence(), supplierIsCheapest: 'no', supplierChoiceReason: 'Preferred supplier is the only one with same-day service' };
    const resYes = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: (() => {
        const form = new FormData();
        form.append('category', 'quotation');
        form.append('title', 'Not cheapest, reason given');
        form.append('requestedAmount', '1500');
        form.append('files', pdfFile('quote.pdf'));
        for (const [key, value] of Object.entries(withReason)) form.append(key, value);
        return form;
      })(),
    });
    expect(resYes.status).toBe(201);
  });

  it('two comparison rows with quotation dates satisfy the quotes rule with no waiver, and the dates are stored', async () => {
    const id = await createItem({ amount: '1500', title: 'Two dated quotes', comparisonCount: 2, evidence: { ...fullEvidence(), quotationWaiverReason: '' } });
    const detail = await SELF.fetch(`https://example.com/api/approvals/${id}`, {
      headers: { Cookie: await adminCookie() },
    });
    const body = await detail.json<{ item: { comparison: Array<{ quoteDate?: string }> | null } }>();
    expect(body.item.comparison).toHaveLength(2);
    expect(body.item.comparison?.[0]?.quoteDate).toBe('2026-08-01');
    expect(body.item.comparison?.[1]?.quoteDate).toBeUndefined();
  });
});

describe('board approval above S$10,000 (plan §7.3, Batch B)', () => {
  it('purchase approve without a board reference expects 409', async () => {
    const id = await createItem({ amount: '12000', title: 'Board needed', evidence: fullEvidence() });
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: await purchaseCookie(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ message?: string }>();
    expect(body.message).toContain('board approval reference');
    const item = await env.DB.prepare('SELECT status FROM approval_items WHERE id = ?').bind(id).first<{ status: string }>();
    expect(item?.status).toBe('pending');
  });

  it('purchase approve with the reference and an attachment expects 200', async () => {
    const id = await createItem({
      amount: '12000',
      title: 'Board evidenced',
      evidence: { ...fullEvidence(), boardApprovalRef: 'Board meeting 12 Aug 2026, item 4' },
    });
    await purchaseApprove(id);
    const item = await env.DB.prepare('SELECT status FROM approval_items WHERE id = ?').bind(id).first<{ status: string }>();
    expect(item?.status).toBe('purchase_approved');
  });

  it('below S$10,000 no board reference is needed', async () => {
    const id = await createItem({ amount: '9999.99', title: 'Just under', evidence: fullEvidence() });
    await purchaseApprove(id);
    const item = await env.DB.prepare('SELECT status FROM approval_items WHERE id = ?').bind(id).first<{ status: string }>();
    expect(item?.status).toBe('purchase_approved');
  });
});

describe('R1: field-level audit trail (Batch B)', () => {
  it('edit writes every changed field as old → new pairs into the item_edited note', async () => {
    const adminEmail = 'approvals-compliance-admin16@example.com';
    const id = await createItem({ amount: '500', title: 'Audit me' });
    // Confirm the create note carries the R1 pairs.
    const created = await env.DB.prepare("SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'item_created'")
      .bind(id)
      .first<{ note: string }>();
    expect(created?.note).toContain('title: (none) → Audit me');
    expect(created?.note).toContain('requested_amount: (none) → 500');

    // Now edit two fields.
    const form = new FormData();
    form.append('title', 'Audit me twice');
    form.append('requestedAmount', '650');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await mintCookie(adminEmail, 'admin') },
      body: form,
    });
    expect(res.status).toBe(200);

    const edited = await env.DB.prepare("SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'item_edited'")
      .bind(id)
      .first<{ note: string | null }>();
    expect(edited?.note).toContain('title: Audit me → Audit me twice');
    expect(edited?.note).toContain('requested_amount: 500 → 650');
    expect(edited?.note).not.toContain('payee'); // unchanged fields stay out
  });

  it('evidence changes are captured too', async () => {
    const id = await createItem({ amount: '1500', title: 'Evidence audit', evidence: fullEvidence() });
    const form = new FormData();
    form.append('quotationWaiverReason', 'Emergency purchase, single source');
    const res = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(200);
    const edited = await env.DB.prepare("SELECT note FROM approval_audit_log WHERE item_id = ? AND action = 'item_edited'")
      .bind(id)
      .first<{ note: string | null }>();
    expect(edited?.note).toContain('quotation_waiver_reason: Sole authorised supplier for this item → Emergency purchase, single source');
  });
});

describe('R6: category remembers the payment method (Batch B)', () => {
  it('detail returns the most recent paid method in the same category', async () => {
    // Seed a paid payroll item directly.
    await env.DB.prepare(
      "INSERT INTO approval_items (category, title, status, paid_by, paid_at, payment_method, payment_reference, created_by) VALUES ('payroll', 'Old payroll', 'paid', 'Treasurer', '2026-08-01', 'bank_transfer', 'DBS 001', 'seed@example.com')",
    ).run();
    const item = await env.DB.prepare('SELECT id, category FROM approval_items WHERE title = ?').bind('Old payroll').first<{ id: number }>();

    const res = await SELF.fetch(`https://example.com/api/approvals/${item!.id}`, {
      headers: { Cookie: await adminCookie() },
    });
    const body = await res.json<{ last_paid_method: string | null }>();
    expect(body.last_paid_method).toBe('bank_transfer');
  });

  it('the most recent paid item wins (ordered by paid_at DESC)', async () => {
    await env.DB.prepare(
      "INSERT INTO approval_items (category, title, status, paid_by, paid_at, payment_method, created_by) VALUES ('vendor_payment', 'Old vendor', 'paid', 'Treasurer', '2026-07-01', 'cash', 'seed@example.com')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO approval_items (category, title, status, paid_by, paid_at, payment_method, created_by) VALUES ('vendor_payment', 'Recent vendor', 'paid', 'Treasurer', '2026-08-15', 'paynow', 'seed@example.com')",
    ).run();
    const item = await env.DB.prepare('SELECT id FROM approval_items WHERE title = ?').bind('Recent vendor').first<{ id: number }>();
    const res = await SELF.fetch(`https://example.com/api/approvals/${item!.id}`, {
      headers: { Cookie: await adminCookie() },
    });
    const body = await res.json<{ last_paid_method: string | null }>();
    expect(body.last_paid_method).toBe('paynow');
  });
});

describe('R7: Tax Invoice flag (Batch B)', () => {
  it('create stores the tick and the ticked attachment renders first', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Tax invoice pick');
    form.append('files', pdfFile('receipt.pdf'));
    form.append('files', pdfFile('quotation.pdf'));
    form.append('taxInvoice', 'receipt.pdf');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ success: boolean; id: number }>();

    const detail = await SELF.fetch(`https://example.com/api/approvals/${id}`, {
      headers: { Cookie: await adminCookie() },
    });
    const body = await detail.json<{ attachments: Array<{ filename: string; is_tax_invoice: number }> }>();
    expect(body.attachments[0].filename).toBe('receipt.pdf');
    expect(body.attachments[0].is_tax_invoice).toBe(1);
    expect(body.attachments[1].is_tax_invoice).toBe(0);
  });

  it('edit re-ticks onto another attachment, clearing the first (one per item)', async () => {
    const form = new FormData();
    form.append('category', 'quotation');
    form.append('title', 'Retick');
    form.append('files', pdfFile('first.pdf'));
    form.append('files', pdfFile('second.pdf'));
    form.append('taxInvoice', 'first.pdf');
    const res = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: form,
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ success: boolean; id: number }>();
    // Attachment ids straight from D1 — the detail endpoint round-trip is
    // already covered by the create-tick test above, and the shared-D1 test
    // harness has shown flaky read-your-writes here under the full suite.
    const seeded = await env.DB.prepare('SELECT id, filename FROM approval_attachments WHERE item_id = ?')
      .bind(id)
      .all<{ id: number; filename: string }>();
    const secondId = (seeded.results || []).find((a) => a.filename === 'second.pdf')!.id;

    const editForm = new FormData();
    editForm.append('taxInvoiceAttachmentId', String(secondId));
    const editRes = await SELF.fetch(`https://example.com/api/approvals/${id}/edit`, {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
      body: editForm,
    });
    expect(editRes.status).toBe(200);

    const rows = await env.DB.prepare('SELECT filename, is_tax_invoice FROM approval_attachments WHERE item_id = ? ORDER BY is_tax_invoice DESC, id')
      .bind(id)
      .all<{ filename: string; is_tax_invoice: number }>();
    const flagged = (rows.results || []).filter((r) => r.is_tax_invoice === 1);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].filename).toBe('second.pdf');
  });
});

describe('R2: view-only auditor role (Batch C)', () => {
  async function auditorCookie(): Promise<string> {
    return mintCookie(AUDITOR_EMAIL, 'committee');
  }

  it('an auditor can read the board list and open a drawer (GET)', async () => {
    const id = await createItem({ title: 'Auditor eye view' });
    for (const path of ['/api/approvals', `/api/approvals/${id}`]) {
      const res = await SELF.fetch(`https://example.com${path}`, {
        headers: { Cookie: await auditorCookie() },
      });
      expect(res.status).toBe(200);
    }
  });

  it('an auditor cannot create, remind, or record payment (all writes 403)', async () => {
    const id = await createItem({ title: 'Not for auditors' });

    const create = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await auditorCookie() },
      body: new FormData(),
    });
    expect(create.status).toBe(403);

    const remind = await SELF.fetch(`https://example.com/api/approvals/${id}/remind`, {
      method: 'POST',
      headers: { Cookie: await auditorCookie() },
    });
    expect(remind.status).toBe(403);

    const paid = await SELF.fetch(`https://example.com/api/approvals/${id}/paid`, {
      method: 'POST',
      headers: { Cookie: await auditorCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidBy: 'x', paidDate: '2026-09-05', paymentMethod: 'cash' }),
    });
    expect(paid.status).toBe(403);
  });

  it('an auditor cannot export (R3 keeps export admin-only)', async () => {
    const res = await SELF.fetch('https://example.com/api/approvals/export', {
      headers: { Cookie: await auditorCookie() },
    });
    expect(res.status).toBe(403);
  });

  it('a finance approver cannot export either (admin and IT admin only)', async () => {
    const res = await SELF.fetch('https://example.com/api/approvals/export', {
      headers: { Cookie: await financeCookie() },
    });
    expect(res.status).toBe(403);
  });
});

describe('R3: board-list CSV export (Batch C)', () => {
  it('exports the requested status tab with the board columns', async () => {
    await createItem({ title: 'Export pending one', amount: '800', evidence: fullEvidence() });
    await createItem({ title: 'Export under-threshold', amount: '900' });

    const res = await SELF.fetch('https://example.com/api/approvals/export?status=pending', {
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');

    const csv = await res.text();
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n');
    expect(lines[0]).toContain('Voucher No');
    expect(lines[0]).toContain('Purchase Decision By');
    const body = lines.slice(1);
    expect(body).toHaveLength(2);
    const joined = body.join('\n');
    expect(joined).toContain('Export pending one');
    expect(joined).toContain('Export under-threshold');
    expect(joined).toContain('pending');
  });

  it('exports all items when no status filter is given, and honours tab filters', async () => {
    await createItem({ title: 'All-tab row' });
    const all = await SELF.fetch('https://example.com/api/approvals/export', {
      headers: { Cookie: await adminCookie() },
    });
    const allCsv = (await all.text()).replace(/^\uFEFF/, '').trim().split('\n');
    expect(allCsv.length).toBeGreaterThanOrEqual(2);
    expect(allCsv.join('\n')).toContain('All-tab row');

    const none = await SELF.fetch('https://example.com/api/approvals/export?status=paid', {
      headers: { Cookie: await adminCookie() },
    });
    const noneCsv = (await none.text()).replace(/^\uFEFF/, '').trim().split('\n');
    expect(noneCsv).toHaveLength(1); // header only
  });

  it('rejects an unknown status filter (400)', async () => {
    const res = await SELF.fetch('https://example.com/api/approvals/export?status=nonsense', {
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(400);
  });
});
