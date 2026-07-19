# SWA Workers Architecture Assessment

> **Date**: 2026-05-13
> **Context**: Evaluation of whether the current 3-worker structure (swa-site, swa-portal, swa-gtw) should be merged into fewer workers, and the recommended approach for cross-worker data access (namecards on the public site).

---

## Current Worker Structure

| | swa-site | swa-portal | swa-gtw |
|---|---|---|---|
| **Repo** | `swa2024` | `swa-portal` | `gtw2026` |
| **Domain** | `singaporewomenassociation.org` | `admin.singaporewomenassociation.org` | `gtw.singaporewomenassociation.org` (pending) |
| **Purpose** | Public website | Admin portal | GTW event |
| **Pages** | 108 | 5 | 10 |
| **API routes** | 2 (health + contact) | 14 (auth + members + bookings) | 24 (auth + tickets + draw + analytics) |
| **D1** | None | swa-portal | swa-gtw |
| **KV** | 1 (rate limit) | 1 (sessions + OTP + rate limit) | 1 (config) |
| **R2** | None | 1 (uploads) | 1 (screenshots) |
| **Auth** | None | OTP + HMAC session | OTP + domain session |
| **Cron** | None | None | None |
| **Worker code** | ~300 lines | ~1,070 lines | ~2,450 lines |
| **Dependencies** | Astro, Hono, Tailwind, Cloudinary, Sharp | Astro, Hono | Astro, Hono |
| **Session cookie** | None | `swa_session` | `gtw_session` |
| **KV prefix** | None | `swa:` | `gtw:` |

### swa-site (Public Website)

- Content-heavy static site with 108 Astro pages and 11 content collections
- Only 2 API routes: health check and contact form
- No D1, no R2, no auth
- KV binding for rate limiting exists but is not currently wired into routes
- Images served via Cloudinary
- Heavily centred around SP49 pageant event content, SWA programmes, and various forms

### swa-portal (Admin Portal)

- Internal management tool for SWA committee and admin
- 5 pages: Dashboard, Login, Members, Namecards, Office Booking
- 14 API routes: auth (OTP, verify, session), members CRUD, bookings CRUD, photo upload
- D1 for member data, bookings, error logging
- KV for sessions, OTP storage, rate limiting
- R2 for member photo uploads
- 3-tier role system: IT Admin, Admin, Committee
- Bookings auto-approved, namecard sync not yet implemented

### swa-gtw (Guess the Winner Event)

- Special event ticketing and draw system
- 10 pages: landing, login, form, dashboard, analytics, draw, results, prize collection, user guide
- 24 API routes across public, admin, and IT-admin tiers
- D1 for submissions, tickets, error logging
- KV for config
- R2 for PayNow screenshots
- Domain-based auth (`@singaporewomenassociation.org`) plus IT admin hardcoded list
- Complex business logic: ticket numbering, draw system, Miss Popularity calculation, CSV export, prize collection

---

## Option A: Keep 3 Separate Workers (Current)

### Pros

- **Isolation by design** — a bug in GTW draw logic cannot break the public website. A bad deploy to swa-site does not take down the admin portal.
- **Independent deploy cadence** — update GTW during event season without touching the site. Fix an admin portal bug without risking public-facing pages.
- **Security boundary** — the public website has zero access to member data, bookings, or payment info. If swa-site is compromised, the attacker gains nothing sensitive.
- **Simpler per-worker code** — each worker does one thing well. New developers can understand one worker in isolation.
- **Cloudflare free tier is per-account** — Workers scripts (10 max), KV namespaces, D1 databases (5 free) are all pooled at the account level. The 3 workers share the same free tier allocation without issue.

### Cons

- **No shared login** — logging into swa-portal and swa-gtw requires separate authentication. Session cookies are scoped to different subdomains.
- **Code duplication** — `crypto.ts`, `email-otp.ts`, `rate-limit.ts`, `error-handler.ts` are nearly identical across swa-portal and swa-gtw.
- **3 repos to maintain** — dependency updates, Cloudflare config changes, and auth reworks need to be applied 2-3 times.
- **D1 data cannot be easily joined** — crossing worker boundaries for data access requires separate D1 bindings or alternative approaches.

---

## Option B: Merge Into 1 Worker

### Pros

- **Single deploy** — one `wrangler deploy` for everything.
- **Shared auth** — one login, one session cookie, one middleware. Navigate between admin portal and GTW admin without re-authenticating.
- **Shared code** — no duplication of crypto, email, rate limiting, or error handling.
- **Shared D1** — could query across member data and GTW tickets (e.g., "which members bought GTW tickets?").
- **Simpler routing** — use path prefixes (`/admin/...`, `/gtw/...`) with a single Hono app.

### Cons

- **Blast radius** — one bad deploy breaks everything: public site, admin portal, AND GTW.
- **Security risk** — the public website handler would have code-level access to D1 with member data, payment info, and OTP secrets. Even if routing prevents exposure, the binding exists in the same runtime.
- **Worker size** — Cloudflare Workers have a 10 MB compressed script limit. With 108+ pages of static output, static assets are served separately, but the worker code itself would grow substantially with all three codebases combined.
- **Route complexity** — path-based routing must carefully keep public site, admin portal, and GTW separate. One middleware misconfiguration could expose admin routes publicly.
- **Deploy coupling** — changing a GTW draw feature forces a redeploy of the public website. During the GTW event (high traffic), redeploying the entire stack is risky.
- **No isolation** — rate limiting attacks on the contact form consume the same worker CPU and request quota as admin operations.

---

## Option C: 2 Workers (Merge Portal + GTW, Keep Site Separate)

A middle ground: merge the two admin workers since they share the same auth model and admin base, while keeping the public website separate for security.

### Pros

- Shared auth across admin portal and GTW admin — one login
- Shared code (crypto, email, rate limiting)
- Public website stays isolated — no access to sensitive data
- Separate deploy cadence for public site

### Cons

- GTW has very different business logic (draw system, ticket numbering, Miss Popularity) — mixing it with member management increases code complexity
- The combined admin worker would be ~3,500 lines of API code — manageable but growing
- GTW uses domain-based auth (`@singaporewomenassociation.org`) while portal uses D1-based auth — auth middleware would need to handle both models
- During GTW event season, rapid iteration on draw features would also deploy portal changes

---

## Recommendation: Keep 3 Separate Workers

### Reasoning

1. **Security is the strongest argument.** The public website handles zero sensitive data. It should never have a D1 binding to member data or OTP secrets. Keeping it on a separate worker is correct architectural discipline — not just "nice to have."

2. **Code duplication is minimal and manageable.** The shared files (`crypto.ts`, `email-otp.ts`) are small, stable, and rarely change. Copying them across 2 repos is far cheaper than the risk of one bad deploy taking down everything.

3. **Deploy isolation matters in practice.** During GTW event season, rapid iteration on ticket/draw features should not redeploy the public website or admin portal. Similarly, the admin portal is new and evolving — it should not destabilise the mature public site.

4. **Cloudflare free tier is not a constraint.** 10 workers, 100k requests/day, 5 D1 databases — all well within limits for the foreseeable future.

5. **The shared login problem is solvable without merging.** If SSO is desired in the future, use a shared session KV namespace and set cookies on a parent domain (`singaporewomenassociation.org`). Today, admins log into portal and GTW separately, which is acceptable.

### Mitigating Code Duplication

If shared code drift becomes a concern, two options:

- **Git submodule**: Extract shared code into a `swa-worker-common` repo and include it as a submodule in both `swa-portal` and `gtw2026`.
- **npm package**: Publish a private `@swa/worker-common` package with shared utilities.

However, with only ~5 small shared files that rarely change, even this is optional. The current approach of copying stable files is pragmatic and low-maintenance.

---

## Cross-Worker Data Access: Namecards on swa-site

> **REMOVED 19-07-2026** — Public-website integration dropped. swa-portal is now isolated from swa2024; cross-worker namecard data access is no longer required. Historical analysis preserved below for audit only.

The public website needs to display member namecards that are managed in the admin portal. This is the one place where cross-worker data access is genuinely needed.

### Recommended Approach: D1 Binding

Since both workers are in the same Cloudflare account, the simplest approach is to add a read-only D1 binding.

1. Add a D1 binding to swa-site's `wrangler.jsonc` pointing to the `swa-portal` database:

```jsonc
"d1_databases": [
  {
    "binding": "SWA_DB",
    "database_name": "swa-portal",
    "database_id": "b8ca063c-6767-445c-a42e-d092daf80fc4"
  }
]
```

2. Add a Hono route in swa-site's worker that queries D1 for namecards:

```sql
SELECT * FROM members WHERE has_namecard = 1 AND show_on_website = 1 ORDER BY sort_order
```

3. Render namecard pages dynamically (or at build time with a rebuild trigger from the portal).

**Key principle**: swa-site only reads from the swa-portal D1 database. It never writes. This keeps the security boundary clean — if the public site is compromised, the attacker can only read public-facing member data, not modify it.

### Alternative Approaches (Not Recommended)

| Approach | Why Not |
|----------|---------|
| API calls from swa-site to swa-portal | Adds latency, requires auth between workers, couples deploy timing |
| Shared R2 bucket for JSON exports | Stale data, requires sync mechanism, more complexity than D1 binding |
| Cloudflare Workers KV shared namespace | Eventually consistent, not ideal for relational data, adds another dependency |

---

## Cloudflare Free Tier Impact

All three workers share the same account-level free tier:

| Resource | Free Tier | Current Usage | Remaining |
|----------|-----------|---------------|-----------|
| Workers scripts | 10 | 3 | 7 |
| Requests/day | 100,000 | Low | Plenty |
| D1 databases | 5 | 2 (swa-portal, swa-gtw) | 3 |
| KV namespaces | 10 | 3 | 7 |
| R2 buckets | Unlimited | 2 (swa-portal-uploads, swa-gtw-assets) | Unlimited |
| Custom domains | Unlimited per worker | 3 (planned) | Unlimited |

There is no cost or capacity reason to consolidate workers.

---

## Summary

| Criterion | 3 Workers (Current) | 1 Worker | 2 Workers |
|-----------|---------------------|----------|-----------|
| Security isolation | Best | Worst | Good |
| Deploy isolation | Best | Worst | Moderate |
| Code duplication | Some | None | Less |
| Auth unification | None | Best | Good |
| Blast radius | Small | Everything | Moderate |
| Maintenance effort | 3 repos | 1 repo | 2 repos |
| GTW complexity impact | Isolated | Mixed in | Mixed in |
| Cloudflare free tier fit | Comfortable | Comfortable | Comfortable |

**Keep 3 separate workers.** The security and deploy isolation benefits far outweigh the minor inconvenience of duplicated utility code. For cross-worker namecard data, use a D1 binding — it is the simplest, most performant, and most secure approach.