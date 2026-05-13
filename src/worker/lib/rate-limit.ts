export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

const API_RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 15 minutes
const API_RATE_LIMIT_MAX_REQUESTS = 10;

export async function checkApiRateLimit(
  kv: KVNamespace,
  endpointKey: string,
  email: string,
): Promise<RateLimitResult> {
  const key = `swa:rl:api:${endpointKey}:${email.toLowerCase()}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % API_RATE_LIMIT_WINDOW_SECONDS);

  const raw = await kv.get(key);
  let records: number[] = raw ? JSON.parse(raw) : [];
  records = records.filter((t: number) => t > windowStart);

  if (records.length >= API_RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }

  records.push(now);
  await kv.put(key, JSON.stringify(records), { expirationTtl: API_RATE_LIMIT_WINDOW_SECONDS + 60 });
  return { allowed: true, remaining: API_RATE_LIMIT_MAX_REQUESTS - records.length };
}

/**
 * Maps a request path and HTTP method to a rate-limit endpoint key.
 * Returns null if the endpoint should not be rate limited.
 */
export function getEndpointKey(path: string, method: string): string | null {
  const basePath = getBasePath(path);
  const m = method.toUpperCase();

  // Only write operations are rate limited
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
    return null;
  }

  switch (basePath) {
    case '/api/bookings':
      if (m === 'POST') return 'bookings:post';
      return null;
    case '/api/members':
      if (path.includes('/photo')) return 'members:photo';
      if (m === 'POST') return 'members:post';
      if (m === 'PATCH') return 'members:patch';
      if (m === 'DELETE') return 'members:delete';
      return null;
    case '/api/sync-website':
      if (m === 'POST') return 'sync-website:post';
      return null;
    default:
      return null;
  }
}

function getBasePath(path: string): string {
  const parts = path.split('/');
  return '/' + parts.slice(1, 3).join('/');
}
