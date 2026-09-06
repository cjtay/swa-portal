// Unit tests for lib/notify-recipients.ts — the environment-aware email
// recipient resolver (owner request 2026-09-05).
//
// Guarantee under test: on a developer laptop (SESSION_SECRET with the
// 'local-dev-' anchor) every auto-triggered email resolves to the shared
// owner-controlled inboxes or cjtay@ — never to the real approvers in
// portal.ts. On staging/production (any other secret) the real lists pass
// through unchanged.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  isLocalMailEnvironment,
  resolvePurchaseApproverRecipients,
  resolveFinanceApproverRecipients,
  resolvePurchaseStageRecipients,
  resolveFormNotifyRecipients,
  LOCAL_APPROVAL_RECIPIENT,
  LOCAL_FINANCE_RECIPIENT,
  LOCAL_FORM_NOTIFY_RECIPIENT,
} from '../notify-recipients';
import type { Env } from '../../types';

const REAL_SECRET = 'a-high-entropy-production-secret-value';
const LOCAL_SECRET = 'local-dev-session-secret-change-me';

const FORM_DEFAULTS = [
  'jolene.lim@singaporewomenassociation.org',
  'angela.wong@singaporewomenassociation.org',
];

function envWith(sessionSecret: string | undefined, override?: string): Env {
  return {
    SESSION_SECRET: sessionSecret,
    NOTIFY_RECIPIENTS_OVERRIDE: override,
  } as unknown as Env;
}

describe('isLocalMailEnvironment', () => {
  it('is true only for the local-dev secret anchor', () => {
    expect(isLocalMailEnvironment(envWith(LOCAL_SECRET))).toBe(true);
    expect(isLocalMailEnvironment(envWith(REAL_SECRET))).toBe(false);
    expect(isLocalMailEnvironment(envWith(undefined))).toBe(false);
    expect(isLocalMailEnvironment(envWith(''))).toBe(false);
  });
});

describe('resolvePurchaseApproverRecipients', () => {
  it('locally: approval@ inbox, never the real approvers', () => {
    const recipients = resolvePurchaseApproverRecipients(envWith(LOCAL_SECRET));
    expect(recipients).toEqual([LOCAL_APPROVAL_RECIPIENT]);
    expect(recipients.join(',')).not.toContain('roxanne');
    expect(recipients.join(',')).not.toContain('angela');
  });

  it('locally: NOTIFY_RECIPIENTS_OVERRIDE wins when set', () => {
    const recipients = resolvePurchaseApproverRecipients(
      envWith(LOCAL_SECRET, ' CJTay@Example.com , second@example.com '),
    );
    expect(recipients).toEqual(['cjtay@example.com', 'second@example.com']);
  });

  it('deployed (real secret): the real portal.ts list passes through', () => {
    const recipients = resolvePurchaseApproverRecipients(envWith(REAL_SECRET));
    expect(recipients).toContain('roxanne.zhang@singaporewomenassociation.org');
    expect(recipients).toContain('angela.wong@singaporewomenassociation.org');
    expect(recipients).toContain('approval@singaporewomenassociation.org');
  });

  it('deployed: the override is deliberately ignored', () => {
    const recipients = resolvePurchaseApproverRecipients(
      envWith(REAL_SECRET, 'someone-else@example.com'),
    );
    expect(recipients).not.toContain('someone-else@example.com');
  });
});

describe('resolveFinanceApproverRecipients', () => {
  it('locally: finance@ inbox, never the real approvers', () => {
    const recipients = resolveFinanceApproverRecipients(envWith(LOCAL_SECRET));
    expect(recipients).toEqual([LOCAL_FINANCE_RECIPIENT]);
    expect(recipients.join(',')).not.toContain('joyce.yeo');
    expect(recipients.join(',')).not.toContain('wong.ys');
  });

  it('deployed (real secret): the real portal.ts list passes through', () => {
    const recipients = resolveFinanceApproverRecipients(envWith(REAL_SECRET));
    expect(recipients).toContain('wong.ys@singaporewomenassociation.org');
    expect(recipients).toContain('joyce.yeo@singaporewomenassociation.org');
    expect(recipients).toContain('finance@singaporewomenassociation.org');
  });
});

describe('resolvePurchaseStageRecipients', () => {
  it('under S$1,000 (deployed): purchase approvers plus the finance approvers, no duplicates', () => {
    const recipients = resolvePurchaseStageRecipients(envWith(REAL_SECRET), 999);
    expect(recipients).toContain('roxanne.zhang@singaporewomenassociation.org');
    expect(recipients).toContain('angela.wong@singaporewomenassociation.org');
    expect(recipients).toContain('wong.ys@singaporewomenassociation.org');
    expect(recipients).toContain('joyce.yeo@singaporewomenassociation.org');
    // The purchase list may already overlap the finance list (shared inboxes);
    // each address must appear exactly once.
    expect(new Set(recipients).size).toBe(recipients.length);
  });

  it('at S$1,000 or above (deployed): purchase approvers only', () => {
    const atThreshold = resolvePurchaseStageRecipients(envWith(REAL_SECRET), 1000);
    expect(atThreshold).toContain('roxanne.zhang@singaporewomenassociation.org');
    expect(atThreshold).not.toContain('wong.ys@singaporewomenassociation.org');

    const above = resolvePurchaseStageRecipients(envWith(REAL_SECRET), 2500);
    expect(above).not.toContain('joyce.yeo@singaporewomenassociation.org');
  });

  it('a null amount fails closed: purchase approvers only', () => {
    const recipients = resolvePurchaseStageRecipients(envWith(REAL_SECRET), null);
    expect(recipients).toContain('angela.wong@singaporewomenassociation.org');
    expect(recipients).not.toContain('wong.ys@singaporewomenassociation.org');
  });

  it('locally: both lists collapse to the shared inboxes', () => {
    const recipients = resolvePurchaseStageRecipients(envWith(LOCAL_SECRET), 999);
    expect(recipients).toEqual([LOCAL_APPROVAL_RECIPIENT, LOCAL_FINANCE_RECIPIENT]);
  });

  it('locally: the override wins and is de-duplicated across both resolvers', () => {
    const recipients = resolvePurchaseStageRecipients(envWith(LOCAL_SECRET, ' test@example.com '), 999);
    expect(recipients).toEqual(['test@example.com']);
  });
});

describe('resolveFormNotifyRecipients', () => {
  it('locally: cjtay@ inbox, never the real notify list', () => {
    const recipients = resolveFormNotifyRecipients(envWith(LOCAL_SECRET), FORM_DEFAULTS);
    expect(recipients).toEqual([LOCAL_FORM_NOTIFY_RECIPIENT]);
    expect(recipients.join(',')).not.toContain('jolene');
    expect(recipients.join(',')).not.toContain('angela');
  });

  it('deployed (real secret): the passed-in defaults pass through', () => {
    expect(resolveFormNotifyRecipients(envWith(REAL_SECRET), FORM_DEFAULTS)).toEqual(FORM_DEFAULTS);
  });
});

describe('test-suite local guarantee', () => {
  it('the suite runs with the local-dev anchor, so tests resolve to safe inboxes', () => {
    // vitest loads .dev.vars, whose SESSION_SECRET carries the local-dev
    // prefix (asserted in test/suite-setup.ts for the Resend sentinel; this
    // is the recipient-side counterpart).
    expect(isLocalMailEnvironment(env as unknown as Env)).toBe(true);
    expect(resolvePurchaseApproverRecipients(env as unknown as Env)).toEqual([
      LOCAL_APPROVAL_RECIPIENT,
    ]);
    expect(resolveFinanceApproverRecipients(env as unknown as Env)).toEqual([
      LOCAL_FINANCE_RECIPIENT,
    ]);
  });
});
