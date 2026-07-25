import { describe, it, expect } from 'vitest';
import {
  buildVcard,
  foldVcard,
  formatRev,
  resolveNameParts,
  type BuildVcardOptions,
} from '../namecard-vcard';

const baseMember: BuildVcardOptions['member'] = {
  name: 'Sarah Chen',
  email: 'sarah.chen@singaporewomenassociation.org',
  mobile: '+65 9123 4567',
  job_title: 'Chief Innovation Officer',
  role: 'Committee',
  address_line1: '96 Waterloo Street',
  address_line2: null,
  address_postal_code: '187967',
  address_country: 'Singapore',
};

const baseNamecard: BuildVcardOptions['namecard'] = {
  slug: 'sarah-chen',
  bio: null,
  name_family: null,
  name_given: null,
  whatsapp: null,
  website: null,
  facebook: 'https://www.facebook.com/swa.sg',
  linkedin: 'https://www.linkedin.com/in/sarah-chen',
  instagram: null,
  tiktok: null,
  youtube: null,
  updated_at: '2026-07-25 12:00:00',
};

function makeOpts(overrides: Partial<BuildVcardOptions> = {}): BuildVcardOptions {
  return {
    member: baseMember,
    namecard: baseNamecard,
    cardBaseUrl: 'https://admin.singaporewomenassociation.org',
    ...overrides,
  };
}

describe('buildVcard — structure', () => {
  it('emits BEGIN/END and VERSION 3.0', () => {
    const vcf = buildVcard(makeOpts());
    expect(vcf.startsWith('BEGIN:VCARD\r\n')).toBe(true);
    expect(vcf.includes('VERSION:3.0\r\n')).toBe(true);
    expect(vcf.trim().endsWith('END:VCARD')).toBe(true);
  });

  it('uses CRLF line endings', () => {
    const vcf = buildVcard(makeOpts());
    expect(vcf).not.toMatch(/\r[^\n]/); // no lone CR
    expect(vcf).not.toMatch(/[^\r]\n/); // no lone LF
  });

  it('emits the canonical SWA example fields', () => {
    const vcf = buildVcard(makeOpts());
    expect(vcf).toContain('FN:Sarah Chen\r\n');
    expect(vcf).toContain('N:Chen;Sarah;;;\r\n');
    expect(vcf).toContain('TITLE:Chief Innovation Officer\r\n');
    expect(vcf).toContain('ORG:Singapore Women\\\'s Association\r\n');
    expect(vcf).toContain('TEL;TYPE=CELL:+65 9123 4567\r\n');
    expect(vcf).toContain('EMAIL;TYPE=INTERNET:sarah.chen@singaporewomenassociation.org\r\n');
    expect(vcf).toContain('URL:https://admin.singaporewomenassociation.org/c/sarah-chen\r\n');
  });

  it('emits ADR with the street address split correctly', () => {
    const vcf = buildVcard(makeOpts());
    // ADR fields: PO box; extended; street; locality; region; postal; country
    expect(vcf).toContain('ADR;TYPE=WORK:;;96 Waterloo Street;Singapore;;187967;Singapore');
  });

  it('includes a social line per populated platform', () => {
    const vcf = buildVcard(makeOpts());
    expect(vcf).toContain('X-SOCIALPROFILE;TYPE=facebook:https://www.facebook.com/swa.sg');
    expect(vcf).toContain('X-SOCIALPROFILE;TYPE=linkedin:https://www.linkedin.com/in/sarah-chen');
    // Instagram/tiktok/youtube are null and must not appear.
    expect(vcf).not.toContain('TYPE=instagram');
    expect(vcf).not.toContain('TYPE=tiktok');
    expect(vcf).not.toContain('TYPE=youtube');
  });

  it('includes the REV timestamp from updated_at, ISO-style', () => {
    const vcf = buildVcard(makeOpts());
    expect(vcf).toContain('REV:20260725T120000Z');
  });

  it('omits the NOTE line when bio is null', () => {
    const vcf = buildVcard(makeOpts());
    expect(vcf).not.toContain('NOTE:');
  });

  it('emits NOTE with bio text when bio is present', () => {
    const vcf = buildVcard(
      makeOpts({ namecard: { ...baseNamecard, bio: ' Loves community work.' } }),
    );
    expect(vcf).toContain('NOTE: Loves community work.');
  });
});

describe('buildVcard — name handling', () => {
  it('uses name_family/name_given overrides when set', () => {
    const vcf = buildVcard(
      makeOpts({
        member: { ...baseMember, name: 'S. D. Rani' },
        namecard: { ...baseNamecard, name_family: 'Rani', name_given: 'S. Devi' },
      }),
    );
    expect(vcf).toContain('N:Rani;S. Devi;;;\r\n');
    // FN stays the display name.
    expect(vcf).toContain('FN:S. D. Rani\r\n');
  });

  it('falls back to splitting the display name on the last whitespace', () => {
    const vcf = buildVcard(makeOpts({ member: { ...baseMember, name: 'Lee Li Hua' } }));
    expect(vcf).toContain('N:Hua;Lee Li;;;\r\n');
    expect(vcf).toContain('FN:Lee Li Hua\r\n');
  });

  it('treats a mononym as the family name', () => {
    const vcf = buildVcard(makeOpts({ member: { ...baseMember, name: 'Madonna' } }));
    expect(vcf).toContain('N:Madonna;;;;\r\n');
  });

  it('escapes commas, semicolons, backslashes in fields', () => {
    const vcf = buildVcard(
      makeOpts({
        member: {
          ...baseMember,
          name: 'Sarah, Chen; Jr.',
          job_title: 'CFO \\ Treasurer',
        },
      }),
    );
    expect(vcf).toContain('FN:Sarah\\, Chen\\; Jr.');
    expect(vcf).toContain('TITLE:CFO \\\\ Treasurer');
  });
});

describe('buildVcard — photo embedding', () => {
  it('embeds PHOTO;ENCODING=b;TYPE=jpeg with base64 of the bytes', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG-ish magic
    const expectedB64 = btoa(String.fromCharCode(...bytes));
    const vcf = buildVcard(makeOpts({ photo: { bytes, mimeType: 'image/jpeg' } }));
    expect(vcf).toContain('PHOTO;ENCODING=b;TYPE=jpeg:');
    expect(vcf).toContain(expectedB64);
  });

  it('omits PHOTO when no photo is provided', () => {
    const vcf = buildVcard(makeOpts());
    expect(vcf).not.toContain('PHOTO;');
  });
});

describe('foldVcard', () => {
  it('leaves short lines unchanged', () => {
    expect(foldVcard('a\r\nb\r\nc')).toBe('a\r\nb\r\nc');
  });

  it('folds a long line at 75 octets with a leading-space continuation', () => {
    const long = 'PHOTO;ENCODING=b;TYPE=jpeg:' + 'A'.repeat(200);
    const folded = foldVcard(long);
    const lines = folded.split('\r\n');
    expect(lines[0].length).toBeLessThanOrEqual(75);
    // Every continuation line begins with a single space and is ≤75 octets.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].startsWith(' ')).toBe(true);
      expect(lines[i].length).toBeLessThanOrEqual(75);
    }
    // Reassembling the folded payload (drop the leading spaces) reconstructs the input.
    const reassembled = lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('');
    expect(reassembled).toBe(long);
  });

  it('never splits a multi-byte UTF-8 sequence', () => {
    // '中' is 3 bytes; build a long line where the 75-byte boundary falls inside it.
    const payload = 'N:' + '中'.repeat(40); // 80 bytes after N:
    const folded = foldVcard(payload);
    // Decode the whole folded block and confirm the original string is intact.
    const reassembled = folded
      .split('\r\n')
      .map((l, i) => (i === 0 ? l : l.slice(1)))
      .join('');
    expect(reassembled).toBe(payload);
    expect(reassembled).not.toContain('\uFFFD'); // no replacement chars from broken sequences
  });
});

describe('resolveNameParts', () => {
  it('returns overrides as-is', () => {
    const r = resolveNameParts('Anything', { name_family: 'Last', name_given: 'First' });
    expect(r).toEqual({ familyName: 'Last', givenName: 'First' });
  });

  it('uses only one override when only one is set (treats the other as empty)', () => {
    const r = resolveNameParts('X', { name_family: 'Last', name_given: null });
    expect(r).toEqual({ familyName: 'Last', givenName: '' });
  });

  it('splits a two-word name on the space', () => {
    expect(resolveNameParts('Sarah Chen', { name_family: null, name_given: null })).toEqual({
      familyName: 'Chen',
      givenName: 'Sarah',
    });
  });

  it('keeps middle names in the given-name portion', () => {
    expect(resolveNameParts('Mary Anne Reid', { name_family: null, name_given: null })).toEqual({
      familyName: 'Reid',
      givenName: 'Mary Anne',
    });
  });

  it('treats a mononym as the family name', () => {
    expect(resolveNameParts('Prince', { name_family: null, name_given: null })).toEqual({
      familyName: 'Prince',
      givenName: '',
    });
  });
});

describe('formatRev', () => {
  it('formats the D1 datetime format correctly', () => {
    expect(formatRev('2026-07-25 12:00:00')).toBe('20260725T120000Z');
  });

  it('accepts ISO 8601 with the T separator', () => {
    expect(formatRev('2026-07-25T12:00:00')).toBe('20260725T120000Z');
  });

  it('falls back to "now" when the input is null or malformed', () => {
    expect(formatRev(null)).toMatch(/^\d{8}T\d{6}Z$/);
    expect(formatRev(undefined)).toMatch(/^\d{8}T\d{6}Z$/);
    expect(formatRev('nonsense')).toMatch(/^\d{8}T\d{6}Z$/);
  });
});
