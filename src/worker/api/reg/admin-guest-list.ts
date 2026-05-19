import type { Context } from 'hono';
import type { Env } from '../../types';
import { loadTablesConfig, getTable } from '../../lib/reg/tables';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

export async function handleAdminGuestList(c: AppContext) {
  const config = await loadTablesConfig(c.env.SWA_CONFIG);

  const results = await c.env.DB.prepare(`
    SELECT g.id, g.ticket_code, g.guest_name, g.table_id, g.seat_counter,
           g.is_buyer, g.is_walk_in, g.arrived_at, g.arrived_by, g.notes,
           b.booking_ref, b.buyer_name
    FROM reg_guests g
    LEFT JOIN reg_bookings b ON g.booking_id = b.id
    ORDER BY g.table_id ASC, g.seat_counter ASC
  `).all();

  // Build a lookup map of existing guests by tableId -> ticketCode -> guest
  const guestsByTable = new Map<string, Map<string, {
    id: string;
    ticketCode: string;
    guestName: string | null;
    isBuyer: boolean;
    isWalkIn: boolean;
    arrived: boolean;
    arrivedAt: string | null;
    notes: string | null;
    bookingRef: string | null;
    buyerName: string | null;
  }>>();

  for (const row of (results.results as Record<string, unknown>[])) {
    const tableId = String(row.table_id);
    const arrivedAt = row.arrived_at ? String(row.arrived_at) : null;
    const ticketCode = String(row.ticket_code);
    const guest = {
      id: String(row.id),
      ticketCode,
      guestName: row.guest_name ? String(row.guest_name) : null,
      isBuyer: Boolean(row.is_buyer),
      isWalkIn: Boolean(row.is_walk_in),
      arrived: arrivedAt !== null,
      arrivedAt: arrivedAt,
      notes: row.notes ? String(row.notes) : null,
      bookingRef: row.booking_ref ? String(row.booking_ref) : null,
      buyerName: row.buyer_name ? String(row.buyer_name) : null,
    };

    if (!guestsByTable.has(tableId)) {
      guestsByTable.set(tableId, new Map());
    }
    guestsByTable.get(tableId)!.set(ticketCode, guest);
  }

  // Build response for ALL configured tables, filling empty seats with pre-printed ticket codes
  const tables = [];
  let totalGuests = 0;
  let namedGuests = 0;
  let arrivedGuests = 0;

  for (const tableConfig of config.tables) {
    const tableGuests = guestsByTable.get(tableConfig.id) || new Map();
    const guests = [];

    for (let seat = 1; seat <= tableConfig.capacity; seat++) {
      const ticketCode = `${tableConfig.ticketPrefix}-${String(seat).padStart(2, '0')}`;
      const existingGuest = tableGuests.get(ticketCode);

      if (existingGuest) {
        totalGuests++;
        if (existingGuest.guestName !== null) namedGuests++;
        if (existingGuest.arrived) arrivedGuests++;
        guests.push(existingGuest);
      } else {
        guests.push({
          id: null,
          ticketCode,
          guestName: null,
          isBuyer: false,
          isWalkIn: false,
          arrived: false,
          arrivedAt: null,
          notes: null,
          bookingRef: null,
          buyerName: null,
        });
      }
    }

    tables.push({
      tableId: tableConfig.id,
      tableLabel: tableConfig.label,
      isVIP: tableConfig.isVIP,
      capacity: tableConfig.capacity,
      guests,
    });
  }

  const now = new Date();
  const generatedAt = now.toLocaleString('en-SG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Singapore',
    timeZoneName: 'short',
  });

  return c.json({
    success: true,
    generatedAt,
    totalGuests,
    namedGuests,
    arrivedGuests,
    tables,
  });
}