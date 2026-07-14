# Top Flaw: Stale Session Privilege Escalation

## Finding

The original brute-force flaw on `/api/verify-otp` has been fixed in the latest code. The current top flaw is **stale session privilege escalation**.

In `verify-otp.ts`, the user's `role` is determined once at login time and baked into the session cookie payload:

```typescript
let role: string;
if (isItAdmin) {
  role = 'admin';
} else if (member && member.category === 'admin') {
  role = 'admin';
} else {
  role = 'committee';
}
```

The middleware (`middleware.ts`) only checks `session.role` on every request — it never re-validates the user's current role against the D1 `members` table or the `IT_ADMIN_EMAILS` list.

## Why This Is Critical

1. **Privilege revocation is ineffective** — If an admin is demoted (e.g., `category` changed from `admin` to `exco`, or removed from `IT_ADMIN_EMAILS`), their existing session cookie still grants admin access for the full session lifetime.
2. **"Remember me" extends exposure to 30 days** — A demoted IT admin with a remembered session retains full admin privileges for up to a month.
3. **No server-side re-validation** — The auth middleware trusts the cookie completely; the database is never consulted for role checks.

## Impact

A former admin or committee member whose access has been revoked in the database can continue performing admin actions (member CRUD, sync-website, etc.) until their session cookie expires or they explicitly log out.

## Fix Summary

Re-validate the user's role from D1 on every authenticated API request (or at least on admin-restricted endpoints). The middleware should:

1. Look up the member's current `category` and `can_login` status from `members` table using `session.email`.
2. Recompute the effective role (respecting `IT_ADMIN_EMAILS` override).
3. If the computed role differs from `session.role`, either:
   - Reject the request with 401 and force re-login, or
   - Downgrade the role transparently for that request.
4. If `can_login = 0`, immediately invalidate the session.
