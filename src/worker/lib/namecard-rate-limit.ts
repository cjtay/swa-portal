// IP-keyed sliding-window rate limiter for public namecard endpoints.
//
// This cannot reuse checkApiRateLimit (src/worker/lib/rate-limit.ts) because
// that helper is keyed by `email` and assumes an authenticated session. The
// public namecard surface has no session — visitors may be unauthenticated —
// so we key off the Cloudflare-provided client IP instead.
//
// KV layout: a JSON array of unix timestamps (seconds) under
// `swa:rl:card:ip:{ip}` in SWA_SESSION, with `expirationTtl` so the entry
// self-cleans after the window closes. Same shape as checkApiRateLimit so the
// behaviour is identical, just keyed differently.
//
// See docs/specs/features/namecards.md §5.4.

import {
  NAMECARD_PUBLIC_RATE_LIMIT_MAX_REQUESTS,
  NAMECARD_PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
} from '../../constants/portal';

export interface PublicRateLimitResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Check and record a request against the public-namecard IP rate limit.
 *
 * Returns `{ allowed: true, remaining }` and pushes a timestamp when allowed,
 * or `{ allowed: false, remaining: 0 }` when the caller is over the limit and
 * leaves KV untouched.
 */
export async function checkNamecardIpRateLimit(
  kv: KVNamespace,
  ip: string,
): Promise<PublicRateLimitResult> {
  const key = `swa:rl:card:ip:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % NAMECARD_PUBLIC_RATE_LIMIT_WINDOW_SECONDS);

  const raw = await kv.get(key);
  let records: number[] = raw ? JSON.parse(raw) : [];
  records = records.filter((t: number) => t > windowStart);

  if (records.length >= NAMECARD_PUBLIC_RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }

  records.push(now);
  await kv.put(key, JSON.stringify(records), {
    expirationTtl: NAMECARD_PUBLIC_RATE_LIMIT_WINDOW_SECONDS + 60,
  });
  return { allowed: true, remaining: NAMECARD_PUBLIC_RATE_LIMIT_MAX_REQUESTS - records.length };
}

/**
 * Extract the caller's IP from a Request. Prefers `CF-Connecting-IP` (set by
 * Cloudflare for every request); falls back to the first IP in
 * `X-Forwarded-For` for local dev (where CF-Connecting-IP may be absent).
 *
 * Returns 'unknown' if no IP can be determined — the limiter will then
 * effectively apply a single bucket to all anonymous traffic, which is the
 * safe failure mode.
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = req.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}
