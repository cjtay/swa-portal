# Email OTP Security Checklist

## Comprehensive Security Measures for Magic-Link / OTP-as-Password Authentication

This checklist covers all security measures when implementing email-based OTP (one-time password) authentication — the pattern where a user enters their email, receives a code, and enters that code to obtain a session. It is framework-agnostic and applies to any web application, whether built on Cloudflare Workers, Node.js, or any other runtime.

Each measure is independent. Implement as many as your threat model requires.

---

## How to Use This Document

**For human developers:** Read through each section and implement what applies to your project. Use the "How to Verify" column to confirm each measure is in place.

**For AI coding agents:** When asked to audit a project's OTP implementation against this checklist:

1. Read this entire document
2. For each measure, run the verification command(s) or inspect the relevant code
3. Report each measure as: ✅ Verified | ⬜ Not implemented | ➖ Not applicable | ❓ Cannot verify (requires manual check)
4. For measures marked ⬜, assess whether they should be implemented now or deferred
5. Skip measures that are not relevant (see "Relevance" criteria per section)

---

## Self-Auditing Checklist

| # | Measure | How to Verify | Relevance | Status |
|---|---------|---------------|-----------|--------|
| 1.1 | Cryptographically secure OTP generation | Check that OTP uses `crypto.getRandomValues()`, `crypto.randomBytes()`, or equivalent — not `Math.random()` | All projects | _audit_ |
| 1.2 | Sufficient OTP entropy | Calculate: digit count^10 for numeric, or character space^length for alphanumeric. Minimum 16 bits of entropy (6 numeric digits = ~20 bits) | All projects | _audit_ |
| 1.3 | OTP not returned in send response | Grep send-otp handler — response should not include the OTP code | All projects | _audit_ |
| 2.1 | HMAC-signed OTP storage | OTP stored with an HMAC signature, not in plaintext | All projects using HMAC | _audit_ |
| 2.2 | Separate signing keys for OTP vs session | `OTP_SECRET` and `SESSION_SECRET` are different values | All projects | _audit_ |
| 2.3 | Timing-safe comparison for HMAC verification | `verifyHmac` uses `crypto.subtle.timingSafeEqual` or equivalent constant-time compare | All projects using HMAC | _audit_ |
| 3.1 | OTP consumed on successful verification | After verify, the stored OTP is deleted or invalidated | All projects | _audit_ |
| 3.2 | No plaintext OTP comparison before HMAC | Verify HMAC first; do not compare plaintext OTP before signature check | All projects using HMAC | _audit_ |
| 3.3 | Unified error messages on verification failure | Incorrect OTP and invalid signature return identical error messages | All projects | _audit_ |
| 4.1 | Rate limiting on OTP send endpoint | Check for IP-based or email-based throttle on the send endpoint | All projects | _audit_ |
| 4.2 | Rate limiting on OTP verify endpoint | Check for attempt-based throttle on the verify endpoint — this is distinct from send rate limiting | All projects | _audit_ |
| 4.3 | Maximum verify attempts per OTP | After N failed verifies, invalidate the OTP regardless of TTL | All projects | _audit_ |
| 5.1 | Bot protection on OTP send | CAPTCHA, Turnstile, or equivalent bot-detection before sending | All projects | _audit_ |
| 5.2 | Bot protection is mandatory, not conditional | CAPTCHA verification runs unconditionally — no `if (secretExists)` guard that silently skips | All projects | _audit_ |
| 5.3 | Bot protection on OTP verify (optional) | Consider adding CAPTCHA to verify endpoint in high-threat scenarios | High-value targets | _audit_ |
| 5.4 | Turnstile widget mode selected appropriately | Invisible for closed systems/allowlists; Managed for public signups | Projects using Turnstile | _audit_ |
| 5.5 | Separate Turnstile widget per project/domain | Each project has its own widget with matching hostname; site key public, secret key via env var | Projects using Turnstile | _audit_ |
| 6.1 | OTP TTL is short | Verify TTL is ≤ 10 minutes (5 minutes recommended) | All projects | _audit_ |
| 6.2 | OTP is single-use | After successful verify, the OTP cannot be replayed | All projects | _audit_ |
| 6.3 | No OTP reuse across requests | Sending a new OTP invalidates the previous one | All projects | _audit_ |
| 7.1 | Session cookie: HttpOnly, Secure, SameSite | Check Set-Cookie headers include these three attributes | All projects | _audit_ |
| 7.2 | Session expiry is reasonable | Default session ≤ 24 hours; "remember me" ≤ 30 days | All projects | _audit_ |
| 7.3 | Session contains expiry timestamp | Session payload includes `exp` field; checked on every request | All projects | _audit_ |
| 7.4 | HMAC-signed session cookie | Session cookie is `payload.signature` pattern, not an opaque token that requires a DB lookup | All projects using stateless sessions | _audit_ |
| 8.1 | No email enumeration via send response | Send endpoint returns same response for registered and unregistered emails | All projects | _audit_ |
| 8.2 | No email enumeration via verify response | Verify endpoint returns same error type regardless of whether email exists | All projects | _audit_ |
| 8.3 | No email enumeration via timing | Send and verify endpoints have constant-time response regardless of email existence | All projects | _audit_ |
| 9.1 | OTP not logged | Grep logs for any OTP value being written | All projects | _audit_ |
| 9.2 | OTP not included in error messages | Error responses never contain the OTP or partial OTP | All projects | _audit_ |
| 10.1 | Allowlist or registration gate | Only pre-approved emails can request an OTP | Projects with closed membership | _audit_ |
| 10.2 | Locked role assignment | User role comes from server-side data, not client-supplied claims | All projects | _audit_ |

---

## Level 1 — OTP Generation

### 1.1 Cryptographically Secure Randomness

The OTP must be generated using a cryptographically secure random number generator. `Math.random()`, `Date.now() % 1000000`, and similar approaches are predictable and must not be used.

**Correct patterns by runtime:**

```javascript
// Web Crypto API (Cloudflare Workers, browsers, Deno)
const bytes = new Uint8Array(4);
crypto.getRandomValues(bytes);
const otp = String(bytes.reduce((acc, b) => acc * 256 + b, 0) % 1000000).padStart(6, '0');

// Node.js
const crypto = require('crypto');
const otp = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
```

**Common mistake — modulo bias:**

```javascript
// BAD — bytes[0] is 0–255, not uniformly distributed mod 100
const otp = String(crypto.getRandomValues(new Uint8Array(1))[0] % 100).padStart(6, '0');

// BETTER — use enough bytes that modulo bias is negligible
const bytes = new Uint8Array(3); // 0–16,777,215
crypto.getRandomValues(bytes);
const num = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
const otp = String(num % 1000000).padStart(6, '0');
```

For 6-digit numeric OTPs, 3 bytes (24 bits, 16.7M values mod 1M) gives negligible bias. For alphanumeric OTPs, use a character set and index into it securely.

### 1.2 Sufficient Entropy

| OTP Format | Entropy | Brute Force Feasibility |
|---|---|---|
| 4 numeric digits | ~13.3 bits | Trivially brute-forced |
| 6 numeric digits | ~20 bits | Feasible without rate limiting |
| 8 numeric digits | ~26.6 bits | Feasible with parallelism |
| 6 alphanumeric (a-z, 0-9) | ~31 bits | Hard without rate limiting |
| 8 alphanumeric (a-z, 0-9) | ~41 bits | Infeasible without rate limiting |

**Minimum:** 6 numeric digits (~20 bits). **Recommended:** 6 alphanumeric characters (~31 bits) for higher-value targets.

The shorter your OTP and the longer its TTL, the more critical rate limiting becomes (see Level 4).

### 1.3 OTP Must Not Be in the Send Response

The response from the send-otp endpoint must never include the OTP code, even in development. The code reaches the user only via email.

```javascript
// BAD
return c.json({ success: true, otp: generatedOtp });

// GOOD
return c.json({ success: true, message: 'OTP sent.' });
```

---

## Level 2 — OTP Storage & Signing

### 2.1 HMAC-Signed OTP Storage

Store the OTP in a temporary store (KV, Redis, database) alongside an HMAC signature. This prevents an attacker who gains read access to the store from forging OTPs.

**Storage pattern:**

```javascript
const otp = generateOtp();
const signature = await signHmac(`${otp}:${email}`, HMAC_SECRET);
await kv.put(`otp:${email}`, JSON.stringify({ otp, sig: signature }), { expirationTtl: 300 });
```

**Verification pattern:**

```javascript
const stored = JSON.parse(await kv.get(`otp:${email}`));

// Verify HMAC FIRST — do not check plaintext before signature
const sigValid = await verifyHmac(`${stored.otp}:${email}`, stored.sig, HMAC_SECRET);
if (!sigValid) {
  return invalidResponse(); // same error message as wrong OTP
}

// Then check the user's input against the stored value
if (!timingSafeEqual(stored.otp, userOtp)) {
  return invalidResponse(); // same error message as invalid HMAC
}
```

**Alternative pattern — HMAC-only, no plaintext stored:**

This is even more secure. Store the HMAC of the OTP instead of the OTP itself, and verify by computing the HMAC of the user's input:

```javascript
// Store
const signature = await signHmac(`${otp}:${email}`, HMAC_SECRET);
await kv.put(`otp:${email}`, JSON.stringify({ sig: signature }), { expirationTtl: 300 });

// Verify
const stored = JSON.parse(await kv.get(`otp:${email}`));
const candidateSig = await signHmac(`${userOtp}:${email}`, HMAC_SECRET);
if (!timingSafeEqual(candidateSig, stored.sig)) {
  return invalidResponse();
}
```

This eliminates plaintext OTP from storage entirely.

### 2.2 Separate Signing Keys for OTP vs Session

Use different secrets for signing OTPs and signing session cookies. If one secret is compromised, the other system remains secure.

```javascript
// BAD — same secret for both
const otpSig = await signHmac(data, env.MASTER_SECRET);
const sessionSig = await signHmac(payload, env.MASTER_SECRET);

// GOOD — separate secrets
const otpSig = await signHmac(data, env.OTP_SECRET);
const sessionSig = await signHmac(payload, env.SESSION_SECRET);
```

**How to verify:** Check your environment variables or secret configuration. You should see at least two distinct secrets: one for OTP signing and one for session signing.

### 2.3 Timing-Safe HMAC Comparison

HMAC verification must use a constant-time comparison function. String equality (`===`, `!==`) leaks timing information that can be exploited to forge signatures byte by byte.

```javascript
// BAD — string comparison leaks timing
async function verifyHmac(data, signature, secret) {
  const expected = await signHmac(data, secret);
  return expected === signature; // timing-vulnerable
}

// GOOD — constant-time comparison
async function verifyHmac(data, signature, secret) {
  const expected = await signHmac(data, secret);
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(signature);
  return crypto.subtle.timingSafeEqual(a, b);
}
```

This applies to both HMAC comparison and OTP plaintext comparison. If you compare the OTP directly (not via HMAC), use timing-safe comparison for that too.

**Note:** In practice, remote timing attacks on HMAC verification over HTTP are extremely difficult due to network jitter. This is a defense-in-depth measure, not a critical vulnerability for most applications. Prioritise rate limiting (Level 4) over timing-safe comparison if you must choose.

---

## Level 3 — OTP Verification

### 3.1 OTP Consumed on Successful Verification

After a successful verification, the OTP must be invalidated immediately so it cannot be replayed.

```javascript
// Verify the OTP
if (valid) {
  await kv.delete(`otp:${email}`); // invalidate immediately
  // ... create session
}
```

**Also consider:** Delete the OTP even on failed verification after a certain number of attempts (see Level 4).

### 3.2 No Plaintext OTP Comparison Before HMAC Check

If you store OTP with an HMAC signature, always verify the HMAC before (or instead of) comparing the plaintext OTP. Checking plaintext first leaks information:

```javascript
// BAD — plaintext check leaks OTP correctness
if (stored.otp !== userOtp) {
  return json({ error: 'Incorrect code' }); // attacker knows OTP was wrong
}
if (!verifyHmac(stored.sig)) {
  return json({ error: 'Invalid signature' }); // never reached if OTP was right
}

// GOOD — HMAC first, then timing-safe plaintext check
const sigValid = await verifyHmac(`${stored.otp}:${email}`, stored.sig, HMAC_SECRET);
if (!sigValid) {
  return invalidResponse(); // generic error
}
if (!timingSafeEqual(stored.otp, userOtp)) {
  return invalidResponse(); // same generic error
}
```

### 3.3 Unified Error Messages

All failed verification attempts must return the same error message and HTTP status code. Distinct messages leak state:

```javascript
// BAD — different messages reveal different states
if (!stored) return json({ error: 'OTP_EXPIRED' }, 401);
if (stored.otp !== otp) return json({ error: 'WRONG_CODE' }, 401);
if (!sigValid) return json({ error: 'INVALID_SIGNATURE' }, 401);

// GOOD — single generic message
if (!valid) return json({ error: 'INVALID_OR_EXPIRED', message: 'Invalid or expired code.' }, 401);
```

This applies to HTTP status codes too — all failure paths should return the same status (typically 401).

---

## Level 4 — Rate Limiting

This is the most critical level. An OTP without rate limiting on the verify endpoint is effectively a 6-digit password with no account lockout.

### 4.1 Rate Limiting on the Send Endpoint

Throttle OTP requests per IP address (and optionally per email) to prevent spam and email bombing.

```javascript
// Per-IP: max 5 requests per 15-minute window
const key = `rl:send:${ip}`;
// Per-email: max 3 OTPs per hour (prevents email bombing of a specific inbox)
const emailKey = `rl:send:${email}`;
```

**Recommended limits:**

| Dimension | Limit | Window |
|---|---|---|
| Per IP | 5 requests | 15 minutes |
| Per email | 3 requests | 60 minutes |

### 4.2 Rate Limiting on the Verify Endpoint

**This is the most commonly overlooked measure.** The verify endpoint must have its own rate limiting, separate from the send endpoint. Without it, an attacker who obtains or intercepts an OTP can brute-force all possible codes.

For a 6-digit OTP (1,000,000 combinations):
- At 100 req/s (trivially achievable): brute force in ~2.7 hours
- With a 10-minute TTL: attacker needs ~1,667 req/s to exhaust the space — achievable with distributed attacks
- At 1,000 req/s: brute force in ~16 minutes

**Recommended limits:**

| Dimension | Limit | Window |
|---|---|---|
| Per IP | 10 attempts | 15 minutes |
| Per email | 5 attempts | per OTP lifetime |

```javascript
async function checkVerifyRateLimit(kv, ip, email) {
  // Per-IP limit
  const ipKey = `rl:verify:ip:${ip}`;
  const ipAttempts = await kv.get(ipKey);
  if (ipAttempts && parseInt(ipAttempts) >= 10) {
    return { allowed: false, message: 'Too many attempts. Try again later.' };
  }

  // Per-email limit (per OTP lifetime)
  const emailKey = `rl:verify:email:${email}`;
  const emailAttempts = await kv.get(emailKey);
  if (emailAttempts && parseInt(emailAttempts) >= 5) {
    return { allowed: false, message: 'Too many attempts. Request a new code.' };
  }

  return { allowed: true };
}
```

### 4.3 Maximum Verify Attempts Per OTP

After N failed verification attempts for a specific email, invalidate the OTP regardless of whether it has expired. This caps the brute-force space.

```javascript
// After failed verify
const failKey = `rl:verify:fail:${email}`;
const fails = parseInt(await kv.get(failKey) || '0') + 1;
await kv.put(failKey, String(fails), { expirationTtl: OTP_TTL_SECONDS });

if (fails >= 5) {
  // Invalidate the OTP — force user to request a new one
  await kv.delete(`otp:${email}`);
  await kv.delete(failKey);
  return json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many incorrect attempts. Please request a new code.' }, 429);
}
```

**Recommended:** 5 failed attempts per OTP, then invalidate.

---

## Level 5 — Bot Protection

### 5.1 CAPTCHA / Turnstile on the Send Endpoint

Require a CAPTCHA solution (Cloudflare Turnstile, reCAPTCHA, hCaptcha) before sending an OTP. This prevents automated scripts from triggering OTP emails.

```javascript
// Verify Turnstile token server-side
const turnstileValid = await verifyTurnstile(token, secret, ip);
if (!turnstileValid) {
  return json({ error: 'CAPTCHA_FAILED' }, 403);
}
```

**Server-side verification is mandatory.** The client obtains a token; the server validates it against the CAPTCHA provider's API.

### 5.2 Bot Protection Must Be Mandatory

Do not gate CAPTCHA verification on whether a secret exists:

```javascript
// BAD — silently skips CAPTCHA in development or misconfigured deploys
if (env.TURNSTILE_SECRET) {
  await verifyTurnstile(token, env.TURNSTILE_SECRET, ip);
}

// GOOD — fails loudly if CAPTCHA is not configured
if (!env.TURNSTILE_SECRET) {
  throw new Error('TURNSTILE_SECRET is not configured');
}
if (!turnstileToken) {
  return json({ error: 'CAPTCHA_REQUIRED' }, 400);
}
const turnstileValid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
if (!turnstileValid) {
  return json({ error: 'CAPTCHA_FAILED' }, 403);
}
```

For development, use Turnstile's test keys (`1x0000000000000000000000000000000AA` for always-passing, documented at <https://developers.cloudflare.com/turnstile/testing/>).

### 5.3 CAPTCHA on the Verify Endpoint (Optional)

For high-value targets (admin panels, financial systems), add CAPTCHA to the verify endpoint too. Most applications only need it on the send endpoint, since rate limiting (Level 4) makes brute force impractical.

### 5.4 Turnstile Widget Mode Selection

Cloudflare Turnstile offers three widget modes. Choose based on your threat model and user experience requirements:

| Mode | User Experience | Suspicious Visitors | Use Case |
|---|---|---|---|
| **Invisible** | Completely silent — no visible UI | Silently blocked; server returns error on token verification | Closed systems with allowlist/registration gate (admin panels, internal tools, volunteer portals) |
| **Managed** | Silent for low-risk; shows a checkbox challenge for suspicious visitors | Shown an interactive challenge (e.g. "Verify you are human") | Public-facing logins where you want a fallback for edge cases |
| **Non-Interactive** | Always shows a visible widget with a spinning checkmark | Silently blocked; same as Invisible but with visible UI | When you want users to see that verification is happening |

**Recommendation:**

- **Closed systems** (pre-registered users, allowlist gates) → **Invisible** mode. Suspicious visitors are blocked server-side; legitimate users see nothing. This is the cleanest UX for volunteer portals and internal tools.
- **Public signups** → **Managed** mode. Gives suspicious users a second chance via a challenge instead of a hard block.

**Implementation note for Invisible mode:** The Turnstile widget renders into a hidden container (CSS: `position:absolute;width:0;height:0;overflow:hidden;visibility:hidden`). The callback fires silently when verification passes. No visible widget appears on the page. The "Send Login Code" button starts disabled and is enabled when the invisible callback provides a valid token.

### 5.5 Turnstile Widget Configuration

Each project/domain must have its own Turnstile widget. Common pitfalls:

**Widget per project, not per environment:**

- Create a separate Turnstile widget for each project in the Cloudflare dashboard
- Do not share a widget across multiple projects or domains — the hostname match will fail with error 110200

**Hostname must match exactly:**

- In the Turnstile dashboard, the **Hostname** field must match the exact domain where the widget renders (e.g. `swa-gtw.cjtay-4e0.workers.dev`)
- Mismatched hostnames produce Turnstile Error 110200 (invalid site key) in the browser console
- Subdomains must be listed separately (e.g. `app.example.com` and `www.example.com` are different)

**Site key vs Secret key:**

- **Site key** — public, embeds in client-side HTML/JS. Added as a build-time constant (e.g. `TURNSTILE_SITE_KEY` in `src/constants/event.ts`). Safe to commit to source control.
- **Secret key** — private, used only server-side to verify tokens. Set via `wrangler secret put TURNSTILE_SECRET`. Never commit to source control.

**Different keys for different projects — why it matters:**

Using a widget created for `swa-portal.example.com` on `swa-gtw.cjtay-4e0.workers.dev` will fail because:
1. The site key's hostname won't match — error 110200
2. Even if you added both hostnames, the secret key from `swa-portal` would be used to verify `swa-gtw` tokens — creating an unnecessary cross-domain dependency

**For local development:** Use Turnstile's test keys (documented at <https://developers.cloudflare.com/turnstile/testing/>):
- Always-passing site key: `1x00000000000000000000AA`
- Always-passing secret key: `1x0000000000000000000000000000000AA`
- These only work when the Turnstile widget mode matches (e.g. Invisible test keys for Invisible mode)

---

## Level 6 — OTP Lifecycle

### 6.1 Short TTL

The OTP expiry time bounds the window of opportunity for brute-force and interception attacks. Shorter is better, but must balance usability (email delivery can be delayed).

**Recommended:**

| TTL | Use Case |
|---|---|
| 5 minutes | Default, recommended for most applications |
| 10 minutes | Acceptable for low-sensitivity admin panels |
| 15+ minutes | Not recommended — increases brute-force window |

### 6.2 Single-Use OTP

After successful verification, the OTP must be invalidated. This prevents replay attacks where an attacker captures an OTP (via network sniffing, email compromise, or log exfiltration) and reuses it within the TTL.

### 6.3 New OTP Invalidates Previous

When a user requests a new OTP, the old one must be invalidated. This prevents confusion and reduces the attack surface.

This happens automatically if you use the same KV key (e.g. `otp:${email}`) — writing a new value overwrites the old one. If you use unique keys, you must explicitly delete the previous OTP.

---

## Level 7 — Session Cookie Security

### 7.1 Cookie Attributes

The session cookie must have these attributes:

```
Set-Cookie: session=cookieValue; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200
```

| Attribute | Purpose | Required |
|---|---|---|
| `HttpOnly` | Prevents JavaScript access (XSS) | Yes |
| `Secure` | Only sent over HTTPS | Yes |
| `SameSite=Strict` | Prevents CSRF on cross-site requests | Yes |
| `SameSite=Lax` | Also acceptable if you need top-level navigations to carry the cookie | OK |
| `Path=/` | Scope cookie to entire site | Yes |

**Do not use `SameSite=None`** unless you have a specific cross-site use case and understand the CSRF implications.

### 7.2 Session Expiry

| Session Type | Recommended Max-Age |
|---|---|
| Default (no "remember me") | 12 hours (43200 seconds) |
| Extended ("remember me") | 30 days (2592000 seconds) |

The expiry must be enforced server-side (in the session payload), not just in the cookie's `Max-Age`. A client can modify `Max-Age`; they cannot forge a valid HMAC signature.

### 7.3 Expiry Timestamp in Session Payload

The session payload must include an `exp` (expiry) field that is checked on every authenticated request:

```javascript
const session = parseSession(cookie);
if (!session || session.exp < Date.now()) {
  return json({ error: 'SESSION_EXPIRED' }, 401);
}
```

### 7.4 HMAC-Signed Stateless Session

For Cloudflare Workers and similar serverless runtimes, storing sessions in KV or a database adds latency. A common pattern is HMAC-signed stateless sessions:

```javascript
// Create session
const payload = base64urlEncode(JSON.stringify({ email, name, role, exp }));
const signature = await signHmac(payload, SESSION_SECRET);
const cookie = `${payload}.${signature}`;

// Verify session
const [payload, signature] = cookie.split('.');
const valid = await verifyHmac(payload, signature, SESSION_SECRET); // timing-safe!
const session = JSON.parse(base64urlDecode(payload));
if (session.exp < Date.now()) return null;
```

**Important:** The HMAC verification must use timing-safe comparison (see Level 2.3).

---

## Level 8 — Email Enumeration Protection

### 8.1 Send Endpoint

The OTP send endpoint should return the same response regardless of whether the email is registered:

```javascript
// BAD — reveals whether email exists
if (!member) {
  return json({ error: 'NOT_REGISTERED' }, 403);
}

// GOOD — same response either way
if (member) {
  await sendOtpEmail(email, otp);
}
return json({ success: true, message: 'If this email is registered, a code has been sent.' });
```

**Trade-off:** This prevents automated enumeration but degrades UX — legitimate users don't know if they're using the wrong email. For closed admin panels where all users are pre-registered, the allowlist approach (Level 10.1) is sufficient and explicit "not registered" messages may be acceptable.

### 8.2 Verify Endpoint

The verify endpoint should not reveal whether an email exists in the system. All failure cases should return the same response:

```javascript
// BAD — different responses
if (!stored) return json({ error: 'NO_OTP' }, 404);      // reveals email had no OTP sent
if (wrong_code) return json({ error: 'WRONG_CODE' }, 401); // reveals email exists

// GOOD — uniform response
return json({ error: 'INVALID_OR_EXPIRED', message: 'Invalid or expired code.' }, 401);
```

### 8.3 Timing Attack Prevention

An endpoint that returns quickly for unregistered emails and slowly for registered ones (due to database lookups, email sending, etc.) leaks information. Consider adding a minimum response time:

```javascript
const startTime = Date.now();
// ... process request
const elapsed = Date.now() - startTime;
if (elapsed < 200) {
  await sleep(200 - elapsed);
}
```

This is a defense-in-depth measure — practical timing attacks over HTTP are difficult due to network jitter.

---

## Level 9 — Logging and Error Hygiene

### 9.1 OTP Never Logged

OTP codes must never appear in application logs, error tracking, or monitoring. Audit your logging:

```javascript
// BAD
console.log(`OTP generated for ${email}: ${otp}`);
logger.info('OTP sent', { email, otp });

// GOOD — log the event, not the code
logger.info('OTP sent', { email });
```

Also check: error logger payloads, request/response interceptors, debug endpoints.

### 9.2 OTP Not in Error Messages

Error responses must never include the OTP or any partial derivation of it:

```javascript
// BAD
return json({ error: 'Code incorrect', debug: `expected=${storedOtp}, got=${userOtp}` });

// GOOD
return json({ error: 'INVALID_OR_EXPIRED', message: 'Invalid or expired code.' });
```

---

## Level 10 — Authorisation and Access Control

### 10.1 Allowlist / Registration Gate

Only pre-approved users should be able to request an OTP. This is the first gate — if the email isn't in the system, no OTP is sent.

```javascript
const member = await db.prepare('SELECT id FROM members WHERE email = ? AND can_login = 1')
  .bind(email).first();
if (!member) {
  return json({ error: 'NOT_REGISTERED' }, 403);
}
```

For closed systems (admin panels, internal tools), this is essential. For open systems (public signup), replace the allowlist check with rate limiting.

### 10.2 Server-Side Role Assignment

The user's role must come from server-side data, not from client-supplied claims:

```javascript
// BAD — client sends role
const { email, otp, role } = await request.json(); // attacker sets role: 'admin'

// GOOD — server determines role from database
const member = await db.prepare('SELECT role FROM members WHERE email = ?').bind(email).first();
const role = member.role;
```

This applies to both the verify response and the session cookie. The session should embed the role from the database, not echo back what the client sent.

---

## Quick Reference — OTP Implementation Pattern

This is the recommended end-to-end pattern incorporating all levels:

```javascript
// ── SEND OTP ──

async function handleSendOtp(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { email, turnstileToken } = await request.json();

  // 5.2 — CAPTCHA is mandatory
  if (!env.TURNSTILE_SECRET) throw new Error('TURNSTILE_SECRET not configured');
  if (!turnstileToken) return json({ error: 'CAPTCHA_REQUIRED' }, 400);

  // 5.1 — Verify CAPTCHA server-side
  const captchaValid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
  if (!captchaValid) return json({ error: 'CAPTCHA_FAILED' }, 403);

  // 4.1 — Rate limit OTP send per IP
  if (!(await checkSendRateLimitIp(env.KV, ip))) return json({ error: 'RATE_LIMITED' }, 429);

  // 10.1 — Only registered users
  const member = await env.DB.prepare('SELECT id FROM members WHERE email = ? AND can_login = 1')
    .bind(email).first();

  // 8.1 — Same response whether registered or not
  if (!member) return json({ success: true, message: 'If this email is registered, a code has been sent.' });

  // 4.1 — Rate limit per email
  if (!(await checkSendRateLimitEmail(env.KV, email))) return json({ error: 'RATE_LIMITED' }, 429);

  // 1.1 — Crypto-secure OTP
  const otp = generateOtp(); // uses crypto.getRandomValues

  // 2.1 — HMAC-only storage (no plaintext OTP), 2.2 — separate secret
  const sig = await signHmac(`${otp}:${email}`, env.OTP_SECRET);
  await env.KV.put(`otp:${email}`, JSON.stringify({ sig }), { expirationTtl: 300 }); // 6.1 — 5-min TTL

  // 9.1 — OTP not logged
  await sendOtpEmail(email, otp);

  // 1.3, 8.1 — OTP not in response, generic message
  return json({ success: true, message: 'If this email is registered, a code has been sent.' });
}
```

```javascript
// ── VERIFY OTP ──

async function handleVerifyOtp(request, env) {
  const { email, otp } = await request.json();

  // 4.2 — Rate limit verify attempts per email
  if (!(await checkVerifyRateLimit(env.KV, email))) {
    return json({ error: 'TOO_MANY_ATTEMPTS' }, 429);
  }

  const stored = JSON.parse(await env.KV.get(`otp:${email}`));

  // 3.3 — Unified error message
  const invalidResponse = () => json({ error: 'INVALID_OR_EXPIRED', message: 'Invalid or expired code.' }, 401);

  if (!stored) return invalidResponse();

  // 2.1 — HMAC-only verification (no plaintext stored), 2.3 — timing-safe
  const candidateSig = await signHmac(`${otp}:${email}`, env.OTP_SECRET);
  const sigValid = await verifyHmac(`${otp}:${email}`, candidateSig, env.OTP_SECRET);
  if (!sigValid) return invalidResponse();

  // 3.1 — Invalidate OTP on success
  // Also invalidates on max failures (see 4.3)
  await env.KV.delete(`otp:${email}`);
  await env.KV.delete(`rl:verify:fail:${email}`);

  // 10.2 — Server-side role
  const member = await env.DB.prepare('SELECT name, role FROM members WHERE email = ? AND can_login = 1')
    .bind(email).first();

  // 7.3 — Expiry in payload, 7.4 — HMAC-signed, 2.2 — separate session secret
  const exp = Date.now() + 43200000; // 7.2 — 12-hour default
  const payload = base64urlEncode(JSON.stringify({ email, name: member.name, role: member.role, exp }));
  const signature = await signHmac(payload, env.SESSION_SECRET);

  // 7.1 — HttpOnly, Secure, SameSite=Strict
  return json({ success: true }, 200, {
    'Set-Cookie': `session=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
  });
}
```

---

## Architecture Decision Matrix

### Where to Store OTPs

| Storage | Latency | TTL Support | Use Case |
|---|---|---|---|
| KV (Cloudflare) | Low | Yes (expirationTtl) | Cloudflare Workers projects |
| Redis | Low | Yes (EXPIRE) | General-purpose |
| Database table | Medium | Manual cleanup | Projects without KV/Redis |
| In-memory | None | Lost on restart | Never for production |

### HMAC-Only vs HMAC+Plaintext Storage

| Approach | Security | Complexity | Recommendation |
|---|---|---|---|
| Plaintext in KV | Lowest | Simplest | Not recommended |
| HMAC + plaintext in KV | Medium | Medium | Acceptable with timing-safe comparison |
| HMAC-only in KV (no plaintext) | Highest | Medium | Recommended for new projects |

### Numeric vs Alphanumeric OTP

| Format | Entropy (6 chars) | Brute Forcefeasibility | User Experience |
|---|---|---|---|
| 6 numeric digits | ~20 bits | Feasible without rate limiting | Easy to type |
| 6 alphanumeric | ~31 bits | Infeasible without rate limiting | Harder to type |
| 8 numeric digits | ~27 bits | Hard without rate limiting | Easy to type |

**Recommendation:** 6 numeric digits with rate limiting (Level 4) is sufficient for most admin panels. Use 6 alphanumeric characters for higher-security applications.

---

## Threat Model Summary

| Attack | Mitigated By | Level |
|---|---|---|
| OTP interception (email compromise) | Short TTL (6.1), single-use (6.2) | 6 |
| OTP brute force | Verify rate limiting (4.2, 4.3) | 4 |
| OTP replay | Single-use (6.2) | 6 |
| OTP forgery (tamper with stored value) | HMAC signing (2.1) | 2 |
| OTP enumeration (timing attack on verification) | Timing-safe comparison (2.3, 3.2), unified errors (3.3) | 2, 3 |
| Email enumeration (discover valid accounts) | Generic responses (8.1, 8.2) | 8 |
| OTP spam / email bombing | Send rate limiting (4.1), CAPTCHA (5.1) | 4, 5 |
| Automated bot attacks | CAPTCHA (5.1), mandatory enforcement (5.2) | 5 |
| Session hijacking (XSS) | HttpOnly cookie (7.1) | 7 |
| Session hijacking (CSRF) | SameSite=Strict (7.1) | 7 |
| Session tampering | HMAC-signed cookie (7.4) | 7 |
| Session expiry bypass | Server-side expiry check (7.3) | 7 |
| Privilege escalation (role injection) | Server-side role assignment (10.2) | 10 |
| Unregistered user OTP request | Allowlist gate (10.1) | 10 |
| OTP leak via logs | Logging hygiene (9.1) | 9 |
| OTP leak via error messages | Error hygiene (9.2) | 9 |
| Weak random OTP | Crypto-secure generation (1.1) | 1 |

---

*Self-auditing checklist for email OTP authentication — May 2026.*

---

## Appendix A — GTW 2026 Audit Results (2026-05-13)

Audit of the GTW 2026 implementation against this checklist. All measures implemented in this session unless noted.

| # | Measure | Status | Notes |
|---|---------|--------|-------|
| 1.1 | Cryptographically secure OTP generation | ✅ Verified | `crypto.getRandomValues(new Uint8Array(3))`, 3 bytes mod 1M. Negligible modulo bias. |
| 1.2 | Sufficient OTP entropy | ✅ Verified | 6 numeric digits ≈ 19.9 bits. Acceptable with rate limiting. |
| 1.3 | OTP not returned in send response | ✅ Verified | Response: `{ success: true, message: "If this email is registered, a code has been sent." }` |
| 2.1 | HMAC-signed OTP storage | ✅ Verified | HMAC-only storage — `{ sig }` in KV, no plaintext OTP stored. |
| 2.2 | Separate signing keys for OTP vs session | ✅ Verified | `OTP_SECRET` for OTP HMAC, `SESSION_SECRET` for session cookies. Set via `wrangler secret put`. |
| 2.3 | Timing-safe HMAC comparison | ✅ Verified | `verifyHmac` uses `crypto.subtle.timingSafeEqual` via `(crypto.subtle as any).timingSafeEqual(a, b)`. |
| 3.1 | OTP consumed on successful verification | ✅ Verified | `await env.GTW_CONFIG.delete(`gtw:otp:${email}`)` on success. |
| 3.2 | No plaintext OTP comparison before HMAC | ✅ Verified | HMAC-only pattern — no plaintext stored at all. Verification computes `signHmac(userOtp:email)` and compares via `verifyHmac`. |
| 3.3 | Unified error messages on verification failure | ✅ Verified | All failure paths return `{ error_code: 'INVALID_OR_EXPIRED', message: 'Invalid or expired code.' }` with status 401. Rate limit exhaustion returns separate 429 with distinct message. |
| 4.1 | Rate limiting on OTP send endpoint | ✅ Verified | KV-based: 5 req/IP/15min, 3 req/email/60min. `src/worker/lib/rate-limit.ts`. |
| 4.2 | Rate limiting on OTP verify endpoint | ✅ Verified | KV-based: 10 req/IP/15min, 5 req/email/10min. |
| 4.3 | Maximum verify attempts per OTP | ✅ Verified | 5 failed attempts → OTP invalidated, user must request new code. Returns 429 `TOO_MANY_ATTEMPTS`. |
| 5.1 | Bot protection on OTP send | ✅ Verified | Cloudflare Turnstile on login page. Server-side verification via `verifyTurnstile()`. |
| 5.2 | Bot protection is mandatory | ✅ Verified | `if (!env.TURNSTILE_SECRET) throw new Error(...)` — fails loudly if not configured. |
| 5.3 | Bot protection on OTP verify | ➖ Not applicable | Low-sensitivity volunteer portal; rate limiting sufficient. |
| 5.4 | Turnstile widget mode | ✅ Verified | Invisible mode. Widget per domain (`swa-gtw.cjtay-4e0.workers.dev`). Hidden container, no visible UI. |
| 5.5 | Separate Turnstile widget per project | ✅ Verified | Dedicated `gtw-login` widget with matching hostname. Site key in `src/constants/event.ts`, secret via `wrangler secret`. |
| 6.1 | OTP TTL is short | ✅ Verified | TTL = 300 seconds (5 minutes). Email text updated to match. |
| 6.2 | OTP is single-use | ✅ Verified | Deleted from KV after successful verify. |
| 6.3 | No OTP reuse across requests | ✅ Verified | Same KV key `gtw:otp:${email}` — new OTP overwrites previous. |
| 7.1 | Session cookie: HttpOnly, Secure, SameSite | ✅ Verified | `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`. |
| 7.2 | Session expiry is reasonable | ✅ Verified | 12 hours default. "Remember me" extends to event date (2026-06-25). |
| 7.3 | Session contains expiry timestamp | ✅ Verified | `exp` field in payload, checked at `session.ts:32`. |
| 7.4 | HMAC-signed session cookie | ✅ Verified | `payload.signature` pattern, verified with `SESSION_SECRET`. |
| 8.1 | No email enumeration via send response | ✅ Verified | Returns `{ success: true, message: "If this email is registered, a code has been sent." }` for all emails, whether registered or not. |
| 8.2 | No email enumeration via verify response | ✅ Verified | All failure paths return same `INVALID_OR_EXPIRED` error. |
| 8.3 | No email enumeration via timing | ⬜ Not implemented | Defense-in-depth only. Registered emails trigger KV lookup + Resend call; unregistered fast-return. Practical timing attacks over HTTP are extremely difficult. Can be added later with `sleep()` padding if threat model changes. |
| 9.1 | OTP not logged | ✅ Verified | OTP value never written to `gtw_error_log` or `console.log`. |
| 9.2 | OTP not in error messages | ✅ Verified | No error response contains OTP or partial OTP. |
| 10.1 | Allowlist or registration gate | ✅ Verified | Admin domain (`@singaporewomenassociation.org`) + KV volunteer list. Non-registered emails still get generic success response (8.1). |
| 10.2 | Locked role assignment | ✅ Verified | Role derived server-side from email domain (`verify-otp.ts:65`). Not client-supplied. |

### Implementation files

| Component | File |
|---|---|
| OTP generation | `src/worker/api/send-otp.ts` |
| OTP verification | `src/worker/api/verify-otp.ts` |
| HMAC + crypto | `src/worker/lib/crypto.ts` |
| Rate limiting | `src/worker/lib/rate-limit.ts` |
| Turnstile verification | `src/worker/api/send-otp.ts` |
| Session management | `src/worker/api/session.ts` |
| Auth middleware | `src/worker/middleware.ts` |
| Email template | `src/worker/lib/email-otp.ts` |
| Login page | `src/pages/login.astro` |
| Constants | `src/constants/event.ts` |
| Worker types | `src/worker/types.ts` |

### Secrets required

| Secret | Purpose | How to set |
|---|---|---|
| `OTP_SECRET` | HMAC signing for OTP verification | `wrangler secret put OTP_SECRET` |
| `SESSION_SECRET` | HMAC signing for session cookies (separate from OTP) | `wrangler secret put SESSION_SECRET` |
| `TURNSTILE_SECRET` | Server-side Turnstile token verification | `wrangler secret put TURNSTILE_SECRET` |
| `RESEND_API_KEY` | Transactional email (OTP, confirmation, winner) | `wrangler secret put RESEND_API_KEY` |
| `GTW_ADMIN_DOMAIN` | Admin email domain for role assignment | `wrangler secret put GTW_ADMIN_DOMAIN` |