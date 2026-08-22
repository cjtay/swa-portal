// Phase 3 — stored XSS defence: server-side allowlist for applicant names.
// The fullName value lands in members.name on approval and is rendered in
// admin browsers, so markup characters must be rejected at submission.

import { describe, it, expect } from 'vitest';
import { isValidFullName } from '../membership-reg';

describe('isValidFullName — allowlist', () => {
  it('accepts typical Singaporean names across scripts', () => {
    expect(isValidFullName('Angela Wong')).toBe(true);
    expect(isValidFullName("O'Brien")).toBe(true);
    expect(isValidFullName('Anne-Marie Tan')).toBe(true);
    expect(isValidFullName('Dr. S. Chandran')).toBe(true);
    expect(isValidFullName('陈美玲')).toBe(true);
    expect(isValidFullName('Siti binte Ahmad')).toBe(true);
    expect(isValidFullName('José María')).toBe(true);
  });

  it('rejects markup and injection payloads', () => {
    expect(isValidFullName('<img src=x onerror=alert(1)>')).toBe(false);
    expect(isValidFullName('Bob<script>')).toBe(false);
    expect(isValidFullName('Name "Quotes"')).toBe(false);
    expect(isValidFullName('A & B')).toBe(false);
    expect(isValidFullName('Bad\u0000Name')).toBe(false);
    expect(isValidFullName('Bad\nName')).toBe(false);
  });

  it('rejects digits and enforces the length cap', () => {
    expect(isValidFullName('R2D2')).toBe(false);
    expect(isValidFullName('A'.repeat(100))).toBe(true);
    expect(isValidFullName('A'.repeat(101))).toBe(false);
  });
});
