// Photo read helpers for the public namecard surface.
//
// Two concerns:
//   1. Visibility: a photo is only streamable when the namecard row has
//      `has_namecard = 1` AND the member is NOT soft-deleted. The DB join
//      enforces both in a single query.
//   2. Cache headers: the public photo is edge-cached with long immutable
//      directives — see docs/specs/features/namecards.md §8.3. This DIFFERS from the
//      authenticated membership-reg image handler (private, 1h) and the
//      difference is deliberate.
//
// See docs/specs/features/namecards.md §8.3, §9.1.

import type { Env } from '../types';
import { NAMECARD_BOARD_CATEGORIES } from '../../constants/portal';

const BOARD_CATEGORY_SQL = NAMECARD_BOARD_CATEGORIES.map((c) => `'${c}'`).join(', ');

export interface NamecardPhoto {
  body: ReadableStream;
  contentType: string;
  r2Key: string;
}

/**
 * Resolve the photo for a public namecard slug.
 *
 * Returns null if any of:
 *   - the slug does not exist
 *   - has_namecard = 0 (admin disabled the card)
 *   - the member is soft-deleted (deleted_at IS NOT NULL)
 *   - the member's category is not committee/advisor (board-only gate,
 *     2026-08-23 — matches READ_QUERY in namecard-public.ts)
 *   - no photo_r2_key on the row
 *   - the R2 object is missing
 *
 * The caller maps null to a 404 (or 410 for intentionally-disabled cards,
 * distinguished at the handler layer).
 */
export async function streamNamecardPhoto(
  env: Env,
  slug: string,
): Promise<NamecardPhoto | null> {
  const row = await env.DB.prepare(
    `SELECT n.photo_r2_key AS key
       FROM namecards n
       JOIN members m ON m.id = n.member_id
      WHERE n.slug = ?1
        AND n.has_namecard = 1
        AND m.deleted_at IS NULL
        AND m.category IN (${BOARD_CATEGORY_SQL})`,
  )
    .bind(slug)
    .first<{ key: string | null }>();

  if (!row || !row.key) return null;

  const obj = await env.R2_BUCKET.get(row.key);
  if (!obj) return null;

  return {
    body: obj.body,
    contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
    r2Key: row.key,
  };
}

/**
 * Resolve the photo bytes (used by the SVG renderer to base64-embed the
 * headshot into the card image). Same visibility rules as streamNamecardPhoto.
 *
 * Returns the raw bytes plus the content-type so the renderer can label the
 * embedded data URI correctly.
 */
export async function readNamecardPhotoBytes(
  env: Env,
  slug: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const row = await env.DB.prepare(
    `SELECT n.photo_r2_key AS key
       FROM namecards n
       JOIN members m ON m.id = n.member_id
      WHERE n.slug = ?1
        AND n.has_namecard = 1
        AND m.deleted_at IS NULL
        AND m.category IN (${BOARD_CATEGORY_SQL})`,
  )
    .bind(slug)
    .first<{ key: string | null }>();

  if (!row || !row.key) return null;

  const obj = await env.R2_BUCKET.get(row.key);
  if (!obj) return null;

  const buf = await obj.arrayBuffer();
  return {
    bytes: new Uint8Array(buf),
    contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
  };
}
