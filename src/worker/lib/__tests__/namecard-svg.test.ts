import { describe, it, expect } from 'vitest';
import { renderCardSvg, type RenderCardSvgOptions } from '../namecard-svg';

const baseMember: RenderCardSvgOptions['member'] = {
  name: 'Lee Li Hua',
  email: 'lihua.lee@singaporewomenassociation.org',
  mobile: '+65 9123 4567',
  job_title: 'Advisor / Immediate Past President',
  role: 'Advisor',
  address_line1: '96 Waterloo Street',
  address_line2: null,
  address_postal_code: '187967',
  address_country: 'Singapore',
};

const baseNamecard: RenderCardSvgOptions['namecard'] = {
  slug: 'lee-li-hua',
  bio: null,
  name_family: null,
  name_given: null,
  whatsapp: null,
  website: null,
  facebook: null,
  linkedin: null,
  instagram: null,
  tiktok: null,
  youtube: null,
  updated_at: '2026-07-25 12:00:00',
};

function render(overrides: Partial<RenderCardSvgOptions> = {}): string {
  return renderCardSvg({ member: baseMember, namecard: baseNamecard, ...overrides });
}

describe('renderCardSvg — structure and dimensions', () => {
  it('emits a single root <svg> with the 1050×600 viewBox', () => {
    const svg = render();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('viewBox="0 0 1050 600"');
    expect(svg).toContain('width="1050"');
    expect(svg).toContain('height="600"');
  });

  it('has exactly one root <svg> tag', () => {
    const svg = render();
    const openCount = (svg.match(/<svg\b/g) ?? []).length;
    const closeCount = (svg.match(/<\/svg>/g) ?? []).length;
    // Two of each is OK — the badge is an inline-XML fragment (no outer <svg>),
    // so there should be exactly one outer pair.
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it('fills the entire card with the §1.3 background purple', () => {
    const svg = render();
    expect(svg).toContain('fill="#7A0381"');
  });
});

describe('renderCardSvg — content (the four required text rows)', () => {
  it('renders the name, title, phone, and email', () => {
    const svg = render();
    expect(svg).toContain('Lee Li Hua');
    expect(svg).toContain('Advisor / Immediate Past President');
    expect(svg).toContain('+65 9123 4567');
    expect(svg).toContain('lihua.lee@singaporewomenassociation.org');
  });

  it('uses Bold weight for the name and Light for the title', () => {
    const svg = render();
    // Name element
    const nameText = svg.match(/font-size="40"[^>]*font-weight="700"[^>]*>[^<]*Lee Li Hua/);
    expect(nameText).not.toBeNull();
    // Title element
    const titleText = svg.match(/font-size="22"[^>]*font-weight="300"/);
    expect(titleText).not.toBeNull();
  });

  it('renders the divider as a translucent white rect', () => {
    const svg = render();
    expect(svg).toContain('fill="rgba(255, 255, 255, 0.8)"');
  });

  it('omits the card URL — design spec says no URL on the card', () => {
    const svg = render();
    expect(svg).not.toContain('/c/lee-li-hua');
    expect(svg).not.toContain('admin.singaporewomenassociation.org');
  });

  it('omits the social icon strip — socials are on the HTML page only', () => {
    const svg = render({
      namecard: { ...baseNamecard, facebook: 'https://fb.com/swa', linkedin: 'https://li.com/in/x' },
    });
    expect(svg).not.toContain('facebook');
    expect(svg).not.toContain('linkedin');
    expect(svg).not.toContain('fb.com');
  });
});

describe('renderCardSvg — self-containment (canvas-untainted requirement)', () => {
  it('contains no external http(s) URL references in src/href/xlink:href attributes', () => {
    const svg = render({ photoDataUri: 'data:image/jpeg;base64,/9j/4AAQ' });
    // Find any href=/src=/xlink:href= attribute value and assert each is either
    // a data: URI (an inlined subresource) OR a same-document fragment ref
    // (e.g. `#photoClip` or `#swaRing`). Anything else would either break
    // self-containment or taint the canvas.
    const refs = svg.match(/(?:xlink:href|href|src)\s*=\s*"([^"]*)"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const value = ref.replace(/^.*?"([^"]*)"$/, '$1');
      const safe = value.startsWith('data:') || value.startsWith('#');
      expect(safe).toBe(true);
    }
  });

  it('does not embed any external http(s) subresource (URLs only allowed as the xmlns namespace, which is not a fetch)', () => {
    const svg = render({ photoDataUri: 'data:image/jpeg;base64,/9j/4AAQ' });
    // The SVG xmlns namespace is `http://www.w3.org/2000/svg` and is mandatory;
    // it is an identifier, not a fetch, and does not taint the canvas. Every
    // OTHER occurrence of http(s):// would be a subresource — none allowed.
    const stripped = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
    expect(stripped).not.toMatch(/https?:\/\//);
  });

  it('inlines the photo as a data URI when one is supplied', () => {
    const svg = render({ photoDataUri: 'data:image/jpeg;base64,/9j/4AAQ' });
    expect(svg).toContain('href="data:image/jpeg;base64,/9j/4AAQ"');
  });

  it('renders a translucent photo placeholder when no photo is supplied', () => {
    const svg = render();
    // The placeholder rect is present.
    expect(svg).toContain('fill="rgba(255,255,255,0.18)"');
    // No PHOTO is embedded. (The SWA logo is always embedded as an
    // image/webp data URI — that's expected; this assertion is scoped to
    // the photo MIME types a member headshot would carry: jpeg/png only.)
    expect(svg).not.toMatch(/href="data:image\/(jpeg|png)/);
  });

  it('always inlines the SWA logo as a white-background circle + webp data URI', () => {
    const svg = render();
    // White circular badge backdrop.
    expect(svg).toMatch(/<circle[^>]*fill="#FFFFFF"/);
    // The logo is embedded as a base64 WebP data URI (the same asset the
    // admin nav and PayNow QR use). Verifies the generator ran and the
    // renderer picked it up.
    expect(svg).toContain('href="data:image/webp;base64,');
  });
});

describe('renderCardSvg — escaping and edge cases', () => {
  it('escapes XML-significant characters in the name', () => {
    const svg = render({
      member: { ...baseMember, name: 'A <B> & "C" \\\'D\\\'', job_title: '' },
    });
    expect(svg).toContain('&lt;B&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&quot;C&quot;');
    // Should not break XML structure: still exactly one root svg pair.
    expect((svg.match(/<svg\b/g) ?? []).length).toBe(1);
    expect((svg.match(/<\/svg>/g) ?? []).length).toBe(1);
  });

  it('uses a fallback name when the member name is blank', () => {
    const svg = render({ member: { ...baseMember, name: '' } });
    expect(svg).toContain('>Member<');
  });

  it('truncates very long titles with an ellipsis on a single line', () => {
    // maxChars at 22px / 0.6 width = 65. Use a title clearly over the limit.
    const longTitle = 'Chief Officer of Many Many Many Things and Such and So Forth Without End Also Further';
    const svg = render({ member: { ...baseMember, job_title: longTitle } });
    expect(svg).toContain('…');
    // No raw newline in the title (single line).
    const titleMatch = svg.match(/font-size="22"[^>]*>([^<]*)</);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1]).not.toContain('\n');
    // The full untruncated title must NOT appear.
    expect(svg).not.toContain(longTitle);
  });

  it('leaves the canonical "Advisor / Immediate Past President" title untruncated', () => {
    const svg = render();
    expect(svg).toContain('Advisor / Immediate Past President');
    expect(svg).not.toContain('…');
  });
});
