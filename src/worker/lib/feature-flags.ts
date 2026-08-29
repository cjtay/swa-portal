// Feature flags — runtime availability switches for not-yet-launched features.
//
// The source of truth is PROD_DEFAULT_FEATURE_FLAGS in this file; the KV key
// `swa:feature_flags` in SWA_CONFIG is an optional per-key override written by
// the Settings page ("Feature availability" card) via /api/admin/settings.
// A missing key, a missing KV entry, or an unparseable value all fall back to
// the code default — fail closed, so a half-built feature can never leak into
// production just because someone forgot to write a KV value.
//
// Local dev (isDevBypassActive): defaults are all-ON so WIP features stay
// visible while being built, regardless of the dev identity in use. A local
// KV override (wrangler --local, stored under .wrangler/state) can still turn
// individual features off to preview the production experience:
//
//   npx wrangler kv key put --binding SWA_CONFIG "swa:feature_flags" \
//     '{"namecards":false,"office_booking":false,"events":false}' --local
//
// Adding a new feature behind a flag (same commit as the feature):
//   1. Add the key to FeatureKey + PROD_DEFAULT_FEATURE_FLAGS (default false).
//      TypeScript's Record<FeatureKey, boolean> forces the default — a new
//      union member without a declared default is a compile error.
//   2. Gate its API paths in middleware.ts (FEATURE_GATES) or 404 its
//      worker-rendered routes.
//   3. Gate its pages via auth-gate's `feature` option and any nav items /
//      dashboard cards via data-feature.
//   4. Add a row to the Settings "Feature availability" card and to
//      validateFeatureFlags in api/admin-settings.ts.

import { isDevBypassActive } from '../api/session';
import type { Env } from '../types';

export const FEATURE_FLAGS_KV_KEY = 'swa:feature_flags';

export type FeatureKey = 'namecards' | 'office_booking' | 'events';

export type FeatureFlags = Record<FeatureKey, boolean>;

/** Production defaults — every unlaunched feature is hidden. */
export const PROD_DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  namecards: false,
  office_booking: false,
  events: false,
};

/** Local-dev defaults — everything visible while under construction. */
export const DEV_DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  namecards: true,
  office_booking: true,
  events: true,
};

// In-isolate cache. Cloudflare KV is eventually consistent (~60s globally)
// and isolates are reused across requests, so this collapses flag reads to
// roughly one KV get per minute per isolate. A Settings-page flip therefore
// takes effect within 60s without per-request KV traffic.
const CACHE_TTL_MS = 60_000;
let cache: { at: number; flags: FeatureFlags } | null = null;

export async function getFeatureFlags(env: Env, url: string): Promise<FeatureFlags> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.flags;

  const defaults = isDevBypassActive(env, url)
    ? DEV_DEFAULT_FEATURE_FLAGS
    : PROD_DEFAULT_FEATURE_FLAGS;

  const flags: FeatureFlags = { ...defaults };
  try {
    const raw = await env.SWA_CONFIG.get(FEATURE_FLAGS_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<FeatureKey, unknown>>;
      for (const key of Object.keys(PROD_DEFAULT_FEATURE_FLAGS) as FeatureKey[]) {
        if (typeof parsed[key] === 'boolean') flags[key] = parsed[key] as boolean;
      }
    }
  } catch {
    // Unparseable KV value → keep defaults (fail closed in prod).
  }

  cache = { at: now, flags };
  return flags;
}

/** Test-only: drop the in-isolate cache so a KV write takes effect at once
 * (vitest cannot wait out the 60s TTL between scenarios). */
export function __resetFeatureFlagCacheForTests(): void {
  cache = null;
}
