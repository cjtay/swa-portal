import { describe, it, expect } from 'vitest';
import { qrPayload } from '../namecard-qr';

const BASE = 'https://admin.singaporewomenassociation.org';

describe('qrPayload', () => {
  it('encodes the .vcf URL for the vcf variant', () => {
    expect(qrPayload({ cardBaseUrl: BASE, slug: 'sarah-chen', variant: 'vcf' })).toBe(
      `${BASE}/c/sarah-chen/contact.vcf`,
    );
  });

  it('encodes the page URL for the page variant', () => {
    expect(qrPayload({ cardBaseUrl: BASE, slug: 'sarah-chen', variant: 'page' })).toBe(
      `${BASE}/c/sarah-chen`,
    );
  });

  it('strips a trailing slash from the base URL', () => {
    expect(qrPayload({ cardBaseUrl: BASE + '/', slug: 'sarah-chen', variant: 'vcf' })).toBe(
      `${BASE}/c/sarah-chen/contact.vcf`,
    );
    expect(qrPayload({ cardBaseUrl: BASE + '///', slug: 'sarah-chen', variant: 'page' })).toBe(
      `${BASE}/c/sarah-chen`,
    );
  });

  it('also accepts a dev localhost base', () => {
    expect(qrPayload({ cardBaseUrl: 'http://localhost:8787', slug: 'sarah-chen', variant: 'page' })).toBe(
      'http://localhost:8787/c/sarah-chen',
    );
  });

  it('throws on an unknown variant', () => {
    expect(() => qrPayload({ cardBaseUrl: BASE, slug: 'sarah-chen', variant: 'unknown' as never })).toThrow();
  });
});
