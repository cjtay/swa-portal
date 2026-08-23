// vCard 3.0 builder for the public namecard .vcf endpoint.
//
// Produces a single vCard string per RFC 2426, with:
//   - CRLF line endings (mandatory — some contact apps reject LF-only vcards)
//   - line folding at 75 octets per RFC 2426 §5 (the continuation line begins
//     with a single space)
//   - escaped text values (comma, semicolon, backslash, newline)
//   - N: field sourced from name_family/name_given overrides when set, else
//     split on the last whitespace (Western-order fallback). This is the fix
//     for the documented limitation with Malay/Indian/mononym/multi-word-
//     surname names common in SWA's membership.
//   - PHOTO;ENCODING=b;TYPE=jpeg:<base64> when a photo is supplied, with the
//     base64 folded across lines
//   - REV: from the namecard row's updated_at, reformatted as
//     YYYYMMDDTHHMMSSZ (UTC), so re-importing an updated card refreshes the
//     contact on devices that honour REV
//   - X-SOCIALPROFILE;TYPE=<platform>:<url> for each populated social field
//
// See docs/NAMECARD.md §9.3 for the field-by-field spec.

import { escapeVcard } from './namecard-sanitize';
import { SWA_OFFICE_ADDRESS } from '../../constants/portal';

/** Identity fields read from the members table at render time. */
export interface VcardMemberInput {
  name: string;
  email: string | null;
  mobile: string | null;
  job_title: string | null;
  role: string | null;
}

/** Presentation fields read from the namecards table. */
export interface VcardNamecardInput {
  slug: string;
  bio: string | null;
  name_family: string | null;
  name_given: string | null;
  whatsapp: string | null;
  website: string | null;
  facebook: string | null;
  linkedin: string | null;
  instagram: string | null;
  tiktok: string | null;
  youtube: string | null;
  /** ISO-ish timestamp from D1 (datetime('now')) — 'YYYY-MM-DD HH:MM:SS' UTC. */
  updated_at: string | null;
}

export interface BuildVcardOptions {
  member: VcardMemberInput;
  namecard: VcardNamecardInput;
  /** Public base URL of the card, e.g. 'https://admin.singaporewomenassociation.org'. */
  cardBaseUrl: string;
  /** Optional photo: raw bytes plus the MIME type for the TYPE= param. */
  photo?: { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' } | null;
  /** Optional org website URL for a second URL: line (defaults to SWA marketing site). */
  orgWebsiteUrl?: string;
}

const CRLF = '\r\n';

/**
 * Build a vCard 3.0 string for a namecard.
 *
 * The returned string uses CRLF line endings and is folded at 75 octets. It
 * always begins with `BEGIN:VCARD` and ends with `END:VCARD`.
 */
export function buildVcard(opts: BuildVcardOptions): string {
  const { member, namecard, cardBaseUrl } = opts;
  const cardUrl = `${cardBaseUrl.replace(/\/+$/, '')}/c/${namecard.slug}`;
  const orgUrl = (opts.orgWebsiteUrl ?? 'https://www.singaporewomenassociation.org').trim();

  const { familyName, givenName } = resolveNameParts(member.name, namecard);
  const fullName = member.name.trim();

  // Build each property as a single unfolded `NAME;PARAMS:VALUE` line first,
  // then fold the whole document at the end. Folding must operate on the
  // CRLF-joined string so byte offsets are correct.
  const lines: string[] = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');
  lines.push(`FN:${escapeVcard(fullName)}`);
  lines.push(`N:${escapeVcard(familyName)};${escapeVcard(givenName)};;;`);
  if (member.job_title) lines.push(`TITLE:${escapeVcard(member.job_title)}`);
  lines.push('ORG:Singapore Women\\\'s Association');
  if (member.mobile) lines.push(`TEL;TYPE=CELL:${escapeVcard(member.mobile)}`);
  if (member.email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVcard(member.email)}`);
  // ADR is ALWAYS the SWA office address (2026-08-23) — personal member
  // addresses are never exported to a vCard. ADR uses semicolons as field
  // separators (PO box; extended; street; locality; region; postal; country).
  const adr = [
    '', // PO box
    '', // extended address
    SWA_OFFICE_ADDRESS.line1,
    SWA_OFFICE_ADDRESS.country, // locality
    '', // region
    SWA_OFFICE_ADDRESS.postal_code,
    SWA_OFFICE_ADDRESS.country,
  ]
    .map((p) => escapeVcard(p))
    .join(';');
  lines.push(`ADR;TYPE=WORK:${adr}`);
  lines.push(`URL:${cardUrl}`);
  if (orgUrl) lines.push(`URL:${orgUrl}`);

  // Socials via the widely-supported X-SOCIALPROFILE extension. iOS Contacts
  // and most Android skins either import or safely ignore these.
  const socials: Array<[string, string | null]> = [
    ['facebook', namecard.facebook],
    ['linkedin', namecard.linkedin],
    ['instagram', namecard.instagram],
    ['tiktok', namecard.tiktok],
    ['youtube', namecard.youtube],
  ];
  for (const [platform, url] of socials) {
    if (url && url.trim()) lines.push(`X-SOCIALPROFILE;TYPE=${platform}:${url.trim()}`);
  }

  if (namecard.bio && namecard.bio.trim()) {
    lines.push(`NOTE:${escapeVcard(namecard.bio)}`);
  }

  if (opts.photo) {
    const typeParam = photoTypeParam(opts.photo.mimeType);
    const b64 = base64Bytes(opts.photo.bytes);
    lines.push(`PHOTO;ENCODING=b;TYPE=${typeParam}:${b64}`);
  }

  lines.push(`REV:${formatRev(namecard.updated_at)}`);
  lines.push('END:VCARD');

  const unfolded = lines.join(CRLF);
  return foldVcard(unfolded) + CRLF;
}

/**
 * Split a display name into (familyName, givenName) using overrides when set,
 * else splitting on the last whitespace (Western order). Mononyms produce
 * (name, '').
 */
export function resolveNameParts(
  displayName: string,
  namecard: Pick<VcardNamecardInput, 'name_family' | 'name_given'>,
): { familyName: string; givenName: string } {
  const fam = (namecard.name_family ?? '').trim();
  const giv = (namecard.name_given ?? '').trim();
  if (fam || giv) return { familyName: fam, givenName: giv };
  const trimmed = displayName.trim();
  if (!trimmed) return { familyName: '', givenName: '' };
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace < 0) return { familyName: trimmed, givenName: '' };
  return {
    givenName: trimmed.slice(0, lastSpace),
    familyName: trimmed.slice(lastSpace + 1),
  };
}

/**
 * Fold long lines at 75 octets per RFC 2426 §5. The continuation line begins
 * with a single space. Operates on the full CRLF-joined document.
 *
 * Breaks at a *character boundary* that fits within the byte budget — never
 * inside a multi-byte UTF-8 sequence. The RFC's "75 octet" rule is a maximum,
 * not a target; cutting a few bytes short to land on a character boundary is
 * the standard vCard producer behaviour and is what `wrangler d1` produces.
 */
export function foldVcard(document: string): string {
  const lines = document.split(CRLF);
  return lines
    .map((line) => foldLine(line, 75, 74))
    .join(CRLF);
}

/**
 * Fold a single line. The first chunk is at most `firstMaxBytes` octets;
 * each continuation chunk (preceded by a single space) is at most
 * `contMaxBytes` octets, both broken at a character boundary.
 */
function foldLine(line: string, firstMaxBytes: number, contMaxBytes: number): string {
  if (byteLength(line) <= firstMaxBytes) return line;
  const chunks: string[] = [];
  let pos = 0;
  let isFirst = true;
  while (pos < line.length) {
    const budget = isFirst ? firstMaxBytes : contMaxBytes;
    const next = takeBytesOnCharBoundary(line, pos, budget);
    if (next.end === pos) {
      // Pathological: a single character is larger than the budget. Force-emit
      // it to avoid an infinite loop (this cannot happen with our budget ≥74).
      chunks.push((isFirst ? '' : ' ') + line[pos]);
      pos += 1;
    } else {
      chunks.push((isFirst ? '' : ' ') + line.slice(pos, next.end));
      pos = next.end;
    }
    isFirst = false;
  }
  return chunks.join(CRLF);
}

/**
 * Walk forward from `start` accumulating UTF-8 byte length; return the index
 * of the last character boundary that fits within `maxBytes`. Always returns
 * an end ≥ start + 1 unless the very first character already exceeds the
 * budget (caller handles that).
 */
function takeBytesOnCharBoundary(
  s: string,
  start: number,
  maxBytes: number,
): { end: number } {
  let acc = 0;
  let lastSafeEnd = start;
  for (let i = start; i < s.length; i++) {
    const charBytes = byteLength(s[i]);
    if (acc + charBytes > maxBytes) break;
    acc += charBytes;
    lastSafeEnd = i + 1;
  }
  return { end: lastSafeEnd };
}

/**
 * Format the D1 `updated_at` ('YYYY-MM-DD HH:MM:SS', UTC) as the vCard REV
 * format: 'YYYYMMDDTHHMMSSZ'. Returns the current time if input is missing
 * or unparseable so the field is always present.
 */
export function formatRev(updatedAt: string | null | undefined): string {
  const fallback = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  if (!updatedAt) return fallback;
  // Accept 'YYYY-MM-DD HH:MM:SS' (D1) or 'YYYY-MM-DDTHH:MM:SS' or full ISO.
  const m = updatedAt.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return fallback;
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`;
}

function photoTypeParam(mimeType: 'image/jpeg' | 'image/png' | 'image/webp'): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
  }
}

/**
 * Base64-encode a Uint8Array. Avoids Node's Buffer (unavailable in the
 * Workers runtime without nodejs_compat). Uses the Web-standard pattern of
 * spreading the byte array into a string of char codes, then btoa().
 */
function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000; // avoid call-stack limits on large photos
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
