# ☁️ Cloudflare Setup Checklist for New AstroJS Projects (Cloudflare Workers)

---

## 🔗 Section 1 — DNS & Domain Routing

### ✅ 1.1 Add custom domain to your Worker
**Where:** Workers & Pages → your-worker → Domains tab → `+ Add Domain`

**Purpose:** Connects your real domain (e.g. `yoursite.org`) to the Cloudflare Worker that serves your Astro site. Without this, your domain points to wherever it was hosted before.

**Keep in mind:**
- You must delete any existing A record pointing to the old host (e.g. old AWS/Netlify IP) *before* adding the domain here, otherwise Cloudflare will throw a "Failed to add domain" error.
- Once added, Cloudflare automatically creates the correct DNS routing — you don't need to manually create DNS records.
- Add both the root domain (`yoursite.org`) and the `www` subdomain separately if you want both to work.

---

### ✅ 1.2 Add `www` subdomain as a second custom domain
**Where:** Workers & Pages → your-worker → Domains tab → `+ Add Domain` → type `www` in the subdomain field

**Purpose:** Makes `www.yoursite.org` work and point to the same Worker as the root domain. Many users habitually type `www.` so this prevents them landing on a broken page.

**Keep in mind:**
- If your DNS had a `www` CNAME pointing to an old Netlify/Vercel/etc. site, Cloudflare will automatically update or remove it when you add `www` as a custom domain here.

---

### ✅ 1.3 Verify MX (email) records are untouched
**Where:** DNS → Records

**Purpose:** Email (Outlook, Google Workspace, etc.) is configured via MX records. Migrating a domain or changing DNS can accidentally break email.

**Keep in mind:**
- MX records should be set to **DNS only** (grey cloud icon), NOT proxied through Cloudflare.
- Before making DNS changes, always scroll through DNS records and confirm MX records, DKIM (TXT), SPF, and DMARC are still intact after any changes.

---

## 🔒 Section 2 — SSL / HTTPS

### ✅ 2.1 Always Use HTTPS
**Where:** SSL/TLS → Edge Certificates → Always Use HTTPS → toggle ON

**Purpose:** Automatically redirects anyone who visits `http://yoursite.org` to the secure `https://` version. Prevents users from accidentally browsing your site over an unencrypted connection.

**Keep in mind:** This is a free setting and should always be ON for any public website.

---

### ✅ 2.2 Minimum TLS Version — set to TLS 1.2
**Where:** SSL/TLS → Edge Certificates → Minimum TLS Version → select `TLS 1.2`

**Purpose:** Blocks very old, insecure browser connections that use TLS 1.0 or 1.1 (deprecated protocols with known vulnerabilities). TLS 1.2 is the modern standard supported by all browsers made after 2013.

**Keep in mind:** Setting this to TLS 1.3 is slightly more secure but may block a small number of older devices/browsers. TLS 1.2 is the safe, balanced choice.

---

### ⛔ 2.3 HSTS — Do NOT enable
**Where:** SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS)

**Purpose:** HSTS tells browsers to *never* connect to your site over HTTP again — ever. Browsers cache this instruction for months or years.

**Why NOT to enable it:** HSTS is essentially a one-way switch. Once enabled, if you ever need to move your site, remove HTTPS, or change your domain setup, browsers that have cached the HSTS instruction will refuse to load your site and show a hard error — with no easy way to fix it for affected users. The risk is disproportionate for most organisations. **Leave this OFF.** "Always Use HTTPS" (2.1 above) is sufficient protection.

---

## 🛡️ Section 3 — Security

### ✅ 3.1 Bot Fight Mode
**Where:** Security → Settings → Bot Fight Mode → toggle ON

**Purpose:** Cloudflare's free bot detection layer. It automatically identifies and challenges/blocks known malicious bots, scrapers, and credential stuffers before they consume your server resources.

**Keep in mind:**
- This is different from "Block AI training bots" — Bot Fight Mode targets *malicious* bots (spammers, scrapers, attackers), not AI crawlers.
- It's free and has no meaningful impact on legitimate visitors.

---

### ✅ 3.2 Email Address Obfuscation
**Where:** Security → Settings → Email Address Obfuscation → toggle ON

**Purpose:** Hides email addresses in your HTML from spam bots that harvest contact details by crawling websites. Real human visitors see and can use the email address normally; bots see scrambled text.

**Keep in mind:** This is handled entirely by Cloudflare on-the-fly — no changes needed to your Astro source code. It's free and has zero downside.

---

### ✅ 3.3 Browser Integrity Check
**Where:** Security → Settings → Browser Integrity Check

**Purpose:** Cloudflare checks the request headers of incoming visitors and blocks bots or scrapers that use fake or suspicious browser signatures (e.g. they claim to be Chrome but their headers don't match a real browser).

**Keep in mind:** This is usually **ON by default** — just verify it hasn't been accidentally turned off.

---

### ⏭️ 3.4 Hotlink Protection — skip if images are on a CDN
**Where:** Security → Settings → Hotlink Protection

**Purpose:** Prevents other websites from embedding your images directly (stealing your bandwidth). If someone hotlinks your image on their site, Cloudflare blocks the request.

**Keep in mind:** If your images are hosted on an external CDN like **Cloudinary, Imgix, or Bunny.net**, this setting has no effect on those images — skip it. Only relevant if you serve images directly from your own domain/Worker.

---

## 🤖 Section 4 — AI Crawlers & robots.txt

### ✅ 4.1 Disable Cloudflare's managed robots.txt
**Where:** Domain Overview page → right panel → "Manage your robots.txt" → select **"Disable robots.txt configuration"**

**Purpose:** By default, Cloudflare may inject its own managed `robots.txt` section that blocks *all* AI crawlers including search-oriented ones like GPTBot and ClaudeBot. Disabling this gives you full control via your own `robots.txt` file.

**Keep in mind:** Do this *before* deploying your custom `robots.txt`, so Cloudflare's version doesn't override or merge with yours.

---

### ✅ 4.2 Add a custom robots.txt to your Astro project
**Where:** `public/robots.txt` in your Astro project (deploy via `npm run deploy`)

**Purpose:** Controls which bots can crawl your site and which paths are off-limits. A well-crafted `robots.txt` lets AI search crawlers (ChatGPT, Perplexity, Claude etc.) index your content for AI search results, while blocking pure training scrapers that offer no search benefit.

**Recommended template:**

```
# Robots.txt for [Your Site Name]
# Last updated: YYYY-MM-DD

# AI Training scrapers — block (no search benefit, often ignore robots.txt anyway)
User-agent: CCBot
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Amazonbot
Disallow: /

User-agent: meta-externalagent
Disallow: /

User-agent: Applebot-Extended
Disallow: /

# All other bots and AI search crawlers (GPTBot, ClaudeBot, Google-Extended,
# PerplexityBot etc.) follow the general rules below and are welcome to index
# public content for AI search results.

User-agent: *
Disallow: /admin/
Disallow: /_astro/
Disallow: /api/

Sitemap: https://yoursite.org/sitemap-index.xml

User-agent: Googlebot
Crawl-delay: 0

User-agent: Bingbot
Crawl-delay: 1
```

**Keep in mind:**
- After deploying, verify by visiting `https://yoursite.org/robots.txt` directly in the browser.
- Adjust the `Disallow` paths to match your project's private routes.

---

### ✅ 4.3 Block AI training bots (Cloudflare firewall rule)
**Where:** Domain Overview page → right panel → "Block AI training bots" → set to **"Block on all pages"**

**Purpose:** Cloudflare's own firewall rule that blocks known AI training scrapers at the network level — before they even reach your Worker. This is stronger than `robots.txt` alone, since training scrapers often ignore `robots.txt`.

**Keep in mind:**
- This blocks *training* scrapers only (CCBot, Bytespider, etc.) — it does **not** block AI *search* crawlers like GPTBot, ClaudeBot, or PerplexityBot. Your AI search visibility is completely unaffected.
- Works as a complementary layer on top of your `robots.txt`.

---

## 🚫 Section 5 — Workers.dev URLs (Security Hygiene)

### ✅ 5.1 Disable Worker URL and Preview URLs for all Workers
**Where:** Workers & Pages → each Worker → Domains tab → toggle OFF both "Worker URL" and "Preview URLs"

**Purpose:** By default, every Cloudflare Worker gets a public `*.workers.dev` URL (e.g. `your-site.account.workers.dev`). If left active, bots and attackers can access your site through this URL — bypassing any domain-level security rules, WAF, and Bot Fight Mode you've configured.

**Keep in mind:**
- Disable these for **every Worker** in your account once you've set up a proper custom domain.
- Do this for both public-facing Workers and any internal/admin Workers (e.g. event management tools) that should never be publicly accessible.
- Verify by visiting the `workers.dev` URL after disabling — it should return inaccessible/error.

---

## 📋 Quick Reference Summary

| # | Setting | Location | Action |
|---|---|---|---|
| 1.1 | Add custom domain | Worker → Domains | Add root domain |
| 1.2 | Add www subdomain | Worker → Domains | Add `www` subdomain |
| 1.3 | Verify email (MX) records | DNS → Records | Confirm untouched, DNS only |
| 2.1 | Always Use HTTPS | SSL/TLS → Edge Certificates | ✅ ON |
| 2.2 | Minimum TLS Version | SSL/TLS → Edge Certificates | ✅ Set to TLS 1.2 |
| 2.3 | HSTS | SSL/TLS → Edge Certificates | ⛔ Leave OFF |
| 3.1 | Bot Fight Mode | Security → Settings | ✅ ON |
| 3.2 | Email Address Obfuscation | Security → Settings | ✅ ON |
| 3.3 | Browser Integrity Check | Security → Settings | ✅ Verify ON |
| 3.4 | Hotlink Protection | Security → Settings | ⏭️ Skip if using Cloudinary/CDN |
| 4.1 | Disable managed robots.txt | Domain Overview (right panel) | ✅ Disable |
| 4.2 | Custom robots.txt | `public/robots.txt` in Astro | ✅ Deploy with wrangler |
| 4.3 | Block AI training bots | Domain Overview (right panel) | ✅ Block on all pages |
| 5.1 | Disable workers.dev URLs | Each Worker → Domains | ✅ Both toggles OFF |