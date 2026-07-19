#!/usr/bin/env node
// Local dev helper: clears membership intake test data.
//
// Deletes, in FK-safe order:
//   1. membership_payments rows belonging to members created via approval
//   2. members rows created by approving an application (via member_id link)
//   3. membership_applications rows (the list at /admin/forms/membership)
//
// Manually created / seed members are NOT touched. Local R2 signature and
// PayNow images become orphans — harmless; use `npm run db:setup` for a full
// local rebuild.
//
// LOCAL ONLY — every command hardcodes --local and the script aborts if
// --remote is passed. There is no code path that touches production.
//
// Usage:
//   npm run db:clear:membership

import { execSync } from 'node:child_process';

const DB = 'swa-portal';

// Hard guard: refuse to run if anyone passes --remote. All wrangler commands
// below carry --local explicitly, so this should be impossible to trip — it
// exists as a second line of defence against accidental prod access.
if (process.argv.some((a) => a === '--remote' || a.startsWith('--remote-'))) {
  console.error('Refusing to run: --remote is not allowed. This script is local-only.');
  process.exit(1);
}

function run(label, cmd) {
  console.log(`\n--- ${label} ---`);
  execSync(cmd, { stdio: 'inherit' });
}

const wr = (sql) => `npx wrangler d1 execute ${DB} --local --command "${sql}"`;

run(
  'Counts BEFORE clear',
  wr('SELECT (SELECT COUNT(*) FROM membership_applications) AS applications, ' +
     '(SELECT COUNT(*) FROM members WHERE id IN (SELECT member_id FROM membership_applications WHERE member_id IS NOT NULL)) AS approved_members, ' +
     '(SELECT COUNT(*) FROM membership_payments WHERE member_id IN (SELECT member_id FROM membership_applications WHERE member_id IS NOT NULL)) AS their_payments'),
);

// Order matters: the member_id link on membership_applications must be read
// before the application rows are deleted.
run(
  '1/3 Deleting payment rows of approved members',
  wr('DELETE FROM membership_payments WHERE member_id IN (SELECT member_id FROM membership_applications WHERE member_id IS NOT NULL)'),
);
run(
  '2/3 Deleting members created via approval',
  wr('DELETE FROM members WHERE id IN (SELECT member_id FROM membership_applications WHERE member_id IS NOT NULL)'),
);
run(
  '3/3 Deleting membership applications',
  wr('DELETE FROM membership_applications'),
);

run(
  'Counts AFTER clear',
  wr('SELECT COUNT(*) AS applications FROM membership_applications'),
);

console.log('\nDone. Local membership intake data cleared. Start testing: npm run dev:worker\n');
