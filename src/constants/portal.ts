export const IT_ADMIN_EMAILS = [
  'cjtay@singaporewomenassociation.org',
  'angela.wong@singaporewomenassociation.org',
  'system@singaporewomenassociation.org',
] as const;

export const SESSION_COOKIE_NAME = 'swa_session';
// Marker cookie set by `DELETE /api/session` when the dev bypass is active.
// While present, `getDevBypassSession` returns null so the portal behaves as
// logged-out — letting you reach `/login` and pick a different dev identity
// via the dev role-picker. Cleared by `POST /api/dev/login`. Production never
// sets it: `handleLogout` only emits it when `isDevBypassActive` is true.
export const DEV_LOGOUT_COOKIE_NAME = 'swa_dev_logout';
export const SESSION_DEFAULT_EXPIRY_MS = 12 * 60 * 60 * 1000;
export const SESSION_EXTENDED_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const OTP_TTL_SECONDS = 300;

export const OTP_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
export const OTP_RATE_LIMIT_MAX_REQUESTS = 5;

export const VERIFY_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
export const VERIFY_RATE_LIMIT_MAX_ATTEMPTS_IP = 10;
export const VERIFY_RATE_LIMIT_MAX_ATTEMPTS_EMAIL = 5;
export const VERIFY_MAX_FAILURES_PER_OTP = 5;

// Authenticated API rate limiting (per-user per-endpoint)
export const API_RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 15 minutes
export const API_RATE_LIMIT_MAX_REQUESTS = 10;

// Default recipients for public form submission notifications.
// May be overridden per-event via KV (swa:volunteer_event_config.notifyEmail).
export const VOLUNTEER_NOTIFY_EMAILS = [
  'cjtay@singaporewomenassociation.org',
  'jolene.lim@singaporewomenassociation.org',
  'angela.wong@singaporewomenassociation.org',
];

// Membership application form — recipients for new submission notifications.
export const MEMBERSHIP_NOTIFY_EMAILS = [
  'cjtay@singaporewomenassociation.org',
  'jolene.lim@singaporewomenassociation.org',
  'angela.wong@singaporewomenassociation.org',
];

// Restricted set of admins who can approve or reject membership applications.
// Other admins retain member/booking CRUD but cannot transition
// membership_applications.status. See docs/plans/membership-lifecycle-plan.md §3.
//
// The approve/reject gate is `isMembershipApprover(email)` (defined below),
// which checks membership in MEMBERSHIP_APPROVER_EMAILS OR IT_ADMIN_EMAILS.
// Per 14-07-2026 SWA review: IT admins can also approve/reject.
export const MEMBERSHIP_APPROVER_EMAILS = [
  'angela.wong@singaporewomenassociation.org',
  'roxanne.zhang@singaporewomenassociation.org',
] as const;

/**
 * Returns true if the given email is authorised to approve or reject
 * membership applications. The approver set is the union of
 * MEMBERSHIP_APPROVER_EMAILS and IT_ADMIN_EMAILS.
 *
 * Per 14-07-2026 SWA review: "IT admin to be able to approve or reject
 * membership" in addition to the named approvers.
 */
export function isMembershipApprover(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    (IT_ADMIN_EMAILS as readonly string[]).includes(lower) ||
    (MEMBERSHIP_APPROVER_EMAILS as readonly string[]).includes(lower)
  );
}

// First-year membership fee tier (per 2026-07-13 SWA review).
// Tier resolved by submission month: Jan–Jun → $20; Jul–Dec → $10.
// Renewal fee is $20 every year, anchored to 31 January.
//
// Per 14-07-2026 SWA review: fees are hardcoded here as the single source
// of truth — no KV storage. The registration form reads these constants
// via /api/membership/config. The legacy membership_types D1 table is
// dormant and no longer read. See docs/plans/membership-lifecycle-plan.md §3.
export const MEMBERSHIP_FIRST_YEAR_FEE_BEFORE_JULY = 20;
export const MEMBERSHIP_FIRST_YEAR_FEE_FROM_JULY = 10;
export const MEMBERSHIP_RENEWAL_FEE = 20;

// PayNow merchant details for the membership application QR.
// UEN is the same SWA entity used across SWA online properties (e.g. gtw2026).
export const SWA_UEN = 'S54SS0010L';
export const SWA_PAYNOW_MERCHANT_NAME = 'SWA';

// IP rate limit for the public membership submission endpoint.
export const MEMBERSHIP_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
export const MEMBERSHIP_RATE_LIMIT_MAX_REQUESTS = 10;

// Max upload size for PayNow screenshot + signature image (10 MB each).
export const MEMBERSHIP_MAX_FILE_BYTES = 10 * 1024 * 1024;

// ── Namecard (public /c/* surface) ─────────────────────────────────────────
//
// IP-keyed rate limit for the high-cost public namecard endpoints
// (/c/:slug/contact.vcf, /c/:slug/card.svg, /c/:slug/photo.*). The HTML page
// is exempt so QR-scan → page-load stays snappy. See docs/NAMECARD.md §5.4.
export const NAMECARD_PUBLIC_RATE_LIMIT_WINDOW_SECONDS = 60;
export const NAMECARD_PUBLIC_RATE_LIMIT_MAX_REQUESTS = 60;

// Hard server-side cap on namecard photo uploads. The admin upload form
// also resizes client-side to ~800×800, but the server enforces this
// regardless of what the client sends. See docs/NAMECARD.md §4.2.
export const NAMECARD_PHOTO_MAX_BYTES = 2 * 1024 * 1024;

