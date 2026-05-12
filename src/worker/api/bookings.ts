import type { Context } from 'hono';
import type { Env } from '../types';
import { buildBookingConfirmationEmail } from '../lib/email-booking';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string };
}>;

async function sendConfirmationEmail(env: Env, booking: Record<string, unknown>) {
  try {
    const html = buildBookingConfirmationEmail({
      booker_name: String(booking.booker_name || ''),
      purpose: String(booking.purpose || ''),
      attendees: Number(booking.attendees || 1),
      start_datetime: String(booking.start_datetime || ''),
      end_datetime: String(booking.end_datetime || ''),
      notes: booking.notes ? String(booking.notes) : null,
    });

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SWA Portal <contactus@singaporewomenassociation.org>',
        to: String(booking.booker_email),
        subject: 'Booking Confirmed — SWA Office',
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Booking email failed: ${res.status} ${errText}`);
    }
  } catch (err) {
    console.error('Booking email error:', err);
  }
}

export async function handleBookings(c: AppContext) {
  if (c.req.method === 'GET') {
    const month = c.req.query('month');

    let query = 'SELECT * FROM office_bookings WHERE 1=1';
    const params: unknown[] = [];

    if (month) {
      query += " AND strftime('%Y-%m', start_datetime) = ?";
      params.push(month);
    }
    query += ' ORDER BY start_datetime ASC';

    const results = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, bookings: results.results });
  }

  if (c.req.method === 'POST') {
    const sessionEmail = c.get('sessionEmail') as string;
    const sessionName = c.get('sessionName') as string;

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
    const notes = body.notes ? String(body.notes).trim() : null;

    if (!booker_name || !booker_email || !purpose || !start_datetime || !end_datetime) {
      return c.json({ success: false, message: 'Required fields: booker_name, booker_email, purpose, start_datetime, end_datetime' }, 400);
    }

    const startDate = new Date(start_datetime);
    const endDate = new Date(end_datetime);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return c.json({ success: false, message: 'Invalid date format.' }, 400);
    }
    if (endDate <= startDate) {
      return c.json({ success: false, message: 'End time must be after start time.' }, 400);
    }
    if (startDate < new Date()) {
      return c.json({ success: false, message: 'Cannot book in the past.' }, 400);
    }
    if (attendees < 1) {
      return c.json({ success: false, message: 'Attendees must be at least 1.' }, 400);
    }

    const conflict = await c.env.DB.prepare(
      `SELECT id FROM office_bookings
       WHERE status = 'approved'
         AND start_datetime < ?
         AND end_datetime > ?`
    ).bind(end_datetime, start_datetime).first();

    if (conflict) {
      return c.json({ success: false, message: 'This time slot conflicts with an existing booking.' }, 409);
    }

    const memberRow = await c.env.DB.prepare(
      'SELECT id FROM members WHERE email = ?'
    ).bind(booker_email).first();
    const member_id = memberRow ? (memberRow as Record<string, unknown>).id : null;

    const result = await c.env.DB.prepare(
      `INSERT INTO office_bookings (member_id, booker_name, booker_email, purpose, attendees, start_datetime, end_datetime, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`
    ).bind(member_id, booker_name, booker_email, purpose, attendees, start_datetime, end_datetime, notes, sessionEmail).run();

    const bookingId = result.meta.last_row_id;

    const booking = { id: bookingId, booker_name, booker_email, purpose, attendees, start_datetime, end_datetime, notes };
    sendConfirmationEmail(c.env, booking);

    return c.json({ success: true, id: bookingId }, 201);
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

export async function handleBookingById(c: AppContext) {
  const id = c.req.param('id');
  const booking = await c.env.DB.prepare('SELECT * FROM office_bookings WHERE id = ?').bind(id).first();
  if (!booking) {
    return c.json({ success: false, message: 'Booking not found.' }, 404);
  }
  return c.json({ success: true, booking });
}

export async function handleBookingCancel(c: AppContext) {
  const id = c.req.param('id');
  const sessionEmail = c.get('sessionEmail') as string;

  const booking = await c.env.DB.prepare('SELECT * FROM office_bookings WHERE id = ?').bind(id).first();
  if (!booking) {
    return c.json({ success: false, message: 'Booking not found.' }, 404);
  }

  const b = booking as Record<string, unknown>;
  if (b.status === 'cancelled') {
    return c.json({ success: false, message: 'Booking is already cancelled.' }, 400);
  }

  if (b.created_by !== sessionEmail) {
    return c.json({ success: false, message: 'Only the person who created this booking can cancel it.' }, 403);
  }

  await c.env.DB.prepare(
    "UPDATE office_bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();

  return c.json({ success: true, id: Number(id), status: 'cancelled' });
}