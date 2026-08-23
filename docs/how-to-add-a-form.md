# How to add a public form (checklist)

This is the rulebook for adding a fourth public form (after volunteer,
membership and laughter-yoga). Read it fully before writing any code.

> **Docs rule** (all features, not just forms): a new feature means one row
> in the feature matrix in `docs/specs/SWAPortal-Functional-Specs.md` plus
> one spec file in `docs/specs/features/` (template in that file's §5).
> Update them in the same commit as the code.

## The one big rule

**Never copy an existing form file and change the table name.** The three
current forms were built that way, and it caused a real security bug: the
laughter-yoga form had a private copy of the CSV export code that was missing
the fix which stops spreadsheets running formulas typed into form fields.
Copy-paste means fixes only reach the copies someone remembers.

Instead: import the shared helpers, write only what is unique to your form.

## The shared helpers you must reuse

| Need | Import from | What it does |
|---|---|---|
| CSV export cells | `src/worker/lib/csv.ts` (`csvEscape`) | Quotes cells and neutralises formula injection (`=`, `+`, `-`, `@`) |
| Rate limiting (authed endpoints) | `src/worker/lib/rate-limit.ts` | Caps writes per user per window |
| Error logging | `src/worker/lib/error-handler.ts` (`handleApiError`) | Returns JSON and writes to the `error_log` table |
| Turnstile verify | Copy the pattern, not a private copy — see "wiring" below | Blocks bots on public forms |

## Steps, in order

1. **Database**: write a new numbered migration in `migrations/` (next free
   number — check for duplicates). Add the table to `schema.sql` at the same
   time so fresh local databases match production.
2. **Constants**: any fixed numbers (rate limits, notify emails, fee amounts)
   go in `src/constants/portal.ts`. No magic numbers inside handlers.
3. **Handler**: create `src/worker/api/<your-form>-reg.ts`. Import `csvEscape`,
   `handleApiError` and shared logic; define only your form's validation and
   fields. Look at `volunteer-reg.ts` for the shape, but do not paste from it.
4. **Middleware**: add your public path prefix to `src/worker/middleware.ts`
   (the `PUBLIC`-style set for your form, with a comment saying Turnstile is
   verified in the handler).
5. **Routes**: register the routes in `src/worker/index.ts`.
6. **Page**: create the Astro page under `src/pages/`. For Turnstile setup on
   the front end, mirror an existing form page's script.
7. **Tripwire (required)**: add your handler's path to the `EXPORTERS` list in
   `src/worker/lib/__tests__/csv-guard.test.ts`. That test fails if any export
   endpoint defines its own `csvEscape` or is missing from the list.
8. **Verify**: run `npm run test:run`, `npm run typecheck` and
   `npm run typecheck:worker`. All must pass. The pre-commit hook also refuses
   any commit containing a private `csvEscape` copy.

## Why the tests and hook exist

- `csv-guard.test.ts` feeds formula payloads to the shared escaper and checks
  every export endpoint is wired to it. If a future copy drifts, `npm test`
  fails the same day instead of months later.
- The pre-commit hook greps staged files for private `csvEscape` definitions.
  It is a seatbelt, not a substitute for the test.

## Longer term

The real cure is one shared "form engine" (one module handling Turnstile,
rate limits, validation, CSV export and notification emails, so each form is
just a field list plus config). That refactor is planned but not started —
see `docs/ARCHITECTURE-ANALYSIS-2026-08-22.md` Flaw 1 and recommendation 5.
Until it exists, this checklist is the safety net.
