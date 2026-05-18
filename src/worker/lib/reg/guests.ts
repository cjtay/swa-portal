export interface GuestRow {
  id: string;
  booking_id: string | null;
  table_id: string;
  seat_counter: number;
  ticket_code: string;
  guest_name: string | null;
  is_buyer: number;
  is_walk_in: number;
  notes: string | null;
  arrived_at: string | null;
  arrived_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function getGuestsByBooking(db: D1Database, bookingId: string): Promise<GuestRow[]> {
  const result = await db.prepare(
    'SELECT * FROM reg_guests WHERE booking_id = ? ORDER BY seat_counter ASC',
  )
    .bind(bookingId)
    .all();
  return result.results as unknown as GuestRow[];
}

export async function searchGuests(db: D1Database, query: string, tableId?: string): Promise<GuestRow[]> {
  const likeQuery = `%${query}%`;
  let stmt;
  if (tableId) {
    stmt = db.prepare(
      "SELECT * FROM reg_guests WHERE (guest_name LIKE ? OR ticket_code LIKE ?) AND table_id = ? ORDER BY table_id, seat_counter LIMIT 20",
    ).bind(likeQuery, likeQuery, tableId);
  } else {
    stmt = db.prepare(
      "SELECT * FROM reg_guests WHERE guest_name LIKE ? OR ticket_code LIKE ? ORDER BY table_id, seat_counter LIMIT 20",
    ).bind(likeQuery, likeQuery);
  }
  const result = await stmt.all();
  return result.results as unknown as GuestRow[];
}

export async function getGuestById(db: D1Database, guestId: string): Promise<GuestRow | null> {
  const result = await db.prepare('SELECT * FROM reg_guests WHERE id = ?').bind(guestId).first();
  return result as unknown as GuestRow | null;
}

export async function updateGuestName(
  db: D1Database,
  guestId: string,
  guestName: string,
  notes?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  if (notes !== undefined) {
    await db.prepare(
      'UPDATE reg_guests SET guest_name = ?, notes = ?, updated_at = ? WHERE id = ?',
    )
      .bind(guestName, notes, now, guestId)
      .run();
  } else {
    await db.prepare(
      'UPDATE reg_guests SET guest_name = ?, updated_at = ? WHERE id = ?',
    )
      .bind(guestName, now, guestId)
      .run();
  }
}

export async function deleteGuest(db: D1Database, guestId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM reg_guests WHERE id = ?').bind(guestId).run();
  return result.meta.changes > 0;
}

export async function markArrived(db: D1Database, guestId: string, sessionEmail: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE reg_guests SET arrived_at = ?, arrived_by = ?, updated_at = ? WHERE id = ? AND arrived_at IS NULL',
  )
    .bind(now, sessionEmail, now, guestId)
    .run();
}

export interface ArrivalStats {
  totalExpected: number;
  totalArrived: number;
  arrivalPct: number;
}

export async function getArrivalStats(db: D1Database): Promise<ArrivalStats> {
  const totalResult = await db.prepare(
    'SELECT COUNT(*) AS total FROM reg_guests WHERE guest_name IS NOT NULL',
  ).first();
  const arrivedResult = await db.prepare(
    'SELECT COUNT(*) AS total FROM reg_guests WHERE arrived_at IS NOT NULL',
  ).first();

  const totalExpected = (totalResult?.total as number) ?? 0;
  const totalArrived = (arrivedResult?.total as number) ?? 0;
  const arrivalPct = totalExpected > 0 ? Math.round((totalArrived / totalExpected) * 100) : 0;

  return { totalExpected, totalArrived, arrivalPct };
}

export interface RecentArrival {
  guestName: string | null;
  ticketCode: string;
  tableId: string;
  arrivedAt: string;
  arrivedBy: string | null;
}

export async function getRecentArrivals(db: D1Database, limit = 10): Promise<RecentArrival[]> {
  const result = await db.prepare(
    'SELECT guest_name, ticket_code, table_id, arrived_at, arrived_by FROM reg_guests WHERE arrived_at IS NOT NULL ORDER BY arrived_at DESC LIMIT ?',
  )
    .bind(limit)
    .all();
  return (result.results as Record<string, unknown>[]).map((row) => ({
    guestName: row.guest_name as string | null,
    ticketCode: row.ticket_code as string,
    tableId: row.table_id as string,
    arrivedAt: row.arrived_at as string,
    arrivedBy: row.arrived_by as string | null,
  }));
}