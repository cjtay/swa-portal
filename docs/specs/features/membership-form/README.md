# Membership Registration — Documentation

This subfolder documents the **public membership registration form** at `/reg/membership/register`, the **admin approval workflow**, and the **member lifecycle management** features (fee tracking, payment recording, status management).

## Files in this subfolder

| File | Audience | Contents |
|------|----------|----------|
| `README.md` (this file) | Everyone | Index and navigation |
| `Membership-Registration-Functional-Spec.md` | Product owners, admins, support | What the system does from the user's perspective |
| `Membership-Registration-Technical-Spec.md` | Developers, operators | How it is built, security/resilience posture, known gaps |

## When to read which

- **You are an approver** (Angela, Roxanne, IT admin) → Functional Spec §7 (Approval workflow) and §8 (Admin submissions view).
- **You are configuring fees or PayNow** → Functional Spec §5 (Fee model) and §6 (PayNow QR); Technical Spec §8 (PayNow QR implementation).
- **You are debugging a failed submission** → Technical Spec §7 (Resilience & observability) and §10 (Configuration & deployment — error_log queries).
- **You are adding a field or changing validation** → Functional Spec §4 (Form fields); Technical Spec §4 (Request/response contracts) and §5 (Validation rules).
- **You are recording a payment or managing member status** → Functional Spec §9 (Members page lifecycle).
- **You are reviewing security posture** → Technical Spec §6 (Security measures) and §9 (Known limitations).

## Related docs elsewhere in `docs/`

- `docs/plans/membership-lifecycle-plan.md` — the forward-looking design plan for the full lifecycle (Phase 2 cron, email reminders, auto-inactivation). This spec documents the **as-built** system; the plan tracks what's coming next.
- `docs/plans/membership-lifecycle-testing-strategy.md` — staging and testing plan for Phase 2 features.
- `docs/specs/SWAPortal-Functional-Specs.md` — portal-wide role access matrix (the membership admin views inherit the admin/committee tier from here).
- `docs/plans/SWAPortal-Implementation-Plan.md` — overall implementation tracker.

## Release history (most recent first)

| Date | Change | Files touched |
|------|--------|---------------|
| 2026-07-15 | **Revert `committee→exco` rename** — dropped the planned category rename; `committee` retained. Reverted dropdowns/defaults/comments to `committee`. No data UPDATE required. Updated 13 docs. | `src/pages/members.astro`, `src/worker/api/members.ts`, `src/worker/api/verify-otp.ts`, `schema.sql`, `migrations/005_membership_lifecycle.sql`, 13 doc files |
| 2026-07-14 | Lifecycle rewrite: approve flow rewritten with gtw2026 patterns (atomic batch, `isMembershipApprover` gate, tier-resolve by submission month, next-31-Jan `fee_due_date`); members page UI (status/fee_due/waived columns, record-payment modal); payment API; server hardening (idempotent retry, `waitUntil`, `request_body` in error_log); `committee → exco` code changes; migration 005 written | `src/worker/api/membership-reg.ts`, `src/worker/api/members.ts`, `src/pages/members.astro`, `src/constants/portal.ts`, `src/worker/lib/log-error.ts`, `schema.sql`, `migrations/005_membership_lifecycle.sql` |
| 2026-07-13 | Form simplification: removed NRIC/address/DOB/citizenship/occupation/hobbies/skills/associations/intent/telephone from the public form; replaced Declaration with PDPA consent; referrer placeholder → "SWA Board Member"; tiered fees wired; `MEMBERSHIP_APPROVER_EMAILS` constant added | `src/pages/reg/membership/register.astro`, `src/worker/api/membership-reg.ts`, `src/constants/portal.ts`, `migrations/005_pdpa_consent.sql` |
| 2026-05-11 | Initial membership application form (schema, API, page, CSS) | `schema.sql`, `src/worker/api/membership-reg.ts`, `src/pages/reg/membership/register.astro`, `src/styles/membership-form.css` |
