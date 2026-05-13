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
