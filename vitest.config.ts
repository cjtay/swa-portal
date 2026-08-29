import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { TEST_SUPPRESSED_RESEND_KEY } from './src/worker/lib/resend';

// Vitest configuration for the SWA portal.
//
// Uses @cloudflare/vitest-pool-workers so every test runs inside a Miniflare
// isolate with real D1 / KV / R2 bindings (read from wrangler.jsonc). Pure
// library tests also use this pool — the isolate boot cost is small and keeps
// everything uniform.
//
// Vitest 4 + pool-workers 0.18 use the `cloudflareTest(...)` plugin form (the
// older `poolOptions.workers` / `defineWorkersProject` style was removed).
//
// Tests live alongside source under `src/**/__tests__/` and in the top-level
// `test/` directory. Shared DB helpers live in `test/db-helpers.ts`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Test runs never send real email: RESEND_API_KEY is replaced with a
      // sentinel (this override beats .dev.vars, which holds the real key —
      // asserted fail-fast in test/suite-setup.ts). Every send site checks
      // lib/resend.ts and treats the sentinel as a suppressed no-op.
      // Production and local `wrangler dev` are unaffected.
      miniflare: {
        bindings: {
          RESEND_API_KEY: TEST_SUPPRESSED_RESEND_KEY,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    // Guards the whole suite: email suppression assertion + feature-flag
    // seeding (see the file header).
    setupFiles: ['test/suite-setup.ts'],
    // The @cloudflare/vitest-pool-workers pool shares a single Miniflare D1
    // instance across all test files. Running files in parallel would race
    // their applyMigrations() calls and clobber each other's fixture data.
    // Serialise file execution so each file starts from a known state.
    fileParallelism: false,
  },
});
