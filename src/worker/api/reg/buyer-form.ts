import type { Context } from 'hono';
import type { Env } from '../../types';
import { validateToken } from '../../lib/reg/tokens';
import { loadTablesConfig, getTable, isFormOpen, formatCutoffTime } from '../../lib/reg/tables';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

export async function handleBuyerForm(c: AppContext) {
  const token = c.req.param('token');

  const tokenRow = await validateToken(c.env.DB, token);
  if (!tokenRow) {
    return c.json({ closed: true, reason: 'invalid' });
  }

  const config = await loadTablesConfig(c.env.SWA_SESSION);
  if (!isFormOpen(config)) {
    return c.json({ closed: true, reason: 'cutoff' });
  }

  const booking = await c.env.DB.prepare(
    'SELECT * FROM reg_bookings WHERE id = ?',
  ).bind(tokenRow.booking_id).first();

  if (!booking) {
    return c.json({ closed: true, reason: 'invalid' });
  }

  const b = booking as Record<string, unknown>;
  const guests = await c.env.DB.prepare(
    'SELECT id, ticket_code, guest_name, is_buyer, is_walk_in, notes, table_id FROM reg_guests WHERE booking_id = ? ORDER BY seat_counter ASC',
  ).bind(tokenRow.booking_id).all();

  const table = getTable(config, String(b.table_id));

  const guestList = guests.results.map((g: Record<string, unknown>) => ({
    id: g.id,
    ticket_code: g.ticket_code,
    guest_name: g.guest_name,
    is_buyer: g.is_buyer,
    is_walk_in: g.is_walk_in,
    notes: g.notes,
    table_id: g.table_id,
    table_label: getTable(config, String(g.table_id))?.label || String(g.table_id),
  }));

  return c.json({
    closed: false,
    booking: {
      id: b.id,
      booking_ref: b.booking_ref,
      buyer_name: b.buyer_name,
      pax: b.pax,
      table_id: b.table_id,
      table_label: table ? table.label : String(b.table_id),
    },
    guests: guestList,
    formCutoffTime: config.formCutoffTime,
    formCutoffFormatted: formatCutoffTime(config),
  });
}

export async function handleBuyerUpdateGuest(c: AppContext) {
  const token = c.req.param('token');
  const guestId = c.req.param('id');

  const tokenRow = await validateToken(c.env.DB, token);
  if (!tokenRow) {
    return c.json({ success: false, message: 'Invalid or expired link.' }, 403);
  }

  const config = await loadTablesConfig(c.env.SWA_SESSION);
  if (!isFormOpen(config)) {
    return c.json({ success: false, message: 'Guest registration has closed.', closed: true }, 403);
  }

  const guest = await c.env.DB.prepare(
    'SELECT * FROM reg_guests WHERE id = ?',
  ).bind(guestId).first();

  if (!guest) {
    return c.json({ success: false, message: 'Guest not found.' }, 404);
  }

  const g = guest as Record<string, unknown>;

  if (String(g.booking_id) !== String(tokenRow.booking_id)) {
    return c.json({ success: false, message: 'This guest does not belong to your booking.' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Invalid request body.' }, 400);
  }

  const guestName = String(body.guest_name || '').trim();
  const notes = body.notes !== undefined ? String(body.notes).trim() : undefined;

  if (!guestName) {
    return c.json({ success: false, message: 'Guest name is required.' }, 400);
  }

  const now = new Date().toISOString();
  if (notes !== undefined) {
    await c.env.DB.prepare(
      'UPDATE reg_guests SET guest_name = ?, notes = ?, updated_at = ? WHERE id = ?',
    ).bind(guestName, notes || null, now, guestId).run();
  } else {
    await c.env.DB.prepare(
      'UPDATE reg_guests SET guest_name = ?, updated_at = ? WHERE id = ?',
    ).bind(guestName, now, guestId).run();
  }

  return c.json({ success: true, id: guestId, guest_name: guestName });
}