// QR payload helper for namecards. The QR encodes a URL — either the .vcf
// endpoint (default) or the interactive page — selectable per member via the
// `namecards.qr_variant` column.
//
// Why a URL rather than raw vCard text? Recent iOS and many Android camera
// apps no longer parse vCard-text QR codes into the contact picker, and
// vCard text produces large QR payloads that scan poorly. A URL QR is small,
// scans fast, and degrades gracefully (the visitor lands on a normal page).
//
// See docs/specs/features/namecards.md §7.1.

export type QrVariant = 'vcf' | 'page';

export interface QrPayloadOptions {
  /** Public base URL, no trailing slash, e.g. 'https://admin.singaporewomenassociation.org'. */
  cardBaseUrl: string;
  slug: string;
  variant: QrVariant;
}

/**
 * Build the URL that the QR code encodes. Throws if `variant` is not 'vcf'
 * or 'page' — invalid DB values must surface loudly, not silently fall back.
 */
export function qrPayload(opts: QrPayloadOptions): string {
  const base = opts.cardBaseUrl.replace(/\/+$/, '');
  if (opts.variant === 'vcf') return `${base}/c/${opts.slug}/contact.vcf`;
  if (opts.variant === 'page') return `${base}/c/${opts.slug}`;
  throw new Error(`Invalid qr_variant: ${String(opts.variant)}`);
}
