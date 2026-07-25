import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

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
    }),
  ],
  test: {
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    // The @cloudflare/vitest-pool-workers pool shares a single Miniflare D1
    // instance across all test files. Running files in parallel would race
    // their applyMigrations() calls and clobber each other's fixture data.
    // Serialise file execution so each file starts from a known state.
    fileParallelism: false,
  },
});
