import type { Context } from 'hono';
import type { AppContext } from "../../types";
import { loadTablesConfig, getTable } from '../../lib/reg/tables';
import { getArrivalStats, getRecentArrivals } from '../../lib/reg/guests';


type TableDashboardRow = {
  tableId: string;
  tableLabel: string;
  isVIP: boolean;
  capacity: number;
  namedCount: number;
  arrivedCount: number;
  walkInCount: number;
};

type RecentArrival = {
  guestName: string | null;
  tableLabel: string;
  ticketCode: string;
  arrivedAt: string;
};

export async function handleRegDashboard(c: AppContext) {
  const config = await loadTablesConfig(c.env.SWA_CONFIG);
  const stats = await getArrivalStats(c.env.DB);
  const recent = await getRecentArrivals(c.env.DB, 10);

  const tableRows: TableDashboardRow[] = [];

  for (const table of config.tables) {
    const namedResult = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM reg_guests WHERE table_id = ? AND guest_name IS NOT NULL AND guest_name != "" AND is_walk_in = 0',
    ).bind(table.id).first();

    const arrivedResult = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM reg_guests WHERE table_id = ? AND arrived_at IS NOT NULL',
    ).bind(table.id).first();

    const walkInResult = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM reg_guests WHERE table_id = ? AND is_walk_in = 1',
    ).bind(table.id).first();

    tableRows.push({
      tableId: table.id,
      tableLabel: table.label,
      isVIP: table.isVIP,
      capacity: table.capacity,
      namedCount: (namedResult?.cnt as number) ?? 0,
      arrivedCount: (arrivedResult?.cnt as number) ?? 0,
      walkInCount: (walkInResult?.cnt as number) ?? 0,
    });
  }

  tableRows.sort((a, b) => {
    if (a.isVIP !== b.isVIP) return a.isVIP ? -1 : 1;
    return a.tableId.localeCompare(b.tableId);
  });

  const recentArrivals: RecentArrival[] = recent.map((r) => {
    const table = getTable(config, r.tableId);
    return {
      guestName: r.guestName,
      tableLabel: table ? table.label : r.tableId,
      ticketCode: r.ticketCode,
      arrivedAt: r.arrivedAt,
    };
  });

  return c.json({
    success: true,
    totalExpected: stats.totalExpected,
    totalArrived: stats.totalArrived,
    walkInCount: stats.walkInCount,
    arrivalPct: stats.arrivalPct,
    tables: tableRows,
    recentArrivals,
  });
}