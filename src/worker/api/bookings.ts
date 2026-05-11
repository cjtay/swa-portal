import type { Context } from 'hono';
import type { Env } from '../types';
import { handleApiError } from '../lib/error-handler';

export async function handleBookings(c: Context<{ Bindings: Env }>) {
  if (c.req.method === 'GET') {
    const status = c.req.query('status') || 'all';
    const month = c.req.query('month');

    let query = 'SELECT * FROM office_bookings WHERE 1=1';
    const params: unknown[] = [];

    if (status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }
    if (month) {
      query += ' AND strftime(\'%Y-%m\', start_datetime) = ?';
      params.push(month);
    }
    query += ' ORDER BY start_datetime ASC';

    const results = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, bookings: results.results });
  }

  if (c.req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const booker_name = String(body.booker_name || '').trim();
    const booker_email = String(body.booker_email || '').trim().toLowerCase();
    const purpose = String(body.purpose || '').trim();
    const attendees = Number(body.attendees || 1);
    const start_datetime = String(body.start_datetime || '').trim();
    const end_datetime = String(body.end_datetime || '').trim();
    const notes = String(body.notes || '').trim();

    if (!booker_name || !booker_email || !purpose || !start_datetime || !end_datetime) {
      return c.json({ success: false, message: 'Required fields: booker_name, booker_email, purpose, start_datetime, end_datetime' }, 400);
    }

    // Check for time conflicts
    const conflict = await c.env.DB.prepare(
      `SELECT id FROM office_bookings
       WHERE status IN ('pending', 'approved')
         AND start_datetime < ?
         AND end_datetime > ?`
    ).bind(end_datetime, start_datetime).first();

    if (conflict) {
      return c.json({ success: false, message: 'This time slot conflicts with an existing booking.' }, 409);
    }

    const result = await c.env.DB.prepare(
      `INSERT INTO office_bookings (booker_name, booker_email, purpose, attendees, start_datetime, end_datetime, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(booker_name, booker_email, purpose, attendees, start_datetime, end_datetime, notes || null).run();

    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

export async function handleBookingById(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  const booking = await c.env.DB.prepare('SELECT * FROM office_bookings WHERE id = ?').bind(id).first();
  if (!booking) {
    return c.json({ success: false, message: 'Booking not found.' }, 404);
  }
  return c.json({ success: true, booking });
}

export async function handleBookingStatus(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Invalid request body.' }, 400);
  }

  const status = String(body.status || '').trim();
  if (!['approved', 'rejected', 'cancelled'].includes(status)) {
    return c.json({ success: false, message: 'Status must be approved, rejected, or cancelled.' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE office_bookings SET status = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(status, id).run();

  return c.json({ success: true, id: Number(id), status });
}