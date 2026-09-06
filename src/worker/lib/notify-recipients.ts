// Environment-aware email recipients (owner request 2026-09-05).
//
// The approver and form-notification lists in src/constants/portal.ts hold
// the REAL people — correct for staging and production. But local manual
// testing (`npm run dev:worker`) uses the real Resend key from .dev.vars, so
// before this guard existed, raising a test approval item on a laptop
// emailed Roxanne, Angela, Joyce and YS.
//
// Local detection reuses the established dev trust anchor: .dev.vars sets a
// SESSION_SECRET prefixed with 'local-dev-' (the same anchor
// getDevBypassSession() requires in api/session.ts). Production secrets are
// high-entropy and can never match, so deployed environments always get the
// real lists.
//
// Local behaviour:
//   approval-stage email -> approval@singaporewomenassociation.org
//   finance-stage email  -> finance@singaporewomenassociation.org
//   form notifications   -> cjtay@singaporewomenassociation.org
//
// NOTIFY_RECIPIENTS_OVERRIDE (optional .dev.vars entry, comma-separated)
// replaces all three when set — and only has effect when the local anchor is
// present, so it can never reroute staging/production mail even if it ever
// leaks into deployed vars.
//
// This file only decides WHO is emailed. WHO MAY APPROVE is unchanged:
// isPurchaseApprover()/isFinanceApprover() in portal.ts still gate authority
// in middleware and handlers.

import type { Env } from '../types';
import {
  APPROVAL_FINANCE_APPROVER_EMAILS,
  APPROVAL_PURCHASE_APPROVER_EMAILS,
  APPROVAL_QUOTE_RULE_THRESHOLD,
} from '../../constants/portal';

const LOCAL_DEV_SECRET_PREFIX = 'local-dev-';

export const LOCAL_APPROVAL_RECIPIENT = 'approval@singaporewomenassociation.org';
export const LOCAL_FINANCE_RECIPIENT = 'finance@singaporewomenassociation.org';
export const LOCAL_FORM_NOTIFY_RECIPIENT = 'cjtay@singaporewomenassociation.org';

/** True when the worker runs on a developer laptop (.dev.vars local anchor). */
export function isLocalMailEnvironment(env: Pick<Env, 'SESSION_SECRET'>): boolean {
  return !!env.SESSION_SECRET && env.SESSION_SECRET.startsWith(LOCAL_DEV_SECRET_PREFIX);
}

function parseOverride(env: Env): string[] {
  return (env.NOTIFY_RECIPIENTS_OVERRIDE ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('@'));
}

function localRecipients(env: Env, fallback: string[]): string[] {
  const override = parseOverride(env);
  return override.length > 0 ? override : fallback;
}

/** Purchase-stage recipients: the real list everywhere except local dev. */
export function resolvePurchaseApproverRecipients(env: Env): string[] {
  if (!isLocalMailEnvironment(env)) return [...APPROVAL_PURCHASE_APPROVER_EMAILS];
  return localRecipients(env, [LOCAL_APPROVAL_RECIPIENT]);
}

/** Finance-stage recipients: the real list everywhere except local dev. */
export function resolveFinanceApproverRecipients(env: Env): string[] {
  if (!isLocalMailEnvironment(env)) return [...APPROVAL_FINANCE_APPROVER_EMAILS];
  return localRecipients(env, [LOCAL_FINANCE_RECIPIENT]);
}

/**
 * Purchase-stage recipients for an item of the given amount (before GST,
 * null when unknown). Under S$1,000 the finance approvers may sign the
 * purchase stage too (finance policy §3.2 puts "Below $1000" with the
 * Treasurer/Secretary; canDecidePurchaseStage mirrors this authority), so
 * the request email asks them as well. At S$1,000+ or unknown amount —
 * purchase approvers only. Local dev collapses to the shared test inbox
 * through the same resolvers as always.
 */
export function resolvePurchaseStageRecipients(env: Env, amount: number | null): string[] {
  const purchase = resolvePurchaseApproverRecipients(env);
  if (amount === null || amount >= APPROVAL_QUOTE_RULE_THRESHOLD) return purchase;
  const finance = resolveFinanceApproverRecipients(env);
  const merged = [...purchase];
  for (const email of finance) if (!merged.includes(email)) merged.push(email);
  return merged;
}

/** Form-notification recipients (volunteer / laughter yoga / membership):
 *  the passed-in defaults everywhere except local dev. */
export function resolveFormNotifyRecipients(env: Env, defaults: readonly string[]): string[] {
  if (!isLocalMailEnvironment(env)) return [...defaults];
  return localRecipients(env, [LOCAL_FORM_NOTIFY_RECIPIENT]);
}
