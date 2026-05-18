import type { Context } from 'hono';
import type { Env } from '../../types';
import { loadTablesConfig, getTable } from '../../lib/reg/tables';
import { allocateGuestSlot } from '../../lib/reg/tickets';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

export async function handleAdminGuests(c: AppContext) {
  if (c.req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const bookingId = String(body.booking_id || '').trim();
    const guestName = String(body.guest_name || '').trim() || null;
    const tableId = String(body.table_id || '').trim();
    const notes = body.notes ? String(body.notes).trim() : null;

    if (!bookingId) {
      return c.json({ success: false, message: 'booking_id is required.' }, 400);
    }

    const booking = await c.env.DB.prepare(
      'SELECT * FROM reg_bookings WHERE id = ?',
    ).bind(bookingId).first();

    if (!booking) {
      return c.json({ success: false, message: 'Booking not found.' }, 404);
    }

    const effectiveTableId = tableId || (booking as Record<string, unknown>).table_id as string;

    const config = await loadTablesConfig(c.env.SWA_SESSION);
    const table = getTable(config, effectiveTableId);
    if (!table) {
      return c.json({ success: false, message: 'Invalid table_id.' }, 400);
    }

    const slot = await allocateGuestSlot(c.env.DB, {
      bookingId,
      tableId: effectiveTableId,
      tableConfig: table,
      guestName,
      isBuyer: false,
      isWalkIn: false,
      notes,
    });

    await c.env.DB.prepare(
      "UPDATE reg_bookings SET pax = pax + 1, updated_at = datetime('now') WHERE id = ?",
    ).bind(bookingId).run();

    return c.json({
      success: true,
      guest: {
        id: slot.id,
        ticket_code: slot.ticketCode,
        table_id: effectiveTableId,
        seat_counter: slot.seatCounter,
        guest_name: slot.guestName,
        is_buyer: slot.isBuyer,
        notes: slot.notes,
      },
    }, 201);
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}

export async function handleAdminGuestById(c: AppContext) {
  const guestId = c.req.param('id');

  const guest = await c.env.DB.prepare(
    'SELECT * FROM reg_guests WHERE id = ?',
  ).bind(guestId).first();

  if (!guest) {
    return c.json({ success: false, message: 'Guest not found.' }, 404);
  }

  const g = guest as Record<string, unknown>;

  if (c.req.method === 'PATCH') {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body.' }, 400);
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if ('guest_name' in body) {
      updates.push('guest_name = ?');
      values.push(String(body.guest_name || '').trim() || null);
    }
    if ('notes' in body) {
      updates.push('notes = ?');
      values.push(String(body.notes || '').trim() || null);
    }

    if (updates.length === 0) {
      return c.json({ success: false, message: 'No fields to update.' }, 400);
    }

    updates.push("updated_at = datetime('now')");
    values.push(guestId);

    await c.env.DB.prepare(
      `UPDATE reg_guests SET ${updates.join(', ')} WHERE id = ?`,
    ).bind(...values).run();

    return c.json({ success: true, id: guestId });
  }

  if (c.req.method === 'DELETE') {
    const bookingId = g.booking_id;

    await c.env.DB.prepare(
      'DELETE FROM reg_guests WHERE id = ?',
    ).bind(guestId).run();

    if (bookingId) {
      await c.env.DB.prepare(
        "UPDATE reg_bookings SET pax = pax - 1, updated_at = datetime('now') WHERE id = ?",
      ).bind(bookingId).run();
    }

    return c.json({ success: true, id: guestId });
  }

  return c.json({ success: false, message: 'Method not allowed' }, 405);
}