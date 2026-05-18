import type { TablesConfig, TableConfig } from './tables';

export interface GuestSlot {
  id: string;
  bookingId: string | null;
  tableId: string;
  seatCounter: number;
  ticketCode: string;
  guestName: string | null;
  isBuyer: number;
  isWalkIn: number;
  notes: string | null;
}

function generateId(): string {
  return crypto.randomUUID();
}

export async function allocateGuestSlot(
  db: D1Database,
  params: {
    bookingId: string | null;
    tableId: string;
    tableConfig: TableConfig;
    guestName: string | null;
    isBuyer: boolean;
    isWalkIn: boolean;
    notes?: string | null;
  },
): Promise<GuestSlot> {
  const { bookingId, tableId, tableConfig, guestName, isBuyer, isWalkIn, notes } = params;
  const prefix = tableConfig.ticketPrefix;

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const counterResult = await db.prepare(
      'SELECT COALESCE(MAX(seat_counter), 0) + 1 AS next_counter FROM reg_guests WHERE table_id = ?',
    )
      .bind(tableId)
      .first();

    const seatCounter = (counterResult?.next_counter as number) ?? (attempt + 1);
    const ticketCode = `${prefix}-${String(seatCounter).padStart(2, '0')}`;
    const id = generateId();

    try {
      await db.prepare(
        `INSERT INTO reg_guests (id, booking_id, table_id, seat_counter, ticket_code, guest_name, is_buyer, is_walk_in, notes, arrived_at, arrived_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
        .bind(
          id,
          bookingId,
          tableId,
          seatCounter,
          ticketCode,
          guestName,
          isBuyer ? 1 : 0,
          isWalkIn ? 1 : 0,
          notes ?? null,
        )
        .run();

      return {
        id,
        bookingId,
        tableId,
        seatCounter,
        ticketCode,
        guestName,
        isBuyer: isBuyer ? 1 : 0,
        isWalkIn: isWalkIn ? 1 : 0,
        notes: notes ?? null,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed') && attempt < MAX_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to allocate guest slot for table ${tableId} after ${MAX_RETRIES} retries`);
}