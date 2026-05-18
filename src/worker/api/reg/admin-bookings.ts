import type { Context } from 'hono';
import type { Env } from '../../types';
import { loadTablesConfig, getTable } from '../../lib/reg/tables';
import { allocateGuestSlot } from '../../lib/reg/tickets';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

function generateBookingRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'REG-';
  for (let i = 0; i < 5; i++) {
    ref += chars[Math.floor(Math.random() * chars.length)];
  }
  return ref;
}

export async function handleAdminBookings(c: AppContext) {
  if (c.req.method === 'GET') {
    const search = c.req.query('search');
    const tableFilter = c.req.query('table');

    let query = `
      SELECT b.*,
        COUNT(g.id) AS total_guests,
        SUM(CASE WHEN g.guest_name IS NOT NULL AND g.guest_name != '' THEN 1 ELSE 0 END) AS named_guests
      FROM reg_bookings b
      LEFT JOIN reg_guests g ON g.booking_id = b.id
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (search) {
      conditions.push('b.buyer_name LIKE ?');
      params.push(`%${search}%`);
    }
    if (tableFilter) {
      conditions.push('b.table_id = ?');
      params.push(tableFilter);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' GROUP BY b.id ORDER BY b.created_at DESC';

    const results = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, bookings: results.results });
  }

  if (c.req.method === 'POST') {
    const sessionEmail = c.get('sessionEmail') as string;

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const buyerName = String(body.buyer_name || '').trim();
    const buyerEmail = String(body.buyer_email || '').trim().toLowerCase() || null;
    const buyerPhone = String(body.buyer_phone || '').trim() || null;
    const tableId = String(body.table_id || '').trim();
    const pax = Number(body.pax || 1);
    const notes = body.notes ? String(body.notes).trim() : null;

    if (!buyerName || !tableId || pax < 1) {
      return c.json({ success: false, message: 'Required fields: buyer_name, table_id, pax (min 1)' }, 400);
    }

    const config = await loadTablesConfig(c.env.SWA_SESSION);
    const table = getTable(config, tableId);
    if (!table) {
      return c.json({ success: false, message: 'Invalid table_id.' }, 400);
    }

    const id = crypto.randomUUID();
    let bookingRef = generateBookingRef();

    const existingRef = await c.env.DB.prepare(
      'SELECT id FROM reg_bookings WHERE booking_ref = ?',
    ).bind(bookingRef).first();
    if (existingRef) {
      bookingRef = generateBookingRef();
    }

    await c.env.DB.prepare(
      `INSERT INTO reg_bookings (id, booking_ref, buyer_name, buyer_email, buyer_phone, table_id, pax, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, bookingRef, buyerName, buyerEmail, buyerPhone, tableId, pax, notes, sessionEmail).run();

    const guestSlots = [];
    for (let i = 0; i < pax; i++) {
      const isBuyer = i === 0;
      const guestName = isBuyer ? buyerName : null;
      const slot = await allocateGuestSlot(c.env.DB, {
        bookingId: id,
        tableId,
        tableConfig: table,
        guestName,
        isBuyer,
        isWalkIn: false,
        notes: null,
      });
      guestSlots.push(slot);
    }

    return c.json({
      success: true,
      id,
      booking_ref: bookingRef,
      table_label: table.label,
      guest_count: guestSlots.length,
    }, 201);
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

export async function handleAdminBookingById(c: AppContext) {
  const id = c.req.param('id');

  const booking = await c.env.DB.prepare(
    'SELECT * FROM reg_bookings WHERE id = ?',
  ).bind(id).first();

  if (!booking) {
    return c.json({ success: false, message: 'Booking not found.' }, 404);
  }

  if (c.req.method === 'GET') {
    const guests = await c.env.DB.prepare(
      'SELECT * FROM reg_guests WHERE booking_id = ? ORDER BY seat_counter ASC',
    ).bind(id).all();

    return c.json({ success: true, booking, guests: guests.results });
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}