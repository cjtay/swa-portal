export const IT_ADMIN_EMAILS = [
  'cjtay@singaporewomenassociation.org',
  'angela.wong@singaporewomenassociation.org',
  'system@singaporewomenassociation.org',
] as const;

export const SESSION_COOKIE_NAME = 'swa_session';
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

// Membership fee schedule lives in D1 (membership_types rows, ids 1 and 2)
// so admins can change fees without a redeploy. The membership-reg config
// handler reads them at runtime.

// PayNow merchant details for the membership application QR.
// UEN is the same SWA entity used across SWA online properties (e.g. gtw2026).
export const SWA_UEN = 'S54SS0010L';
export const SWA_PAYNOW_MERCHANT_NAME = 'SWA';

// IP rate limit for the public membership submission endpoint.
export const MEMBERSHIP_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
export const MEMBERSHIP_RATE_LIMIT_MAX_REQUESTS = 10;

// Max upload size for PayNow screenshot + signature image (10 MB each).
export const MEMBERSHIP_MAX_FILE_BYTES = 10 * 1024 * 1024;

