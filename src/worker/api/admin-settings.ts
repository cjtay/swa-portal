import type { Context } from 'hono';
import type { Env } from '../types';

type AppContext = Context<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>;

const KNOWN_KEYS = ['swa:reg_tables_config'] as const;
type KnownKey = (typeof KNOWN_KEYS)[number];

function validateRegTablesConfig(value: unknown): { valid: true; data: Record<string, unknown> } | { valid: false; errors: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['Value must be a JSON object.'] };
  }

  const obj = value as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof obj.formCutoffTime !== 'string' || !obj.formCutoffTime.trim()) {
    errors.push('formCutoffTime is required and must be a valid ISO 8601 string.');
  } else {
    const d = new Date(obj.formCutoffTime as string);
    if (isNaN(d.getTime())) {
      errors.push('formCutoffTime must be a valid ISO 8601 datetime string.');
    }
  }

  if (!Array.isArray(obj.tables) || obj.tables.length === 0) {
    errors.push('tables must be a non-empty array.');
  } else {
    const tables = obj.tables as Record<string, unknown>[];
    const ids = new Set<string>();
    const prefixes = new Set<string>();

    tables.forEach((t, i) => {
      const prefix = `tables[${i}]`;
      if (typeof t.id !== 'string' || !t.id.trim()) {
        errors.push(`${prefix}.id is required and must be a non-empty string.`);
      } else {
        if (ids.has(t.id)) errors.push(`Duplicate table ID: ${t.id}`);
        ids.add(t.id as string);
      }
      if (typeof t.label !== 'string' || !t.label.trim()) {
        errors.push(`${prefix}.label is required and must be a non-empty string.`);
      }
      if (typeof t.ticketPrefix !== 'string' || !t.ticketPrefix.trim()) {
        errors.push(`${prefix}.ticketPrefix is required and must be a non-empty string.`);
      } else {
        if (prefixes.has(t.ticketPrefix)) errors.push(`Duplicate ticket prefix: ${t.ticketPrefix}`);
        prefixes.add(t.ticketPrefix as string);
      }
      if (typeof t.capacity !== 'number' || !Number.isInteger(t.capacity) || t.capacity < 1) {
        errors.push(`${prefix}.capacity must be a positive integer.`);
      }
      if (typeof t.isVIP !== 'boolean') {
        errors.push(`${prefix}.isVIP must be a boolean.`);
      }
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, data: obj };
}

function validateValue(key: KnownKey, value: unknown): { valid: true; data: Record<string, unknown> } | { valid: false; errors: string[] } {
  switch (key) {
    case 'swa:reg_tables_config':
      return validateRegTablesConfig(value);
    default:
      return { valid: false, errors: [`Unknown settings key: ${key}`] };
  }
}

export async function handleAdminSettingsGet(c: AppContext) {
  const key = c.req.query('key');

  if (!key) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Query parameter "key" is required.' }, 400);
  }

  if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `Unknown settings key: ${key}` }, 400);
  }

  const raw = await c.env.SWA_SESSION.get(key);
  if (!raw) {
    return c.json({ success: false, error_code: 'NOT_FOUND', message: `No configuration found for key: ${key}` }, 404);
  }

  try {
    const value = JSON.parse(raw);
    return c.json({ success: true, key, value });
  } catch {
    return c.json({ success: false, error_code: 'PARSE_ERROR', message: 'KV value is not valid JSON.' }, 500);
  }
}

export async function handleAdminSettingsPost(c: AppContext) {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, 400);
  }

  const key = body.key;
  if (typeof key !== 'string' || !key) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Field "key" is required.' }, 400);
  }

  if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: `Unknown settings key: ${key}` }, 400);
  }

  if (body.value === undefined) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: 'Field "value" is required.' }, 400);
  }

  const validation = validateValue(key as KnownKey, body.value);
  if (!validation.valid) {
    return c.json({ success: false, error_code: 'VALIDATION_ERROR', message: validation.errors.join('; ') }, 400);
  }

  await c.env.SWA_SESSION.put(key, JSON.stringify(validation.data));

  return c.json({ success: true, key, value: validation.data });
}
