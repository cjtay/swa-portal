import type { Context } from 'hono';
import type { Env } from '../../types';
import { loadTablesConfig } from '../../lib/reg/tables';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

export async function handleRegTables(c: AppContext) {
  const config = await loadTablesConfig(c.env.SWA_SESSION);

  return c.json({
    success: true,
    tables: config.tables,
    formCutoffTime: config.formCutoffTime,
  });
}