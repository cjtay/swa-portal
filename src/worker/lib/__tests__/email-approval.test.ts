// Unit tests for the approval email builders (pure functions — the pattern
// the namecard renderer tests use). Sending is exercised only as a
// non-blocking waitUntil in the API tests and never asserts on the network.

import { describe, it, expect } from 'vitest';
import {
  buildApprovalRequestEmail,
  buildPurchaseDecisionEmail,
  buildVoucherEmail,
  buildFinanceDecisionEmail,
  type ApprovalEmailItem,
} from '../email-approval';
import type { Env } from '../../types';

const env = { SWA_ADMIN_DOMAIN: 'admin.example.com' } as unknown as Env;

const item: ApprovalEmailItem = {
  id: 42,
  title: 'Gala dinner < quotations >',
  categoryLabel: 'Quotation',
  payee: 'Grand Copthorne "Waterfront"',
  requestedAmount: 36772.5,
  description: 'Needs approval before the venue releases the date.'.repeat(30),
  createdBy: 'jolene.lim@singaporewomenassociation.org',
  fileCount: 2,
};

describe('buildApprovalRequestEmail', () => {
  it('escapes HTML in item fields and links to the item', () => {
    const html = buildApprovalRequestEmail(env, item, 'new');
    expect(html).toContain('New Item for Approval');
    expect(html).toContain('Gala dinner &lt; quotations &gt;');
    expect(html).toContain('Grand Copthorne &quot;Waterfront&quot;');
    expect(html).toContain('S$36772.50');
    expect(html).toContain('https://admin.example.com/approvals?item=42');
    expect(html).not.toContain('< quotations');
  });

  it('truncates the description to the preview limit', () => {
    const html = buildApprovalRequestEmail(env, item, 'new');
    expect(html).not.toContain((item.description ?? '').slice(0, 600));
    expect(html).toContain('\u2026');
  });

  it('labels resubmission and reminder variants', () => {
    expect(buildApprovalRequestEmail(env, item, 'resubmitted')).toContain('Item Resubmitted for Approval');
    expect(buildApprovalRequestEmail(env, item, 'reminder')).toContain('Reminder: Item Awaiting Approval');
  });
});

describe('buildPurchaseDecisionEmail', () => {
  it('approve email points the creator at the voucher step', () => {
    const html = buildPurchaseDecisionEmail(env, item, { approved: true, decidedBy: 'Roxanne Zhang' });
    expect(html).toContain('Purchase Approved');
    expect(html).toContain('prepare the payment voucher');
    expect(html).toContain('Roxanne Zhang');
    expect(html).not.toContain('Reason');
  });

  it('reject email includes the escaped reason', () => {
    const html = buildPurchaseDecisionEmail(env, item, {
      approved: false,
      reason: 'Too expensive & <over> budget',
      decidedBy: 'Roxanne Zhang',
    });
    expect(html).toContain('Purchase Rejected');
    expect(html).toContain('Too expensive &amp; &lt;over&gt; budget');
    expect(html).toContain('Edit the item and resubmit');
  });
});

describe('buildVoucherEmail (Phase 4)', () => {
  const voucher = {
    id: 7,
    title: 'Gala dinner settlement',
    payee: 'Grand Copthorne Waterfront Hotel',
    voucherNo: 'PV26-0801',
    voucherDate: '2026-08-23',
    total: 24632.62,
    createdBy: 'jolene.lim@singaporewomenassociation.org',
  };

  it('shows voucher number, date, payee and total with a link', () => {
    const html = buildVoucherEmail(env, voucher, 'new');
    expect(html).toContain('Voucher for Finance Check');
    expect(html).toContain('PV26-0801');
    expect(html).toContain('Grand Copthorne Waterfront Hotel');
    expect(html).toContain('S$24632.62');
    expect(html).toContain('https://admin.example.com/approvals?item=7');
  });

  it('labels resubmission and reminder variants', () => {
    expect(buildVoucherEmail(env, voucher, 'resubmitted')).toContain('Voucher Resubmitted');
    expect(buildVoucherEmail(env, voucher, 'reminder')).toContain('Reminder: Voucher Awaiting Finance Check');
  });

  it('renders a negative total with a leading minus', () => {
    const html = buildVoucherEmail(env, { ...voucher, total: -500 }, 'new');
    expect(html).toContain('-S$500.00');
  });
});

describe('buildFinanceDecisionEmail (Phase 4)', () => {
  const voucher = {
    id: 7,
    title: 'Gala dinner settlement',
    payee: 'Vendor',
    voucherNo: 'PV26-0802',
    voucherDate: '2026-08-24',
    total: 1000,
    createdBy: 'jolene.lim@singaporewomenassociation.org',
  };

  it('approve email points at export + record payment', () => {
    const html = buildFinanceDecisionEmail(env, voucher, { approved: true, decidedBy: 'YS Tan' });
    expect(html).toContain('Voucher Approved by Finance');
    expect(html).toContain('export the voucher as a PDF');
    expect(html).toContain('YS Tan');
  });

  it('reject email includes the escaped reason', () => {
    const html = buildFinanceDecisionEmail(env, voucher, {
      approved: false,
      reason: 'Total & <description> mismatch',
      decidedBy: 'Joyce Lim',
    });
    expect(html).toContain('Voucher Rejected by Finance');
    expect(html).toContain('Total &amp; &lt;description&gt; mismatch');
  });
});
