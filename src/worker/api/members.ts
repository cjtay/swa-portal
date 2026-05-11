import type { Context } from 'hono';
import type { Env } from '../types';

export async function handleMembers(c: Context<{ Bindings: Env }>) {
  if (c.req.method === 'GET') {
    const category = c.req.query('category');
    const search = c.req.query('search');

    let query = 'SELECT * FROM members WHERE 1=1';
    const params: unknown[] = [];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    if (search) {
      query += ' AND (name LIKE ? OR email LIKE ? OR role LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    query += ' ORDER BY sort_order ASC, name ASC';

    const results = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, members: results.results });
  }

  if (c.req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const result = await c.env.DB.prepare(
      `INSERT INTO members (name, slug, role, email, mobile, whatsapp, job_title, description, category, can_login, show_on_website, has_namecard, address_line1, address_line2, address_postal_code, address_country, facebook, linkedin, instagram, tiktok, youtube, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      String(body.name || '').trim() || null,
      String(body.slug || '').trim() || null,
      String(body.role || '').trim() || null,
      String(body.email || '').trim().toLowerCase() || null,
      String(body.mobile || '').trim() || null,
      String(body.whatsapp || '').trim() || null,
      String(body.job_title || '').trim() || null,
      String(body.description || '').trim() || null,
      String(body.category || 'committee').trim(),
      Number(body.can_login ?? 0),
      Number(body.show_on_website ?? 1),
      Number(body.has_namecard ?? 0),
      String(body.address_line1 || '').trim() || null,
      String(body.address_line2 || '').trim() || null,
      String(body.address_postal_code || '').trim() || null,
      String(body.address_country || 'Singapore').trim(),
      String(body.facebook || '').trim() || null,
      String(body.linkedin || '').trim() || null,
      String(body.instagram || '').trim() || null,
      String(body.tiktok || '').trim() || null,
      String(body.youtube || '').trim() || null,
      Number(body.sort_order || 0),
    ).run();

    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

export async function handleMemberById(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');

  if (c.req.method === 'GET') {
    const member = await c.env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
    if (!member) {
      return c.json({ success: false, message: 'Member not found.' }, 404);
    }
    return c.json({ success: true, member });
  }

  if (c.req.method === 'PATCH') {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const allowedFields = ['name', 'slug', 'role', 'email', 'mobile', 'whatsapp', 'job_title', 'description', 'category', 'can_login', 'show_on_website', 'has_namecard', 'address_line1', 'address_line2', 'address_postal_code', 'address_country', 'facebook', 'linkedin', 'instagram', 'tiktok', 'youtube', 'sort_order', 'photo_url', 'photo_alt'];
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const field of allowedFields) {
      if (field in body) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    if (updates.length === 0) {
      return c.json({ success: false, message: 'No fields to update.' }, 400);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await c.env.DB.prepare(`UPDATE members SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    return c.json({ success: true, id: Number(id) });
  }

  if (c.req.method === 'DELETE') {
    await c.env.DB.prepare('DELETE FROM members WHERE id = ?').bind(id).run();
    return c.json({ success: true, id: Number(id) });
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

export async function handleMemberPhoto(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  const formData = await c.req.parseBody();
  const file = formData['file'];

  if (!file || !(file instanceof File)) {
    return c.json({ success: false, message: 'No file uploaded.' }, 400);
  }

  const key = `members/${id}/${file.name}`;
  await c.env.R2_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

  const photo_url = `/${key}`;
  await c.env.DB.prepare('UPDATE members SET photo_url = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(photo_url, id).run();

  return c.json({ success: true, photo_url });
}