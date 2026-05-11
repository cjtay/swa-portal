import type { Context } from 'hono';
import type { Env } from '../types';

interface ErrorLogEntry {
  endpoint: string;
  error_type: string;
  error_message: string;
  http_status: number;
  user_email?: string;
}

export async function logError(env: Env, entry: ErrorLogEntry): Promise<void> {
  const logged_at = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO error_log
        (logged_at, endpoint, error_type, error_message, http_status, user_email)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      logged_at,
      entry.endpoint,
      entry.error_type,
      entry.error_message,
      entry.http_status,
      entry.user_email ?? null,
    ).run();
  } catch (logErr) {
    console.error('[SWA PORTAL ERROR LOG WRITE FAILED]', logErr);
  }
  console.error(
    `[SWA ${entry.error_type}]`,
    entry.endpoint,
    entry.error_message,
    entry.user_email ?? '',
  );
}