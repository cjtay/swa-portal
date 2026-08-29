// Resend transport guard.
//
// The vitest suite binds RESEND_API_KEY to the sentinel below (see
// vitest.config.ts), so `npm run test:run` can never email a real mailbox —
// approval reminders and notification emails were landing in the owner's
// inbox on every verification run (owner request 2026-08-29).
//
// Real Resend keys look like `re_...`; the sentinel can never authenticate.
// Every send site checks isResendSuppressed() before the fetch and treats a
// suppressed send as success (the surrounding handler logic — audit rows,
// OTP storage, API responses — proceeds unchanged). Suppression logs one
// console line so it is visible in `wrangler tail` if the sentinel ever
// appears outside a test run.
//
// Local `wrangler dev` is unaffected: .dev.vars keeps the real key, so
// manual email flows (OTP login, reminders) can still be tested by hand.

import type { Env } from '../types';

export const TEST_SUPPRESSED_RESEND_KEY = 'TEST-SUPPRESSED-DO-NOT-SEND';

export function isResendSuppressed(env: Env): boolean {
  return env.RESEND_API_KEY === TEST_SUPPRESSED_RESEND_KEY;
}
