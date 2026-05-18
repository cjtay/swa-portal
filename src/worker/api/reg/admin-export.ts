import type { Context } from 'hono';
import type { Env } from '../../types';
import { loadTablesConfig, getTable } from '../../lib/reg/tables';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

export async function handleAdminExport(c: AppContext) {
  const config = await loadTablesConfig(c.env.SWA_SESSION);

  const results = await c.env.DB.prepare(`
    SELECT g.ticket_code, g.guest_name, g.table_id, g.is_buyer, g.is_walk_in, g.arrived_at, g.notes,
           b.booking_ref, b.buyer_name, b.buyer_email
    FROM reg_guests g
    LEFT JOIN reg_bookings b ON g.booking_id = b.id
    ORDER BY g.table_id, g.seat_counter ASC
  `).all();

  const tableMap = new Map(config.tables.map((t) => [t.id, t.label]));

  const header = 'ticket_code,guest_name,table_label,is_buyer,is_walk_in,booking_ref,buyer_name,buyer_email,arrived_at,notes';
  const rows = results.results.map((row: Record<string, unknown>) => {
    const tableLabel = tableMap.get(String(row.table_id)) || String(row.table_id);
    const guestName = String(row.guest_name || '');
    const buyerEmail = String(row.buyer_email || '');
    const arrivedAt = row.arrived_at ? String(row.arrived_at) : '';
    const notes = String(row.notes || '');
    return [
      row.ticket_code,
      csvEscape(guestName),
      csvEscape(tableLabel),
      row.is_buyer,
      row.is_walk_in,
      row.booking_ref || '',
      csvEscape(String(row.buyer_name || '')),
      csvEscape(buyerEmail),
      arrivedAt,
      csvEscape(notes),
    ].join(',');
  });

  const csv = [header, ...rows].join('\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename=guest-export.csv',
    },
  });
}

function csvEscape(value: string): string {
  if (!value) return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}