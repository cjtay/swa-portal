# SWA Portal — Data Protection, Explained Simply

**Date:** 2026-07-15
**Audience:** Anyone — no technical background needed
**Technical version:** `docs/specs/SWA-Data-Protection-Technical-Spec.md`

---

## What this is about

Once the SWA Portal goes live, its database will hold real members' personal details — names, emails, phone numbers, NRICs, signatures. You use AI assistants (Claude Code, opencode, zcode) to build the portal, and an AI assistant that is *trying to be helpful* might casually open member data — for example, printing rows from the database to "check a migration worked".

This setup makes that accident practically impossible, without getting in your way. Everything described below was built, tested end-to-end, and switched on, on 2026-07-15.

## The one golden rule

> **Member data stays in Cloudflare. It is never downloaded onto this computer.**

No database exports, no backup files, no copies — nothing for an AI tool (or a stolen laptop) to find. If the database ever needs restoring, Cloudflare itself keeps a rolling 30-day history that can wind the database back to any point in time.

## The three protections

**1. Every AI assistant is told the rules.**
One shared rule file is automatically read by all three AI tools at the start of every session. It says: never read member data, check your work using *counts* only ("members: 412 rows" — fine; the rows themselves — never), and if you truly need to see real data, stop and ask first. Update that one file and all tools follow.

**2. The dangerous actions are physically gated.**
Telling an AI the rules is good; enforcing them is better:
- Any command an AI runs against the **live** database makes the tool stop and ask you **"yes or no?"** first. You see exactly what it wants to run. (One tool, zcode, can't do yes/no prompts — there it simply refuses and asks you to run the command yourself, which amounts to the same safeguard.)
- If a database-export file (`backup…sql`) ever appears on this computer, the AI tools are blocked from opening it — they'll tell you it exists so you can delete it.

**3. Git won't let export files sneak into the code repository.**
Even if an export file appeared, git ignores it — in this project and every other project on this machine — so it can't be accidentally published to GitHub.

## What you'll notice day-to-day

- **Almost nothing.** Normal development is untouched.
- Occasionally a tool pauses with a yes/no prompt before touching the live database. That's protection #2 working. Read the command; if it's a count or a migration you expect, approve it.
- If a tool refuses to open a file with "backup" in its name — also by design. Delete the file rather than working around the block.

## What happened to the encrypted backups?

Earlier on 2026-07-15 an encrypted-backup system was built (backups scrambled with an encryption key, readable summaries alongside). It was removed the same day: the portal isn't live, the current member list is easily recreated dev data, and keeping *any* production data locally isn't wanted. The design is summarised in the technical spec's history section if it's ever needed again.

## When the portal goes live

Three things to do at that point (the technical spec has the full checklist):
1. Double-check Cloudflare's 30-day database history is enough of a safety net, or set up an off-site copy that never touches a workstation.
2. Re-run the quick tests below.
3. If a new AI tool has joined the toolbox, give it the same two guards.

## Setting up a new or replacement computer

The whole setup can be recreated in minutes without copying anything from the old machine: open this project on the new computer and ask any AI tool to follow **section 8 of the technical spec** (`docs/specs/SWA-Data-Protection-Technical-Spec.md`). That document contains every rule file, script, and setting verbatim, plus the tests to confirm it all works.

## Two-minute health check

Last full check: **2026-07-15 — everything passed** (including the deeper technical tests in the companion spec).

Any time you want reassurance it's all still working:
1. Ask any AI tool to run `cat README.md` — should work normally (no false alarms).
2. Create a fake file called `backup-test.sql` with a made-up line in it, ask an AI tool to read it — should be refused. Delete the file.
3. Ask a tool to run a count against the live database — you should get the yes/no prompt.

If any of the three behaves differently, check the technical spec's verification section.
