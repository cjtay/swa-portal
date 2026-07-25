import { describe, it, expect } from 'vitest';
import { isSafeUrl, normaliseWhatsApp, WhatsAppNormalisationError, escapeVcard } from '../namecard-sanitize';

describe('isSafeUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('https://www.facebook.com/swa.sg')).toBe(true);
  });

  it('accepts empty/null/undefined (treats as unset)', () => {
    expect(isSafeUrl('')).toBe(true);
    expect(isSafeUrl('   ')).toBe(true);
    expect(isSafeUrl(null)).toBe(true);
    expect(isSafeUrl(undefined)).toBe(true);
  });

  it('rejects dangerous schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JaVaScRiPt:alert(1)')).toBe(false); // case-insensitive
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isSafeUrl('not a url')).toBe(false);
    expect(isSafeUrl('example.com')).toBe(false); // no scheme
  });

  it('rejects other schemes', () => {
    expect(isSafeUrl('mailto:foo@example.com')).toBe(false);
    expect(isSafeUrl('tel:+6591234567')).toBe(false);
    expect(isSafeUrl('ftp://example.com')).toBe(false);
  });
});

describe('normaliseWhatsApp', () => {
  it('returns null for empty/null/undefined', () => {
    expect(normaliseWhatsApp('')).toBeNull();
    expect(normaliseWhatsApp('   ')).toBeNull();
    expect(normaliseWhatsApp(null)).toBeNull();
    expect(normaliseWhatsApp(undefined)).toBeNull();
  });

  it('strips formatting but keeps the leading plus and digits', () => {
    expect(normaliseWhatsApp('+65 9123 4567')).toBe('+6591234567');
    expect(normaliseWhatsApp('+65-9123-4567')).toBe('+6591234567');
    expect(normaliseWhatsApp('  +6591234567  ')).toBe('+6591234567');
    expect(normaliseWhatsApp('+1 (415) 555-2671')).toBe('+14155552671');
  });

  it('throws when digits exist but no country-code plus is provided', () => {
    expect(() => normaliseWhatsApp('91234567')).toThrow(WhatsAppNormalisationError);
    expect(() => normaliseWhatsApp('65 9123 4567')).toThrow(WhatsAppNormalisationError);
  });

  it('returns null when there are no digits at all', () => {
    expect(normaliseWhatsApp('+')).toBeNull();
    expect(normaliseWhatsApp('+ - - ')).toBeNull();
  });
});

describe('escapeVcard', () => {
  it('returns empty string for null/undefined', () => {
    expect(escapeVcard(null)).toBe('');
    expect(escapeVcard(undefined)).toBe('');
  });

  it('escapes commas, semicolons, backslashes', () => {
    expect(escapeVcard('a,b;c\\d')).toBe('a\\,b\\;c\\\\d');
  });

  it('escapes newlines (both LF and CRLF) as literal \\n', () => {
    expect(escapeVcard('line1\nline2')).toBe('line1\\nline2');
    expect(escapeVcard('line1\r\nline2')).toBe('line1\\nline2');
  });

  it('does not modify plain text', () => {
    expect(escapeVcard('Sarah Chen')).toBe('Sarah Chen');
  });
});
