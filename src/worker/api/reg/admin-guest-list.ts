import type { Context } from 'hono';
import type { Env } from '../../types';
import { loadTablesConfig, getTable } from '../../lib/reg/tables';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

export async function handleAdminGuestList(c: AppContext) {
  const config = await loadTablesConfig(c.env.SWA_SESSION);

  const results = await c.env.DB.prepare(`
    SELECT g.id, g.ticket_code, g.guest_name, g.table_id, g.seat_counter,
           g.is_buyer, g.is_walk_in, g.arrived_at, g.arrived_by, g.notes,
           b.booking_ref, b.buyer_name
    FROM reg_guests g
    LEFT JOIN reg_bookings b ON g.booking_id = b.id
    ORDER BY g.table_id ASC, g.seat_counter ASC
  `).all();

  const tablesMap = new Map<string, {
    tableId: string;
    tableLabel: string;
    isVIP: boolean;
    guests: typeof guests;
  }>();

  const guests: Array<{
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
  }> = [];

  for (const row of (results.results as Record<string, unknown>[])) {
    const tableId = String(row.table_id);
    const table = getTable(config, tableId);
    const tableLabel = table ? table.label : tableId;

    if (!tablesMap.has(tableId)) {
      tablesMap.set(tableId, {
        tableId,
        tableLabel,
        isVIP: table?.isVIP ?? false,
        guests: [],
      });
    }

    const arrivedAt = row.arrived_at ? String(row.arrived_at) : null;
    const guest = {
      id: String(row.id),
      ticketCode: String(row.ticket_code),
      guestName: row.guest_name ? String(row.guest_name) : null,
      isBuyer: Boolean(row.is_buyer),
      isWalkIn: Boolean(row.is_walk_in),
      arrived: arrivedAt !== null,
      arrivedAt: arrivedAt,
      notes: row.notes ? String(row.notes) : null,
      bookingRef: row.booking_ref ? String(row.booking_ref) : null,
      buyerName: row.buyer_name ? String(row.buyer_name) : null,
    };

    guests.push(guest);
    tablesMap.get(tableId)!.guests.push(guest);
  }

  const tables = Array.from(tablesMap.values());

  const totalGuests = guests.length;
  const namedGuests = guests.filter(g => g.guestName !== null).length;
  const arrivedGuests = guests.filter(g => g.arrived).length;

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