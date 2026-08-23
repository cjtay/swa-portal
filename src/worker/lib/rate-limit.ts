export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

const API_RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 15 minutes
const API_RATE_LIMIT_MAX_REQUESTS = 10;

export interface EndpointLimit {
  windowSeconds: number;
  maxRequests: number;
}

const DEFAULT_LIMIT: EndpointLimit = {
  windowSeconds: API_RATE_LIMIT_WINDOW_SECONDS,
  maxRequests: API_RATE_LIMIT_MAX_REQUESTS,
};

// Per-endpoint overrides (security-remediation-plan Phase 4b). Anything not
// listed gets the default 10 requests / 15 minutes.
const ENDPOINT_LIMITS: Record<string, EndpointLimit> = {
  // Email send — expensive and externally visible; strict.
  'reg:magic-link:post': { windowSeconds: 60 * 60, maxRequests: 5 },
  // Volunteer check-in writes — bursty by nature (kiosk use), generous.
  'reg:volunteer-write:post': { windowSeconds: 15 * 60, maxRequests: 30 },
  // Namecard photo upload — R2 write + large body.
  'namecards:photo:post': { windowSeconds: 60 * 60, maxRequests: 10 },
  // Membership approve/reject — state transitions with email side effects.
  'membership-review:post': { windowSeconds: 60 * 60, maxRequests: 20 },
  // Approval workflow (plan §8) — reminder emails are externally visible;
  // review covers approve/reject at both stages (matches membership);
  // write covers create/edit/voucher at the default cadence.
  'approvals:remind:post': { windowSeconds: 60 * 60, maxRequests: 5 },
  'approvals:review:post': { windowSeconds: 60 * 60, maxRequests: 20 },
  'approvals:write:post': { windowSeconds: 15 * 60, maxRequests: 10 },
};

export function getEndpointLimit(endpointKey: string): EndpointLimit {
  return ENDPOINT_LIMITS[endpointKey] ?? DEFAULT_LIMIT;
}

export async function checkApiRateLimit(
  kv: KVNamespace,
  endpointKey: string,
  email: string,
): Promise<RateLimitResult> {
  const { windowSeconds, maxRequests } = getEndpointLimit(endpointKey);
  const key = `swa:rl:api:${endpointKey}:${email.toLowerCase()}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);

  const raw = await kv.get(key);
  let records: number[] = raw ? JSON.parse(raw) : [];
  records = records.filter((t: number) => t > windowStart);

  if (records.length >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  records.push(now);
  await kv.put(key, JSON.stringify(records), { expirationTtl: windowSeconds + 60 });
  return { allowed: true, remaining: maxRequests - records.length };
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

  // Path-specific buckets first (basePath alone is too coarse for these).
  if (m === 'POST') {
    if (path.startsWith('/api/reg/admin/send-magic-link/')) return 'reg:magic-link:post';
    if (
      path === '/api/reg/volunteer/walkin' ||
      /^\/api\/reg\/volunteer\/(arrive|guest)\/[^/]+$/.test(path)
    ) {
      return 'reg:volunteer-write:post';
    }
    if (/^\/api\/namecards\/[^/]+\/photo$/.test(path)) return 'namecards:photo:post';
    if (/^\/api\/admin\/forms\/membership\/[^/]+\/(approve|reject)$/.test(path)) {
      return 'membership-review:post';
    }
    // Approval workflow — specific actions first, then every remaining POST
    // under /api/approvals (create, edit, voucher, paid, attachments).
    if (/^\/api\/approvals\/[^/]+\/remind$/.test(path)) return 'approvals:remind:post';
    if (/^\/api\/approvals\/[^/]+\/(approve|reject|finance-approve|finance-reject)$/.test(path)) {
      return 'approvals:review:post';
    }
    if (path === '/api/approvals' || path.startsWith('/api/approvals/')) {
      return 'approvals:write:post';
    }
  }

  switch (basePath) {
    case '/api/bookings':
      if (m === 'POST') return 'bookings:post';
      return null;
    case '/api/members':
      if (m === 'POST') return 'members:post';
      if (m === 'PATCH') return 'members:patch';
      if (m === 'DELETE') return 'members:delete';
      return null;
    case '/api/namecards':
      // The /api/namecards surface has several write methods. Bucket them by
      // method so the email-keyed limiter treats bulk-create differently from
      // a single edit (docs/specs/features/namecards.md §5.4).
      if (m === 'POST') return 'namecards:post';
      if (m === 'PATCH') return 'namecards:patch';
      if (m === 'DELETE') return 'namecards:delete';
      return null;
    default:
      return null;
  }
}

function getBasePath(path: string): string {
  const parts = path.split('/');
  return '/' + parts.slice(1, 3).join('/');
}
