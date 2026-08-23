import type { Env } from '../types';
import { logError } from './log-error';
import { APPROVAL_FINANCE_APPROVER_EMAILS, APPROVAL_PURCHASE_APPROVER_EMAILS } from '../../constants/portal';

// Approval-workflow emails — docs/plans/Approval-Workflow-Implementation-Plan.md §10.
//
// Structure copied from email-membership-notification.ts: purple header,
// summary rows, action button. All mail goes through Resend from the
// existing SWA Portal sender and is sent non-blocking via waitUntil by the
// callers, so an email failure never fails the action.
//
// Recipients: emails go to the named approver list only. The IT-admin union
// in isPurchaseApprover() grants authority to decide, not mailbox traffic.

export interface ApprovalEmailItem {
  id: number;
  title: string;
  categoryLabel: string;
  payee: string | null;
  requestedAmount: number | null;
  description: string | null;
  createdBy: string;
  fileCount: number;
}

const DESCRIPTION_PREVIEW_CHARS = 500;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function row(label: string, value: string): string {
  const safe = value && value.length > 0 ? escapeHtml(value) : '&mdash;';
  return `<tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;vertical-align:top;width:180px;border-bottom:1px solid #f3f4f6;">${escapeHtml(label)}</td><td style="padding:8px 12px;color:#1f2937;font-size:14px;vertical-align:top;border-bottom:1px solid #f3f4f6;">${safe}</td></tr>`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function money(amount: number | null): string {
  return amount === null || amount === undefined ? '' : 'S$' + amount.toFixed(2);
}

function itemUrl(env: Env, itemId: number): string {
  return `https://${env.SWA_ADMIN_DOMAIN || 'admin.singaporewomenassociation.org'}/approvals?item=${itemId}`;
}

function header(title: string, subtitle: string): string {
  return (
    `<div style="background:#70308c;padding:20px 24px;color:#ffffff;">` +
    `<div style="font-size:18px;font-weight:600;">${escapeHtml(title)}</div>` +
    (subtitle ? `<div style="font-size:13px;opacity:0.9;margin-top:4px;">${escapeHtml(subtitle)}</div>` : '') +
    `</div>`
  );
}

function summaryTable(item: ApprovalEmailItem, withDescription: boolean): string {
  let rows =
    row('Title', item.title) +
    row('Category', item.categoryLabel) +
    row('Payable to', item.payee || '') +
    row('Requested amount', money(item.requestedAmount)) +
    row('Documents attached', String(item.fileCount)) +
    row('Raised by', item.createdBy);
  if (withDescription && item.description) {
    // Plain text, whitespace preserved; truncated per the session-4 note.
    rows += row('Description', truncate(item.description, DESCRIPTION_PREVIEW_CHARS));
  }
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px 0;">${rows}</table>`;
}

function actionButton(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:#70308c;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:4px;font-size:14px;font-weight:500;">${escapeHtml(label)}</a>`;
}

function wrap(inner: string): string {
  return (
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;">' +
    inner +
    '<div style="padding:12px 24px;color:#9ca3af;font-size:11px;border-top:1px solid #f3f4f6;">' +
    'Sent automatically by the SWA Portal. Please do not reply directly to this email.' +
    '</div>' +
    '</div></body></html>'
  );
}

/** "New item for approval" / resubmission / reminder — goes to the purchase approvers. */
export function buildApprovalRequestEmail(env: Env, item: ApprovalEmailItem, kind: 'new' | 'resubmitted' | 'reminder'): string {
  const heading = kind === 'new' ? 'New Item for Approval' : kind === 'resubmitted' ? 'Item Resubmitted for Approval' : 'Reminder: Item Awaiting Approval';
  const intro =
    kind === 'new'
      ? 'A new purchase request has been raised in the SWA Portal and needs a purchase decision.'
      : kind === 'resubmitted'
        ? 'A purchase request that was rejected has been edited and resubmitted, and needs a new purchase decision.'
        : 'This request is still waiting for a purchase decision.';
  return wrap(
    header(heading, item.title) +
    `<div style="padding:20px 24px;"><p style="margin:0 0 12px 0;color:#374151;font-size:14px;">${intro}</p>` +
    summaryTable(item, true) +
    actionButton(itemUrl(env, item.id), 'Review in SWA Portal') +
    '</div>',
  );
}

/** Approve / reject decision — goes to the creator. */
export function buildPurchaseDecisionEmail(env: Env, item: ApprovalEmailItem, decision: { approved: boolean; reason?: string; decidedBy: string }): string {
  const heading = decision.approved ? 'Purchase Approved' : 'Purchase Rejected';
  const intro = decision.approved
    ? 'Your request was approved at the purchase stage. You can now prepare the payment voucher.'
    : 'Your request was rejected at the purchase stage. Edit the item and resubmit it when ready.';
  let inner =
    header(heading, item.title) +
    `<div style="padding:20px 24px;"><p style="margin:0 0 12px 0;color:#374151;font-size:14px;">${intro}</p>` +
    row('Title', item.title) +
    row('Payable to', item.payee || '') +
    row('Requested amount', money(item.requestedAmount)) +
    row('Decided by', decision.decidedBy) +
    '</table>';
  if (!decision.approved && decision.reason) {
    inner +=
      `<div style="border-left:3px solid #b3261e;background:#fdecea;padding:10px 14px;margin:12px 0 16px 0;border-radius:0 4px 4px 0;">` +
      `<div style="font-size:12px;color:#b3261e;font-weight:600;margin-bottom:4px;">Reason</div>` +
      `<div style="font-size:14px;color:#1f2937;white-space:pre-wrap;">${escapeHtml(decision.reason)}</div></div>`;
  }
  inner += actionButton(itemUrl(env, item.id), 'Open in SWA Portal') + '</div>';
  return wrap(inner);
}

/* ---------------- senders ---------------- */

async function sendViaResend(env: Env, to: string[], subject: string, html: string, logEndpoint: string): Promise<void> {
  if (to.length === 0) return;
  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SWA Portal <contactus@singaporewomenassociation.org>',
        to,
        subject,
        html,
      }),
    });
    if (!resendRes.ok) {
      const errText = await resendRes.text();
      throw new Error(`Resend returned ${resendRes.status}: ${errText}`);
    }
  } catch (err) {
    await logError(env, {
      endpoint: logEndpoint,
      error_type: 'RESEND_NOTIFY',
      error_message: err instanceof Error ? err.message : String(err),
      http_status: 502,
    });
  }
}

export async function sendApprovalRequestEmail(env: Env, item: ApprovalEmailItem, kind: 'new' | 'resubmitted' | 'reminder'): Promise<void> {
  const subject =
    (kind === 'new' ? 'New approval request: ' : kind === 'resubmitted' ? 'Resubmitted approval request: ' : 'Reminder — approval request: ') + item.title;
  await sendViaResend(env, [...APPROVAL_PURCHASE_APPROVER_EMAILS], subject, buildApprovalRequestEmail(env, item, kind), 'approvals-request-email');
}

export async function sendPurchaseDecisionEmail(env: Env, item: ApprovalEmailItem, decision: { approved: boolean; reason?: string; decidedBy: string }): Promise<void> {
  const subject = (decision.approved ? 'Approved: ' : 'Rejected: ') + item.title;
  await sendViaResend(env, [item.createdBy], subject, buildPurchaseDecisionEmail(env, item, decision), 'approvals-decision-email');
}

/* ---------------- finance stage (Phase 4) ---------------- */

export interface VoucherEmailItem {
  id: number;
  title: string;
  payee: string | null;
  voucherNo: string;
  voucherDate: string;
  total: number | null;
  createdBy: string;
}

function moneySigned(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return sign + 'S$' + Math.abs(amount).toFixed(2);
}

/** "Voucher for finance check" — goes to the finance approvers on submission
 *  or resubmission after a finance rejection (plan §10). */
export function buildVoucherEmail(env: Env, item: VoucherEmailItem, kind: 'new' | 'resubmitted' | 'reminder'): string {
  const heading = kind === 'new' ? 'Voucher for Finance Check' : kind === 'resubmitted' ? 'Voucher Resubmitted for Finance Check' : 'Reminder: Voucher Awaiting Finance Check';
  const intro =
    kind === 'new'
      ? 'A payment voucher has been submitted and needs a finance decision.'
      : kind === 'resubmitted'
        ? 'A voucher that was rejected at the finance stage has been resubmitted and needs a new decision.'
        : 'This voucher is still waiting for a finance decision.';
  return wrap(
    header(heading, item.voucherNo) +
    `<div style="padding:20px 24px;"><p style="margin:0 0 12px 0;color:#374151;font-size:14px;">${intro}</p>` +
    `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px 0;">` +
    row('Item', item.title) +
    row('Voucher No', item.voucherNo) +
    row('Voucher date', item.voucherDate) +
    row('Payable to', item.payee || '') +
    row('Total payable', moneySigned(item.total ?? 0)) +
    row('Prepared by', item.createdBy) +
    '</table>' +
    actionButton(itemUrl(env, item.id), 'Review in SWA Portal') +
    '</div>',
  );
}

/** Finance approve / reject decision — goes to the creator. */
export function buildFinanceDecisionEmail(env: Env, item: VoucherEmailItem, decision: { approved: boolean; reason?: string; decidedBy: string }): string {
  const heading = decision.approved ? 'Voucher Approved by Finance' : 'Voucher Rejected by Finance';
  const intro = decision.approved
    ? 'Your payment voucher was approved by finance. You can now export the voucher as a PDF and record the payment.'
    : 'Your payment voucher was rejected at the finance stage. Edit the voucher and resubmit it when ready.';
  let inner =
    header(heading, item.title) +
    `<div style="padding:20px 24px;"><p style="margin:0 0 12px 0;color:#374151;font-size:14px;">${intro}</p>` +
    `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px 0;">` +
    row('Voucher No', item.voucherNo) +
    row('Payable to', item.payee || '') +
    row('Total payable', moneySigned(item.total ?? 0)) +
    row('Decided by', decision.decidedBy) +
    '</table>';
  if (!decision.approved && decision.reason) {
    inner +=
      `<div style="border-left:3px solid #b3261e;background:#fdecea;padding:10px 14px;margin:12px 0 16px 0;border-radius:0 4px 4px 0;">` +
      `<div style="font-size:12px;color:#b3261e;font-weight:600;margin-bottom:4px;">Reason</div>` +
      `<div style="font-size:14px;color:#1f2937;white-space:pre-wrap;">${escapeHtml(decision.reason)}</div></div>`;
  }
  inner += actionButton(itemUrl(env, item.id), 'Open in SWA Portal') + '</div>';
  return wrap(inner);
}

export async function sendVoucherEmail(env: Env, item: VoucherEmailItem, kind: 'new' | 'resubmitted' | 'reminder'): Promise<void> {
  const prefix = kind === 'new' ? 'Voucher for finance check: ' : kind === 'resubmitted' ? 'Voucher resubmitted: ' : 'Reminder — voucher awaiting finance check: ';
  await sendViaResend(env, [...APPROVAL_FINANCE_APPROVER_EMAILS], prefix + `${item.title} (${item.voucherNo})`, buildVoucherEmail(env, item, kind), 'approvals-voucher-email');
}

export async function sendFinanceDecisionEmail(env: Env, item: VoucherEmailItem, decision: { approved: boolean; reason?: string; decidedBy: string }): Promise<void> {
  const subject = (decision.approved ? 'Finance approved: ' : 'Finance rejected: ') + `${item.title} (${item.voucherNo})`;
  await sendViaResend(env, [item.createdBy], subject, buildFinanceDecisionEmail(env, item, decision), 'approvals-finance-decision-email');
}
