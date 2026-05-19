import type { Context } from 'hono';
import type { Env } from '../../types';
import { markArrived } from '../../lib/reg/guests';
import { loadTablesConfig, getTable } from '../../lib/reg/tables';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

export async function handleVolunteerSearch(c: AppContext) {
  const q = (c.req.query('q') || '').trim();
  const tableId = c.req.query('table') || '';

  if (!q) {
    return c.json({ success: true, results: [] });
  }

  const likeQuery = `%${q}%`;
  let stmt;
  if (tableId) {
    stmt = c.env.DB.prepare(
      "SELECT g.*, b.booking_ref, b.buyer_name FROM reg_guests g LEFT JOIN reg_bookings b ON g.booking_id = b.id WHERE (g.guest_name LIKE ? OR g.ticket_code LIKE ?) AND g.table_id = ? ORDER BY g.table_id, g.seat_counter LIMIT 20",
    ).bind(likeQuery, likeQuery, tableId);
  } else {
    stmt = c.env.DB.prepare(
      "SELECT g.*, b.booking_ref, b.buyer_name FROM reg_guests g LEFT JOIN reg_bookings b ON g.booking_id = b.id WHERE g.guest_name LIKE ? OR g.ticket_code LIKE ? ORDER BY g.table_id, g.seat_counter LIMIT 20",
    ).bind(likeQuery, likeQuery);
  }

  const config = await loadTablesConfig(c.env.SWA_CONFIG);
  const result = await stmt.all();

  const results = result.results.map((row: Record<string, unknown>) => {
    const table = getTable(config, String(row.table_id));
    return {
      id: row.id,
      ticket_code: row.ticket_code,
      guest_name: row.guest_name,
      table_id: row.table_id,
      table_label: table ? table.label : String(row.table_id),
      is_buyer: row.is_buyer,
      is_walk_in: row.is_walk_in,
      arrived_at: row.arrived_at,
      notes: row.notes,
      booking_ref: row.booking_ref,
      buyer_name: row.buyer_name,
    };
  });

  return c.json({ success: true, results });
}

export async function handleVolunteerArrive(c: AppContext) {
  const sessionEmail = c.get('sessionEmail') as string;
  const guestId = c.req.param('id');

  const guest = await c.env.DB.prepare(
    'SELECT * FROM reg_guests WHERE id = ?',
  ).bind(guestId).first();

  if (!guest) {
    return c.json({ success: false, message: 'Guest not found.' }, 404);
  }

  const g = guest as Record<string, unknown>;

  if (g.arrived_at) {
    const arrivedTime = new Date(String(g.arrived_at)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return c.json({
      success: true,
      message: `Already checked in at ${arrivedTime}.`,
      guest: {
        id: g.id,
        guest_name: g.guest_name,
        ticket_code: g.ticket_code,
        arrived_at: g.arrived_at,
      },
    });
  }

  await markArrived(c.env.DB, guestId, sessionEmail);

  const config = await loadTablesConfig(c.env.SWA_CONFIG);
  const table = getTable(config, String(g.table_id));

  return c.json({
    success: true,
    guest: {
      id: g.id,
      guest_name: g.guest_name,
      ticket_code: g.ticket_code,
      table_label: table ? table.label : String(g.table_id),
      arrived_at: new Date().toISOString(),
    },
  });
}

export async function handleVolunteerWalkin(c: AppContext) {
  const sessionEmail = c.get('sessionEmail') as string;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Invalid request body.' }, 400);
  }

  const guestName = String(body.guest_name || '').trim();
  const tableId = String(body.table_id || '').trim();
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!guestName) {
    return c.json({ success: false, message: 'Guest name is required.' }, 400);
  }
  if (!tableId) {
    return c.json({ success: false, message: 'Table is required.' }, 400);
  }

  const config = await loadTablesConfig(c.env.SWA_CONFIG);
  const table = getTable(config, tableId);
  if (!table) {
    return c.json({ success: false, message: 'Invalid table.' }, 400);
  }

  const { allocateGuestSlot } = await import('../../lib/reg/tickets');
  const slot = await allocateGuestSlot(c.env.DB, {
    bookingId: null,
    tableId,
    tableConfig: table,
    guestName,
    isBuyer: false,
    isWalkIn: true,
    notes,
  });

  await markArrived(c.env.DB, slot.id, sessionEmail);

  return c.json({
    success: true,
    guest: {
      id: slot.id,
      ticket_code: slot.ticketCode,
      guest_name: guestName,
      table_id: tableId,
      table_label: table.label,
      is_walk_in: 1,
      arrived_at: new Date().toISOString(),
    },
  }, 201);
}

export async function handleVolunteerUpdateGuest(c: AppContext) {
  const guestId = c.req.param('id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Invalid request body.' }, 400);
  }

  const guestName = String(body.guest_name || '').trim() || null;

  const guest = await c.env.DB.prepare(
    'SELECT * FROM reg_guests WHERE id = ?',
  ).bind(guestId).first();

  if (!guest) {
    return c.json({ success: false, message: 'Guest not found.' }, 404);
  }

  const g = guest as Record<string, unknown>;

  if (g.arrived_at) {
    return c.json({ success: false, message: 'Cannot edit name after guest has arrived.' }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE reg_guests SET guest_name = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(guestName, guestId).run();

  return c.json({ success: true, id: guestId, guest_name: guestName });
}