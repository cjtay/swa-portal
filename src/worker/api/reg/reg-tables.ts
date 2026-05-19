import type { Context } from 'hono';
import type { Env } from '../../types';
import { loadTablesConfig } from '../../lib/reg/tables';
import { getTableOccupancyMap } from '../../lib/reg/guests';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

export async function handleRegTables(c: AppContext) {
  const config = await loadTablesConfig(c.env.SWA_CONFIG);
  const occupancy = await getTableOccupancyMap(c.env.DB);

  return c.json({
    success: true,
    tables: config.tables.map((t) => ({ ...t, occupied: occupancy[t.id] ?? 0 })),
    formCutoffTime: config.formCutoffTime,
  });
}