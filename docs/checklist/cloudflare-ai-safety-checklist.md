# Cloudflare Worker + GitHub Safety Checklist
## Protecting D1, R2, KV and Your Code Repository from AI Agent Damage

This checklist covers all safety measures when using AI coding agents (Claude Code, OpenCode) to build Cloudflare Worker applications with Hono, D1, R2, and KV bindings, and to push code via GitHub.

Measures are ordered from simplest to most involved. Each one is independent — implement as many as your situation requires.

---

## How to Use This Document

This document is designed to be **dropped into any Cloudflare Workers project folder** and used as a self-auditing checklist.

**For human users:** Read through each level and implement what applies to your project.

**For AI coding agents:** When asked to audit this project against this checklist:

1. Read this entire document
2. For each measure, run the verification command(s) listed in the "How to Verify" column
3. Report each measure as: ✅ Verified | ⬜ Not implemented | ➖ Not applicable | ❓ Cannot verify (manual habit/GitHub setting)
4. For measures marked ⬜, assess whether they should be implemented now or deferred (see Risk Assessment section)
5. Skip measures that are not relevant to this project (see "Relevance" criteria for each level)

**Relevance filter — skip the entire document if:**
- This is not a Cloudflare Workers project (no `wrangler.jsonc` or `wrangler.toml`)
- This project does not use AI coding agents

**Partial relevance — skip specific sections:**
- No D1 database? → Skip D1-related preview bindings and D1 runtime wrapper
- No R2 bucket? → Skip R2-related preview bindings and R2 runtime wrapper
- No KV namespace? → Skip KV-related preview bindings and KV runtime wrapper
- No Hono/Worker runtime? → Skip Level 5 (runtime wrappers)

---

## Self-Auditing Checklist

Run these checks and fill in the status for YOUR project. The "How to Verify" column contains commands an AI agent can execute.

| # | Measure | How to Verify | Relevance | Status |
|---|---------|---------------|-----------|--------|
| 1.1 | Wrangler logout | `npx wrangler whoami` — should return "not authenticated" | All projects | _audit_ |
| 1.2 | Login-deploy-logout habit | Cannot verify — this is a manual habit | All projects | _audit_ |
| 1.3 | No hardcoded API tokens | `grep -r "CLOUDFLARE_API_TOKEN" . --include="*.toml" --include="*.env"` should return nothing | All projects | _audit_ |
| 2 | Shell guards | `ls -la ~/.shell-guards.sh` exists AND `grep -c "shell-guards" ~/.zshrc ~/.bashrc 2>/dev/null` returns > 0 | macOS/Linux | _audit_ |
| 3 | Preview bindings | Check `wrangler.jsonc` (or `wrangler.toml`) for `preview_database_id`, `preview_bucket_name`, `preview_id` keys | Projects with D1, R2, or KV | _audit_ |
| 4 | Code review habit | Cannot verify — this is a manual habit | All projects | _audit_ |
| 5 | Runtime wrappers | Check if a safe-bindings file exists (e.g. `src/bindings.ts`, `src/worker/lib/bindings.ts`) that wraps `env.DB`/`env.R2_BUCKET`/`env.KV` with delete-blocking | Hono/Worker projects | _audit_ |
| G1 | Branch protection | Cannot verify from terminal — check GitHub repo Settings > Branches | All projects on GitHub | _audit_ |
| G2 | Manual git push / deploy | Cannot verify — this is a manual habit | All projects | _audit_ |
| G3 | Fine-grained PAT | Cannot verify — check GitHub account settings | All projects on GitHub | _audit_ |
| G4 | Git shell guard | Included in `~/.shell-guards.sh` — if Level 2 is implemented, this is too | macOS/Linux | _audit_ |

---

## Level 1 - Immediate Actions (No Coding Required)

These take under 5 minutes and can be done right now.

### 1.1 Log Out of Wrangler on Every Device

Run this on every machine where you use AI coding agents:

```bash
wrangler logout
```

If you get `zsh: command not found: wrangler`, Wrangler is installed locally inside your project rather than globally. Use `npx` instead:

```bash
npx wrangler logout
```

Or if your project uses `pnpm`:

```bash
pnpm wrangler logout
```

- Must be done per device — it is not account-wide
- The AI can no longer deploy, execute D1 queries, delete data, or touch backups from the terminal
- Not sure if you are logged in? Run `npx wrangler whoami` — if it shows your email, you are still logged in

### 1.2 Login-Deploy-Logout Habit

When you need to deploy or run Wrangler commands, follow this sequence yourself — never ask the AI to do it.

If Wrangler is installed globally:

```bash
wrangler login        # log in (opens browser)
wrangler deploy       # or whatever command you need
wrangler logout       # log out immediately after
```

If Wrangler is only installed locally in the project (use `npx`):

```bash
npx wrangler login
npx wrangler deploy
npx wrangler logout
```

To check which applies on your machine, run `which wrangler`. If it returns nothing, use the `npx` version.

### 1.3 Check for Hardcoded API Tokens

A hardcoded token bypasses `wrangler logout` entirely. Check your project:

```bash
grep -r "CLOUDFLARE_API_TOKEN" . --include="*.toml" --include="*.env"
```

If found, remove it from the file and revoke it in the Cloudflare dashboard under My Profile > API Tokens.

---

## Level 2 - Shell Guard (5 Minutes, Terminal Config)

Blocks destructive Wrangler and git commands even if you are logged in. Implemented as a single project-agnostic file `~/.shell-guards.sh` sourced from `.zshrc`.

### How It Works

Shell functions in `.zshrc` intercept commands you type in your **interactive terminal**. When a command matches a destructive pattern (DELETE, DROP, TRUNCATE, force push, etc.), it prints a block message and refuses to run. To bypass the guard when you genuinely need to, prefix with `command`:

```bash
# Blocked — prints error, refuses to run
npx wrangler d1 execute <your-db> --remote --command="DELETE FROM gtw_tickets;"

# Allowed — `command` keyword bypasses the shell function
command npx wrangler d1 execute <your-db> --remote --command="DELETE FROM gtw_tickets;"

# Allowed — git force push bypass
command git push --force origin main
```

### Why Scripts Are Not Affected

Scripts that call wrangler via Node.js `execSync()` spawn a **non-interactive shell**. Shell functions from `.zshrc` are never loaded in non-interactive shells, so these commands continue to work without any prefix:

```bash
npx tsx scripts/seed-database.ts --clean        # still works
npx tsx scripts/seed-database.ts --clean-only    # still works
bash scripts/r2-purge.sh                          # still works (bash subprocess)
npx tsx scripts/seed-tie-test.ts --clean --count=30  # still works
```

This is intentional — these are controlled scripts with known destructive operations that you choose to run.

### Implementation

The file `~/.shell-guards.sh` contains all guard functions. It is sourced from `.zshrc`:

```bash
# In ~/.zshrc
source ~/.shell-guards.sh
```

The file is **project-agnostic** — it works across all Cloudflare Workers projects on your machine. The wrangler blocklist only triggers when the `wrangler` subcommand contains destructive keywords. On non-Cloudflare projects, `wrangler` simply won't be installed and these functions are harmless (they pass through to `command wrangler` which doesn't exist).

Pattern matching is **case-insensitive** (using zsh `${(L)*}` lowercase conversion). This catches `DELETE`, `delete`, `Delete` and any other casing, since SQL keywords are conventionally uppercase but may appear in any case on the command line.

### What Gets Blocked vs. What Works

| Command | Blocked? | Why |
|---|---|---|
| `npx tsx scripts/seed-database.ts --clean` | No | `tsx` is first arg, not `wrangler` |
| `npx tsx scripts/seed-database.ts --clean-only` | No | Same reason |
| `bash scripts/r2-purge.sh` | No | bash subprocess, no zsh functions |
| `npx wrangler deploy` | No | no destructive keyword |
| `npx wrangler dev` | No | no destructive keyword |
| `npx wrangler d1 execute ... --file=cleanup.sql` | No | SQL file name doesn't match `*delete*` |
| `npx wrangler d1 execute ... --command="DELETE ..."` | **Yes** | `*delete*` matches |
| `wrangler r2 object delete ...` | **Yes** | `*delete*` matches |
| `wrangler kv key delete ...` | **Yes** | `*delete*` matches |
| `wrangler d1 time-travel restore ...` | **Yes** | `*time-travel restore*` matches |
| `git push origin main` | No | normal push |
| `git push --force origin main` | **Yes** | `*--force*` matches |
| `git push --delete origin branch` | **Yes** | `*--delete*` matches |
| `git branch -D branch` | **Yes** | `*-D*` matches |
| `command npx wrangler d1 execute ... --command="DELETE ..."` | No | `command` bypasses function |
| `command git push --force origin main` | No | `command` bypasses function |

### Package Manager Coverage

The guard intercepts wrangler commands regardless of which package manager runs them:

| Package Manager | Intercepted? | Example |
|---|---|---|
| `npx wrangler` | Yes | Most common on macOS |
| `pnpm dlx wrangler` | Yes | If project uses pnpm |
| `bunx wrangler` | Yes | If project uses bun |
| `wrangler` (global) | Yes | If installed globally |

---

## Level 3 - Preview Bindings (10 Minutes, Config File)

**This is project-specific** — each Cloudflare Workers project has its own `wrangler.jsonc` (or `wrangler.toml`) with its own D1 databases, R2 buckets, and KV namespaces.

When running `wrangler dev` locally, all bindings point to a separate dev database — never the production one. The AI can run any code it wants locally and your real data is untouched.

### Relevance

- No D1 database in `wrangler.jsonc`? → Skip D1 preview binding
- No R2 bucket in `wrangler.jsonc`? → Skip R2 preview binding
- No KV namespace in `wrangler.jsonc`? → Skip KV preview binding

### How Preview Bindings Work

Think of it as **two sets of keys** — one for your real house, one for a test house.

| When you run... | Which bindings are used |
|---|---|
| `wrangler dev` (local) | Preview IDs — dev resources |
| `wrangler deploy` (production) | Production IDs — real resources |

No code changes needed. Your Hono handlers reference `c.env.DB`, `c.env.R2_BUCKET`, `c.env.GTW_CONFIG` — Cloudflare resolves them to whichever binding the runtime provides.

The AI can `SELECT`, `INSERT`, even `DELETE` all day long locally — it only touches the dev database. Your production data is never reachable from local dev.

### Configuration in `wrangler.jsonc`

Add preview keys to the existing binding blocks. Note: Cloudflare's config key names are inconsistent across binding types — these are the official key names:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "your-db-prod",
    "database_id": "your-prod-uuid",
    "preview_database_id": "your-dev-uuid"          // ADD THIS — note: underscores
  }
],
"r2_buckets": [
  {
    "binding": "R2_BUCKET",
    "bucket_name": "your-bucket-prod",
    "preview_bucket_name": "your-bucket-dev"         // ADD THIS — note: different naming convention
  }
],
"kv_namespaces": [
  {
    "binding": "YOUR_KV",
    "id": "your-prod-kv-id",
    "preview_id": "your-dev-kv-id"                   // ADD THIS — note: just preview_id
  }
]
```

### Implementation Steps

**Step 1 — Create dev D1 database**
```bash
npx wrangler d1 create <your-db>-dev
```
Copy the `database_id` from the output.

**Step 2 — Create dev R2 bucket**
```bash
npx wrangler r2 bucket create <your-bucket>-dev
```
R2 uses bucket names, not IDs. The name itself goes in the config.

**Step 3 — Create dev KV namespace**
```bash
npx wrangler kv namespace create <YOUR_KV>_DEV
```
Copy the `id` from the output.

**Step 4 — Update `wrangler.jsonc`**

Add the preview keys from Steps 1–3 to the existing binding blocks (see Configuration section above).

**Step 5 — Seed dev KV with initial values**

> **Example (project-specific):** Replace the KV keys below with your project's config keys.

```bash
npx wrangler kv key put --remote --binding=<YOUR_KV>_DEV "gtw:event_year" "2026"
npx wrangler kv key put --remote --binding=<YOUR_KV>_DEV "gtw:prize_count" "10"
npx wrangler kv key put --remote --binding=<YOUR_KV>_DEV "gtw:draw_open" "true"
npx wrangler kv key put --remote --binding=<YOUR_KV>_DEV "gtw:draw_complete" "false"
```

**Step 6 — Apply schema to dev database**
```bash
npx wrangler d1 execute <your-db>-dev --remote --file=./schema.sql
```

**Step 7 — Verify**
```bash
npm run build
npx wrangler dev
```
Test an API endpoint locally — it should hit the dev database, not production.

**Step 8 — Update seed scripts for `--database` flag (if applicable)**

> **Example (project-specific):** If your project has seed scripts that hardcode a production database name, add a `--database` flag.

```bash
npx tsx scripts/seed-database.ts --clean --database=<your-db>-dev
```

This requires a small change to `scripts/seed-database.ts` to accept a `--database` parameter and use it in the `wrangler d1 execute` commands instead of the hardcoded database name.

**Step 9 — Keep dev schema in sync**

After any schema change in `schema.sql`, re-run:
```bash
npx wrangler d1 execute <your-db>-dev --remote --file=./schema.sql
```

---

## Level 4 - Code Review Before Every Deploy (Habit)

AI-written code can contain SQL deletes even if the AI cannot deploy autonomously. Before running `wrangler deploy`, scan changed files:

```bash
git diff --staged
```

You are specifically looking for these patterns in any `.ts` or `.js` file:

```
DELETE FROM
DROP TABLE
TRUNCATE
DROP DATABASE
```

If you see any of these and did not explicitly ask for a delete function, question it before deploying.

---

## Level 5 - Runtime Wrappers (Strongest Protection, ~1 Hour)

This is the hard stop. The AI never receives raw access to D1, R2, or KV. Delete operations are physically removed from the objects the AI works with.

### Relevance

- No D1? → Skip D1 wrapper
- No R2? → Skip R2 wrapper
- No KV? → Skip KV wrapper (or implement selectively — see Risk Assessment below)
- Not a Hono/Worker project? → Skip this entire level

### How It Works

Create a file `src/bindings.ts` (or `src/worker/lib/bindings.ts` — wherever your project keeps utilities). You write this once, the AI always imports from it:

```typescript
// src/bindings.ts — Safe binding wrappers

import type { Env } from './index'; // your Env type

// Safe D1 — blocks DELETE, DROP, TRUNCATE at runtime
export function getDB(env: Env) {
  const forbidden = /^\s*(DELETE|DROP|TRUNCATE|ALTER\s+TABLE.*DROP)/i;
  return {
    prepare: (query: string) => {
      if (forbidden.test(query)) {
        throw new Error(`Blocked query: ${query.slice(0, 80)}`);
      }
      return env.DB.prepare(query);
    },
    batch: env.DB.batch.bind(env.DB),
    dump: env.DB.dump.bind(env.DB),
    exec: (query: string) => {
      if (forbidden.test(query)) {
        throw new Error(`Blocked query: ${query.slice(0, 80)}`);
      }
      return env.DB.exec(query);
    },
  };
}

// Safe R2 — delete method does not exist
export function getR2(env: Env) {
  return {
    get: env.R2_BUCKET.get.bind(env.R2_BUCKET),
    put: env.R2_BUCKET.put.bind(env.R2_BUCKET),
    list: env.R2_BUCKET.list.bind(env.R2_BUCKET),
    head: env.R2_BUCKET.head.bind(env.R2_BUCKET),
    // delete is intentionally omitted
  };
}

// Safe KV — delete method does not exist
// ⚠️ WARNING: If your project uses intentional KV deletes (OTP cleanup,
// clearing config keys, etc.), you CANNOT use this wrapper as-is.
// See Risk Assessment section for alternatives.
export function getKV(env: Env) {
  return {
    get: env.GTW_CONFIG.get.bind(env.GTW_CONFIG),
    getWithMetadata: env.GTW_CONFIG.getWithMetadata.bind(env.GTW_CONFIG),
    put: env.GTW_CONFIG.put.bind(env.GTW_CONFIG),
    list: env.GTW_CONFIG.list.bind(env.GTW_CONFIG),
    // delete is intentionally omitted
  };
}
```

In your Hono entry point (`src/index.ts` or `src/worker/index.ts`) — you write this scaffolding:

```typescript
import { getDB, getR2, getKV } from './bindings';

app.use('*', async (c, next) => {
  c.set('db', getDB(c.env));
  c.set('r2', getR2(c.env));
  c.set('kv', getKV(c.env));
  await next();
});
```

AI-generated route handlers only ever call `c.get('db')`, `c.get('r2')`, `c.get('kv')`. They never receive `c.env.DB` directly.

**What this catches:** DELETE SQL in deployed production code, even if it slips past code review.

### Migration Approaches

Two ways to adopt runtime wrappers:

| Approach | Effort | Trade-off |
|----------|--------|-----------|
| **A) Safe wrappers only** | ~30 min | Add `bindings.ts` + middleware. New handlers use `c.get('db')`. Existing handlers can migrate gradually. |
| **B) Safe wrappers + migrate all handlers** | ~1–2 hours | Same protection, but requires changing every handler from `c.env.DB` → `c.get('db')`. Cleaner codebase. |

Both approaches work. Option A is fine even without migrating — the middleware can set both `c.env.DB` (original, still accessible) and `c.get('db')` (safe version) so there's no breakage during transition.

---

## Risk Assessment — Can You Defer Preview Bindings and Runtime Wrappers?

Both measures are valuable but can be safely deferred in most projects. Here's why:

### Preview Bindings — Risk of Deferring

| Risk scenario | How likely? | Already mitigated by |
|---|---|---|
| Running `wrangler dev` while logged in hits production data | Low — you'd have to be logged in AND running local dev | Wrangler logout (no auth token), shell guard (blocks destructive CLI) |
| AI agent modifies production data during local dev | Very low — the AI doesn't run `wrangler dev` on its own | Wrangler logout, AGENTS.md restrictions |

**Verdict:** Low risk to defer. The primary protection is wrangler logout — if you're not authenticated, `wrangler dev` can't reach production regardless of which bindings point where. Shell guards provide a second layer. Preview bindings are a third layer (defense in depth).

**Recommendation:** Implement before going live or when you start doing frequent local development. 10 minutes of config work.

### Runtime Wrappers — Risk of Deferring

| Risk scenario | How likely? | Already mitigated by |
|---|---|---|
| Bug in deployed code executes SQL DELETE | Low — requires bug to pass code review AND reach production | Code review habit, branch protection |
| AI-generated code introduces destructive SQL | Low — AI follows AGENTS.md restrictions | AGENTS.md, code review |

**Important caveat for KV/R2 wrappers:** Your project may use **intentional KV deletes** and **intentional R2 operations** that a blanket wrapper would block. For example:

> **Example (GTW project):** This project has three intentional `env.GTW_CONFIG.delete()` calls:
> - `verify-otp.ts` — deletes OTP key after successful login
> - `clear-winning-contestant.ts` — deletes winner KV keys (3 deletes)
> - `register-volunteer.ts` — deletes a volunteer's `tables` field from the KV JSON array
>
> A blanket KV wrapper that removes `.delete()` would **break these handlers at runtime**.

**Verdict:** Low risk to defer. D1 runtime wrappers (blocking SQL DELETE/DROP/TRUNCATE) are safe and straightforward. KV and R2 wrappers need careful design — either whitelist intentional deletes or keep using `c.env.GTW_CONFIG` directly for trusted handlers.

**Recommendation:**

| Wrapper | Difficulty | Recommendation |
|---------|-----------|----------------|
| D1 (block SQL DELETE/DROP/TRUNCATE) | Easy — no intentional SQL deletes exist | Implement before going live |
| R2 (remove .delete) | Easy — if your project doesn't delete R2 objects | Implement before going live |
| KV (remove .delete) | **Tricky** — if your project has intentional KV deletes | Implement carefully with a whitelist or skip |

### Overall: 6 out of 8 measures is well above average

Most Cloudflare Workers projects have **zero** of these protections. If you have wrangler logout, shell guards, code review, and branch protection, you are well-protected. Preview bindings and runtime wrappers add defense-in-depth but are not urgent if the other layers are in place.

---

## D1 Time Travel and Backups

| Attack Surface | Can AI Reach It? | How |
|---|---|---|
| Time Travel (restore) | Only via terminal | Blocked by wrangler logout + shell guard |
| D1 backup delete | Only via terminal | Blocked by wrangler logout + shell guard |
| Worker code (env.DB) | No | Time Travel has no binding-level API |
| Live database rows | Yes, via SQL | Blocked by runtime wrapper (when implemented) |

D1 Time Travel is always on. It requires no setup and costs nothing. It covers the last 30 days (Paid plan) or 7 days (Free plan). This is your recovery net if anything does go wrong.

---

## GitHub Repository Protection

### What an AI Agent Can and Cannot Do With Your Current SSH Key

| Action | Possible via SSH? | Notes |
|---|---|---|
| Push code to a branch | Yes | Normal workflow |
| Force push and overwrite history | Yes | Dangerous — silently destroys commits |
| Delete a branch on GitHub | Yes | `git push origin --delete branch-name` |
| Delete the entire repository | No | Requires GitHub web UI or special API token |

The entire repository cannot be deleted from the terminal — that requires manual action in the browser. However, branch deletion and force pushes are possible and are the real risks.

---

### G1 - Enable Branch Protection on Main (2 Minutes, Do This Now)

This is the single most important GitHub action. It is enforced server-side by GitHub — no terminal command or SSH key can bypass it.

1. Go to your GitHub repository
2. Settings → Branches → Add branch protection rule
3. Branch name pattern: `main`
4. Turn on **Require a pull request before merging**
5. Turn on **Do not allow bypassing the above settings**
6. Save

**What this blocks:**
- `git push --force origin main` — rejected by GitHub
- `git push origin --delete main` — rejected by GitHub
- Any direct push to `main` without a pull request

**What still works normally:**
- AI can push to feature branches freely
- You merge to `main` yourself via pull request

---

### G2 - Stop Asking AI to Run git push and wrangler deploy

These are the two commands that touch external systems. Both take under 10 seconds to run yourself.

Let the AI write and edit all the code. You run:

```bash
git add .
git commit -m "describe what changed"
git push
npx wrangler deploy
```

This is the clean division — AI handles files, you handle publishing.

---

### G3 - Switch From SSH to a Fine-Grained Personal Access Token (Optional but Stronger)

Your current account-wide SSH key has access to all your GitHub repositories. A fine-grained PAT scopes access to one repo with defined permissions only.

**How to set it up:**

1. Go to GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens
2. Create a new token
3. Set repository access to your specific project repos only
4. Set permissions:
   - Contents: Read and Write (allows push)
   - Administration: None (cannot delete repo or manage settings)
   - Everything else: None or Read-only
5. Set an expiry — 90 days is a reasonable rotation period
6. Configure git to use HTTPS with this token instead of SSH for AI work

**Why this is stronger than SSH:**
- Scoped to one repo only — AI cannot touch your other repositories
- Administration permission is None — no repo deletion possible even via API
- Expires automatically — limits the damage window if anything goes wrong

---

### G4 - Add a Shell Guard for Destructive Git Commands

Covered by `~/.shell-guards.sh` (see Level 2). The git guard is in the same file:

```bash
git() {
  case "$*" in
    *push*--force*|*push*"-f"*|*push*--delete*|*branch*"-D"*)
      echo "⛔ HARD BLOCK: Destructive git command detected."
      echo "   If intentional, run:  command git $@"
      return 1
    ;;
  esac
  command git "$@"
}
```

To bypass: `command git push --force origin main`

**What this blocks:**
- `git push --force` — force push that overwrites remote history
- `git push --delete` — deletes a remote branch
- `git branch -D` — force deletes a local branch

**What still works normally:**
- `git add`, `git commit`, `git push` (normal), `git pull`, `git status`

---

## How the `command` Bypass Works

The shell guards are intentionally bypassable with the `command` keyword. This is by design:

- **AI agents** run `wrangler` and `git` naturally — the function intercepts them
- **You** can prefix with `command` to run the real binary when you genuinely need to
- **Scripts** bypass automatically because `execSync()` spawns non-interactive shells that never load `.zshrc`

The guard is a **speed bump, not an absolute block**. Combined with `wrangler logout`, the real absolute protection is: when logged out, no auth token exists so nothing works regardless. The guard catches the case where you forgot to logout after deploying.

```
Layer effectiveness:

wrangler logout         → Absolute block (no auth token = nothing works)
AGENTS.md instructions → Soft block (AI can choose to ignore)
Shell guard             → Soft block (bypassable with `command` prefix)
Preview bindings        → Hard block (hits dev DB, not prod)
Runtime wrappers        → Hard block (DELETE physically removed from objects)
```

Each layer is independent. If one fails, the next one holds.

---

*Generated for Cloudflare Workers / Hono / D1 / R2 / KV stack. Self-auditing version — May 2026.*