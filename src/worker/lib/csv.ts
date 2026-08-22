// Shared CSV cell escaping for all export endpoints.
//
// Besides RFC-4180 quoting, neutralises spreadsheet formula injection: cells
// starting with `=`, `+`, `-`, `@` (or tab/CR) are interpreted as formulas by
// Excel/Google Sheets, so attacker-controlled form values could execute code
// when an admin opens an export. Prefixing a single quote forces the cell to
// be treated as text (security-remediation-plan Phase 4c).

export function csvEscape(val: unknown): string {
  let s = val === null || val === undefined ? '' : String(val);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
