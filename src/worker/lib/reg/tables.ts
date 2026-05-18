export interface TableConfig {
  id: string;
  label: string;
  ticketPrefix: string;
  capacity: number;
  isVIP: boolean;
}

export interface TablesConfig {
  formCutoffTime: string;
  tables: TableConfig[];
}

export async function loadTablesConfig(kv: KVNamespace): Promise<TablesConfig> {
  const raw = await kv.get('swa:reg_tables_config');
  if (!raw) {
    throw new Error('Table configuration not found in KV. Set swa:reg_tables_config before using registration features.');
  }
  const config: TablesConfig = JSON.parse(raw);
  return config;
}

export function getTable(config: TablesConfig, tableId: string): TableConfig | undefined {
  return config.tables.find((t) => t.id === tableId);
}

export function isFormOpen(config: TablesConfig): boolean {
  const cutoff = new Date(config.formCutoffTime);
  return new Date() < cutoff;
}

export function formatCutoffTime(config: TablesConfig): string {
  const cutoff = new Date(config.formCutoffTime);
  return cutoff.toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}