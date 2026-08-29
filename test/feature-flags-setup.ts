// Vitest setup file — runs inside the isolate before every test file.
//
// The vitest pool loads wrangler.jsonc + .dev.vars, but test requests are
// issued against https://example.com, so isDevBypassActive() is false and
// getFeatureFlags() would apply the PRODUCTION defaults (every gated feature
// disabled). Existing integration tests for namecards / office booking /
// events APIs exercise those features as ENABLED, so seed the KV override
// with all-true up front. Tests that verify the disabled behaviour manage
// the KV key + cache themselves (see feature-flags.test.ts) and restore
// all-true in their beforeEach.
import { env } from 'cloudflare:test';
import { FEATURE_FLAGS_KV_KEY } from '../src/worker/lib/feature-flags';

await env.SWA_CONFIG.put(
  FEATURE_FLAGS_KV_KEY,
  JSON.stringify({ namecards: true, office_booking: true, events: true }),
);
