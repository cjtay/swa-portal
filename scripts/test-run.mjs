#!/usr/bin/env node
// Watchdog wrapper for `vitest run` (npm run test:run).
//
// WHY THIS EXISTS: @cloudflare/vitest-pool-workers occasionally deadlocks in
// teardown — the tests finish and print their results, but vitest and its
// workerd child then block forever waiting on each other (verified with
// process stack samples on 2026-08-23; the 0.18.8 -> 0.22.0 upgrade fixed
// the observed hangs, this wrapper is insurance). The wrapper forwards all
// output live, and kills the whole process group when:
//   - no output for SWA_TEST_SILENCE_MS (default 90,000 ms), or
//   - the run exceeds SWA_TEST_MAX_MS (default 600,000 ms).
// A watchdog kill exits with code 75 — results printed above are still
// valid to read; the hang was only in cleanup.

import { spawn } from 'node:child_process';

const SILENCE_MS = Number(process.env.SWA_TEST_SILENCE_MS || 90_000);
const MAX_MS = Number(process.env.SWA_TEST_MAX_MS || 600_000);

const args = process.argv.slice(2);
const child = spawn('npx', ['vitest', 'run', ...args], {
  stdio: ['inherit', 'pipe', 'pipe'],
  detached: true, // own process group so the kill reaches workerd too
});

let lastOutput = Date.now();
let killed = false;

function forward(stream, out) {
  stream.on('data', (chunk) => {
    lastOutput = Date.now();
    out.write(chunk);
  });
}
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

const silenceTimer = setInterval(() => {
  if (killed) return;
  if (Date.now() - lastOutput > SILENCE_MS) {
    killTree(
      `vitest produced no output for ${Math.round(SILENCE_MS / 1000)}s ` +
        `(tests likely finished; pool-workers teardown hang). Killing the process tree.`,
    );
  }
}, 5_000);
silenceTimer.unref();

const maxTimer = setTimeout(() => {
  if (!killed) killTree(`vitest exceeded ${Math.round(MAX_MS / 60000)} minutes. Killing the process tree.`);
}, MAX_MS);
maxTimer.unref();

function killTree(reason) {
  killed = true;
  clearInterval(silenceTimer);
  clearTimeout(maxTimer);
  console.error(`\n[test-run watchdog] ${reason}`);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

child.on('exit', (code, signal) => {
  clearInterval(silenceTimer);
  clearTimeout(maxTimer);
  if (killed || signal) {
    process.exit(75);
  }
  process.exit(code ?? 1);
});
