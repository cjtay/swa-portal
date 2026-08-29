// Vitest suite setup — runs inside the isolate before every test file.
//
// Two guards, both fail-fast:
//
// 1. Email suppression. The vitest config replaces RESEND_API_KEY with a
//    sentinel (overriding .dev.vars, which holds the real key). If that
//    override ever stops winning, this assertion throws so a config change
//    can never silently resume real emails from test runs.
//
// 2. Feature flags. The vitest pool loads wrangler.jsonc + .dev.vars, but
//    test requests are issued against https://example.com, so
//    isDevBypassActive() is false and getFeatureFlags() would apply the
//    PRODUCTION defaults (every gated feature disabled). Existing
//    integration tests for namecards / office booking / events APIs
//    exercise those features as ENABLED, so seed the KV override with
//    all-true up front. Tests that verify the disabled behaviour manage
//    the KV key + cache themselves (see feature-flags.test.ts) and restore
//    all-true in their beforeEach.
import { env } from 'cloudflare:test';
import { FEATURE_FLAGS_KV_KEY } from '../src/worker/lib/feature-flags';
import { TEST_SUPPRESSED_RESEND_KEY } from '../src/worker/lib/resend';

if (env.RESEND_API_KEY !== TEST_SUPPRESSED_RESEND_KEY) {
  const got = env.RESEND_API_KEY ? `${env.RESEND_API_KEY.slice(0, 6)}…` : '(empty)';
  throw new Error(
    `Test suite is not email-suppressed: RESEND_API_KEY is ${got} instead of the sentinel. ` +
      `Running tests now would email real mailboxes. Check the miniflare bindings override ` +
      `in vitest.config.ts (it must beat .dev.vars).`,
  );
}

await env.SWA_CONFIG.put(
  FEATURE_FLAGS_KV_KEY,
  JSON.stringify({ namecards: true, office_booking: true, events: true }),
);
