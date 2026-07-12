#!/usr/bin/env node
// Local dev database setup helper.
//
// Rebuilds the LOCAL wrangler D1 emulator from schema.sql + dummy seed files.
// LOCAL ONLY — every command uses --local and never touches production data.
//
// Usage:
//   npm run db:setup   wipe local D1, apply schema, apply all dummy seed files
//   npm run db:seed    re-apply dummy seed files only (no wipe, no schema)
//
// The seed files contain only fabricated dummy data (see seed-members.sql,
// seed-membership.sql). No production data is copied or read.

import { execSync } from 'node:child_process';
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DB = 'swa-portal';
const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const seedOnly = process.argv.includes('--seed-only');

function run(label, cmd) {
  console.log(`\n--- ${label} ---`);
  execSync(cmd, { stdio: 'inherit' });
}

function wipeLocal() {
  console.log('\n--- Wiping local D1 emulator state ---');
  if (!existsSync(D1_DIR)) {
    console.log('(no local D1 state found yet — nothing to wipe)');
    return;
  }
  let removed = 0;
  for (const f of readdirSync(D1_DIR)) {
    // Preserve miniflare's internal metadata.sqlite; only delete the data DB
    // and its WAL/SHM sidecar files.
    if (f.startsWith('metadata')) continue;
    if (f.endsWith('.sqlite') || f.endsWith('.sqlite-shm') || f.endsWith('.sqlite-wal')) {
      rmSync(join(D1_DIR, f));
      console.log(`deleted ${f}`);
      removed++;
    }
  }
  if (removed === 0) console.log('(data DB not present — nothing to wipe)');
}

const seedFiles = [
  'seed-members.sql',
  'seed-membership.sql',
  'scripts/seed-test-data.sql',
];

if (!seedOnly) {
  wipeLocal();
  run(
    'Applying schema.sql (full structure, every table)',
    `npx wrangler d1 execute ${DB} --local --file=schema.sql`,
  );
}

for (const f of seedFiles) {
  run(`Applying ${f} (dummy data)`, `npx wrangler d1 execute ${DB} --local --file=${f}`);
}

console.log(
  seedOnly
    ? '\nDone. Dummy seed data re-applied to the local database.\n'
    : '\nDone. Local database rebuilt with dummy data.\n         Start the dev server: npm run dev:worker\n',
);
