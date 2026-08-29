# SWA Portal — Progress Log

A running log of work completed each session, plus the immediate next steps.
Append a new dated entry at the top; keep it short and skimmable.

This file is committed to git — it is the session memory that AI tools are
told (via AGENTS.md) to read first. Keep entries factual and short.

For the full phase tracker see `docs/plans/SWAPortal-Implementation-Plan.md`.
For role access, API permissions, and feature specs see
`docs/specs/SWAPortal-Functional-Specs.md`.

---

## 2026-08-29 (session 25): Approvals — document required when approval is required

Owner decision: purchase approvers decide remotely from the uploaded files,
so a request raised with "Approval required" checked must carry at least one
document. Recurring items (payroll, standing vendor payments, office
maintenance — approval_required = 0) stay paperless.

### Done
- `src/worker/api/approvals.ts` create endpoint: 400 VALIDATION_ERROR when
  approvalRequired resolves true and no files attached (check sits after the
  per-file MIME/size validation, before comparison parsing).
- `src/pages/approvals.astro` create form: submit-time guard with red
  message; documents label states the rule.
- No edit-path change needed: approval_required is frozen at creation and
  attachments are add-only, so create is the only enforcement point.
- Tests: new 400 case proving the rule; every prior create of an
  approval-required item without files now seeds `pdfFile('quote.pdf')`
  (incl. seedPendingItem); edit-attachments test expects 2 files now.
- Docs: approvals.md spec (§3 create row, §4 Documents rule, §8 tests);
  guide.astro Step 2 explains the rule and the paperless exception.

### Verify
`npx vitest run src/worker/api/__tests__/approvals.test.ts` (74 passed);
full `npm run test:run`, `npm run typecheck`, `npm run typecheck:worker`,
`npm run build` clean.

---

## 2026-08-28 (session 24): Approvals user guide page (/approvals/guide)

Owner asked for a role-based user guide with screenshots, hosted in the
portal instead of an external AI-generated manual. Guide text uses generic
role names only (office admin, purchase approvers, finance approver, IT
admin), with no personal names or email addresses anywhere.

### Done
- Walked the full workflow in the local dev server as each role with dummy
  items ("Office water dispenser rental" end-to-end incl. AI analyse,
  PV26-0807) and captured 19 screenshots (1200x900) into
  `public/guide/approval/`: board, create form, comparison, AI preview,
  drawers, voucher form + print page, record payment, finance check,
  Settings cards.
- Anonymised local seed data first (display names to Office Admin /
  Purchase Approver / Finance Approver / IT Admin; created_by to
  office.admin@example.org; gibberish test titles, payees and descriptions
  rewritten) so no screenshot shows a real-looking name or address.
- New `src/pages/approvals/guide.astro`, reference-style layout: sticky
  topic list on the left (native drop-down on phones), one topic shown at
  a time, hash deep links, browser Back moves between topics, Previous /
  Next buttons per topic, screenshots enlarge in an in-page lightbox
  (pannable at 1000px wide on phones), purple border around every
  screenshot for separation, print expands all topics. Same audience gate
  as the board; committee members redirect to `/` (browser-verified).
- Approvals board got a "New to approvals?" banner with an Open the user
  guide button instead of an inline text link.
- Drawer fix found during capture: a purchase-stage rejected item showed
  "Purchase approved by / Approved at"; now labelled "Purchase decision
  by / Decided at (SG)" when the purchase decision was a rejection
  (approvals.astro, spec section 5 updated).
- Docs: ARCHITECTURE.md pages tree, approvals.md UI-rules row and drawer
  note.

### Verify
`npm run build` (27 pages) and `npm run typecheck` clean; guide checked in
Playwright at 1440px, 1200px and 375px (no horizontal overflow, images
render ~1070px wide at 1440px), lightbox and topic switching tested,
committee redirect confirmed.

---

## 2026-08-28 (session 23) — Approvals UI: senior-friendly CSS pass (browser-verified)

Owner asked for the approvals screen to be easier for older members on
desktop and phone. All changes CSS-only in approvals.astro's style block;
every fix measured in the live dev server with Playwright at 1200px and
375px, across admin, purchase-approver and finance-approver sessions.

### Done
- Size floor: board table 15.2px body / 12.8px heads (mobile override keeps
  14.4px where admin.css shrank to 12px), chips 13.6px, drawer labels
  12px captions with 16px weight-600 values, tabs 14.4px.
- Tap targets: page/View/Remove buttons and drawer close now 40-42px tall;
  checkboxes 20x20 (flex-shrink:0 — long labels were squeezing them to
  13px, a pre-existing bug).
- Inputs 1rem so Safari on iPhone stops auto-zooming the page.
- Hierarchy: dt/dd pairs split into quiet grey small-caps captions vs
  16px bold dark values, hairline divider per pair; form field labels
  (.ap-field > span) use the same caption family so Edit/create forms
  match; all form buttons 42px tall like the drawer action buttons.
- Scroll behaviour: .table-scroll uses the scrolling-shadow hint (fade on
  the cut edge, disappears when fully scrolled) plus contain:paint — the
  wide table was leaking to the page layer and letting the whole page pan
  633px into empty space. .ap-comparison-table switched to the
  responsive-table pattern (display:block + overflow-x) so the 558px AI
  table pans inside its own border box instead of dragging the drawer
  sideways; an earlier section-level attempt was rejected because it slid
  the AI summary off-screen.
- Contrast: inactive tabs/headers/pagination grey #6b7280 -> #4b5563 on
  small text (measured 4.63:1 before; nothing failed AA, this is margin).
  Focus-visible rings added for Remove buttons and checkboxes.

### Pre-deploy content-policy audit (same session)
- Checked CSP (_headers), robots.txt, worker response headers, Workers AI
  terms, Resend AUP, R2/D1 — nothing blocks any approvals feature; PDF
  iframes, inline images and canvas blob conversion are all covered by the
  existing frame-src/img-src directives.
- Fixed: wrangler.jsonc max_request_body_size 20 MB -> 110 MB. The old cap
  413-rejected legitimate multi-file creates (10 files x 10 MB is
  advertised) before the API's own limits ran. Effective ceiling is also
  plan-capped (~100 MB free) and zone WAF/bot settings start applying only
  once the custom domain serves traffic — post-deploy test from an outside
  network: OTP login, file upload, Analyse with AI.
- Spec updated: docs/specs/features/approvals.md — documents bullet now
  covers the 110 MB request-body cap; AI bullet covers the reader-failure
  note; §5 records the senior-friendly UI conventions and the drawer's
  purchase-approver display.

### Verification
- `npm run build` clean after each change. Measured before/after on every
  fix; screenshots archived (session temp dir). Role gating re-checked
  (approvers see no New request button; Approve/Reject for both stages).
- Desktop 1200px regression caught and fixed: bigger fonts overflowed the
  board table by 44px — cell padding trimmed to 0.75rem, fits exactly.

---

## 2026-08-27 (session 22) — AI analysis: friendly note when Cloudflare's reader fails

Owner's three mic-quote PDFs all failed Analyse with "Could not read this
document (Unexpected token 'e', "error code: 1031 " is not valid JSON)".
Retrying the same files later the same evening worked.

### Root cause
Cloudflare's toMarkdown backend answered with a plain-text edge error
("error code: 1031", undocumented, not on the status page) during a
transient degradation. The runtime tried to parse that text as JSON, and
the parse error is what the admin saw. Not a portal bug and not the files.

### Done
- ai-comparison.ts: new readerFailureNote() turns any error containing
  "error code: NNNN" into "Cloudflare's document reader failed on this
  file (Cloudflare error NNNN). This is usually temporary. Run Analyse
  again in a few minutes, or attach a photo of the quotation instead."
  All other failures keep the old cause-in-parens note. Single-attempt
  policy unchanged (plan §4.6).
- Regression test feeds the exact thrown message from 2026-08-27 through
  runAiComparison and checks the note. 266 total.

### Verification
- `npm run test:run` 266 passed (16 files). `npm run typecheck` 0 errors.
  `npm run typecheck:worker` clean. `npm run build` clean.

---

## 2026-08-27 (session 21) — Drawer: show who approved at the purchase stage

Owner noticed the drawer showed no approver while an item sits In finance
check. The API already returned `purchase_decision_by`/`purchase_decision_at`;
the drawer simply never rendered them.

### Done
- approvals.astro: two conditional detail-grid rows ("Purchase approved by",
  "Approved at (SG)") appear whenever a purchase decision exists — covering
  purchase_approved, finance_check, finance_approved and paid. Fields added
  to the ApprovalItem interface (they were already in the API SELECT).
- Finance approval keeps its existing "Payment approved by" line inside the
  voucher block, so both stages are now visible in the drawer.

### Verification
- `npm run typecheck` 0 errors. `npm run build` clean. Verified in the
  browser against the live In-finance-check item. Frontend only — no API or
  test changes.

---

## 2026-08-27 (session 20) — Bug: AI analysis silently dropped at create

Owner's fresh submission (tick files, run AI, edit the recommendation,
submit) produced an item with NO AI block in the drawer. D1 showed both
`comparison` and `ai_comparison` NULL on the new item.

### Root cause
The create-form submit only appended `aiComparison` when the typed
comparison table had rows, and those rows only count with a per-file
description. With AI doing the comparing, the owner ticked files without
typing descriptions — so `comparison.length === 0` silently discarded the
analysis (and its edited recommendation) she had just reviewed.

### Done
- approvals.astro submit now appends `aiComparison` whenever a preview
  exists; the typed comparison table stays independent.
- Regression test: create with `aiComparison` and deliberately NO
  `comparison` field stores the analysis and returns it parsed in the detail
  view. 265 total.
- Verified end to end after a dev-server restart; owner confirmed working.

### Verification
- `npm run test:run` 265 passed (16 files). `npm run typecheck` 0 errors.
  `npm run build` clean.

---

## 2026-08-26 (session 19) — AI summary/recommendation became editable fields

Owner decision: the AI analysis texts are fields like any other — editable
until the request is submitted for approval, frozen after, changeable again
only through the Edit button.

### Done
- Create form: the preview's summary and recommendation now render as
  textareas; whatever the admin leaves in them is what gets stored on submit.
- Edit form: textareas pre-filled from the stored analysis appear whenever an
  analysis exists; "Save changes" persists them via two new optional form
  fields (`aiSummary`, `aiRecommendation`, caps 4000/1000, empty clears to
  null).
- The edit endpoint updates the texts inside the same guarded UPDATE as the
  other fields, so the purchase-approval freeze covers them with no extra
  rule. Sending the fields without a stored analysis returns 400; an
  unreadable stored analysis returns 400 telling the admin to re-run Analyse.
- Drawer display stays read-only for every role.
- Tests +4 (edit persists + clears, 400 without analysis, 400 over cap, 409
  after purchase approval with the stored text unchanged). 264 total. The
  admin rotation pool in approvals.test.ts grew 12→20 emails because the new
  creates exhausted the shared write rate-limit bucket (the file's own
  documented pattern).

### Verification
- `npm run test:run` 264 passed (16 files). `npm run typecheck` 0 errors.
  `npm run typecheck:worker` clean. `npm run build` clean.

---

## 2026-08-26 (session 18) — AI analyse button: animated loading spinner

Owner asked for a visual progress cue while an AI analysis runs, instead of
the static "may take up to a minute" text alone.

### Done
- New pure-CSS `.ap-spinner` (rotating ring, brand purple) in approvals.astro,
  with a `prefers-reduced-motion` fallback that pulses opacity instead of
  spinning. No images, no emoji.
- Both working messages (create-form `#ap-ai-msg` and edit-form
  `#ap-edit-ai-msg`) render the spinner beside the text while a run is in
  flight; success/error messages replace it with plain text as before.
  Spinner is `aria-hidden` — the message spans are already `role="status"`.

### Verification
- `npm run typecheck` 0 errors. `npm run build` clean (26 pages). Frontend
  only — no test changes needed.

---

## 2026-08-26 (session 17) — AI regeneration moved into the edit form

Owner decision: the drawer's "Regenerate AI comparison" button duplicated
the edit path — any change to a request must start from the Edit button, and
the AI comparison must never change otherwise.

### Done
- Removed the drawer Regenerate button; the stored AI block in the drawer is
  now read-only for every role.
- Added an "Analyse with AI" button inside the drawer's edit form (visible
  for admins on editable items with ≥2 comparison rows while the kill-switch
  is off-hidden). Clicking it re-reads the ticked quotations and updates the
  stored analysis, then refreshes the drawer.
- Server-side enforcement: `POST /api/approvals/:id/analyse` now returns 409
  unless the item is editable (pending, or rejected at the purchase stage) —
  the same freeze rule as the item fields, so the rule holds for direct API
  calls, not just the UI.
- Regression test: purchase-approved item + analyse → 409. 260 total tests.
- Docs updated: features/approvals.md (API table, UI rules), ARCHITECTURE.md.

### Verification
- `npm run test:run` 260 passed (16 files). `npm run typecheck` 0 errors.
  `npm run typecheck:worker` clean. `npm run build` clean.

---

## 2026-08-26 (session 16) — Local re-test: analysis works; migration 011 applied locally

Owner re-tested locally after the session 15 fixes: the previously failing
PDF now analyses correctly end to end. Submitting the request then failed
with "Could not create the approval item" — the create INSERT writes the new
`ai_comparison` column, and the local D1 database predated migration 011.

### Done
- Diagnosed with a schema check (`PRAGMA table_info`): `ai_comparison` was
  missing from the local `approval_items` table.
- Applied `migrations/011_ai_comparison.sql` with `wrangler d1 execute
  --local`. Create now works; no code change was needed.

### Deployment reminder (before the next production deploy)
- Run `npx wrangler d1 execute swa-portal --remote
  --file=migrations/011_ai_comparison.sql` first, or production creates will
  fail the same way the local ones did.

---

## 2026-08-26 (session 15) — AI comparison: live-service fixes after local test

Owner tested locally with two real vendor PDFs; both failed with "extraction
returned unparseable JSON" and the console showed "this model does not support
pdf input". Diagnosed with throw-away probes against the live Workers AI
service (never committed), which found three real problems and one latent one.

### Done
- **Photo path was silently broken (latent bug).** The current runtime drops
  the legacy top-level `image:` field — the model answered "I'm not capable of
  processing images" while inventing JSON. Fixed: images now travel as
  OpenAI-style content parts inside the user message. Probe-verified: the
  model read "Acme Pte Ltd / S$1234.50" off a rendered image.
- **toMarkdown embeds runtime notices inside its data.** For image-heavy or
  scanned PDF pages it writes `ERROR: Cannot read "x.pdf" (this model does
  not support pdf input). Inform the user.` into the markdown instead of
  failing — the owner's PDFs hit exactly this, and that garbage became the
  "document text" fed to extraction. Fixed: notice lines are stripped; the
  PDF is skipped with an honest "attach a photo instead" note unless real
  text remains beyond the metadata header and page headings (toMarkdown emits
  `## Metadata` / `### Page N` even for empty pages).
- **Response shapes vary.** `run()` returns `response` as a fenced string, or
  as an already-parsed object when `guided_json` is used, plus a
  `choices[0].message.content` copy. New `responsePayload()` accepts all
  three. The comparison call now uses a `guided_json` schema
  (probe-verified on the 70b model).
- **End-to-end verified against the live service**: text PDF + photo through
  the real `runAiComparison` — both read correctly, S$ conversion from the
  live FX API, summary and recommendation produced.
- Tests: +7 (notice detection, mixed-text salvage, object-response parsing,
  responsePayload shapes, heading-only PDF skip). 259 total.
- Plan doc §4.2 corrected to record the real API shapes.

### Verification
- `npm run test:run` 259 passed (16 files). `npm run typecheck` 0 errors.
  `npm run typecheck:worker` clean. `npm run build` clean.
- Owner to re-test locally with the two Meridian/Crestline PDFs: text PDFs
  should now extract; scanned/image-only ones will show the honest per-file
  note.

---

## 2026-08-26 (session 14) — AI quotation comparison (approvals)

Implemented `docs/plans/AI-Quotation-Comparison-Plan.md` in full. Workers AI
reads the ticked quotations when the office admin raises a request, extracts
the common fields, converts prices to S$ in code, and writes a summary plus a
one-line recommendation, saved with the request for approvers to see.

### Done
- **Binding + types**: `"ai": { "binding": "AI" }` in wrangler.jsonc; minimal
  structural `AiBinding` interface in src/worker/types.ts (run + toMarkdown)
  so worker code never depends on the generated runtime-types file.
  Regenerated worker-configuration.d.ts.
- **Pipeline (new `src/worker/lib/ai-comparison.ts`)**: PDF text via
  `AI.toMarkdown`; photos + field extraction via llama-4-scout (vision);
  summary + value-based recommendation via llama-3.3-70b-fp8. S$ conversion
  in CODE from a daily FX table (open.er-api.com, free, cached 24 h in
  SWA_CONFIG `swa:ai_fx_cache`). Unreadable files get honest per-file notes.
  30 s timeout per AI call; single-attempt calls, no retry loops anywhere.
- **Endpoints**: `POST /api/approvals/analyse-preview` (form-time, stores
  nothing) and `POST /api/approvals/:id/analyse` (regenerate from the ticked
  comparison attachments in R2, stores the result, writes an
  `ai_comparison_generated` audit row). Guard order in both: role →
  kill-switch 503 → daily breaker 429 → validation, so no AI quota is spent
  on a request that cannot run. `POST /api/approvals` accepts the replayed
  analysis as `aiComparison` (strict shape validation, 128 KB cap) and never
  calls AI itself.
- **Abuse safeguards (plan §4.6)**: per-email rate bucket
  `approvals:analyse:post` (10/hour), portal-wide KV counter capping 50
  analyses/day, in-flight button lock in the UI, preview invalidation when
  quotations change, no auto-retries, per-call timeouts.
- **Kill-switch**: `swa:ai_config` in SWA_CONFIG written by the Settings page
  through the existing IT-admin-only `/api/admin/settings` (new allowlist
  entry + boolean validator). Missing key = enabled. Session exposes
  `ai_comparison_enabled`; page hides Analyse/Regenerate and shows a note
  while off.
- **Migration 011** + schema.sql: nullable `ai_comparison` TEXT column on
  approval_items.
- **UI (approvals.astro)**: "Analyse with AI" button + preview in the create
  form (with the disclaimer label, S$ table, FX date, skip notes); stored
  analysis block + "Regenerate AI comparison" in the drawer; HEIC photos
  converted to JPEG in the browser at pick time (canvas pattern from the
  membership page; browsers that cannot decode HEIC keep the file and the
  analysis notes it as unread).
- **Tests**: new ai-comparison.test.ts (24 tests: pipeline against a fake AI
  binding, JSON extraction, FX maths, kill-switch default, breaker, endpoint
  guards that return before any AI call, settings key) + 3 replay tests in
  approvals.test.ts. No test spends real AI quota.

### Verification
- `npm run test:run` 252 passed (16 files). `npm run typecheck` 0 errors
  (16 pre-existing hints). `npm run typecheck:worker` clean. `npm run build`
  clean (26 pages).
- Manual run in `npm run dev:worker` with real quotations still to do before
  production (the plan's verification section lists the sample set: text PDF,
  photo, HEIC, scanned PDF).

### Notes
- Local testing consumes real Workers AI quota — wrangler dev proxies AI
  binding calls to the live service. At ~10 analyses/month the usage sits
  far inside the free 10,000 Neurons/day.
- Word (.docx) support deliberately deferred (owner decision); the machinery
  supports it later with one allowlist line.

---

## 2026-08-26 (session 13) — AI quotation comparison: planning only

Owner asked whether the approvals "multiple quotations to compare" tick could
be linked to an LLM that reads the quotation files (PDF or photo), extracts
common fields, converts prices to S$, and writes a short summary plus a
one-line recommendation. Answer: yes, using Cloudflare Workers AI. Two
decisions sessions produced a full plan. **No code was changed this session.**

### Done
- Verified Workers AI capabilities against current Cloudflare docs (Aug 2026):
  `toMarkdown` reads PDFs, `.docx` and images; vision models read photos.
- Cost risk analysis for the owner's volume (about 10 analyses/month): one
  worst-case analysis costs under ~3,000 Neurons, the free allowance is
  10,000 Neurons/day, so the feature stays inside what is already free. A
  spike is capped four ways: login gate, per-user rate limit, IT admin
  kill-switch, and the free plan's hard daily ceiling.
- Owner decisions: Cloudflare Workers AI (no new accounts or packages);
  preview button in the form plus Regenerate in the drawer; existing
  PDF/image allowlist only (Word deferred); value-based recommendation;
  IT-admin kill-switch in Settings.
- **Plan saved to `docs/plans/AI-Quotation-Comparison-Plan.md`.** It covers
  the pipeline (toMarkdown for PDFs, vision model for photos, browser-side
  HEIC-to-JPEG, code-side S$ conversion from a KV-cached daily FX rate), two
  new endpoints, the `ai_comparison` column, the `swa:ai_config` KV
  kill-switch with server-side 503 enforcement, the full file list, and the
  verification plan.

### Next
- Implement the plan when the owner gives the go-ahead.

---

## 2026-08-25 (session 12) — Approvals hardening: race-safe writes + field freeze

Gap-review against gtw2026's safeguards and the docs/checklist set found six
gaps in the approval money path, plus a latent audit-integrity flaw. All fixed
in `src/worker/api/approvals.ts` (+ rate-limit.ts, approvals.astro, tests).

### Done
- **Race-safe decisions (gap 1 + a broader fix)**. A lost race (two approvers
  acting on the same item at once) used to leave a false entry in the
  insert-only audit log, because each handler ran `DB.batch([UPDATE, INSERT
  audit])` and the losing UPDATE matched nothing while the audit still wrote.
  New shared helper `applyTransition()` runs the guarded UPDATE first, then
  writes the audit row only if the change won. Used by approve, reject,
  finance-approve, finance-reject, paid, voucher and edit. The voucher save
  also re-states its status rule in the WHERE clause, so a second concurrent
  submit returns a 409 instead of overwriting the first set of lines.
- **Create leaves no untracked item (gap 2)**. The `item_created` audit row is
  written immediately after the item insert, before any file work, so an R2
  or attachment failure can no longer produce an item with no audit entry. If
  the audit write itself fails the item is rolled back. Files already uploaded
  are deleted on failure, and each failure message now says honestly what
  happened instead of a blanket "attachments could not be recorded".
- **Edit guarded (gap 3)**. The edit item-update re-checks the editable status
  in its WHERE clause and returns 409 on zero rows; uploaded files are cleaned
  up if the attachment batch fails.
- **Fields freeze at purchase approval (gap 4, owner decision)**. Editing is
  only allowed for `pending` items or items rejected at the purchase stage. A
  finance-stage rejection is corrected through the voucher editor only, never
  the item edit form. Updated the API gate, the resubmit routing, the approvals
  page `canEdit`, and the spec.
- **GET endpoints rate limited (gap 5)**. New `approvals:read:get` bucket
  (60/min per email) on the board list, item detail, attachment streaming and
  audit CSV, so one approver cannot loop the R2 route.
- **Polish (gap 6)**. Voucher and payment dates reject implausible years
  (typo like 2206 fails). The voucher email total sums in integer cents. The
  board list supports `offset`/`limit`/`total` so items beyond 500 are
  reachable.
- **Tests**: finance-reject item edit now expects 409 (was finance_check);
  +2 pagination, +1 spurious-audit regression (a second approving click writes
  exactly one `purchase_approved` row). 225 total.
- **Docs**: features/approvals.md (edit rule, freeze rule, read rate limit,
  audit-write note), Approval-Workflow-Implementation-Plan.md (audit
  pattern + 4th rate-limit key).

### Verification
- `npm run test:run` 225 passed (15 files). `npm run typecheck` 0 errors
  (16 pre-existing hints in unrelated files). `npm run typecheck:worker` clean.
  `npm run build` clean (26 pages).

### Owner steps before go-live
- Swap `APPROVAL_PURCHASE_APPROVER_EMAILS` and `APPROVAL_FINANCE_APPROVER_EMAILS`
  in `src/constants/portal.ts` from the dev shared inboxes to the real
  addresses (the comments mark them). Not a code safeguard; a go-live step.

---

## 2026-08-25 (session 11) — Approvals UI polish (CSS + micro-fixes)

Owner requested a visual polish of the approval pages — typography, spacing,
alignment, form controls and error visibility — with no layout or workflow
change. No database or API changes.

### Done
- **Shared (`src/styles/admin.css`)**: `.form-input` now sets `font-family:
  inherit`, so inputs/textareas/selects match the surrounding Inter text
  instead of the browser default (badly monospace-looking placeholders).

- **Board (`src/pages/approvals.astro`)**:
  - Amount column right-aligned with tabular figures; Voucher No/Date/Status/
    Created columns nowrap so dates no longer wrap to two lines.
  - Empty Voucher No/Date/Payee/Amount cells show an em dash (was blank).
  - Active sort header coloured (swa-2); `scope="col"` on all headers;
    View buttons get an aria-label with the item title.
  - Chips bumped to 0.78rem; `:focus-visible` outlines added to tabs, page
    buttons, View buttons and the drawer close (keyboard focus was invisible).

- **Drawer detail grid**: three columns (200px) → two columns (260px), so long
  emails fit on one line; labels now uppercase/tiny/muted with values at
  0.9rem for clear hierarchy. "Raised by", "Paid by" and "Payment reference"
  rows span both columns and never wrap. `word-break: break-word` replaced
  with `overflow-wrap: break-word` (only breaks when a word truly cannot fit).
  Voucher date formatted like other dates (25 Aug 2026) instead of raw ISO.

- **Forms**: field labels weight 500; checkboxes get `accent-color` (brand
  purple); file inputs get a branded `::file-selector-button`; sub-form panels
  (reject box, voucher form, paid form, edit form) got consistent margin-top
  and the finance-reject box was added to the panel style.

- **Error/success visibility**: `#ap-act-msg`, `#ap-create-msg` and
  `#ap-files-msg` render as full-width banners (left border + tint from
  `color-mix(currentColor)`), so errors read red-on-pink and successes
  green-on-mint automatically. Added `role="status"` + `aria-live="polite"`
  so screen readers announce them. Amount inputs got `inputmode="decimal"`.

- **Voucher print page** (`approvals/voucher.astro`): tabular figures on
  amounts, Date column nowrap. Kept its Arial print font (deliberate for PDF).

### Verification
- `npm run build` clean (26 pages).
- Browser smoke (dev:worker, admin identity): board (alignment, em dashes,
  one-line dates), paid drawer (email + payment reference on one line,
  formatted voucher date), create form (Inter placeholders, branded file
  button, purple checkbox), reject-inline error banner, members page
  unaffected by the shared font change, 390px mobile (horizontal scroll on
  the table still works).

---

## 2026-08-25 (session 10) — Approvals board UX + audit export date range

Owner decisions: the table leads the approvals page (form behind a button),
and audit exports must be bounded by a date range.

### Done
- **Board (`src/pages/approvals.astro`)**:
  - "New request" form collapses behind a New request button (admin only);
    opens on click, collapses on Cancel or successful submit (fields cleared,
    "Request raised." shown at the button). Default view = table.
  - Browser-side pagination: 20 rows/page, Prev/numbered/Next with ellipsis,
    "Showing X–Y of N"; resets to page 1 on tab or sort change. No API change.
  - Column sorting on all eight data columns (click to sort, click again to
    reverse; dates start newest-first, text A→Z; empty values sink last;
    Amount numeric, Voucher No natural order via localeCompare numeric).
  - Default tab changed from "For approval" to "All". Default sort
    (created_at desc) matches the API order so rows never jump on load.
- **Audit export** (`approvals.ts` + Settings card): `from`/`to`
  (YYYY-MM-DD) are required query params — missing/malformed/inverted → 400.
  SQL filters `created_at` between `<from> 00:00:00` and `<to> 23:59:59`
  (UTC, both days inclusive); filename carries the range. Settings page now
  has From/To date boxes; the Export button enables only when both are
  filled and From ≤ To (inline error otherwise).
- **Tests**: +2 (range filtering excludes out-of-window rows; 400 on
  missing/half/malformed/inverted params). Count 220 → 222.

Also (not code): local `.dev.vars` held a placeholder `RESEND_API_KEY`
(`re_dumm…`) — every approval email silently failed with Resend 401, logged
as RESEND_NOTIFY in `error_log`. Owner replaced it with the real key and
reminder emails now send locally.

### Verification
- `npm run test:run` 222 passed. typecheck + typecheck:worker + build clean
  (26 pages).
- Browser smoke (dev:worker, admin identity): form open/cancel/collapse,
  field clearing, default All tab, numeric Amount sort, Voucher No natural
  sort with empties last in both directions, pagination bar, Settings export
  disabled → error → enabled flow, API 200 (filtered, ranged filename) and
  400 (inverted, missing).

---

## 2026-08-24 (session 9) — Audit export restricted to IT admin + page button

Owner decision: the approval audit CSV is IT-admin eyes only. D1-category
admins (the office admin) lose access; approvers and committee never had it.

### Done
- **Middleware gate**: `/api/approvals/audit/export` added to
  `IT_ADMIN_ONLY_API` (src/worker/middleware.ts). Full path on purpose —
  the basePath `/api/approvals` would lock the whole approvals API. The
  handler's admin-tier check stays as belt-and-braces.
- **Page button**: lives on the Settings page (settings/index.astro), a new
  "Approvals — Audit Log" card with the CSV link. The Settings group is already
  IT-admin only (requireItAdmin), so no per-button session check is needed.
  The approvals board stays clean — no audit UI there. Previously the only
  access was typing the raw URL.
- **Tests**: `itAdminCookie()` helper (IT_ADMIN_EMAILS[0], seeded row).
  The 403 test now also covers D1 admins; the CSV test uses the IT-admin
  cookie. Count unchanged at 220.
- **Docs**: features/approvals.md API row, core spec §3.2 matrix row
  (Admin column No) + §3 note, ARCHITECTURE route table.

### Verification
- `npm run test:run` 220 passed. typecheck + typecheck:worker + build
  clean (26 pages).
- Browser smoke (dev:worker): bypass identity sees the Settings card and gets
  the 200 CSV; quick-login Jolene (admin, not IT) is turned away from Settings
  by requireItAdmin and the URL returns 403 "IT Admin access required."

---

## 2026-08-23 (session 8) — Specs reorganisation: core + per-feature docs

Owner decision: split the single 800-line functional spec. The docs folder
had already fragmented ad hoc (membership-form/, volunteer-form/, NAMECARD.md)
without a convention, and the big file carried stale v1.0 content plus a
confusingly named duplicate.

### Done
- **New structure**: `docs/specs/SWAPortal-Functional-Specs.md` rewritten
  as the v2.0 CORE (~230 lines: roles, permission groups, access
  conventions, feature×role matrix with links, auth, doc conventions,
  error codes). Per-feature specs in `docs/specs/features/`: approvals.md,
  gala-registration.md, members.md, office-booking.md, public-forms.md,
  namecards.md (+ the moved membership-form/ and volunteer-form/ folders).
- **Moved**: `docs/NAMECARD.md` → `features/namecards.md` (content
  unchanged + header pointer); the two form folders under features/ via
  git mv; `docs/registration/` stays (point-in-time records, linked).
- **Renamed**: `SWAPortal-Functional-Specification.md` →
  `SWAPortal-Owner-Guide.md` with a disambiguation header.
- **Stale content dropped in the rewrite**: old website-sync/namecard
  sections, dropped members columns (slug, show_on_website, socials —
  migration 006), the outdated "future features" tentative tables.
- **Boundary stated** (ARCHITECTURE §14 + core §5): ARCHITECTURE = how
  it's built; specs = what it must do + who may do it; plans = owner
  decisions in time; Owner-Guide = non-technical narrative.
- **New-feature rule** added to AGENTS.md + how-to-add-a-form.md: one
  matrix row + one feature spec file, same commit as the code.
- **References fixed**: ~20 `docs/NAMECARD.md` citations in src comments,
  AGENTS, ARCHITECTURE, the namecard plan's relative links.
  Point-in-time docs (ARCHITECTURE-ANALYSIS, old progress entries) keep
  their historical paths.

### Verification
- Link sweep: no remaining references to old paths outside historical
  records. Docs-only change — no tests needed; suite untouched.

---

## 2026-08-23 (session 7) — Approval workflow Phase 5 (finish) + test-stall root cause

Plan: `docs/plans/Approval-Workflow-Implementation-Plan.md` §14 Phase 5.
The workflow is complete end to end: raise → purchase → voucher → finance →
paid → export.

### Phase 5 done
- **Paid step** (`POST /api/approvals/:id/paid`, admin only, from
  finance_approved): who paid, payment date, method (paynow / bank_transfer
  / cheque / cash / other), optional reference. Atomic status flip to
  `paid`; `paid_recorded` audit carries the detail. Drawer "Record
  payment…" form + paid rows in the detail grid.
- **Voucher export page** (`src/pages/approvals/voucher.astro`, standalone —
  no AdminLayout, own noindex): renders the voucher like the June sample
  (PV no, date, payee, lines, TOTAL PAYABLE, "Prepared by" / "Payment
  approved by (approved <date>)", "No approval required" for recurring
  items), one Print / Save-as-PDF button hidden when printing. Board
  drawer gains a "View voucher" link once finance approved.
- **Audit CSV export** (`GET /api/approvals/audit/export`, admin tier
  only): joined with voucher numbers, oldest first, 5,000-row cap, BOM,
  shared injection-guarded csvEscape. Registered BEFORE the /:id routes.
- **Decision columns now store session names** (voucher prints "Prepared
  by: Jolene Lim", not an email); audit rows keep emails. The csv-guard
  tripwire caught the new exporter and demanded registration — working as
  designed.
- Tests: +9 (paid happy/optional-ref/validation/409s/403, CSV gates +
  format incl. formula-cell neutralisation). 220 total.
- Docs: ARCHITECTURE.md (82 routes, 26 pages, 220 tests, Phase 5
  paragraph); functional specs updated to v1.1 with the full approvals
  module (permission groups §2.3, API matrix §3.4, feature spec §5.11,
  UI rules §6.10, tables §7.6–7.8, key files). Known stale v1.0 content
  remains (Website Sync rows, dropped members columns) — separate task.

### Test-stall root cause (the session-6 note, investigated)
- Symptom: `npm run test:run` sometimes hung forever AFTER tests finished
  (results printed at ~2s, process never exited).
- Evidence: stack samples showed vitest and its workerd child both parked
  in `kevent`, each waiting on the other — a teardown deadlock in
  `@cloudflare/vitest-pool-workers`. `npm ls` also showed the installed
  pool-workers was 0.18.8 while package.json pinned ^0.22.0 (interrupted
  install at some point).
- Fixes: (1) `npm install` to the pinned 0.22.0 — three consecutive clean
  runs after; (2) belt-and-braces watchdog `scripts/test-run.mjs` now
  fronts `npm run test:run`: kills the process tree on 90s of silence or
  10 minutes total, exits 75 with a clear message so results remain
  readable. Env knobs: SWA_TEST_SILENCE_MS / SWA_TEST_MAX_MS.

### Verification
- `npm run test:run` 220 passed, exit 0, ~10s. typecheck + typecheck:worker
  + build clean (26 pages).
- Browser smoke: record payment → paid; voucher page renders PV26-0801
  with names; audit CSV downloads.

---

## 2026-08-23 (session 6) — Approval workflow Phase 4 (voucher + finance stage)

Plan: `docs/plans/Approval-Workflow-Implementation-Plan.md` §14 Phase 4.
Both approval stages now run end to end.

### Done
- **Voucher submission** (`POST /api/approvals/:id/voucher`, admin only):
  voucher date + line rows (negative amounts for deposits, note-only rows
  for bank details, total sums what exists). PV numbering
  `PV<YY>-<MM><NN>` from the voucher's own month: MAX+1 under the UNIQUE
  index, next-free retry ×3, 99/month cap returns a clear 400. The number
  survives finance rejection and resubmission unchanged. Status →
  `finance_check`; finance rejection fields cleared on resubmit; emails
  finance approvers (new / resubmitted).
- **Finance stage**: `finance-approve` / `finance-reject` (reason required)
  — isFinanceApprover only, atomic `WHERE status='finance_check'`, audit in
  the same batch, decision email to the creator. IT admins deliberately
  excluded (test proves 403 with a real IT-admin identity).
- **Routing**: finance-rejected items return straight to finance_check via
  voucher resubmit OR item edit; item-edit resubmit now also emails finance.
  Remind works at both waiting stages (`stage=purchase|finance` audit note).
- **Board UI**: voucher display block (no/date/payee, lines table, TOTAL,
  prepared/approved by); "Prepare voucher" / "Edit voucher & resubmit"
  (admin, purchase_approved or finance-rejected); "Approve voucher" /
  "Reject voucher…" (finance approver, finance_check); voucher form with
  add/remove lines, pre-fill from item, live total.
- **Numbering bug caught by tests**: first draft built `PV26-08-01` (extra
  dash) and a LIKE pattern that never matched — fixed to plan format
  `PV26-0801`.
- **Tests**: +19 (numbering sequence/new-month/99-cap, resubmission number
  retention, status guards, validation, finance gates incl. IT-admin 403,
  reason requirement, edit-resubmit routing, finance remind) + 5 email
  builder tests. 211 total. Test admins widened to 12 rotating identities;
  finance seed helper now fails loudly on 429 instead of cascading 409s.
- Docs: ARCHITECTURE.md (80 routes, 211 tests, Phase 4 paragraph).

### Not done (by design — later phases)
- Phase 5: paid step, standalone voucher export page (`/approvals/voucher`),
  audit CSV export.
- Note: `npm run test:run 2>&1 | tail` chained with && stalled twice in this
  session's shell; running each command separately completes in ~8s. Cause
  unknown — if it recurs, run checks one at a time.

### Verification
- `npm run test:run` 211 passed; typecheck + typecheck:worker + build clean.
- Browser smoke owed: prepare voucher → finance approve/reject → resubmit.

---

## 2026-08-23 (session 5) — Approval workflow Phase 3 (purchase stage)

Plan: `docs/plans/Approval-Workflow-Implementation-Plan.md` §14 Phase 3.
Stage one now runs end to end on the board.

### Done
- **`src/worker/lib/email-approval.ts`** (new): membership-email structure.
  Request email (new / resubmitted / reminder) → purchase approvers with
  description truncated to 500 chars; decision email → creator (approve
  points at the voucher step, reject shows the reason). Recipients are the
  named approver list only — the IT-admin union grants authority, not
  mailbox traffic. Resend, waitUntil, failures logged never fatal.
- **`approvals.ts`**: `POST /:id/approve` and `/:id/reject` —
  isPurchaseApprover re-checked in-handler, atomic
  `UPDATE … WHERE status='pending'` (second click 409), audit + state change
  in one batch, decision email to creator. `POST /:id/edit` — admin-only,
  title/payee/description/amount, add attachments (caps count existing),
  optional comparison rebuild validated against attachment ids
  (existing + new), `resubmit=true` routes by `rejected_stage`
  (purchase → pending, resets rejection fields) and re-emails approvers.
  `POST /:id/remind` — admin-only, pending-only, audit + reminder email.
  Create now emails approvers when `approval_required = 1`.
- **Board UI**: drawer action bar — Approve / Reject (reason box) for
  purchase approvers on pending; Send reminder and Edit (fields + add
  files + resubmit tick) for admins; `?item=<id>` deep link opens the
  drawer (the emails' target); drawer refreshes after every action.
- **Tests**: +21 (approve happy/race/403s/409-on-recurring, reject
  reason/400/403, edit fields+files/audits/resubmit routing/409s/403/
  foreign-comparison-400, remind 200/409/403) + 5 email-builder unit
  tests. 192 total. Test admins widened to 6 rotating identities — the
  shared-KV write bucket (10/15 min per email) counts validation-failing
  requests too, and Phase 2+3 together overflowed 3 identities.
- Docs: ARCHITECTURE.md (77 routes, 192 tests, Phase 3 roles paragraph,
  stale duplicate test-count line removed).

### Not done (by design — later phases)
- Phase 4: voucher form with numbering, finance approve/reject + emails,
  finance-check view. Phase 5: paid step, voucher export page, audit CSV.
- Comparison editing UI (API accepts it; edit form offers fields/files/
  resubmit only).

### Verification
- `npm run test:run` 192 passed; typecheck + typecheck:worker clean.
- Browser smoke of the full loop owed: create → approve → reject path →
  edit + resubmit → remind.

---

## 2026-08-23 (session 4) — Approval workflow Phase 2 (items and the board)

Plan: `docs/plans/Approval-Workflow-Implementation-Plan.md` §14 Phase 2.

### Done
- **`src/worker/api/approvals.ts`** (new): `GET /api/approvals?status=` (board
  list + per-status counts), `POST /api/approvals` (multipart create: fields,
  up to 10 files, comparison rows), `GET /api/approvals/:id` (detail with
  parsed comparison), `GET /api/approvals/:id/attachment/:attId` (R2 stream,
  `?download=1`, nosniff + sanitised Content-Disposition).
- **Create flow**: INSERT item → R2 uploads under `approvals/<id>/` → one
  D1 batch of attachment rows + the `item_created` audit row (plan §8:
  audit lands with the state change) → comparison stored with real
  attachment ids per §6. Recurring categories start at `purchase_approved`;
  `approvalRequired` flips the per-item default.
- **File safety** (plan §9): allowlist PDF/JPG/PNG/WebP/HEIC/HEIF
  (+ `image/jpg` alias, membership precedent), HTML and SVG always
  rejected, 10 MB per file, 10 files per item. Filenames are
  percent-decoded before sanitising (browsers encode `"` as %22).
- **`src/pages/approvals.astro`** (new): board with seven count-badged
  tabs, item table, read-only drawer (images inline, PDFs in iframes,
  comparison table with links), create form with per-file comparison
  builder. Admin-only create card; page gate redirects non-approvers.
- **AdminLayout**: "Approvals" nav item, visible to admin or either
  approver flag (the Phase 1 deferral).
- **Tests**: `approvals.test.ts` — 20 tests: role gates (plain committee
  403, both approvers read, finance cannot create), create validation
  (category defaults, override, HTML/SVG/oversize/11-file rejection,
  comparison mapping + phantom-file rejection), counts + status filter,
  detail, attachment stream headers (inline vs download, sanitised
  filename, cross-item 404). Admin identities rotate to stay under the
  approvals:write rate limit.
- Docs: ARCHITECTURE.md (73 routes, 25 pages, 16 tables live, 168 tests).

### Not done (by design — later phases)
- Phase 3: approve/reject, edit + resubmit, emails, remind button.
- Phase 4: voucher form, numbering, finance stage. Phase 5: paid step,
  voucher export page, audit CSV.

### Session 4 addendum — form improvements + two fixes (same day)

- **Description field**: optional textarea (4,000-char cap) on the create
  form — requester writes justification/context for approvers; stored on
  `approval_items.description` (migration 010, backported into
  `schema.sql`), rendered in the drawer, included in the detail API.
  Phase 3 should include it (truncated) in approval emails.
- **Comparison table is now opt-in**: a new "I have multiple quotations to
  compare" checkbox appears only when files are chosen; the per-file
  description rows appear only when it is ticked (a single quotation may
  span several uploads). Unticking clears the rows. Server still accepts
  comparison rows for any category (gate is UI-only).
- **CSP fix**: `public/_headers` `frame-src` gained `'self'` — the drawer's
  PDF iframe was blocked by the CSP (images were fine via img-src).
- **Page-script fix**: category labels are read from the `<select>` options
  instead of an inline JSON tag (Astro ships `{expression}` inside
  `<script>` unevaluated, which killed the whole page script).
- **Upload UX**: files now accumulate across multiple picker visits (the
  native input replaces its selection each time); chosen files render as a
  removable list with an "n of 10" counter, 10-file/10-MB caps enforced
  inline with messages, and typed comparison text + tick states survive
  adding/removing files (drafts keyed by name|size). Submit sends the
  accumulated list; server behaviour unchanged.
- Tests: +3 (description round-trip, 4000-char cap, files-without-
  comparison regression).

### Verification
- `npm run test:run` 168 passed; `npm run typecheck` 0 errors;
  `npm run typecheck:worker` clean. Manual smoke in `npm run dev:worker`
  still owed (log in as Jolene, raise an item, check the board).

---

## 2026-08-23 (session 3) — Approval workflow Phase 1 (foundation)

Plan: `docs/plans/Approval-Workflow-Implementation-Plan.md` (v2). Phase 1 is
plumbing only — no visible feature, no API handler, no pages.

### Done
- **Migration 009** (`migrations/009_approvals.sql`): `approval_items`
  (six-status CHECK, `UNIQUE voucher_no`, voucher + paid + comparison fields),
  `approval_attachments` (`UNIQUE r2_key`), `approval_audit_log`
  (insert-only). Idempotent; backported into `schema.sql` same commit.
- **portal.ts**: `APPROVAL_PURCHASE_APPROVER_EMAILS` (dev `approval@`,
  prod addresses commented for owner swap), `APPROVAL_FINANCE_APPROVER_EMAILS`
  (dev `finance@`; IT admins deliberately excluded),
  `isPurchaseApprover` (unions IT_ADMIN_EMAILS), `isFinanceApprover`,
  `canRaiseApprovalItem` (admin tier), `APPROVAL_CATEGORIES` (8, three
  recurring with no approval), caps 10 files/item + 10 MB/file.
- **Session flags**: `is_purchase_approver` / `is_finance_approver` added to
  all four `/api/session` reply branches + `SessionResponse`
  (`auth-gate.ts`).
- **Middleware gate 7c**: `/api/approvals` entry = admin or either approver,
  all methods; handlers enforce finer rules in later phases.
- **Rate limits**: `approvals:remind:post` (5/h), `approvals:review:post`
  (20/h), `approvals:write:post` (10/15m) with POST path routing.
- **Seed rows**: `approval@` (committee), `finance@` (committee), Jolene Lim
  (admin), all `can_login = 1`, owner test mobile.
- **Drive-by fix**: removed 4 stale address fields from the
  `namecard-svg.test.ts` fixture — a pre-existing `typecheck:worker` failure
  at HEAD (vitest never caught it because it skips type checking); leftover
  from the session 2 namecard restore.
- Docs: ARCHITECTURE.md counts (16 tables, 10 migrations), roles section,
  table list, migration-quirks note.

### Deferred to Phase 2
- AdminLayout "Approvals" nav item (no page exists yet — avoids dead link).
- Create/list endpoints, attachment stream, board page, audit writes.

### Verification
- `npm run test:run`, `npm run typecheck`, `npm run typecheck:worker` green;
  migration 009 applied to local D1.

---

## 2026-08-23 (session 2) — Namecards restored as board-only, auto-generated

Owner decision: restore (not delete). New rules, owner-confirmed:
board = `committee` + `advisor`; auto-created cards live immediately;
every card shows the SWA office address (409 Serangoon Central, #01-303,
Singapore 550409 — from the public website footer), never personal addresses.

### Done
- **Un-hidden** the four `/c/*` routes, `namecards.astro`, nav item, and
  `/c/*` in `run_worker_first` (all `DISABLED 2026-08` markers removed).
- **Board-only gate** at read time: `category IN ('committee','advisor')`
  in `namecard-public.ts` READ_QUERY + both queries in `namecard-photo.ts`.
  A demoted member's card 404s on the next request.
- **Office address only**: `SWA_OFFICE_ADDRESS` + `NAMECARD_BOARD_CATEGORIES`
  in `portal.ts`; HTML page + vCard render the office address; personal
  address columns removed from the public read query and `VcardMemberInput`.
- **Auto-generation**: `ensureBoardNamecards()` in `namecards.ts`; single
  create + bulk are board-only; members.ts auto-creates a card on member
  POST/PATCH into a board category and darkens it on demotion. Soft-fail so
  a card problem never blocks the member write.
- **Indexing/AI block**: robots.txt gets an explicit `Disallow: /c/` plus
  6 missing AI bots; `X-Robots-Tag` + meta robots extended to
  `noindex, nofollow, noarchive, nosnippet, notranslate, noimageindex`;
  HTML page route now IP-rate-limited like vcf/svg/photo.
- **Schema tidy (old next-step 2)**: namecards table + indexes backported
  into `schema.sql`; `db-helpers.ts` applies schema only; smoke test
  wording updated. Duplicate `005` migration rename NOT done (deferred).
- **Tests**: public tests restored + 6 new (category gates, office address,
  robots headers); admin tests get board-only bulk + hidden-stays-hidden;
  new `namecard-autogen.test.ts` (6 tests) covering member POST/PATCH
  card lifecycle. `namecard-vcard.test.ts` expects the office ADR.
- Docs: NAMECARD.md v2.2 restore banner, AGENTS.md status line.

### Verification + ship
- Local smoke test passed after applying migration 007 to the local D1
  (the table was missing — pre-tidy local rebuild; fixed via the documented
  `--local` command, data kept).
- Bulk button now reports real server errors (HTTP status + body snippet)
  instead of a blanket "Network error." — plain-text 500 pages from a
  crashed worker were previously indistinguishable from network failures.
- Tests 148/148, build 24 pages, `astro check` clean.
- Committed + pushed: `6590356` (restore) and `d2777d5` (button polish).
  Local D1 now has the namecards table; 12 committee cards generated and
  verified in the browser.

### Owner steps remaining
1. `npm run deploy` (not yet run at time of writing).
2. Post-deploy checks: `/robots.txt` shows `Disallow: /c/`; any `/c/*`
   shows the branded not-available page. Production has no board members
   yet, so 0 cards is expected — they auto-generate as board members are
   added.

### Note
Admin category 'member'/'volunteer' rows can no longer be given cards via
the API (400 "board members only"). An admin who wants a non-board card
must first set the member's category to committee/advisor.

---

## 2026-08-23 — Remediation deployed; CSV-guard fix + anti-drift guardrails

### Done
- **Deployed** the security remediation (`02799aa`) to production — owner ran
  `npm run deploy`. Tests 112/112 before deploy.
- **Fixed laughter-yoga CSV drift** — `laughter-yoga-reg.ts` carried a
  private, un-guarded `csvEscape` while volunteer/membership imported the
  shared guarded one (P4c had missed the copy). Now imports `lib/csv.ts`.
- **Corrected the architecture report** errata — remediation WAS committed
  (02799aa); `prod-dump.sql` already deleted; 9 migration files not 8;
  `NAMECARD.md` does carry a hidden-feature banner.
- **Anti-drift guardrails** so the CSV miss cannot repeat: tripwire test
  `src/worker/lib/__tests__/csv-guard.test.ts` (watches all 4 CSV exporters),
  pre-commit hook blocks private `csvEscape` copies, and
  `docs/how-to-add-a-form.md` checklist. Tests now 124/124.
- Deleted stray untracked `namecard-full.png` from repo root.
- AGENTS.md slimmed: Next Steps section removed, one pointer to this file.
- Global AI rules updated (beginner-friendly output; explain permission
  requests first) — outside this repo.

### Production note
Production D1 holds only the owner's login account — no member data yet, so
the empty live Members page is expected.

### Next steps (priority order)
1. **Namecard decision (owner)** — restore or delete the hidden feature.
   Recommend delete; git history keeps everything.
2. **Migration tidy-up** — two files share number `005`; roll migration 007
   (namecards) into `schema.sql` so fresh local DBs match prod.
3. **Docs consolidation** — merge the two functional specs into one; add a
   "never executed" banner to `docs/plans/astro-refactor-plan.md`.
4. **Member directory pagination** — only when the member list grows.
5. **Form engine + Astro refactor** — deferred until a 4th form is needed;
   follow `docs/how-to-add-a-form.md` until then.
6. Carried over from previous tracker: Phase 2B fee reminders (cron),
   Phase 2C/3 (member self-service, CMS, MS Forms migration), domain
   transfer for `admin.singaporewomenassociation.org`.

---

## 2026-08-22 — Security remediation plan fully implemented (pending deploy)

Executed `docs/plans/security-remediation-plan.md` end-to-end (P1–P4). Full
file list + verification record in that doc's "Implementation Log" section.

### Highlights
- **P1 critical fixed** — sessions are now revalidated against D1 on every
  authenticated request (`session-revalidation.ts`). Demotions, `can_login=0`
  lock-outs and soft-deletes kill the session immediately; role changes
  re-sign the cookie without extending its expiry. 6 new integration tests.
- **P2** — public namecard surface hidden: `/c/*` routes commented out,
  `namecards.astro` → `_namecards.astro`, nav link removed, `run_worker_first`
  tidied. Everything restorable via the DISABLED-2026-08 marker comments.
- **P3** — stored XSS closed: members table render escapes all member fields;
  `fullName` allowlist (letters/spaces/`.'`-`, max 100) enforced on the
  public membership form; three secondary sinks escaped.
- **P4** — NRIC removed from member API responses (`MEMBER_COLUMNS`), per-
  endpoint rate limits (magic-link 5/h etc.), shared CSV-injection-safe
  `csvEscape` (`lib/csv.ts`), JSON-LD `\u003c` escaping, bookings input
  validation, dev-bypass host wildcard removed.

### Gotchas found today
- **4e deviation**: `wrangler dev` presents `c.req.url` as
  `admin.singaporewomenassociation.org` (the configured route), NOT
  localhost — verified via temp log line. Loopback-only host check broke the
  dev-login picker; kept an exact `SWA_ADMIN_DOMAIN` exception alongside the
  two prod fail-closed anchors. Details in remediation plan §4e note.
- **Local D1 is stale** (pre-migration-005): `GET /api/members` now 500s
  locally because the explicit column list names `membership_status` etc.
  Prod is unaffected (migration 005 applied 19-07-2026). Fix locally when
  convenient: `npm run db:setup` + apply migration 007 (user-invoked only).

  **RESOLVED 2026-08-22 (additive path, data kept):** applied migrations
  004 (+ the two commented-out ALTERs `members.nric`,
  `memberships.application_id`), 005, 005_pdpa, 007, 008 to the local DB
  via `node ./node_modules/wrangler/bin/wrangler.js d1 execute swa-portal
  --local --file=...`. **006 was skipped locally** — the local table has
  `slug TEXT UNIQUE` inline, and SQLite cannot drop an inline-UNIQUE column
  without a table rebuild; the 11 columns are dead code anyway and vanish on
  any future `db:setup`. Migration 006's statement order (drop columns
  before the index) also fails on fresh local DBs — consider reordering if
  it ever needs to run locally. Backup of the pre-migration sqlite file:
  `...miniflare-D1DatabaseObject/373179...sqlite.backup-pre-migrations-20260822`.

### Not done (by design)
- **Production deploy** — owner-gated. Code is ready: tests 112/112, build
  clean, `astro check` clean. Deploy with `npm run deploy` after confirming
  migration 007 status on prod (namecards table — see 2026-07-25 entry).
- Migration 007 backport into `schema.sql` still open (local-dev gotcha
  from 2026-07-25 entry).

---

## 2026-07-25 — Namecard feature (Phases 0–4 done, 1 bug outstanding)

> **Update 2026-08-22:** the QR clipping bug below was fixed in commit
> `117a31f` ("stop QR canvas being clipped on /c/:slug preview"). The
> "OUTSTANDING BUG" section is historical.

**Spec**: `docs/NAMECARD.md`. **Plan**: `docs/plans/Namecard-Implementation-Plan.md`.
**Continued in opencode** (zcode session has no browser MCP — can't see the rendered canvas, which made the QR debugging cycle painful).

### What's implemented & working
- **Migration 007** (`migrations/007_namecards.sql`) — namecards table + UNIQUE indexes. ⚠️ **Owner must run `wrangler d1 execute swa-portal --remote --file=migrations/007_namecards.sql` before the deployed code works** (it's not auto-applied by `db:setup` either — see "Local-dev gotcha" below).
- **Pure libs** (`src/worker/lib/namecard-{slug,sanitize,vcard,svg,qr,rate-limit,photo}.ts`) — all unit-tested.
- **Public routes** (`/c/:slug`, `/c/:slug/contact.vcf`, `/c/:slug/card.svg`, `/c/:slug/photo`) in `src/worker/api/namecard-public.ts`. IP rate-limited. Branded 404 for hidden/soft-deleted cards.
- **Admin CRUD** (`/api/namecards/*`, 11 endpoints) in `src/worker/api/namecards.ts`. Writes admin-gated via `ADMIN_WRITE_API` in `src/worker/middleware.ts`. Slug collisions → 409 with suggestion. Photo upload ≤2 MB, JPEG/PNG/WebP server-enforced.
- **Admin UI** `src/pages/namecards.astro` — table, edit drawer, bulk create, photo upload (client-side canvas crop), self-service panel showing the logged-in user's own card.
- **Nav entry** added to `src/layouts/AdminLayout.astro`.
- **Phase 4** atomic soft-delete — `DELETE /api/members/:id` now `DB.batch`-es the member soft-delete + `namecards.has_namecard=0` in one transaction.
- **Test harness**: vitest + `@cloudflare/vitest-pool-workers` (Miniflare emulates D1/KV/R2). `npm test` → **113 passing**. Config: `vitest.config.ts`, helpers: `test/db-helpers.ts`. Tests run serially (`fileParallelism: false`) because they share a D1 isolate.

### 🔴 OUTSTANDING BUG — pick up here
**The QR code on the public preview page (`/c/{slug}`) renders cut off on the left and right — not a full square.** The downloaded QR PNG is fine and scans; only the on-page canvas is broken.

What I know:
- `<canvas class="nc-qr-canvas" width="660" height="660">` (was 512, bumped to 660 trying to fix a scan-quality bug — that may or may not have helped; the cut-off issue is separate).
- `.nc-qr-canvas { width: 220px; height: 220px; }` in `public/namecard-public.css:259` — CSS is square, so the cut-off isn't an aspect-ratio issue at that rule.
- Parent `.nc-qr` is the QR section; the card container `.nc-card` has `overflow: hidden` (line 53 of namecard-public.css) — **likely culprit**: something is wider than its container and getting clipped. Worth checking `.nc-qr-actions`, the `.nc-card` max-width, and any padding/flex on `.nc-qr` itself.
- The QR is drawn by `public/js/namecard-qr.js` via `window.QRCode.toCanvas(canvas, payload, { width: canvas.width, ... })`. The library reads `canvas.width` (660) so the QR should fill the backing store.

**To debug** (zcode couldn't do this):
- Open `/c/{slug}` in a browser, DevTools → inspect `<canvas class="nc-qr-canvas">`.
- Computed tab: `width`, `height`, `box-sizing`, `padding`, `margin`, `border`. Look for non-zero horizontal padding/margin on the canvas or a parent that's narrower than 220px.
- Right-click canvas → Save image as. If the saved PNG is square and complete, it's a CSS clipping issue (probably `overflow: hidden` somewhere + canvas wider than parent). If the saved PNG is also cut off, the QRCode library is drawing with a margin/width mismatch.
- Most likely fix candidates: drop `overflow: hidden` on `.nc-card` (or scope it to just the header), or check the canvas has `box-sizing: border-box` and no implicit padding.

### Over-engineering I added that the user pushed back on (don't repeat these mistakes)
- `scripts/generate-swalogo-ts.mjs` generates `src/worker/lib/swalogo-generated.ts` from `public/swa-logo.webp`. It exists because the **server-rendered** card SVG needs the logo inlined as a data URI (external `<img src="/swa-logo.webp">` would taint the canvas PNG export). The **client-side** QR overlay does NOT use the generated file — it loads `/swa-logo.webp` directly via `new Image()` (matches the proven PayNow QR pattern in `src/pages/reg/membership/register.astro:142-205`).
- I briefly tried `acorn` / `node:vm` / a prebuild syntax-check script to catch a JS typo. **Removed.** `node --check public/js/namecard-qr.js` is enough if you suspect a parse error.
- I shipped a stray `}` in `public/js/namecard-qr.js` that broke the whole script. The 113 worker-side tests passed because they don't load that file. **Lesson: if you edit hand-written browser JS in `public/js/`, run `node --check` on it before claiming it works.**

### Local-dev gotcha
`npm run db:setup` rebuilds from `schema.sql` only — it does NOT apply `migrations/007_namecards.sql`. After running `db:setup`, you must also run:
```
node ./node_modules/wrangler/bin/wrangler.js d1 execute swa-portal --local --file=migrations/007_namecards.sql
```
Otherwise `/namecards` and `/c/*` all 500 with "no such table: namecards". (The shell's `wrangler` shim is intercepted by something — call the binary directly from `node_modules`.)

The cleaner fix is to backport the `namecards` table into `schema.sql` (the rolled-up baseline), matching how migration 003's `deleted_at` column was backported. That would let `db:setup` pick it up automatically. **Not done** — open question for next session.

### Not done (by design — owner-gated, manual)
- **Phase 5**: swa2024 cleanup PR — remove old namecard code from the sibling `~/Documents/Projects/swa2024` repo. Separate PR after smoke.
- **Phase 6**: production go-live — owner runs `wrangler d1 export` (backup), `wrangler d1 execute --remote --file=migrations/007_namecards.sql`, `npm run deploy`. Per `AGENTS.md` §0 + the project's `AGENTS.md` "Safety Standards", no agent runs `--remote` commands.

### Open design decisions (plan §17)
- Badge logo: currently uses `/swa-logo.webp` (same as admin nav + PayNow QR). Working.
- Font inlining: card SVG uses system fallback stack (`Poppins, 'Segoe UI', Roboto, sans-serif`). Pixel-perfect Poppins would require base64-embedding ~150KB into each card SVG. Deferred.
- `swa2024` `/namecard/*` redirects (301 vs 404) — owner decides.

---

## 2026-07-05

### Done
- **Fixed drawer panel always visible on `/admin/forms/membership`** — the detail
  drawer's `.drawer-overlay { display: flex }` was overriding the `hidden`
  attribute, so the empty panel rendered in front of the page on load. Added
  `.drawer-overlay[hidden] { display: none; }` in
  `src/pages/admin/forms/membership.astro` (matches the existing pattern in
  `src/styles/admin.css` for `.new-booking-form[hidden]` and
  `.mobile-drawer:not([hidden])`). Build verified.

### Notes
- The membership admin page (`src/pages/admin/forms/membership.astro`) and its
  API (`src/worker/api/membership-reg.ts`) shipped in commit `5684268` and look
  feature-complete: list view, detail drawer, approve/reject workflow, PayNow QR,
  signature pad, image rendering, CSV export. No known issues beyond the drawer
  bug fixed today.
- The public membership registration form lives at
  `/reg/membership/register` (`src/pages/reg/membership/register.astro`), styled
  via `src/styles/membership-form.css`.

### Next steps (pick up here)
- **Phase 1D** — Office booking calendar UI
  (see `docs/plans/SWAPortal-Implementation-Plan.md`).
- **Phase 1E** — Namecard management UI + photo upload.
- **Phase 1F** — Member directory with search/filter/pagination.
- Domain transfer: configure `admin.singaporewomenassociation.org` custom domain.
- Smoke-test the membership drawer fix in `npm run dev` (close button, backdrop,
  Escape) since today's verification was build-only.

### Untested changes this session
- The drawer fix was confirmed by `npm run build` (22 pages built cleanly) but
  not by manual browser click-through.

---

## Previously completed (carried over from earlier sessions)

### Volunteer registration form — COMPLETE
- Public form at `/reg/volunteer/register` (`src/pages/reg/volunteer/register.astro`,
  themed via `src/styles/volunteer-form.css`), backed by
  `src/worker/api/volunteer-reg.ts` (config GET + register POST), Turnstile
  required, D1 storage in `volunteer_registrations` table.
- Admin viewer at `src/pages/admin/forms/volunteer.astro` with date filters
  (All / 1 Aug / 8 Aug), client-side sorting, vertical scroll, CSV export.
- UI polish pass done (Inter-only typography, mobile stacking, static submit bar).
- Remote D1 schema migration may still be pending — verify before deploy.
