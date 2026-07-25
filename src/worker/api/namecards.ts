// Admin CRUD for namecards. Routes under /api/namecards/*, auth-gated by
// authMiddleware (the ADMIN_WRITE_API set in middleware.ts makes
// POST/PATCH/DELETE admin-only; GET stays open to every authenticated role
// so the self-service panel works for committee/volunteer/advisor).
//
// Endpoints (docs/NAMECARD.md §9.2):
//   GET    /api/namecards                  list (joined with member identity)
//   GET    /api/namecards/:id              single row
//   POST   /api/namecards                  create (auto-derives slug from name)
//   POST   /api/namecards/bulk             create for every member lacking one
//   PATCH  /api/namecards/:id              edit fields
//   PATCH  /api/namecards/:id/slug         change slug (409 + suggestion on clash)
//   POST   /api/namecards/:id/photo        upload headshot (≤2 MB, image/* only)
//   DELETE /api/namecards/:id/photo        remove photo
//   PATCH  /api/namecards/:id/toggle       flip has_namecard
//   DELETE /api/namecards/:id              hard delete row + R2 photo
//   GET    /api/namecards/me               caller's own card + share URL
//
// Writes are admin-only via the ADMIN_WRITE_API gate (middleware.ts:24-29).
// The in-handler role check below is defence-in-depth, not the primary gate.

import type { Context } from 'hono';
import type { Env } from '../types';
import { NAMECARD_PHOTO_MAX_BYTES } from '../../constants/portal';
import { handleApiError } from '../lib/error-handler';
import {
  deriveSlug,
  validateSlug,
  suggestAlternatives,
} from '../lib/namecard-slug';
import { isSafeUrl, normaliseWhatsApp, WhatsAppNormalisationError } from '../lib/namecard-sanitize';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

/** Fields the admin may PATCH on a namecard row. */
const EDITABLE_FIELDS = [
  'bio',
  'photo_alt',
  'name_family',
  'name_given',
  'website',
  'facebook',
  'linkedin',
  'instagram',
  'tiktok',
  'youtube',
  'template',
  'qr_variant',
] as const;

const URL_FIELDS: ReadonlySet<string> = new Set([
  'website',
  'facebook',
  'linkedin',
  'instagram',
  'tiktok',
  'youtube',
]);

const ALLOWED_PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Assert the caller is admin; return a 403 Response if not. */
function requireAdmin(c: AppContext): Response | null {
  const role = c.get('sessionRole');
  if (role !== 'admin') {
    return c.json(
      { success: false, error_code: 'FORBIDDEN', message: 'Admin access required.' },
      403,
    );
  }
  return null;
}

// ── GET /api/namecards ─────────────────────────────────────────────────────
export async function handleNamecards(c: AppContext): Promise<Response> {
  if (c.req.method === 'GET') {
    const search = c.req.query('search');
    let query = `
      SELECT
        n.id, n.member_id, n.slug, n.has_namecard, n.template,
        n.photo_r2_key, n.photo_alt, n.bio,
        n.name_family, n.name_given,
        n.whatsapp, n.website,
        n.facebook, n.linkedin, n.instagram, n.tiktok, n.youtube,
        n.qr_variant, n.updated_at, n.created_at,
        m.name AS member_name, m.email, m.mobile, m.job_title, m.role,
        m.deleted_at AS member_deleted_at
      FROM namecards n
      JOIN members m ON m.id = n.member_id
      WHERE 1=1`;
    const params: unknown[] = [];
    if (search) {
      query += ` AND (m.name LIKE ? OR n.slug LIKE ? OR m.email LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    query += ` ORDER BY m.name ASC`;
    const result = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, namecards: result.results });
  }

  if (c.req.method === 'POST') {
    // ── Single create ──────────────────────────────────────────────────────
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const memberId = Number(body.member_id);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return c.json({ success: false, message: 'A valid member_id is required.' }, 400);
    }

    // Confirm the member exists.
    const member = await c.env.DB.prepare(
      'SELECT id, name FROM members WHERE id = ? AND deleted_at IS NULL',
    )
      .bind(memberId)
      .first<{ id: number; name: string }>();
    if (!member) {
      return c.json({ success: false, message: 'Member not found.' }, 404);
    }

    // Slug: prefer the admin-supplied value, else derive from the member name.
    let slug = String(body.slug ?? '').trim();
    if (!slug) {
      const derived = deriveSlug(member.name);
      if (!derived) {
        return c.json(
          {
            success: false,
            message:
              'Could not derive a slug from the member name. Please enter a slug manually.',
          },
          400,
        );
      }
      slug = derived;
    }
    if (!validateSlug(slug)) {
      return c.json({ success: false, message: `Invalid slug: "${slug}".` }, 400);
    }

    // Compute a non-clashing slug if necessary.
    const taken = await takenSlugs(c);
    if (taken.has(slug)) {
      slug = suggestAlternatives(slug, taken);
    }

    const result = await c.env.DB.prepare(
      `INSERT INTO namecards (member_id, slug) VALUES (?, ?)`,
    )
      .bind(memberId, slug)
      .run()
      .catch((err: unknown) => err);

    if (result instanceof Error) {
      // UNIQUE violations: distinguish member_id clash (member already has a
      // card) from slug clash (shouldn't happen — we suggested a free one).
      const msg = result.message ?? '';
      if (msg.includes('namecards.member_id')) {
        return c.json(
          { success: false, message: 'This member already has a namecard.' },
          409,
        );
      }
      return handleApiError(c, 'namecards-create', result, 'Could not create the namecard.', {
        http_status: 500,
      });
    }

    return c.json({ success: true, id: Number(result.meta.last_row_id), slug }, 201);
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

// ── POST /api/namecards/bulk ───────────────────────────────────────────────
export async function handleNamecardsBulk(c: AppContext): Promise<Response> {
  if (c.req.method !== 'POST') {
    return c.json({ success: false, message: 'Method not allowed' }, 405);
  }
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  // Members who don't yet have a namecard row, in name order. Skip
  // soft-deleted members — they shouldn't get cards.
  const members = await c.env.DB.prepare(
    `SELECT m.id, m.name FROM members m
       LEFT JOIN namecards n ON n.member_id = m.id
      WHERE m.deleted_at IS NULL AND n.id IS NULL
      ORDER BY m.name ASC`,
  ).all<{ id: number; name: string }>();

  // Pre-load all existing slugs once so collision-suggestion is O(1) per row.
  const slugRows = await c.env.DB.prepare(`SELECT slug FROM namecards`).all<{ slug: string }>();
  const taken = new Set(slugRows.results.map((r) => r.slug));

  const created: Array<{ member_id: number; slug: string }> = [];
  const skipped: Array<{ member_id: number; name: string; reason: string }> = [];

  for (const m of members.results) {
    const derived = deriveSlug(m.name);
    if (!derived) {
      skipped.push({ member_id: m.id, name: m.name, reason: 'No slug could be derived.' });
      continue;
    }
    const slug = taken.has(derived) ? suggestAlternatives(derived, taken) : derived;
    try {
      const r = await c.env.DB.prepare(
        `INSERT INTO namecards (member_id, slug) VALUES (?, ?)`,
      )
        .bind(m.id, slug)
        .run();
      created.push({ member_id: m.id, slug });
      taken.add(slug);
      void r;
    } catch (err) {
      skipped.push({
        member_id: m.id,
        name: m.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({ success: true, created, skipped });
}

// ── GET / PATCH / DELETE /api/namecards/:id ────────────────────────────────
export async function handleNamecardById(c: AppContext): Promise<Response> {
  const idParam = c.req.param('id');
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, message: 'Invalid id.' }, 400);
  }

  if (c.req.method === 'GET') {
    const row = await fetchNamecardById(c, id);
    if (!row) {
      return c.json({ success: false, message: 'Namecard not found.' }, 404);
    }
    return c.json({ success: true, namecard: row });
  }

  if (c.req.method === 'PATCH') {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    // Allow-list patch. URL fields are validated; whatsapp is normalised (or
    // rejected with 400 if the country code is missing).
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const field of EDITABLE_FIELDS) {
      if (!(field in body)) continue;
      const value = body[field];
      if (URL_FIELDS.has(field)) {
        const str = typeof value === 'string' ? value.trim() : '';
        if (str && !isSafeUrl(str)) {
          return c.json(
            { success: false, message: `"${field}" must be an http(s) URL.` },
            400,
          );
        }
        updates.push(`${field} = ?`);
        values.push(str || null);
        continue;
      }
      if (field === 'qr_variant' && value !== 'vcf' && value !== 'page') {
        return c.json(
          { success: false, message: 'qr_variant must be "vcf" or "page".' },
          400,
        );
      }
      updates.push(`${field} = ?`);
      values.push(typeof value === 'string' ? value : value ?? null);
    }

    if ('whatsapp' in body) {
      try {
        const normalised = normaliseWhatsApp(body.whatsapp as string | null | undefined);
        updates.push('whatsapp = ?');
        values.push(normalised);
      } catch (err) {
        if (err instanceof WhatsAppNormalisationError) {
          return c.json({ success: false, message: err.message }, 400);
        }
        throw err;
      }
    }

    if (updates.length === 0) {
      return c.json({ success: false, message: 'No fields to update.' }, 400);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await c.env.DB.prepare(`UPDATE namecards SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
    return c.json({ success: true, id });
  }

  if (c.req.method === 'DELETE') {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;

    const row = await c.env.DB.prepare(
      'SELECT photo_r2_key FROM namecards WHERE id = ?',
    )
      .bind(id)
      .first<{ photo_r2_key: string | null }>();
    if (!row) {
      return c.json({ success: false, message: 'Namecard not found.' }, 404);
    }

    // Drop the row, then best-effort delete the photo from R2.
    await c.env.DB.prepare('DELETE FROM namecards WHERE id = ?').bind(id).run();
    if (row.photo_r2_key) {
      try {
        await c.env.R2_BUCKET.delete(row.photo_r2_key);
      } catch {
        // Best-effort — the row is already gone, which is the important part.
      }
    }
    return c.json({ success: true, id });
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

// ── PATCH /api/namecards/:id/slug ──────────────────────────────────────────
export async function handleNamecardSlug(c: AppContext): Promise<Response> {
  if (c.req.method !== 'PATCH') {
    return c.json({ success: false, message: 'Method not allowed' }, 405);
  }
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, message: 'Invalid id.' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Invalid request body.' }, 400);
  }
  const slug = String(body.slug ?? '').trim();
  if (!validateSlug(slug)) {
    return c.json({ success: false, message: `Invalid slug: "${slug}".` }, 400);
  }

  // Confirm the row exists.
  const existing = await c.env.DB.prepare(
    'SELECT id FROM namecards WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!existing) {
    return c.json({ success: false, message: 'Namecard not found.' }, 404);
  }

  // Check uniqueness against every OTHER row.
  const clash = await c.env.DB.prepare(
    'SELECT id FROM namecards WHERE slug = ? AND id != ?',
  )
    .bind(slug, id)
    .first<{ id: number }>();
  if (clash) {
    const taken = await takenSlugs(c);
    // suggestAlternatives adds the candidate to its search, so add the
    // requested slug here to mirror what the caller would see on retry.
    taken.add(slug);
    return c.json(
      {
        success: false,
        error_code: 'SLUG_TAKEN',
        message: 'That slug is already in use.',
        suggestion: suggestAlternatives(slug, taken),
      },
      409,
    );
  }

  await c.env.DB.prepare(
    "UPDATE namecards SET slug = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(slug, id)
    .run();
  return c.json({ success: true, id, slug });
}

// ── POST /api/namecards/:id/photo  +  DELETE /api/namecards/:id/photo ──────
export async function handleNamecardPhoto(c: AppContext): Promise<Response> {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, message: 'Invalid id.' }, 400);
  }

  if (c.req.method === 'POST') {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;

    const row = await c.env.DB.prepare(
      'SELECT id, member_id FROM namecards WHERE id = ?',
    )
      .bind(id)
      .first<{ id: number; member_id: number }>();
    if (!row) {
      return c.json({ success: false, message: 'Namecard not found.' }, 404);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ success: false, message: 'Expected multipart/form-data.' }, 400);
    }
    const file = form.get('photo');
    if (!(file instanceof File)) {
      return c.json({ success: false, message: 'No photo file uploaded.' }, 400);
    }
    // Server-side enforcement regardless of what the client sent
    // (docs/NAMECARD.md §4.2).
    if (file.size > NAMECARD_PHOTO_MAX_BYTES) {
      return c.json(
        { success: false, message: 'Photo must be 2 MB or smaller.' },
        413,
      );
    }
    if (!ALLOWED_PHOTO_MIME.has(file.type)) {
      return c.json(
        { success: false, message: 'Photo must be JPEG, PNG, or WebP.' },
        400,
      );
    }

    const ext = photoExtension(file.type)!;
    const r2Key = `namecards/${row.member_id}/photo.${ext}`;

    try {
      await c.env.R2_BUCKET.put(r2Key, file.stream(), {
        httpMetadata: { contentType: file.type },
        customMetadata: {
          member_id: String(row.member_id),
          namecard_id: String(row.id),
          uploaded_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      return handleApiError(c, 'namecards-photo-upload', err, 'Could not save the photo.', {
        error_type: 'R2_PUT',
        http_status: 500,
      });
    }

    // If the extension changed, drop the previous object so we don't leave
    // orphan files in R2.
    const previous = await c.env.DB.prepare(
      'SELECT photo_r2_key FROM namecards WHERE id = ?',
    )
      .bind(id)
      .first<{ photo_r2_key: string | null }>();
    if (previous?.photo_r2_key && previous.photo_r2_key !== r2Key) {
      try {
        await c.env.R2_BUCKET.delete(previous.photo_r2_key);
      } catch {
        // best-effort
      }
    }

    await c.env.DB.prepare(
      "UPDATE namecards SET photo_r2_key = ?, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(r2Key, id)
      .run();

    return c.json({ success: true, id, photo_r2_key: r2Key });
  }

  if (c.req.method === 'DELETE') {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;

    const row = await c.env.DB.prepare(
      'SELECT photo_r2_key FROM namecards WHERE id = ?',
    )
      .bind(id)
      .first<{ photo_r2_key: string | null }>();
    if (!row) {
      return c.json({ success: false, message: 'Namecard not found.' }, 404);
    }
    if (row.photo_r2_key) {
      try {
        await c.env.R2_BUCKET.delete(row.photo_r2_key);
      } catch {
        // best-effort
      }
    }
    await c.env.DB.prepare(
      "UPDATE namecards SET photo_r2_key = NULL, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(id)
      .run();
    return c.json({ success: true, id });
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

// ── PATCH /api/namecards/:id/toggle ────────────────────────────────────────
export async function handleNamecardToggle(c: AppContext): Promise<Response> {
  if (c.req.method !== 'PATCH') {
    return c.json({ success: false, message: 'Method not allowed' }, 405);
  }
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, message: 'Invalid id.' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    // Empty body is allowed — we'll just flip the current value.
    body = {};
  }

  // If the body supplies has_namecard, honour it (after coercion). Otherwise
  // flip the current value.
  let next: number | undefined;
  if (typeof body.has_namecard === 'boolean') next = body.has_namecard ? 1 : 0;
  else if (typeof body.has_namecard === 'number') next = body.has_namecard ? 1 : 0;

  if (next === undefined) {
    const row = await c.env.DB.prepare('SELECT has_namecard FROM namecards WHERE id = ?')
      .bind(id)
      .first<{ has_namecard: number }>();
    if (!row) return c.json({ success: false, message: 'Namecard not found.' }, 404);
    next = row.has_namecard ? 0 : 1;
  }

  const result = await c.env.DB.prepare(
    "UPDATE namecards SET has_namecard = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(next, id)
    .run();
  if (!result.meta.changes) {
    return c.json({ success: false, message: 'Namecard not found.' }, 404);
  }
  return c.json({ success: true, id, has_namecard: next });
}

// ── GET /api/namecards/me ──────────────────────────────────────────────────
export async function handleNamecardMe(c: AppContext): Promise<Response> {
  if (c.req.method !== 'GET') {
    return c.json({ success: false, message: 'Method not allowed' }, 405);
  }
  const email = (c.get('sessionEmail') as string | undefined)?.toLowerCase();
  if (!email) {
    return c.json({ success: false, message: 'No session.' }, 401);
  }

  const row = await c.env.DB.prepare(
    `SELECT
       n.id, n.member_id, n.slug, n.has_namecard, n.template, n.photo_r2_key,
       n.bio, n.name_family, n.name_given,
       n.whatsapp, n.website,
       n.facebook, n.linkedin, n.instagram, n.tiktok, n.youtube,
       n.qr_variant, n.updated_at,
       m.name, m.email, m.mobile, m.job_title, m.role
     FROM namecards n
     JOIN members m ON m.id = n.member_id
     WHERE LOWER(m.email) = ? AND m.deleted_at IS NULL`,
  )
    .bind(email)
    .first();

  // No namecard row is not an error — the self-service panel renders an empty
  // state. Return success: true with namecard: null so the client knows.
  return c.json({ success: true, namecard: row ?? null });
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchNamecardById(c: AppContext, id: number): Promise<Record<string, unknown> | null> {
  const row = await c.env.DB.prepare(
    `SELECT
       n.*, m.name AS member_name, m.email, m.mobile, m.job_title, m.role
     FROM namecards n
     JOIN members m ON m.id = n.member_id
     WHERE n.id = ?`,
  )
    .bind(id)
    .first();
  return row;
}

/** Load all slugs currently in use. Does NOT include the candidate — the caller
 * checks `taken.has(slug)` to decide whether to suggest an alternative. */
async function takenSlugs(c: AppContext): Promise<Set<string>> {
  const rows = await c.env.DB.prepare(`SELECT slug FROM namecards`).all<{ slug: string }>();
  return new Set(rows.results.map((r) => r.slug));
}

function photoExtension(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return null;
  }
}
