import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from '../types';
import { logError } from './log-error';

export async function handleApiError(
  c: AppContext,
  endpoint: string,
  error: unknown,
  userMessage: string,
  options?: {
    user_email?: string;
    error_type?: string;
    http_status?: ContentfulStatusCode;
  },
): Promise<Response> {
  const msg = error instanceof Error ? error.message : String(error);
  const httpStatus = options?.http_status ?? 500;
  await logError(c.env, {
    endpoint,
    error_type: options?.error_type ?? 'UNEXPECTED',
    error_message: `${endpoint}: ${msg}`,
    http_status: httpStatus,
    user_email: options?.user_email,
  });
  return c.json(
    { success: false, error_code: 'UNEXPECTED_ERROR', message: userMessage },
    httpStatus,
  );
}