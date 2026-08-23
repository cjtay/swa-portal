// URL scheme allow-list, WhatsApp normalisation, and vCard value escaping
// for namecard fields. All validation happens server-side on write (see
// docs/specs/features/namecards.md §6.5) — the client cannot be trusted.

const SAFE_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * Validate that a URL string uses an allowed scheme (http or https only).
 *
 * Relative URLs, `javascript:`, `data:`, `vbscript:`, `file:`, and any other
 * scheme are rejected. Empty/null/undefined values are allowed (the field is
 * simply unset) — call this on the trimmed value before storing.
 *
 * Returns true for safe URLs and for empty input; false for anything else.
 */
export function isSafeUrl(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  try {
    const url = new URL(trimmed);
    return SAFE_URL_SCHEMES.has(url.protocol.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Normalise a WhatsApp number to full international form, digits-only with a
 * leading `+`. Accepts human-formatted input like `+65 9123 4567` or
 * `65-9123-4567` and returns `+6591234567`.
 *
 * Returns null when the input has no digits (treated as unset). Throws on
 * input that contains digits but does not start with `+` after normalisation
 * — the caller should surface this as a 400 (the admin typed a domestic
 * number without a country code, which would silently produce a broken link).
 */
export function normaliseWhatsApp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const hasPlus = /^[+]/.test(trimmed);
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits === '') return null;
  if (!hasPlus) {
    // No country code prefix → ambiguous. Reject rather than guess.
    throw new WhatsAppNormalisationError(
      'WhatsApp number must include the country code (e.g. +65 9123 4567).',
    );
  }
  return `+${digits}`;
}

/** Thrown by normaliseWhatsApp when the input is malformed. Caller maps to 400. */
export class WhatsAppNormalisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppNormalisationError';
  }
}

/**
 * Escape a vCard 3.0 text value per RFC 2426 §4. Backslash, comma, semicolon,
 * and newline are escaped. Newlines become `\n` (the vCard representation of
 * a line break inside a single field). CRLF is added by the line-folder, not
 * here.
 */
export function escapeVcard(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r?\n/g, '\\n');
}
