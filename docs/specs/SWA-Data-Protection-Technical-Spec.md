# SWA Portal — Data Protection Technical Specification

**Version:** 1.0
**Date:** 2026-07-15
**Status:** Implemented and verified
**Audience:** Technical — developers/maintainers of this machine's tooling setup
**Companion document:** `docs/specs/SWA-Data-Protection-Functional-Spec.md` (plain-language version)

---

## 1. Purpose and threat model

The SWA Portal production database (Cloudflare D1, `swa-portal`, id `b8ca063c-6767-445c-a42e-d092daf80fc4`) will hold personally identifiable information (PII) of real members once live: names, emails, phone numbers, NRICs, signatures, and uploaded images.

**Threat addressed:** *accidental* over-reach by AI coding assistants (Claude Code, opencode, zcode) working on this machine — e.g. an agent verifying a migration by dumping table rows, or opening a database export while debugging. This is a real, observed failure mode, not a hypothetical.

**Out of scope:** a deliberately malicious agent or human with the user's Cloudflare credentials. The guards raise the bar for accidents; they are not a security boundary against intentional misuse.

## 2. Core policy

> **Production data is never downloaded or stored on this computer.**

There is no local-backup workflow, plaintext or encrypted. Consequences of the policy:

- Verification of migrations/data state uses **aggregate queries only** (`COUNT(*)`, `GROUP BY` counts, `PRAGMA table_info`), each individually approved by the user.
- Disaster recovery relies on Cloudflare's built-in **D1 Time Travel** (point-in-time recovery, 30-day window) rather than local exports.
- Any `backup*.sql` file appearing locally is treated as a policy violation: tools must not open it and must surface it to the user for deletion.

## 3. Architecture: three layers

Defense-in-depth, ordered from "prevents the class of problem" to "catches stragglers":

| Layer | Mechanism | Covers |
|---|---|---|
| 1. Policy | Shared rulebook injected into every AI tool's system context | All tools, all projects (advisory) |
| 2. Enforcement | Each tool's native permission system (ask/deny), plus a hook where no native system exists | Tool-specific (enforced) |
| 3. Hygiene | Git ignore rules, project and global | Accidental commits (enforced by git) |

Rejected approach, for the record: an earlier implementation classified Bash command strings with regexes (block `cat`/`grep` on backups, whitelist aggregate SQL). It was removed because pattern-matching commands is inherently fragile — the shipped version falsely blocked *every* `cat`/`head`/`tail` command, while still missing readers like `sort` and `python -c`, and its SQL whitelist passed `SELECT name, COUNT(*) ... GROUP BY name` (returns PII). The replacement principle: **don't classify commands; remove the data and insert a human.**

### 3.1 Layer 1 — Shared policy rulebook

Canonical file: `~/.config/agent-rules/AGENTS.md` — single source of truth, symlinked into each tool's global-rules location:

| Symlink | Read by |
|---|---|
| `~/.claude/CLAUDE.md` | Claude Code (global memory) |
| `~/.config/opencode/AGENTS.md` | opencode (global rules) |
| `~/.zcode/AGENTS.md` | zcode (global rules) |

Rule content (summary): never read production PII contents; counts/structure only; no local exports of production data; stray `backup*.sql` files are reported, not opened; genuine needs require stopping and asking the user; local (non-`--remote`) and seed data exempt.

Project-level `AGENTS.md`/`CLAUDE.md` files load *after* the global rulebook and may narrow but not weaken it. To change the policy, edit the canonical file only — never the symlinks.

### 3.2 Layer 2 — Per-tool enforcement

#### Claude Code — `~/.claude/settings.json`

```json
"permissions": {
  "ask": [
    "Bash(*wrangler * --remote)",
    "Bash(*wrangler * --remote*)"
  ],
  "deny": [
    "Read(//**/backup*.sql)"
  ]
}
```

- **ask**: any Bash command containing `wrangler … --remote` pauses for interactive user approval. Wildcards are position-free in Bash rules; two variants cover `--remote` at end-of-command and mid-command. An ask rule takes precedence over any matching allow rule.
- **deny**: the `Read` tool refuses any file matching `backup*.sql`. The `//**/` anchor makes it filesystem-wide, not just cwd-relative. Deny rules also apply to symlink targets. Verified live: a Read attempt on a test file was refused in-session (settings hot-reload; no restart needed).

#### opencode — `~/.config/opencode/opencode.json`

```json
"permission": {
  "bash": {
    "*": "allow",
    "*wrangler *--remote*": "ask"
  },
  "read": {
    "*backup*.sql": "deny"
  }
}
```

opencode evaluates patterns sequentially, **last matching rule wins** — hence the catch-all `"*": "allow"` first, ask/deny rules after. (A stale `"*.config/age/*": "deny"` read rule left over from the removed encryption workflow was deleted 2026-07-15.)

#### zcode — PreToolUse hook

zcode has no native ask/deny permission rules, so a hook script provides block-and-explain semantics:

- **Script:** `~/.zcode/hooks/protect-prod-pii.sh`
- **Registration:** `~/.zcode/cli/config.json` → `hooks.events.PreToolUse[]`, matcher `Bash`, 10 s timeout.
- **Contract:** payload JSON on stdin; command extracted with `jq -r '.tool_input.command // .command // empty'` (never regex over raw JSON — an earlier sed-based extractor leaked the `description` field into matching, causing false blocks). Exit `0` = allow, exit `2` = block. Block reason is printed to **both stdout and stderr** because zcode's contract for which stream reaches the agent is undocumented.
- **Check 1:** command references a `backup*.sql` filename → block. Regex `backup[a-z0-9._-]*\.sql([^a-z0-9.]|$)` against the lowercased command; deliberately does not match `.sqlite` (or other longer extensions).
- **Check 2:** command contains `wrangler` **and** standalone `--remote` **and** the word `select` → block, directing the agent to hand the query to the user. This intentionally blocks even aggregate `COUNT` queries in zcode — the block message is the ask-prompt substitute.
- **Fail-open:** if `jq` is absent or extraction yields nothing, the hook allows. It is a backstop behind Layers 1 and 3, not the primary control.
- Deliberately **no** reader-command lists and **no** SQL aggregate whitelisting (see rejected approach above).

### 3.3 Layer 3 — Git hygiene

- Project `.gitignore` (this repo): `backup*.sql`, `backups/` (alongside the pre-existing `prod-dump.sql`). Also ignores `.zcode/` (local AI session state — plan files, not PII, but never meant for the repo).
- Global ignore (`~/.gitignore_global`, wired via `git config --global core.excludesfile`): `backup*.sql` — applies to every repository on the machine.

## 4. File inventory

| File | Role |
|---|---|
| `~/.config/agent-rules/AGENTS.md` | Canonical policy rulebook (edit this one) |
| `~/.claude/CLAUDE.md` | Symlink → canonical |
| `~/.config/opencode/AGENTS.md` | Symlink → canonical |
| `~/.zcode/AGENTS.md` | Symlink → canonical |
| `~/.claude/settings.json` | Claude Code `permissions` block |
| `~/.config/opencode/opencode.json` | opencode `permission` block |
| `~/.zcode/hooks/protect-prod-pii.sh` | zcode PreToolUse hook |
| `~/.zcode/cli/config.json` | zcode hook registration |
| `.gitignore` (repo) + `~/.gitignore_global` | Ignore rules |

Everything except the repo `.gitignore` lives outside the repository; this spec is the in-repo record of that external state. To reproduce it on a new machine, follow §8 — the spec (with Appendices A and B) is deliberately self-contained for that purpose.

## 5. Verification procedures

Run after any change to the guard files.

**Last full run: 2026-07-15 (evening) — all checks below passed** (9/9 hook unit tests, deny rule, gitignore matches incl. `.zcode/`, config integrity: both JSON files valid, hook syntax OK, all three symlinks resolve to the canonical rulebook).

**5.1 zcode hook unit tests** — simulate payloads; expected exits shown:

```bash
run_hook() { printf '{"tool_name":"Bash","tool_input":{"command":%s,"description":"t"}}' \
  "$(jq -Rn --arg c "$1" '$c')" | bash ~/.zcode/hooks/protect-prod-pii.sh >/dev/null 2>&1; echo "exit=$? :: $1"; }

# expect exit=0 (allow):
run_hook 'cat README.md'
run_hook 'head -20 src/pages/index.astro'
run_hook 'git log | less'
run_hook 'npx wrangler d1 migrations apply swa-portal --remote'   # no SELECT
run_hook 'npx wrangler d1 execute swa-portal --local --command "SELECT * FROM members"'  # local exempt

# expect exit=2 (block):
run_hook 'cat backup-15-07-2026.sql'
run_hook 'sort backup.sql | uniq'
run_hook 'python3 -c "print(open(\"backup.sql\").read())"'
run_hook 'npx wrangler d1 execute swa-portal --remote --command "SELECT COUNT(*) FROM members"'
```

The false-positive regression cases (`cat README.md` etc.) are the most important lines — they are what the previous implementation failed.

**5.2 Claude Code deny rule** — create a throwaway `backup-test.sql` with fake content; ask Claude Code to read it; expect refusal. Delete the file.

**5.3 Ask rule** — any `wrangler … --remote` command in Claude Code/opencode should surface a yes/no prompt (observed naturally during deploys/migrations).

**5.4 Git ignore** — `git check-ignore backup-x.sql backups/x` in the repo, and `backup-x.sql` in a fresh `git init` temp dir (tests the global rule).

**5.5 Config integrity** — `jq empty ~/.claude/settings.json ~/.config/opencode/opencode.json`; `readlink` the three symlinks; `bash -n` the hook.

## 6. Go-live checklist (when real member data enters production)

1. **Backup strategy:** confirm D1 Time Travel retention (30 days on paid plans) is adequate; if longer retention or off-Cloudflare copies are required, design an export flow that never lands plaintext on a workstation (e.g. export within a Worker to a private R2 bucket, or rebuild the removed encryption-at-rest pipeline from the outline in §7).
2. Re-run all §5 verification procedures.
3. Review whether the `--remote` ask-prompts should tighten to deny for row-returning statements.
4. Confirm every AI tool in use at that time has a guard entry (new tools ⇒ new symlink + native permission rules).
5. Consider protecting other PII surfaces if adopted by then: R2 object contents (signatures/images), KV values.

## 7. History

| Date | Change |
|---|---|
| 2026-07-15 (am) | Initial attempt: zcode-only regex hook classifying commands/SQL. Evaluated; critical false-positive bug (blocked all `cat`/`head`/`tail`) plus multiple bypasses. |
| 2026-07-15 (pm) | Replaced with the three-layer design. Additionally implemented encryption-at-rest for local backups (`age`, counts-only manifests, `scripts/backup-prod.sh`); existing plaintext backup encrypted and destroyed. |
| 2026-07-15 (pm) | **Encryption workflow removed** the same day: the D1 data was recreatable development data, the portal is not yet live, and the owner wants no local-storage workflow at all. Policy simplified to "production data never lands on this machine". The three guard layers were kept. The pipeline was never committed, so this table is its only record: `scripts/backup-prod.sh` produced `age`-encrypted D1 dumps plus counts-only plaintext manifests, keypair held outside the repo. Rebuild from this outline should §6.1 ever need it. |
| 2026-07-15 (eve) | Wrap-up sweep after the removal: confirmed no `backup*.sql`/`*.age` files or age keys remain, `age` binaries uninstalled, `scripts/backup-prod.sh` gone; deleted the stale `*.config/age/*` deny rule from opencode; added `.zcode/` to the repo `.gitignore`; re-ran all §5 verification procedures (pass). |
| 2026-07-16 (am) | Added §8 "Setting up a new machine" — a self-contained runbook for an AI agent to follow on a fresh computer, with Appendix A (zcode hook script, byte-identical to `~/.zcode/hooks/protect-prod-pii.sh`) and Appendix B (canonical rulebook, byte-identical to `~/.config/agent-rules/AGENTS.md`). Updated §4 to point to §8. The tech spec is now sufficient to reproduce the entire setup from a copy of the repo alone. |
| 2026-07-16 (am) | Committed and pushed to `origin/main` as commit `b02585a`: `.gitignore` (adds `.zcode/`, alongside earlier `backup*.sql`/`backups/` entries) + both data-protection spec docs (technical + functional). See commit message for full summary. |

## 8. Setting up a new machine

This section is written so an AI agent (or a human) on a fresh computer can reproduce the whole setup from this document alone — nothing needs copying from the old machine. Steps apply only to tools actually installed on the new machine; skip the rest.

1. **Prerequisite:** ensure `jq` is installed (`brew install jq` on macOS). The zcode hook depends on it and fails open without it.
2. **Rulebook:** create `~/.config/agent-rules/AGENTS.md` with exactly the content of **Appendix B**. Then symlink it into each installed tool's global-rules path per the §3.1 table:
   ```bash
   mkdir -p ~/.config/agent-rules
   ln -sf ~/.config/agent-rules/AGENTS.md ~/.claude/CLAUDE.md
   ln -sf ~/.config/agent-rules/AGENTS.md ~/.config/opencode/AGENTS.md
   ln -sf ~/.config/agent-rules/AGENTS.md ~/.zcode/AGENTS.md
   ```
   If a tool already has a global-rules file with content, merge that content into the canonical file first — the symlink replaces the file.
3. **Claude Code:** **merge** (never overwrite) the §3.2 `permissions` `ask`/`deny` entries into `~/.claude/settings.json`, preserving any existing entries.
4. **opencode:** merge the §3.2 `permission` block into `~/.config/opencode/opencode.json`. Order matters (last matching rule wins): the catch-all `"*": "allow"` must come before the ask/deny patterns.
5. **zcode hook:** write **Appendix A** verbatim to `~/.zcode/hooks/protect-prod-pii.sh` and `chmod +x` it. Merge this entry into `~/.zcode/cli/config.json` under `hooks.events.PreToolUse[]` (creating `hooks.enabled: true` if absent):
   ```json
   {
     "matcher": "Bash",
     "hooks": [
       { "type": "command", "command": "bash \"$HOME/.zcode/hooks/protect-prod-pii.sh\"", "timeout": 10 }
     ]
   }
   ```
6. **Git hygiene:** the repo `.gitignore` arrives with the repository. For the machine-wide rule:
   ```bash
   printf '# production DB exports (PII) — never commit, in any project\nbackup*.sql\n' >> ~/.gitignore_global
   git config --global core.excludesfile ~/.gitignore_global
   ```
   (If a `core.excludesfile` is already configured, append to that file instead.)
7. **Verify:** run every procedure in §5. Setup is complete only when all of them pass — in particular the false-positive cases in §5.1 (`cat README.md` must be allowed).

## Appendix A — zcode hook script (canonical)

Verbatim content of `~/.zcode/hooks/protect-prod-pii.sh`. This is the tested version; the installed file must match it exactly. If the hook is ever changed, update this appendix in the same commit.

```bash
#!/usr/bin/env bash
#
# protect-prod-pii.sh — PreToolUse hook for the Bash tool (zcode).
#
# Backstop for the shared rule in ~/.config/agent-rules/AGENTS.md: production
# data is never downloaded or stored on this computer, and remote queries that
# could return user rows go through the user. Two fixed checks — deliberately
# NO command/SQL classification, which is what made the previous version block
# harmless commands:
#
#   1. Any command referencing a backup*.sql file  -> block.
#      No such file should exist; if one appears, don't touch it.
#   2. Any wrangler --remote command containing SELECT -> block,
#      with instructions to have the user run/approve it. Other tools handle
#      this with an ask-prompt; zcode has no ask so we block-and-explain.
#
# Exit codes: 0 = allow, 2 = block. Reason goes to stdout AND stderr (zcode's
# contract for which stream reaches the agent is undocumented).

set -u

command -v jq >/dev/null 2>&1 || exit 0
cmd="$(jq -r '(.tool_input.command // .command // empty) | tostring' 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0

low="$(printf '%s ' "$cmd" | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')"

block() {
  printf '%s\n' "$1"
  printf '%s\n' "$1" >&2
  exit 2
}

# Check 1: plaintext production backup file referenced anywhere.
# Matches backup*.sql but not backup*.sql.age / .sqlite / manifest files.
if printf '%s' "$low" | grep -Eq 'backup[a-z0-9._-]*\.sql([^a-z0-9.]|$)'; then
  block 'Blocked (protect-prod-pii): this command references a backup*.sql file,
which may contain production member PII. Production data is never stored on
this machine and no such file should exist. Do not open it — tell the user it
is there so they can delete it.'
fi

# Check 2: remote production DB query that could return rows.
if printf '%s' "$low" | grep -q 'wrangler' \
  && printf '%s' "$low" | grep -Eq '(^|[[:space:]])--remote([[:space:]]|=|$)' \
  && printf '%s' "$low" | grep -Eq '(^|[^a-z0-9_])select([^a-z0-9_]|$)'; then
  block 'Blocked (protect-prod-pii): remote production database SELECTs are not run
directly from zcode. If a query is genuinely needed (including COUNT and
other aggregates), show the user the exact query and ask them to run or
approve it themselves.'
fi

exit 0
```

## Appendix B — canonical rulebook (canonical)

Verbatim content of `~/.config/agent-rules/AGENTS.md`. If the rulebook is ever changed, update this appendix in the same commit.

```markdown
# Global rules (all AI coding tools)

This file is the single source of truth, symlinked into every tool's global-rules
location (zcode, opencode, Claude Code). A project's own AGENTS.md/CLAUDE.md loads
afterwards and may add to or narrow these.

## Production data privacy

Never read the *contents* of production user/PII data — names, emails, phone
numbers, NRICs, signatures, uploaded images, or any field identifying a real
person. When verifying a migration result or row state, use **counts and
structure only** — never print raw rows.

**Production data is never downloaded or stored on this computer.** Do not
export, dump, or copy a production database (or R2/KV contents) to a local
file — plaintext or otherwise. There is no local-backup workflow; recovery
relies on Cloudflare's built-in mechanisms (e.g. D1 Time Travel).

How to work within this:

- **Remote database queries** (`--remote`): aggregate/schema queries
  (`COUNT(*)`, `GROUP BY` counts, `PRAGMA table_info`) are fine to propose;
  the user approves each remote command. Never run a `--remote` query that
  returns raw rows from tables holding user data.
- If a stray `backup*.sql` or similar export ever appears locally, do not
  open it — tell the user so they can delete it.
- If a task genuinely requires reading production user data, **stop and ask
  first**: state the specific need and exactly which fields are required, and
  wait for explicit permission.

**Local** (non-`--remote`) databases and test/seed data are exempt — they hold
fabricated data.
```
