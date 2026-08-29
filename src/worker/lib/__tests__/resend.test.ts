// Unit tests for the Resend test-suppression guard (lib/resend.ts).
//
// The suite itself must run with the sentinel key active — that is asserted
// fail-fast in test/suite-setup.ts and re-checked here so the guarantee is
// visible (and exercised) as a test, not just a startup crash.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { isResendSuppressed, TEST_SUPPRESSED_RESEND_KEY } from '../resend';
import type { Env } from '../../types';

function envWithKey(key: string): Env {
  return { RESEND_API_KEY: key } as unknown as Env;
}

describe('isResendSuppressed', () => {
  it('is true only for the exact sentinel key', () => {
    expect(isResendSuppressed(envWithKey(TEST_SUPPRESSED_RESEND_KEY))).toBe(true);
  });

  it('is false for real-shaped keys, empty values and near-miss sentinels', () => {
    expect(isResendSuppressed(envWithKey('re_BxqYnVm_95cCTmc4BjeGFjwRjq5ZDgFN'))).toBe(false);
    expect(isResendSuppressed(envWithKey(''))).toBe(false);
    expect(isResendSuppressed(envWithKey('TEST-SUPPRESSED'))).toBe(false);
    expect(isResendSuppressed(envWithKey('test-suppressed-do-not-send'))).toBe(false);
  });
});

describe('test-suite email guarantee', () => {
  it('the suite runs with the sentinel Resend key active (no real sends)', () => {
    expect(env.RESEND_API_KEY).toBe(TEST_SUPPRESSED_RESEND_KEY);
    // Cloudflare.Env (generated) is structurally close but not identical to
    // the hand-written worker Env — same cast the ai-comparison tests use.
    expect(isResendSuppressed(env as unknown as Env)).toBe(true);
  });
});
