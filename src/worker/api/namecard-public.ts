// Public namecard routes under /c/*.
//
// These routes are NOT under authMiddleware (which is scoped to /api/* only —
// see src/worker/index.ts:36). They serve the public card page, the vCard
// download, the SVG card image, and the photo stream.
//
// See docs/NAMECARD.md §6, §9.1, and the design spec in
// docs/plans/Namecard-Implementation-Plan.md §1.3.

import type { Context } from 'hono';
import type { Env, AppContext } from '../types';
import {
  NAMECARD_PUBLIC_RATE_LIMIT_MAX_REQUESTS,
} from '../../constants/portal';
import { checkNamecardIpRateLimit, clientIp } from '../lib/namecard-rate-limit';
import { streamNamecardPhoto, readNamecardPhotoBytes } from '../lib/namecard-photo';
import { buildVcard } from '../lib/namecard-vcard';
import { renderCardSvg } from '../lib/namecard-svg';


/** The canonical read model: namecard row joined with member identity. */
export interface PublicNamecardRow {
  name: string;
  email: string | null;
  mobile: string | null;
  job_title: string | null;
  role: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_postal_code: string | null;
  address_country: string | null;
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
  qr_variant: string;
  template: string;
  updated_at: string | null;
}

const READ_QUERY = `
  SELECT
    m.name, m.email, m.mobile, m.job_title, m.role,
    m.address_line1, m.address_line2, m.address_postal_code, m.address_country,
    n.slug, n.bio,
    n.name_family, n.name_given,
    n.whatsapp, n.website,
    n.facebook, n.linkedin, n.instagram, n.tiktok, n.youtube,
    n.qr_variant, n.template, n.updated_at
  FROM namecards n
  JOIN members m ON m.id = n.member_id
  WHERE n.slug = ?1
    AND n.has_namecard = 1
    AND m.deleted_at IS NULL`;

async function readNamecard(env: Env, slug: string): Promise<PublicNamecardRow | null> {
  const row = await env.DB.prepare(READ_QUERY).bind(slug).first<PublicNamecardRow>();
  return row ?? null;
}

/**
 * Resolve the public base URL of the card (no trailing slash).
 *
 * Uses the request's own origin so:
 *   - in local dev (http://localhost:8787) the baked-in QR/vCard URLs point
 *     at localhost, and the "Save card image" canvas fetch is same-origin
 *     (no CORS failure);
 *   - in prod the request already arrives on the custom domain, so the URLs
 *     naturally point at admin.singaporewomenassociation.org.
 *
 * Deliberately NOT using SWA_ADMIN_DOMAIN here: that variable has the same
 * value in dev and prod (it's a vars entry in wrangler.jsonc, not a per-env
 * override), so it would force the dev request to bake in the prod hostname
 * and the canvas fetch would be cross-origin. See docs/NAMECARD.md §8.3.
 */
function cardBaseUrl(c: AppContext): string {
  return new URL(c.req.url).origin;
}

// ── GET /c/:slug — HTML card page ──────────────────────────────────────────
export async function handleNamecardPage(c: AppContext): Promise<Response> {
  const slug = c.req.param('slug') ?? '';
  const card = await readNamecard(c.env, slug);
  if (!card) return brandedNotFound(c);

  const html = renderCardHtml(card, cardBaseUrl(c));
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short browser TTL, longer edge TTL — edits appear within 5-10 min
      // (docs/NAMECARD.md §8.5).
      'Cache-Control': 'public, max-age=300, s-maxage=600',
      // Defence-in-depth on top of the admin-domain robots.txt block —
      // prevents indexing if the URL is discovered via an external link
      // and robots.txt is ever weakened.
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

// ── GET /c/:slug/contact.vcf — vCard download ──────────────────────────────
export async function handleNamecardVcard(c: AppContext): Promise<Response> {
  const slug = c.req.param('slug') ?? '';
  const ip = clientIp(c.req.raw);
  const rl = await checkNamecardIpRateLimit(c.env.SWA_SESSION, ip);
  if (!rl.allowed) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': '60',
      },
    });
  }

  const card = await readNamecard(c.env, slug);
  if (!card) return brandedNotFound(c);

  // Try to embed the photo. Failure to fetch the photo must not break the
  // vCard — fall back to a photo-less vCard instead.
  let photo: { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' } | null = null;
  try {
    const photoBytes = await readNamecardPhotoBytes(c.env, slug);
    if (photoBytes && isAllowedPhotoMime(photoBytes.contentType)) {
      photo = {
        bytes: photoBytes.bytes,
        mimeType: photoBytes.contentType as 'image/jpeg' | 'image/png' | 'image/webp',
      };
    }
  } catch {
    // Soft-fail: ship the vCard without a photo.
  }

  const vcf = buildVcard({
    member: {
      name: card.name,
      email: card.email,
      mobile: card.mobile,
      job_title: card.job_title,
      role: card.role,
      address_line1: card.address_line1,
      address_line2: card.address_line2,
      address_postal_code: card.address_postal_code,
      address_country: card.address_country,
    },
    namecard: {
      slug: card.slug,
      bio: card.bio,
      name_family: card.name_family,
      name_given: card.name_given,
      whatsapp: card.whatsapp,
      website: card.website,
      facebook: card.facebook,
      linkedin: card.linkedin,
      instagram: card.instagram,
      tiktok: card.tiktok,
      youtube: card.youtube,
      updated_at: card.updated_at,
    },
    cardBaseUrl: cardBaseUrl(c),
    photo,
  });

  const safeName = sanitiseFilename(card.name);
  return new Response(vcf, {
    headers: {
      'Content-Type': 'text/vcard; charset=utf-8',
      // attachment + filename triggers the "Add to contacts" flow on iOS and
      // Android. nosniff is MANDATORY — without it some iOS Safari versions
      // render .vcf inline as plain text (docs/NAMECARD.md §9.1).
      'Content-Disposition': `attachment; filename="${safeName}_SWA.vcf"`,
      'Cache-Control': 'public, max-age=300, s-maxage=600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ── GET /c/:slug/card.svg — branded card image ─────────────────────────────
export async function handleNamecardCardSvg(c: AppContext): Promise<Response> {
  const slug = c.req.param('slug') ?? '';
  const ip = clientIp(c.req.raw);
  const rl = await checkNamecardIpRateLimit(c.env.SWA_SESSION, ip);
  if (!rl.allowed) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' },
    });
  }

  const card = await readNamecard(c.env, slug);
  if (!card) return brandedNotFound(c);

  let photoDataUri: string | null = null;
  try {
    const photoBytes = await readNamecardPhotoBytes(c.env, slug);
    if (photoBytes && isAllowedPhotoMime(photoBytes.contentType)) {
      photoDataUri = bytesToDataUri(photoBytes.bytes, photoBytes.contentType);
    }
  } catch {
    // Render without photo on R2 errors.
  }

  const svg = renderCardSvg({
    member: {
      name: card.name,
      email: card.email,
      mobile: card.mobile,
      job_title: card.job_title,
      role: card.role,
      address_line1: card.address_line1,
      address_line2: card.address_line2,
      address_postal_code: card.address_postal_code,
      address_country: card.address_country,
    },
    namecard: {
      slug: card.slug,
      bio: card.bio,
      name_family: card.name_family,
      name_given: card.name_given,
      whatsapp: card.whatsapp,
      website: card.website,
      facebook: card.facebook,
      linkedin: card.linkedin,
      instagram: card.instagram,
      tiktok: card.tiktok,
      youtube: card.youtube,
      updated_at: card.updated_at,
    },
    photoDataUri,
  });

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=600',
    },
  });
}

// ── GET /c/:slug/photo — raw photo stream from R2 ───────────────────────────
// The route has no extension on purpose: a `.jpg`/`.png` suffix would let the
// static-assets handler intercept the request before Hono's router fires.
// The Content-Type header (from R2 metadata) governs the response, so the
// browser renders the image correctly without a file extension in the URL.
export async function handlePublicNamecardPhoto(c: AppContext): Promise<Response> {
  const slug = c.req.param('slug') ?? '';
  const ip = clientIp(c.req.raw);
  const rl = await checkNamecardIpRateLimit(c.env.SWA_SESSION, ip);
  if (!rl.allowed) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' },
    });
  }

  const photo = await streamNamecardPhoto(c.env, slug);
  if (!photo) return brandedNotFound(c);

  return new Response(photo.body, {
    headers: {
      'Content-Type': photo.contentType,
      // Long immutable cache — bump by overwriting the R2 key
      // (docs/NAMECARD.md §8.3, §8.5).
      'Cache-Control': 'public, max-age=86400, s-maxage=2592000',
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isAllowedPhotoMime(contentType: string): boolean {
  // SVGs are explicitly forbidden — embedding an SVG photo into the card SVG
  // would be SVG-in-SVG recursion and could carry script. Only raster images.
  return contentType === 'image/jpeg' || contentType === 'image/png' || contentType === 'image/webp';
}

function bytesToDataUri(bytes: Uint8Array, contentType: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

/** Convert a member name into a safe filename stem for the vCard download. */
function sanitiseFilename(name: string): string {
  return (
    name
      .trim()
      // Replace anything that is not a letter, digit, hyphen, or underscore.
      .replace(/[^\p{L}\p{N}_-]+/gu, '_')
      .replace(/^_+|_+$/g, '') || 'contact'
  );
}

/** Build a minimal branded HTML page for the public card. */
function renderCardHtml(card: PublicNamecardRow, baseUrl: string): string {
  const safe = (s: string | null) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const cardUrl = `${baseUrl}/c/${card.slug}`;
  const vcfUrl = `${cardUrl}/contact.vcf`;
  const cardImgUrl = `${cardUrl}/card.svg`;
  // No extension on the photo URL — see handlePublicNamecardPhoto for why.
  const photoUrl = `${cardUrl}/photo`;

  // Social links (open in new tab; URL scheme was validated on write).
  const socials: Array<{ label: string; href: string }> = [];
  if (card.website) socials.push({ label: 'Website', href: card.website });
  if (card.facebook) socials.push({ label: 'Facebook', href: card.facebook });
  if (card.linkedin) socials.push({ label: 'LinkedIn', href: card.linkedin });
  if (card.instagram) socials.push({ label: 'Instagram', href: card.instagram });
  if (card.tiktok) socials.push({ label: 'TikTok', href: card.tiktok });
  if (card.youtube) socials.push({ label: 'YouTube', href: card.youtube });

  const ogImage = `${baseUrl}/og-namecard-default.png`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${safe(card.name)} — Digital Namecard | SWA</title>
  <meta name="description" content="Digital namecard for ${safe(card.name)}, ${safe(card.job_title)} at the Singapore Women's Association.">
  <link rel="canonical" href="${safe(cardUrl)}">
  <link rel="stylesheet" href="/namecard-public.css">
  <!-- Open Graph / Twitter card (WhatsApp & LinkedIn preview). -->
  <meta property="og:type" content="profile">
  <meta property="og:title" content="${safe(card.name)} — SWA Digital Namecard">
  <meta property="og:description" content="${safe(card.job_title)} — Singapore Women's Association">
  <meta property="og:image" content="${safe(ogImage)}">
  <meta property="og:url" content="${safe(cardUrl)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${safe(ogImage)}">
  <!-- JSON-LD Person schema. -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Person",
    "name": ${JSON.stringify(card.name)},
    "jobTitle": ${JSON.stringify(card.job_title ?? '')},
    "worksFor": { "@type": "Organization", "name": "Singapore Women's Association", "url": "https://www.singaporewomenassociation.org" },
    ${card.email ? `"email": ${JSON.stringify(card.email)},` : ''}
    ${card.mobile ? `"telephone": ${JSON.stringify(card.mobile)},` : ''}
    "url": ${JSON.stringify(cardUrl)},
    "image": ${JSON.stringify(photoUrl)}
    ${
      socials.length
        ? `,"sameAs": ${JSON.stringify(socials.map((s) => s.href))}`
        : ''
    }
  }
  </script>
</head>
<body class="nc-page">
  <main class="nc-card" aria-label="Digital namecard for ${safe(card.name)}">
    <header class="nc-header">
      <div class="nc-avatar"><img src="${safe(photoUrl)}" alt="${safe(card.name)}" onerror="this.parentElement.style.display='none'"></div>
      <div class="nc-headings">
        <h1 class="nc-name">${safe(card.name)}</h1>
        ${card.job_title ? `<p class="nc-title">${safe(card.job_title)}</p>` : ''}
        <p class="nc-org">Singapore Women's Association</p>
      </div>
    </header>

    ${
      card.bio
        ? `<details class="nc-bio"><summary>About ${safe(card.name.split(' ')[0])}</summary><p>${safe(card.bio)}</p></details>`
        : ''
    }

    <section class="nc-contact" aria-label="Contact details">
      ${card.mobile ? `<a class="nc-row" href="tel:${safe(card.mobile.replace(/[^\d+]/g, ''))}"><span class="nc-row-label">Mobile</span><span class="nc-row-value">${safe(card.mobile)}</span></a>` : ''}
      ${card.email ? `<a class="nc-row" href="mailto:${safe(card.email)}"><span class="nc-row-label">Email</span><span class="nc-row-value">${safe(card.email)}</span></a>` : ''}
      ${
        card.address_line1
          ? `<address class="nc-row nc-row-address"><span class="nc-row-label">Address</span><span class="nc-row-value">${safe(card.address_line1)}${card.address_line2 ? '<br>' + safe(card.address_line2) : ''}<br>${safe(card.address_country)} ${safe(card.address_postal_code)}</span></address>`
          : ''
      }
    </section>

    <section class="nc-actions" aria-label="Actions">
      <a class="nc-btn nc-btn-primary" href="${safe(vcfUrl)}" download>Save contact</a>
      ${
        card.whatsapp
          ? `<a class="nc-btn" href="https://wa.me/${safe(card.whatsapp.replace(/[^\d]/g, ''))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`
          : ''
      }
      <button class="nc-btn" type="button" data-action="share">Share</button>
      <button class="nc-btn" type="button" data-action="copy-link" data-url="${safe(cardUrl)}">Copy link</button>
    </section>

    ${
      socials.length
        ? `<section class="nc-socials" aria-label="Social links">${socials
            .map(
              (s) =>
                `<a class="nc-social" href="${safe(s.href)}" target="_blank" rel="noopener noreferrer">${safe(s.label)}</a>`,
            )
            .join('')}</section>`
        : ''
    }

    <section class="nc-qr" aria-label="QR code">
      <!-- Mirrors the proven PayNow QR pattern in
           src/pages/reg/membership/register.astro:165-188: 540×540 backing
           store, 240px CSS display, dark modules #000000. Same logo/ECC
           shape, retargeted to the vCard URL. -->
      <canvas class="nc-qr-canvas" width="540" height="540" role="img" aria-label="QR code linking to this contact"></canvas>
      <div class="nc-qr-actions">
        <button class="nc-btn" type="button" data-action="save-qr" data-url="${safe(vcfUrl)}">Save QR image</button>
        <button class="nc-btn" type="button" data-action="save-card" data-url="${safe(cardImgUrl)}">Save card image</button>
      </div>
    </section>

    <footer class="nc-footer">
      <p>Singapore Women's Association</p>
      <a class="nc-link" href="https://www.singaporewomenassociation.org" rel="noopener noreferrer">Visit SWA website</a>
    </footer>
  </main>

  <script src="/js/qrcode.min.js" defer></script>
  <script src="/js/namecard-qr.js" defer></script>
  <script>
    // Wire up the data-action buttons. The QR + Save buttons are owned by
    // namecard-qr.js (loaded above); share + copy-link are simple enough to
    // inline here.
    document.addEventListener('click', async (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const action = t.dataset.action;
      if (action === 'share') {
        const url = window.location.href;
        if (navigator.share) {
          try { await navigator.share({ title: document.title, url }); return; } catch {}
        }
        try { await navigator.clipboard.writeText(url); t.textContent = 'Copied'; return; } catch {}
      }
      if (action === 'copy-link') {
        const url = t.dataset.url || window.location.href;
        try { await navigator.clipboard.writeText(url); t.textContent = 'Copied'; } catch {}
      }
    });
  </script>
</body>
</html>`;
}

/** Branded 404 for missing / hidden / soft-deleted cards. */
function brandedNotFound(c: AppContext): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Namecard not available | SWA</title>
  <link rel="stylesheet" href="/namecard-public.css">
</head>
<body class="nc-page nc-page-notfound">
  <main class="nc-notfound">
    <h1>This namecard is not available</h1>
    <p>The link you followed may have expired, or the card has been disabled by its owner.</p>
    <p><a class="nc-link" href="https://www.singaporewomenassociation.org" rel="noopener noreferrer">Visit singaporewomenassociation.org</a></p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// Exported for tests so they can reference the rate-limit ceiling without
// duplicating the constant.
export const PUBLIC_RATE_LIMIT_MAX = NAMECARD_PUBLIC_RATE_LIMIT_MAX_REQUESTS;
