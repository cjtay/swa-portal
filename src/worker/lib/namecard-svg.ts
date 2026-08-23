// Branded namecard SVG renderer (1050×600, landscape business card).
//
// Implements the design spec at docs/plans/Namecard-Implementation-Plan.md §1.3
// (Lee Li Hua reference card). Where that spec conflicts with the older
// generic sketch in docs/specs/features/namecards.md §8.1, the §1.3 design wins — see the
// conflicts table in the plan.
//
// ──────────────────────────────────────────────────────────────────────────
// CRITICAL — every visual asset is INLINED
// ──────────────────────────────────────────────────────────────────────────
// The card SVG is converted to a PNG client-side via canvas + `toDataURL`
// (docs/specs/features/namecards.md §8.2). Any external resource reference (`<img href>`,
// `@import`, `url(...)`) taints the canvas and silently breaks the export
// with a SecurityError. Every asset — photo, logo badge, font — must be a
// data URI or inline. The renderCardSvg output must contain zero `http://`,
// `https://`, or `/` URL references in attributes that resolve to a
// subresource. (The card's own URL is NOT on the card per the design, so
// there is no legitimate reason for an external URL.)

import { escapeVcard } from './namecard-sanitize';
import { NAMECARD_DESIGN_COLOURS } from './swa-monogram';
import { SWA_LOGO_DATA_URI } from './swalogo-generated';
import type { VcardMemberInput, VcardNamecardInput } from './namecard-vcard';

export interface RenderCardSvgOptions {
  member: VcardMemberInput;
  namecard: VcardNamecardInput;
  /**
   * Optional photo. Must be supplied as a `data:image/...;base64,...` URI so
   * the rendered SVG stays self-contained (no external refs). The caller is
   * responsible for fetching from R2 and base64-encoding before calling this.
   */
  photoDataUri?: string | null;
}

// ── Geometry (px), all from §1.3 ────────────────────────────────────────────
const CARD_W = 1050;
const CARD_H = 600;

const PHOTO_X = 97;
const PHOTO_Y = 59;
const PHOTO_W = 230;
const PHOTO_H = 220;
const PHOTO_RADIUS = 10;

const LOGO_DIAMETER = 190;
const LOGO_MARGIN_RIGHT = 95;
const LOGO_Y = 55;
// Logo is placed by its right-edge so it sticks to the right margin regardless
// of diameter tweaks.
const LOGO_X = CARD_W - LOGO_MARGIN_RIGHT - LOGO_DIAMETER;

const TEXT_LEFT = 95; // left-aligned with the photo
const TEXT_RIGHT_MARGIN = 95; // right padding for the divider
const DIVIDER_RIGHT = CARD_W - TEXT_RIGHT_MARGIN;

// Vertical rhythm. The reference card has a "noticeably large gap" between
// the title and the divider, roughly double a normal line-gap.
const NAME_Y = PHOTO_Y + PHOTO_H + 56; // generous gap under the photo
const TITLE_Y = NAME_Y + 56; // large gap after the name per §1.3
const DIVIDER_Y = TITLE_Y + 50; // small gap after title
const PHONE_Y = DIVIDER_Y + 50; // small gap after divider
const EMAIL_Y = PHONE_Y + 34; // single line-gap after phone

const DIVIDER_THICKNESS = 5;

// ── Typography (px) ─────────────────────────────────────────────────────────
const NAME_SIZE = 40;
const TITLE_SIZE = 22;
const CONTACT_SIZE = 17;

/**
 * Render a namecard as a self-contained SVG string.
 *
 * The result is a single `<svg>` element, 1050×600, with every asset inlined
 * (no external URL references). Suitable for:
 *   - serving at GET /c/:slug/card.svg
 *   - client-side canvas → PNG export (docs/specs/features/namecards.md §8.2)
 */
export function renderCardSvg(opts: RenderCardSvgOptions): string {
  const { member, namecard } = opts;
  const colours = NAMECARD_DESIGN_COLOURS;
  const name = escapeXml(member.name.trim() || 'Member');
  const title = escapeXml((member.job_title ?? '').trim());
  const titleTruncated = truncateTitle(title, TEXT_LEFT, DIVIDER_RIGHT, TITLE_SIZE);
  const phone = escapeXml((member.mobile ?? '').trim());
  const email = escapeXml((member.email ?? '').trim());

  // The photo clip is a rounded rectangle matching the photo's bounds so a
  // square source fills cleanly with rounded corners.
  const photoMarkup = opts.photoDataUri
    ? `
    <defs>
      <clipPath id="photoClip">
        <rect x="${PHOTO_X}" y="${PHOTO_Y}" width="${PHOTO_W}" height="${PHOTO_H}" rx="${PHOTO_RADIUS}" ry="${PHOTO_RADIUS}"/>
      </clipPath>
    </defs>
    <image href="${opts.photoDataUri}" x="${PHOTO_X}" y="${PHOTO_Y}" width="${PHOTO_W}" height="${PHOTO_H}" clip-path="url(#photoClip)" preserveAspectRatio="xMidYMid slice"/>`
    : `
    <rect x="${PHOTO_X}" y="${PHOTO_Y}" width="${PHOTO_W}" height="${PHOTO_H}" rx="${PHOTO_RADIUS}" ry="${PHOTO_RADIUS}" fill="rgba(255,255,255,0.18)"/>`;

  // Logo badge: a white circular backdrop with the SWA logo drawn on top.
  // Matches the proven PayNow QR pattern (src/pages/reg/membership/
  // register.astro:172-188) — white circle at radius r, logo drawn centred
  // at diameter r*1.4 so it slightly overlaps the circle edge. The WebP has
  // transparent corners, so the white circle shows through where the logo
  // doesn't cover; no clipping needed.
  //
  // The logo is embedded as a base64 data URI (image/webp) so the SVG stays
  // self-contained and the canvas PNG export is not tainted.
  const logoRadius = LOGO_DIAMETER / 2;
  const logoCx = LOGO_X + logoRadius;
  const logoCy = LOGO_Y + logoRadius;
  const logoDrawSize = logoRadius * 1.4;
  const logoMarkup = `
  <circle cx="${logoCx}" cy="${logoCy}" r="${logoRadius}" fill="${colours.logoBg}"/>
  <image href="${SWA_LOGO_DATA_URI}" x="${logoCx - logoDrawSize / 2}" y="${logoCy - logoDrawSize / 2}" width="${logoDrawSize}" height="${logoDrawSize}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}" width="${CARD_W}" height="${CARD_H}" role="img" aria-label="${escapeXml(member.name)} namecard">
  <rect width="${CARD_W}" height="${CARD_H}" fill="${colours.bgPurple}"/>${photoMarkup}${logoMarkup}
  <text x="${TEXT_LEFT}" y="${NAME_Y}" font-family="Poppins, 'Segoe UI', Roboto, sans-serif" font-size="${NAME_SIZE}" font-weight="700" fill="${colours.textWhite}">${name}</text>
  <text x="${TEXT_LEFT}" y="${TITLE_Y}" font-family="Poppins, 'Segoe UI', Roboto, sans-serif" font-size="${TITLE_SIZE}" font-weight="300" fill="${colours.textWhite}">${titleTruncated}</text>
  <rect x="${TEXT_LEFT}" y="${DIVIDER_Y}" width="${DIVIDER_RIGHT - TEXT_LEFT}" height="${DIVIDER_THICKNESS}" fill="${colours.divider}"/>
  <text x="${TEXT_LEFT}" y="${PHONE_Y}" font-family="Poppins, 'Segoe UI', Roboto, sans-serif" font-size="${CONTACT_SIZE}" font-weight="400" fill="${colours.textWhite}">${phone}</text>
  <text x="${TEXT_LEFT}" y="${EMAIL_Y}" font-family="Poppins, 'Segoe UI', Roboto, sans-serif" font-size="${CONTACT_SIZE}" font-weight="400" fill="${colours.textWhite}">${email}</text>
</svg>`;
}

/**
 * Truncate a long title so it fits on a single line within the text column.
 *
 * Long titles ("Advisor / Immediate Past President") approach the column
 * width at the title size; multi-line titles break the vertical rhythm. We
 * shrink-to-fit slightly then ellipsis. The full title is preserved in the
 * vCard TITLE field and on the public HTML page — only the card image
 * truncates.
 *
 * Estimate: ~0.6 em average per character for Poppins Light at 22px, with a
 * safety margin so we truncate slightly early rather than overflow the column.
 */
function truncateTitle(title: string, leftX: number, rightX: number, fontSize: number): string {
  if (!title) return '';
  const maxWidthPx = rightX - leftX;
  const approxCharWidth = fontSize * 0.6;
  const maxChars = Math.floor(maxWidthPx / approxCharWidth);
  if (title.length <= maxChars) return title;
  // Leave room for the ellipsis.
  return title.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…';
}

/** Escape a string for safe inclusion as SVG text content. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
