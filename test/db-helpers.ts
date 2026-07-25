// Shared test helpers for namecard and member tests.
//
// Reads `schema.sql` (rolled-up baseline) and every migration in `migrations/`
// against the Miniflare-emulated D1 binding, then optionally inserts fixture
// rows. Each test worker gets an ephemeral D1 isolate, so re-applying is cheap
// and tests never leak state between runs.
//
// All data here is fabricated — these helpers contain no production rows.
//
// SQL files are imported via Vite's `?raw` query so they are inlined as
// strings by the test runner (Node-side) at module-graph build time. This
// sidesteps the cwd / fs differences between Node and the Workers isolate
// (the isolate cannot reliably resolve `import.meta.url` to a real path).

import schemaRaw from '../schema.sql?raw';
import migration007 from '../migrations/007_namecards.sql?raw';
// schema.sql is the rolled-up baseline: it already contains every column added
// by migrations 001-006 (reg_role, deleted_at, membership lifecycle, PDPA, and
// the website-columns drop). Applying those migrations on top would double-add
// columns. Only migrations NOT yet rolled into schema.sql need to be applied
// here. Today that is just 007_namecards.sql (the namecard feature has not yet
// been backported into schema.sql — when it is, remove it from this list).
const ALL_SQL = [schemaRaw, migration007];

export async function applyMigrations(db: D1Database): Promise<void> {
  // Drop everything first so re-applying is safe (multiple tests in the same
  // isolate would otherwise hit "duplicate column" errors on the ALTER
  // TABLE statements that schema.sql uses to backport migration columns).
  await dropAll(db);

  // Miniflare's D1 `.exec()` splits on newlines and rejects comment-only
  // lines, which the schema files are full of. Split on `;` instead and run
  // each non-trivial statement via `.run()`. This mirrors what
  // `wrangler d1 execute --file=...` does on the CLI.
  for (const sql of ALL_SQL) {
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      await db.prepare(stmt).run();
    }
  }
}

/**
 * Drop all tables and indexes so the next applyMigrations call starts from a
 * clean slate. Cheaper than tearing down the isolate per test.
 */
async function dropAll(db: D1Database): Promise<void> {
  // sqlite_master excludes sqlite_sequence and any internal tables.
  const result = await db
    .prepare(
      `SELECT name, type FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '__cf_%'`,
    )
    .all<{ name: string; type: string }>();
  // Drop indexes first (dropping a table also drops its indexes, but explicit
  // is safer when the order is uncertain).
  for (const row of result.results.filter((r) => r.type === 'index')) {
    await db.prepare(`DROP INDEX IF EXISTS "${row.name}"`).run();
  }
  for (const row of result.results.filter((r) => r.type === 'table')) {
    await db.prepare(`DROP TABLE IF EXISTS "${row.name}"`).run();
  }
}

/**
 * Split a multi-statement SQL string into individual statements on `;`.
 * Comment-only fragments and whitespace are dropped. Inline `--` comments
 * inside a statement are tolerated (they are stripped from each fragment).
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  const lines = sql.split('\n');
  let current = '';
  for (const line of lines) {
    const trimmed = line.trim();
    // Strip full-line comments but keep newlines so inline statements stay
    // parseable.
    if (trimmed.startsWith('--')) continue;
    current += line + '\n';
    if (trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt.length > 0 && stmt !== ';') out.push(stmt.replace(/;$/, ''));
      current = '';
    }
  }
  const tail = current.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * Insert a member and return its id. Uses the same column set as
 * `seed-members.sql` so behaviour matches the local dev database.
 */
export async function seedMember(
  db: D1Database,
  overrides: Partial<{
    name: string;
    role: string;
    email: string;
    mobile: string;
    job_title: string;
    category: string;
    can_login: number;
    sort_order: number;
  }> = {},
): Promise<number> {
  const o = {
    name: 'Test Member',
    role: 'Board member',
    email: 'test@example.com',
    mobile: '+65 9123 4567',
    job_title: 'Board member',
    category: 'committee',
    can_login: 1,
    sort_order: 99,
    ...overrides,
  };
  const r = await db
    .prepare(
      `INSERT INTO members (name, role, email, mobile, job_title, category, can_login, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(o.name, o.role, o.email, o.mobile, o.job_title, o.category, o.can_login, o.sort_order)
    .run();
  return Number(r.meta.last_row_id);
}

/**
 * Insert a namecard row for a member. Defaults match the migration defaults
 * (`has_namecard = 1`, `template = 'default'`, `qr_variant = 'vcf'`).
 */
export async function seedNamecard(
  db: D1Database,
  memberId: number,
  overrides: Partial<{
    slug: string;
    has_namecard: number;
    bio: string;
    whatsapp: string;
    website: string;
    facebook: string;
    linkedin: string;
    photo_r2_key: string;
  }> = {},
): Promise<number> {
  const o = {
    slug: `member-${memberId}`,
    has_namecard: 1,
    bio: null,
    whatsapp: null,
    website: null,
    facebook: null,
    linkedin: null,
    photo_r2_key: null,
    ...overrides,
  } as Record<string, string | number | null>;
  const r = await db
    .prepare(
      `INSERT INTO namecards (member_id, slug, has_namecard, bio, whatsapp, website, facebook, linkedin, photo_r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      memberId,
      o.slug,
      o.has_namecard,
      o.bio,
      o.whatsapp,
      o.website,
      o.facebook,
      o.linkedin,
      o.photo_r2_key,
    )
    .run();
  return Number(r.meta.last_row_id);
}

/**
 * Strip SQL line comments (`--`) and blank lines. Kept for tests that want a
 * clean single-statement string; the schema/migration applier passes raw SQL
 * to D1 `.exec()` because that path supports comments natively.
 */
export function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('--');
    })
    .join('\n');
}
