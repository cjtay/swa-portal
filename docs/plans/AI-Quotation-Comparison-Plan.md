# AI Quotation Comparison — Implementation Plan

> **Status: planned, not yet implemented.** Written 26 August 2026 after two
> planning sessions with the owner. No code has been changed for this feature
> yet. This plan records every agreed decision so a later session can build it
> without re-deciding anything. Session history lives in `progress.md`.

## 1. What we are building, in plain words

When the office admin raises an approval request and ticks "I have multiple
quotations to compare", a new "Analyse with AI" button appears next to the
comparison builder. The AI reads each ticked quotation file (PDF or photo),
pulls out the common fields such as vendor, item name, description, unit price
and total price, converts every price to S$ using a live exchange rate, and
writes:

1. a comparison table with all prices normalised to S$,
2. a short paragraph describing the differences, and
3. a one-line recommendation.

The analysis is saved with the request, so purchase approvers see it in the
drawer alongside the existing comparison table. The result always carries the
label "AI-generated, verify against the original documents".

The office admin can also regenerate the analysis later from the request
drawer, which covers edited files and requests raised before the feature
existed.

## 2. Decisions confirmed by the owner

| # | Decision | Choice |
|---|---|---|
| 1 | Provider | Cloudflare Workers AI. No new account, no API key, no new npm package. The project already runs on Cloudflare |
| 2 | Timing | Button in the New request form (preview before submitting) plus a Regenerate button in the item drawer |
| 3 | File formats | Existing allowlist only: PDF, JPEG, PNG, WebP, HEIC. Word (.docx) support deliberately deferred |
| 4 | Recommendation style | Value-based: price in S$, what is included (specs, GST, delivery, validity), cheapest flagged when specs match |
| 5 | Cost control | IT admin kill-switch in Settings. Free-tier ceiling plus per-user rate limit plus server-side flag check |
| 6 | Expected volume | About 10 analyses per month, per the owner |

## 3. Cost risk analysis (why a spike is close to impossible)

Workers AI bills in "Neurons", a unit of GPU compute. Every account gets
10,000 Neurons free per day, resetting at 00:00 UTC. On the free Workers plan
requests simply fail once the daily allowance is spent, so a bill is
impossible on that plan. On the paid plan, usage above 10,000 Neurons per day
costs US$0.011 per 1,000 Neurons.

One full analysis, worst case (5 photo quotations, generous token estimates):

| Step | Model | Neurons (estimate) |
|---|---|---|
| Read 5 photos | `@cf/meta/llama-4-scout-17b-16e-instruct` (vision) | ~1,500 |
| Extract fields, 5 documents | vision or text model | ~1,000 |
| Compare and write summary | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | ~800 |
| PDF text conversion (`toMarkdown`) and FX fetch | negligible | ~0 |
| **Total per analysis** | | **~3,000, typical run under 1,500** |

At 10 analyses per month the portal uses roughly 15,000 to 30,000 Neurons per
month. The free allowance is about 300,000 Neurons per month, so the feature
would use a tenth of what is already free. The free daily allowance alone
absorbs 3 to 6 worst-case analyses every day.

A deliberate spike would need a logged-in user pressing the button hundreds of
times a day. Four layers stop that: the analyse endpoints sit behind login
(middleware gate 7c), a per-user rate limit bucket caps usage, the IT admin
kill-switch returns 503 immediately, and the free plan's daily allowance is a
hard ceiling. Actual usage is visible any time in the Cloudflare dashboard
under Workers AI.

## 4. Technical design

### 4.1 Binding and types

Add `"ai": { "binding": "AI" }` to `wrangler.jsonc`, add `AI` to the `Env`
interface in `src/worker/types.ts`, and regenerate
`worker-configuration.d.ts` with `npm run cf-typegen`. No npm install.

### 4.2 Pipeline (all inside the worker)

1. **Read each ticked quotation.**
   - PDF: `AI.toMarkdown()` extracts the real text. Reliable for PDFs with a
     text layer.
   - JPEG, PNG, WebP photo: sent directly to the vision model
     (`@cf/meta/llama-4-scout-17b-16e-instruct`), which reads figures from the
     image.
   - HEIC (iPhone photos): converted to JPEG in the browser at pick time,
     reusing the canvas pattern already on the membership register page.
   - Unreadable files (scanned PDFs with no text layer, damaged files) are
     skipped with a per-file note in the result. Never a silent failure.
2. **Extract structured JSON per document** using JSON output mode: vendor,
   item name, description/features, unit price, total price, currency, GST,
   validity, lead time. Unknown fields stay null.
3. **Convert to S$ in code, not by the model.** The worker fetches daily
   exchange rates from a free, no-key FX API and caches them for 24 hours in
   the `SWA_CONFIG` KV namespace. The report states the rate and date used.
   Doing the maths in code avoids model arithmetic mistakes.
4. **Compare.** One pass with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
   produces the comparison table (already normalised to S$ by step 3), the
   short paragraph, and the one-line recommendation.

### 4.3 Endpoints

| Route | Purpose |
|---|---|
| `POST /api/approvals/analyse-preview` | Multipart, used at form time. Sends the ticked files, returns the analysis, stores nothing. The preview can then be submitted with the new request |
| `POST /api/approvals/:id/analyse` | Post-submit or regenerate. Reads the ticked attachments from R2, stores the result on the item, writes an `ai_comparison_generated` row to the insert-only audit log |

Both are gated to the admin role (the same tier that may raise items) and get
a new rate-limit bucket, about 10 requests per hour per user. Registration
order in `src/worker/index.ts` matters: these routes must be registered
before the `/:id` routes, following the existing `audit/export` precedent.

The regular `POST /api/approvals` create endpoint never calls AI itself. The
form passes the previewed analysis in as stored JSON, so creating a request
keeps working when the feature is disabled.

### 4.4 Storage

New `ai_comparison` TEXT column on `approval_items` (nullable, JSON). Shape:
generated at and by, models used, FX rates and date, per-file status,
extracted quotations, summary paragraph, recommendation. Migration file plus
`schema.sql` update in the same commit.

### 4.5 IT admin kill-switch

Follows the existing `swa:reg_tables_config` pattern exactly:

1. KV key `swa:ai_config` in `SWA_CONFIG`, value `{ "enabled": true }`.
   Server reads merge with a default of enabled, so a missing key means on.
2. `swa:ai_config` joins the `KNOWN_KEYS` allowlist in
   `src/worker/api/admin-settings.ts` with a boolean validator, so the
   existing IT-admin-only `POST /api/admin/settings` endpoint can write it.
3. New "Approvals, AI Quotation Comparison" card on
   `/admin/settings/index.astro` with a status line and Enable/Disable
   button.
4. The flag reaches the approvals page through `/api/session` as a new
   `ai_comparison_enabled` field (same style as `is_purchase_approver`).
   Added in `session.ts`, `dev-login.ts` and the `SessionResponse` interface
   in `auth-gate.ts`. The page already fetches the session on load, so no
   extra request.
 5. When disabled: the approvals page hides the "Analyse with AI" and
   "Regenerate" buttons and shows a small "Disabled by IT admin" note, and
   both analyse endpoints return 503 `FEATURE_DISABLED`. Enforcement is
   server-side, not just hidden buttons.

### 4.6 Abuse safeguards against retries and runaways

The login gate, the per-user rate limit, the kill-switch and the free-plan
daily ceiling (section 3) are the first four layers. Five more close the
retry-shaped gaps:

1. **In-flight lock.** The Analyse/Regenerate button disables itself while an
   analysis runs (10 to 30 seconds), so an impatient second click cannot
   start a second paid run.
2. **No automatic retries in worker code.** Every AI call is a single
   attempt. An error surfaces as a per-file note or a 502 response. There is
   no retry loop silently multiplying Neurons.
3. **Timeout per AI call, about 30 seconds.** A hanging model call fails fast
   instead of stacking up and holding the worker open.
4. **Global daily circuit breaker.** A KV counter (key under `swa:rl:` in
   `SWA_SESSION`, alongside the existing rate-limit entries) allows at most
   50 analyses per day across all users combined, returning 429. This caps
   total spend no matter how many user accounts exist, independent of any
   per-user limit, and resets at the same time as the free Neuron allowance.
5. **Reuse, never re-run.** The drawer renders the stored `ai_comparison`
   JSON. Page views never trigger AI; regeneration only happens on an
   explicit click.

Worst case with every layer in place: 50 runs/day at ~3,000 Neurons each is
150,000 Neurons, about US$1.54/day and only on the paid plan. Expected real
usage is roughly 1% of that.

## 5. Files to create or edit

| File | Operation |
|---|---|
| `wrangler.jsonc` | edit, add AI binding |
| `src/worker/types.ts` | edit, add `AI` to Env |
| `worker-configuration.d.ts` | regenerate via `npm run cf-typegen` |
| `migrations/0XX_ai_comparison.sql` | create |
| `schema.sql` | edit, add column |
| `src/worker/lib/ai-comparison.ts` | create, conversion, extraction, FX, comparison, `isAiComparisonEnabled()` |
| `src/worker/lib/rate-limit.ts` | edit, new bucket |
| `src/worker/api/approvals.ts` | edit, two analyse handlers, create accepts saved analysis |
| `src/worker/api/admin-settings.ts` | edit, allowlist entry + validator |
| `src/worker/api/session.ts` | edit, flag in response |
| `src/worker/api/dev-login.ts` | edit, flag in response |
| `src/worker/index.ts` | edit, register routes (before `/:id`) |
| `src/scripts/auth-gate.ts` | edit, flag in SessionResponse |
| `src/pages/approvals.astro` | edit, form button + preview, drawer display + regenerate, HEIC conversion, hide when disabled |
| `src/pages/admin/settings/index.astro` | edit, toggle card |
| `src/worker/api/__tests__/ai-comparison.test.ts` | create, mocked AI binding |
| `src/worker/api/__tests__/approvals.test.ts` | edit, new cases |
| `docs/specs/features/approvals.md` | edit, new matrix row and section |
| `docs/ARCHITECTURE.md` | edit |
| `progress.md` | edit at implementation time |

## 6. Verification plan

- Vitest with a mocked AI binding: prompt building, JSON parsing, FX maths,
  unreadable-file fallbacks, auth gates, rate limit, 503 when disabled,
  429 when the daily circuit breaker trips.
- `npm run typecheck`, `npm run typecheck:worker`, `npm run test:run`,
  `npm run build`.
- Manual run in `npm run dev:worker` with sample quotations: a text PDF, a
  photo, an HEIC photo, and a scanned PDF (expected per-file skip note).
  **Local testing consumes real Workers AI quota**: `wrangler dev` cannot
  simulate GPUs, so AI binding calls are proxied to the live Cloudflare
  service on your logged-in account. Each local analysis counts against the
  same free 10,000 Neurons/day as production. No separate environment
  exists, which is fine given the cost analysis in section 3. Automated
  tests cost nothing because the AI binding is mocked.
- Toggle check: disable in Settings, confirm buttons hide and both endpoints
  return 503, confirm a new request without analysis still submits.

## 7. Privacy note

Quotation contents go to Cloudflare's Workers AI service only, the same
platform the portal already runs on. Cloudflare states it does not train on
this data. Vendor quotations may contain vendor contact details, which the
owner accepted as fine for this use.

## 8. Future scope (not in this build)

- Word (.docx) support: one allowlist line plus `toMarkdown`, since the
  machinery in this plan already handles it.
- Excel (.xlsx) quotations, if vendors send spreadsheets.
- Inclusion of the analysis in the approval email, so approvers see the
  summary without opening the portal.
