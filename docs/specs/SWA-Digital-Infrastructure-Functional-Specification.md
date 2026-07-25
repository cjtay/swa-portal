# Singapore Women's Association — Digital Infrastructure Functional Specification

> **Document Version:** 2.0
> **Date:** 23 May 2026
> **Audience:** SWA Board and Senior Leadership
> **Classification:** Confidential — Board Use Only

---

## 1. Executive Summary

The Singapore Women's Association operates **three independent digital properties**, all running on **Cloudflare's global platform**. Together, they form an integrated digital ecosystem serving the public, the SWA committee and board, and event operations for the flagship annual charity gala dinner.

This document describes what each system does, who uses it, its current delivery status, the security and privacy measures in place, and the plan for future development.

**The three systems are:**

| Property | Domain | What It Does |
|----------|--------|-------------|
| **SWA Website** | `singaporewomenassociation.org` | Public-facing website — events, programmes, pageant, forms, fundraising |
| **SWA Admin Portal** | `admin.singaporewomenassociation.org` | Internal management — member directory, office booking, gala dinner registration |
| **GTW 2026** | `gtw.singaporewomenassociation.org` | Gala dinner event microsite — lucky draw ticket sales, payment reconciliation, live draw |

All three systems run within Cloudflare's free tier for non-profit organisations. **There are no foreseeable recurring infrastructure costs.**

The entire digital infrastructure — all three systems, all three domains, all development, maintenance, and operations — is managed single-handedly by **C J Tay, CTO & AI Solutions Architect**, through the strategic deployment of AI development agents. This approach delivers enterprise-grade capabilities at zero IT staffing cost, and with no dependency on external vendors, agencies, or in-house technical teams.

### Current Delivery Status at a Glance

| System | Status |
|--------|--------|
| SWA Website | ✅ Live |
| GTW 2026 | ✅ Core operations complete; final end-to-end testing in progress |
| Admin Portal — Authentication & Login | ✅ Fully operational |
| Admin Portal — Office Booking | ✅ Fully operational |
| Admin Portal — Gala Dinner Registration & Check-In | ✅ Fully operational |
| Admin Portal — Member Directory (UI) | 🔄 API complete; screen interface in progress |
| Admin Portal — Namecard Management (UI) | 🔄 API complete; screen interface in progress |
| Image Library Migration (Cloudinary → Cloudflare R2) | 📋 Planned |
| Website Rebuild Trigger from Portal | 📋 Planned |

---

## 2. The Three Digital Properties

### 2.1 Why Three Separate Systems?

This architecture was deliberately chosen following a formal assessment. The board elected to maintain three independent systems rather than merge them into one, for three reasons:

1. **Risk Isolation:** A fault in the GTW draw system cannot affect the public website. A bad update to the admin portal cannot disrupt a live event. Each system fails independently — and recovers independently.

2. **Security Isolation:** The public website holds no sensitive data. An attacker who compromised it would gain nothing of value — member records, payment information, and login credentials are held in entirely separate systems with no connection to the public site.

3. **Independent Update Cadence:** The public website can be updated at any time without touching the portal. The GTW event system can be rapidly adjusted during event season without risking anything else.

### 2.2 System Comparison

| | SWA Website | SWA Admin Portal | GTW 2026 |
|---|---|---|---|
| **Pages** | 657 (all public) | 15 (login required) | 10 (login required + 1 public results page) |
| **Who can access** | Anyone | Authenticated SWA members only | Registered volunteers, SWA staff, public (results only) |
| **Sensitive data held** | None | Member directory, contact details, photos | Guest names, phones, payment screenshots |
| **File storage** | Images being migrated to Cloudflare R2 | Member photos (Cloudflare R2) | Payment screenshots (Cloudflare R2) |
| **Email service** | Contact form replies | Login codes, booking confirmations, guest registration links | Login codes, ticket confirmations, winner notifications |
| **WhatsApp** | None | None | Optional volunteer notifications (Twilio) |

---

## 3. Deployment Status

This section provides an honest account of what is fully operational, what is in progress, and what is planned. The board should use this as the reference for understanding SWA's current digital capability.

### 3.1 What Is Fully Operational Today

- **GTW 2026**: Volunteer ticket sales form, finance dashboard (payment confirmation, CSV export, screenshot review), live draw operator panel, public results display, post-event analytics, and Miss Popularity calculation are all complete and tested.
- **Admin Portal — Authentication**: Secure email-based login with one-time codes is fully working for all member tiers.
- **Admin Portal — Office Booking**: Committee members can book the meeting room, receive confirmation emails, and cancel bookings. Admins can manage all bookings.
- **Admin Portal — Gala Dinner Registration**: Admin booking creation, buyer magic-link guest registration, volunteer check-in, and the live arrivals dashboard are all fully operational.
- **SWA Website**: All 657 pages are live and verified across all three domains.

### 3.2 What Is In Progress

- **Admin Portal — Member Directory UI**: The backend API supporting member search, create, edit, and delete is complete. The front-end screen that committee members will use is being built.
- **Admin Portal — Namecard Management UI**: Similarly, the API is done; the screen interface is in progress.
- **Admin Portal — Member Photo Upload**: The storage infrastructure (Cloudflare R2) is in place; the upload form is being finalised.
- **GTW 2026 — Final Testing**: End-to-end, concurrency, mobile, email, and print tests are being completed before the event.

### 3.3 What Is Planned (Not Yet Started)

- **Image Library Migration**: All event images currently hosted on Cloudinary will be migrated to Cloudflare R2, consolidating the entire asset library under one platform and eliminating third-party image hosting costs.
- **Website Rebuild from Portal**: A mechanism to trigger a website update from within the admin portal (so member profile changes appear on the public site without developer involvement).
- **Phase 2 — Membership Fee Management**: Fee tracking, payment reminders, and member self-service (see Section 9).
- **Phase 3 — CMS and Form Migration**: A content editor in the portal and migration of 16 Microsoft Forms to native SWA-hosted equivalents.

---

## 4. Technology Platform: Cloudflare

### 4.1 What Is Cloudflare?

Cloudflare is one of the world's largest internet infrastructure companies, operating a global network of data centres in over 330 cities. Every visitor to an SWA digital property connects to the nearest Cloudflare data centre — Singapore, in most cases — delivering fast-loading pages regardless of where the visitor is.

Unlike traditional web hosting (one physical server in one location), Cloudflare distributes SWA's applications across its global network. This means:

- **No single point of failure.** If one data centre has an outage, traffic automatically routes to the next nearest location.
- **Automatic scaling.** The platform absorbs traffic spikes — such as a surge of visitors during event registration — with no manual intervention.
- **Built-in protection.** Cloudflare's network filters malicious traffic before it reaches SWA's applications.
- **No server to maintain.** There is no physical server to provision, patch, or upgrade. Cloudflare manages all infrastructure.

### 4.2 The Building Blocks

Every SWA application is built from the same five Cloudflare services:

**Cloudflare Workers (The Application Logic)**
The code that powers SWA's applications runs here. When a member logs in, submits a booking, or a volunteer confirms a payment, a Worker handles that request — checking identity, retrieving data, sending emails. Workers start in milliseconds and scale to any demand without configuration.

**D1 Database (Structured Data)**
Cloudflare's relational database stores SWA's structured records: member profiles, office bookings, gala dinner guest lists, GTW ticket submissions, and audit logs. Each system has its own isolated database — the portal cannot read GTW data, and vice versa.

**R2 Object Storage (Files)**
Cloudflare's file storage service holds larger items: member photos, payment screenshots, and (in transition) all event imagery. Critically, **Cloudflare charges no fees for serving files to visitors** — unlike other cloud providers, SWA will never pay bandwidth charges regardless of how many people download images or files.

**KV Store (Fast Configuration & Sessions)**
A fast, globally-distributed store for small but frequently-read data: login session tokens, one-time login codes, rate-limiting counters, and event configuration (prize counts, draw state, table layouts).

**Cloudflare Turnstile (Bot Protection)**
A privacy-respecting alternative to Google's reCAPTCHA. Protects all SWA login pages from automated bots and brute-force attacks without requiring members to solve puzzles.

### 4.3 How the Applications Work

Every SWA application follows the same pattern: the page layout, design, and navigation are pre-built and served instantly (at no processing cost). Only when live data is needed — a booking list, a guest search, a draw result — does the application fetch that data from the database and display it. This separation of static pages from live data is the key reason SWA's entire digital stack operates comfortably within Cloudflare's free tier.

---

## 5. What Each System Does

### 5.1 SWA Website (`singaporewomenassociation.org`)

SWA's public digital front door. 657 pages covering the full breadth of the association's work, built for performance and search visibility.

**Content Areas:**

| Section | What's There |
|---------|-------------|
| Homepage | Hero banners, featured events, programme highlights, sponsor logos |
| About SWA | History, founding president, milestones, our work, leadership directory |
| Events | 90+ archived events from 2020–2026, browseable by year |
| Programmes | Chair Yoga, Laughter Yoga, FAWA, Project Rebuild, Project Taking Charge, Ren Ci, SVP, Lunar New Year Lunch |
| Get Involved | Volunteering, membership, corporate ESG partnership, sponsorship |
| Fundraising | Annual Charity Dinner, donation links |
| MSPI Pageant | Miss Singapore Pageant International 2026 campaign, queens gallery |
| SP Microsites | Full 48th and 49th Anniversary microsite content — schedules, contestants, judges, sponsors, prizes, FAQs |
| Digital Namecards | Member profiles with downloadable digital business cards |
| Forms | 18 forms including contact, volunteer registration, sponsor, table booking, programme enrolment |

**Technical Characteristics:**
- All 657 pages are pre-built and served directly from Cloudflare's cache — no database queries for standard page loads
- Full search engine optimisation with structured data, automatic sitemaps, and British English content standards
- Secure headers block clickjacking, content injection, and access from AI scrapers
- Google Analytics 4 with conversion tracking

**Live API Services:**
- Contact form (sends to `info@singaporewomenassociation.org` with rate limiting)
- Health monitoring endpoint

---

### 5.2 SWA Admin Portal (`admin.singaporewomenassociation.org`)

The internal management platform for SWA operations. Accessible only to authenticated members.

#### 5.2.1 Authentication and Who Can Log In

The portal uses **no passwords**. Instead, it sends a one-time login code to the member's registered email address. This eliminates the risk of password reuse, phishing for credentials, and account takeovers through weak passwords.

**Login process:**
1. Member enters their email address and completes a bot-protection check
2. A one-time code is emailed to them
3. They enter the code — it expires after a short window
4. A secure session is created, valid for the configured duration

Only members with `can_login = 1` in the database can receive a code. IT Administrators control this flag.

**Role Tiers:**

| Role | Who | What They Can Do |
|------|-----|-----------------|
| **IT Administrator** | 3 named individuals | Everything below, plus: system settings, table configuration, role assignment, registration management |
| **Admin** | Members with category = 'admin' | Full member directory management, all office bookings, gala dinner administration |
| **Committee** | Members with category = 'committee' | View member directory, create/cancel own office bookings, guest check-in at gala dinner |

**Registration Sub-Roles (Gala Dinner):**

| Sub-Role | Purpose |
|----------|---------|
| `reg_admin` | Manage dinner bookings, guest lists, send buyer links, export CSV |
| `reg_volunteer` | Operate guest check-in on the night |

These sub-roles are assigned per member and allow fine-grained delegation — a committee member can manage dinner registration without being given full admin access.

**Protections Against Abuse:**

| Protection | What It Does |
|------------|-------------|
| Bot check on login | Blocks automated login attempts |
| Code request rate limit | Prevents flooding a member's inbox |
| Code verification limit | Multiple wrong attempts invalidate the code |
| Per-user API rate limit | Prevents automated bulk actions even after login |

#### 5.2.2 Office Booking

Members can book the SWA meeting room through an interactive calendar.

- Month-by-month calendar view with booked days highlighted
- Booking requires: purpose, start and end time, attendee count, optional notes
- All bookings are automatically approved — no admin review needed
- Members can cancel their own bookings; admins can cancel any booking
- A confirmation email is sent via Resend upon booking
- The system rejects bookings that conflict with existing reservations or are in the past

#### 5.2.3 Member Directory

The single source of truth for all SWA member information.

- Searchable and filterable by name, email, role, or category
- Admins can add, edit, and remove members
- Controls whether a member can log into the portal (`can_login`)
- Controls whether a member appears on the public website and has a digital namecard
- Assigns gala dinner registration sub-roles independently of main portal role
- Member photos are stored in Cloudflare R2

> **Note:** The backend API for all member operations is complete. The front-end management screen is currently being built.

#### 5.2.4 Namecard Management

> **REMOVED 19-07-2026** — Public-website integration dropped. swa-portal is now isolated from swa2024; namecard management has been removed from this portal. Historical spec preserved below for audit only.

Controls which members appear as digital namecards on the public website.

- Lists members flagged for website display or namecard publication
- Editing a member's namecard details links through to the Member Directory
- A "Sync to Website" button (IT Admin only) will trigger a rebuild of the public website so changes appear live — this integration is planned and being developed

> **Note:** The namecard management screen is currently being built.

#### 5.2.5 Gala Dinner Registration System

Built specifically for the 49th SWA Annual Charity Dinner 2026. A four-stage workflow:

**Stage 1 — Admin Creates Bookings:**
Admin receives seat reservations from buyers and records them in the portal. The system automatically generates seat slots with unique ticket codes (e.g., `04-07` for Table 4, Seat 7).

**Stage 2 — Buyer Registers Guest Names:**
Admin sends a secure "magic link" to the buyer — no account or password required. The buyer opens the link and fills in each guest's name. They can return multiple times before the deadline to make changes. The link is cryptographically unique and expires at the configured cutoff time.

**Stage 3 — Volunteer Check-In on Event Night:**
A mobile-optimised check-in page for one-handed phone use. Volunteers search by name or ticket code, see the guest's details, and tap once to mark them as arrived. Walk-in guests can be added on the spot. Two volunteers cannot check in the same guest simultaneously.

**Stage 4 — Live Arrivals Dashboard:**
Any logged-in SWA member can view the live arrival dashboard from their phone. It shows expected vs arrived counts, per-table breakdown, and a feed of the most recent arrivals — auto-refreshing every 15 seconds.

**Export and Print:**
Full CSV export of all guests with ticket codes, tables, and arrival status. Print-optimised guest list grouped by table for use as a paper backup.

#### 5.2.6 Admin Settings (IT Admin Only)

- Table configuration: add, edit, or remove tables, set capacities, ticket code prefixes, VIP status, and form cutoff time. Changes take effect immediately.
- Registration role assignment: set `reg_admin` or `reg_volunteer` roles per member.

---

### 5.3 GTW 2026 (`gtw.singaporewomenassociation.org`)

A standalone microsite for managing the "Guess-The-Winner" lucky draw during the 49th Annual Charity Dinner. Three distinct user groups: volunteers selling tickets, finance staff reconciling payments, and a draw operator conducting the live draw on stage.

#### 5.3.1 Authentication

The same one-time code login system as the Admin Portal, with three access tiers:

- **Volunteer (any registered email):** Ticket sales form
- **SWA Staff (`@singaporewomenassociation.org`):** Finance dashboard, results, analytics
- **IT Admin (named list):** Draw panel, prize configuration, volunteer registration

Sessions can be extended to cover the full event day, so volunteers are not interrupted by re-login prompts during the dinner.

#### 5.3.2 Ticket Sales Form

Designed for fast, repetitive use on phones and tablets:

- Displays the 6 Miss Singapore Pageant International contestants with photos for selection
- Generates a PayNow QR code on-screen instantly — updated whenever the ticket count changes — showing the correct SWA UEN, amount, and submission reference
- Accepts payment screenshots (auto-resized if too large)
- Issues a unique submission reference (e.g., `GTW-K4X2AF`) for every sale
- Sends a confirmation email to the guest with their ticket details
- Records each sale in the database with payment status pending finance verification

#### 5.3.3 Finance Dashboard

- Overview of total tickets, revenue, confirmed vs unconfirmed payments, and per-volunteer breakdown
- Per-submission list with payment method, amount, confirmation status, and expandable ticket details
- Finance staff confirm PayNow and cash payments after verification, with access to screenshot review
- Full CSV export of all submissions and tickets
- Print-ready ticket stubs for the physical glass bowl draw (mandatory pre-event step)

#### 5.3.4 Live Draw System

The on-stage draw panel:

**Setup:** The draw operator selects the winning MSPI contestant after the pageant result is announced. The system calculates the eligible ticket pool (tickets that guessed the winner). If fewer eligible tickets exist than prizes, the system automatically designs a split-pool plan — some prizes drawn from all tickets, the remainder from correct guessers — and presents it to the operator for confirmation before any draw begins.

**Execution:** Prizes are drawn in ascending order (smallest prize first, Grand Prize last). Each draw uses cryptographic randomness equivalent to a physical draw from a bowl. A database-level lock ensures two simultaneous draw attempts cannot award the same ticket twice. Every draw is permanently logged for audit. After the Grand Prize is drawn, the system locks and no further draws are possible.

**Prize Collection:** After the event, admins record whether each prize was collected or donated.

#### 5.3.5 Public Results Display

A live results screen — no login required — designed for display on the gala dinner projector. Shows winners as they are drawn, auto-refreshing every 5 seconds.

#### 5.3.6 Post-Event Analytics

Eight analytical views including tickets per contestant, revenue by payment method, volunteer leaderboard, submission time heatmap, and Miss Popularity calculation (contestant with most guesses, tie-broken by earliest ticket timestamp). CSV export for audit.

#### 5.3.7 Embedded Risk Safeguards

This system was designed for a live event where failure is not an option:

| Risk | Technical Safeguard | Physical Fallback |
|------|--------------------|--------------------|
| Cloudflare outage during draw | Audit logging, draw lock prevents partial states | Printed ticket stubs in physical glass bowl — mandatory pre-event checklist item |
| Database write failure | Auto-retry, unique submission reference prevents duplicates | Paper backup forms distributed to all volunteers |
| Unreliable venue WiFi | Pages are lightweight and functional on slow mobile data | Volunteers switch to mobile hotspot |
| Volunteer submits twice | Button disabled on first click; database rejects duplicate reference | System shows "already recorded" message |
| Two draw operators clicking simultaneously | Database-level atomic update guard | Second operator receives a clear error, not a silent failure |
| Wrong prize count configured | Count confirmed on-screen before draws begin | Pre-event checklist includes this as a mandatory step |
| Screenshot upload fails | Submission is saved without screenshot | Finance verifies via bank PayNow notification |

---

## 6. Data Protection and Privacy

### 6.1 Personal Data Held by SWA's Digital Systems

SWA's digital infrastructure collects and stores personal data across two of the three systems:

| System | Personal Data Held | Who Can Access |
|--------|--------------------|----------------|
| **Admin Portal** | Member names, email addresses, mobile numbers, photos, job titles, addresses, social media profiles | IT Admins and Admins only |
| **GTW 2026** | Guest names, phone numbers, email addresses, payment screenshots, arrival timestamps | SWA staff with dashboard access |
| **SWA Website** | Contact form submissions (name, email, message) forwarded immediately to `info@singaporewomenassociation.org`; not stored | N/A — not retained |

### 6.2 Compliance Obligations (PDPA)

SWA is subject to Singapore's **Personal Data Protection Act (PDPA)**. The following principles apply to all personal data held in the digital systems:

- **Purpose limitation:** Member data is collected for the purpose of managing SWA membership, operations, and events. Guest data (GTW and registration) is collected solely for event management.
- **Access control:** Personal data is accessible only to authenticated, authorised members. The public website has no access to any personal data.
- **Data minimisation:** The systems collect only what is necessary for their stated purpose. For example, guest phone numbers are collected for contact in case of a prize win — not for marketing.
- **Retention:** The board should establish and document retention periods for member records, guest lists, and payment screenshots. These should be reviewed annually.
- **Breach notification:** In the event of a data breach, SWA is required to notify the PDPC and affected individuals within the prescribed timeframe. The technical team should be the first point of contact for any suspected breach.

> **Board Action Required:** SWA should formally document its PDPA data protection policy and designate a Data Protection Officer (DPO) or equivalent responsibility. The digital systems provide the technical controls; the governance framework requires board endorsement.

### 6.3 Data Security Measures

| Layer | Measure |
|-------|---------|
| **Login protection** | One-time codes only — no passwords to steal or reuse. Codes expire in minutes. Bot-check on every login attempt. |
| **Session security** | Login sessions are cryptographically signed. A tampered or forged session cookie is rejected. |
| **Data isolation** | Each system has its own database. The portal cannot read GTW data; the public website cannot read either. |
| **File access** | Payment screenshots and member photos are not publicly accessible. Retrieval requires an authenticated session. |
| **Rate limiting** | All login and data-write operations are rate-limited to prevent automated abuse. |
| **Network security** | All sites enforce HTTPS. Headers block clickjacking, content injection, and MIME-type attacks. |
| **Audit logging** | All errors, and all draw operations, are permanently logged with timestamp and user identity. |

### 6.4 Known Security Consideration

**Stale Session After Role Change:** If a member's role is changed (e.g., an admin is demoted to committee), their existing login session will continue to reflect the old role until it naturally expires. This is a known architectural limitation, documented in the technical records, and is considered acceptable given SWA's operating context — role changes are infrequent and conducted by trusted IT administrators. The recommended long-term mitigation is server-side session re-validation, which is on the development roadmap.

---

## 7. Financial Controls (GTW 2026)

The GTW system handles real financial transactions. The following controls are embedded:

**Segregation of duties:** Volunteers record sales; finance staff confirm payments. The same person cannot perform both steps for the same transaction.

**Payment confirmation workflow:** Each submission is marked as unconfirmed by default. A finance staff member must explicitly confirm payment after independently verifying the PayNow screenshot or bank notification.

**Audit trail:** Every submission, payment confirmation, and draw result is permanently recorded in the database with the acting user's identity and timestamp. The draw audit log is immutable.

**No cash handling in the system:** The system records that cash was received and the amount, but does not process cash. Physical cash handling follows SWA's existing financial procedures.

**CSV export for reconciliation:** Finance can export a full transaction record at any time for cross-checking against bank statements.

---

## 8. Long-Term Sustainability

### 8.1 Cloudflare Free Tier

All three SWA applications run within Cloudflare's free tier. Based on current usage and projected growth, SWA will not require paid-tier upgrades for the foreseeable future.

| Resource | Free Tier Limit | SWA Usage |
|----------|----------------|-----------|
| Worker scripts (applications) | 10 | 3 (one per system) |
| Daily web requests | 100,000 | Well within limit |
| Databases | 5 | 2 (portal and GTW) |
| Database rows read per month | 5 million per database | Thousands |
| Database rows written per month | 100,000 per database | Hundreds |
| Configuration store (KV) namespaces | 10 | 4 |
| File storage (R2) | 10 GB total | Under 1 GB |
| File serving | No egress fees | Unlimited |
| Custom domains | Unlimited | 3 |

### 8.2 Why This Matters for SWA

Cloudflare's free tier is a **production-grade tier** used by thousands of organisations — not a limited trial plan. For SWA's scale, it will sustain the association indefinitely.

| Factor | Previous (Netlify) | Current (Cloudflare) |
|--------|-------------------|---------------------|
| Static page hosting | Free (bandwidth limits apply) | Free (no bandwidth limits) |
| API / server logic | Paid add-on | Free (100k requests/day included) |
| Database | Not included | Free (5 databases included) |
| File storage | Not included | Free (10 GB included) |
| File serving bandwidth | Charged above free limit | **No egress fees — ever** |
| Bot protection | Not included | Free (Turnstile, unlimited) |
| DDoS protection | Limited | Unlimited (Cloudflare's core product) |
| **Estimated monthly cost** | $0–$50+ depending on usage | **$0** |

### 8.3 Vendor Dependency Acknowledgement

SWA's digital infrastructure is substantially dependent on Cloudflare. The board should note:

- **Single platform dependency:** If Cloudflare were to significantly change its free tier terms, SWA would need to either migrate to another provider or absorb costs. The architecture uses open standards (standard SQL, standard web APIs) and is not locked into proprietary Cloudflare-only features — a migration, while effortful, would be feasible.
- **Resend (email):** All transactional email across all three systems goes through Resend. Its volume is well within the free tier. A Resend outage would prevent login codes and confirmation emails from being sent but would not affect core operations (ticket sales, bookings, and draw operations continue without email).
- **Twilio (WhatsApp):** Used optionally for GTW volunteer notifications only. If unavailable, ticket sales proceed normally.

---

## 9. Ownership and Governance

### 9.1 System Ownership

| System | Technical Owner | Operational Owner |
|--------|----------------|------------------|
| SWA Website | C J Tay (CTO & AI Solutions Architect) | Communications / Events |
| Admin Portal | C J Tay (CTO & AI Solutions Architect) | Secretary / President |
| GTW 2026 | C J Tay (CTO & AI Solutions Architect) | Finance / IT Admin |

### 9.2 Credential and Access Management

The following critical credentials must be documented, stored securely (e.g., in a sealed envelope held by the President or Secretary), and reviewed annually:

- **Cloudflare account login** — controls all three systems, domains, and infrastructure
- **Domain registrar login** — controls all three SWA domain names
- **Resend API account** — controls all transactional email delivery
- **Application secrets** — cryptographic keys stored within Cloudflare (not accessible externally, but must be re-generated if the account is compromised)

> **Board Action Required:** The board should confirm that at least two named individuals have documented access to the Cloudflare account and domain registrar, and that a sealed credential record is held by the President or Secretary. This is a governance requirement, not a technical one.

### 9.3 Succession Planning

The codebase is fully documented with AI-readable specifications (`AGENTS.md`, `CLAUDE.md` in each repository) designed to allow a new technical volunteer to understand, maintain, and extend each system with AI-assisted development tools. This documentation is the primary succession mechanism.

The board should note:
- All code is stored in private GitHub repositories under the `cjtay` account (`github.com/cjtay`)
- A new technical lead would need to be granted access to: GitHub repositories, Cloudflare account, domain registrar, and Resend account
- The AI-assisted development approach means the barrier to onboarding a capable technical volunteer is lower than for traditional codebases — the documentation is built for this purpose

> **Board Action Required:** The board should designate a successor technical lead and ensure they have been introduced to the codebase and tooling, even if they are not yet active.

---

## 10. One CTO, Three Systems, Zero IT Cost — Powered by AI Agents

### 10.1 The Model

All three SWA digital systems — the public website, the admin portal, and the GTW event microsite — are designed, built, operated, and maintained by a **single individual**: SWA's CTO & AI Solutions Architect, **C J Tay**.

This is not a conventional arrangement. Traditionally, a digital estate of this scale and complexity — three production applications, three databases, three domains, 680+ pages, 50+ API endpoints, real-time event operations, transactional email, file storage, authentication, and analytics — would require a team of developers, a project manager, and an ongoing agency or vendor relationship, with an associated annual cost running into tens of thousands of dollars.

SWA achieves the same outcome with **no IT staffing budget and no external vendor dependency** through the deliberate, strategic deployment of **AI development agents**.

### 10.2 How AI Agents Are Used

AI development agents are not simply tools for writing code faster. They function as skilled technical collaborators — capable of holding the full context of a complex system, reasoning about architectural decisions, identifying security gaps, reviewing code for correctness, and generating production-ready implementations from specifications.

In SWA's case, AI agents have been used across the full development lifecycle:

| Activity | What AI Agents Do | What the CTO Does |
|----------|------------------|------------------|
| **Architecture** | Analyse platform options, assess trade-offs, produce architectural recommendations | Evaluate recommendations, make decisions, set direction |
| **Development** | Generate complete API handlers, database schemas, authentication flows, email templates, and frontend components from specifications | Review all generated code, test against requirements, commit to version control |
| **Documentation** | Draft functional specifications, risk reports, implementation plans, user guides | Edit for accuracy, validate against actual implementation, finalise |
| **Code review** | Independent review pass identifying deviations, security gaps, and edge cases — often using a different AI agent from the one that wrote the code | Evaluate findings, decide on fixes |
| **Testing** | Generate test scenarios, seed data scripts, concurrency test scripts, edge case analysis | Run tests, interpret results, action failures |
| **Operations** | Assist with diagnostic analysis, log interpretation, performance assessment | Execute deployments, manage credentials, make operational decisions |

The CTO directs all activity and exercises judgement at every decision point. AI agents execute, generate, review, and advise — but do not deploy, hold credentials, or act autonomously on production systems.

### 10.3 Quality Safeguards

AI-generated code is never deployed without human oversight. The workflow for every production change is:

1. AI generates code against a documented specification
2. CTO reviews, tests locally, and commits to version control
3. Build verification runs automatically
4. Staging deployment and smoke testing
5. Independent AI-assisted code review (a separate agent reviews what a different agent produced)
6. Manual production deployment by the CTO

No automated deployment pipelines exist — every production deployment is a deliberate, manual action by the CTO.

### 10.4 Enterprise Capability at Charity Cost

The result of this model is that SWA operates with a digital capability profile that would typically require significant resources to acquire and sustain:

| Capability | Typical Enterprise Approach | SWA's Approach |
|------------|---------------------------|----------------|
| Three production web applications | Development team, DevOps, QA | Single CTO + AI agents |
| Secure authentication system | Security specialist, identity vendor | AI-designed OTP + HMAC, CTO implemented |
| Live event operations system | Event technology vendor | Custom-built, CTO operated |
| Real-time database and file storage | Cloud infrastructure team | Cloudflare free tier, zero management overhead |
| Transactional email | Email service contract | Resend free tier |
| Technical documentation | Technical writer | AI-drafted, CTO reviewed |
| Code review and security audit | External audit firm | AI-assisted review, CTO validated |
| **Total recurring IT cost** | **$30,000–$100,000+ per year** | **$0** |

### 10.5 Implications for SWA's Governance

The board should understand both the opportunity and the responsibility this model creates:

**Opportunity:** SWA can continue to build significant digital capabilities — membership fee management, form migration, a content editor, automated reminders — without any budget allocation, at a pace that would be impossible through traditional IT procurement.

**Responsibility:** The model's sustainability depends on retaining a technically capable CTO who can direct AI agents effectively. The documentation and specification approach is deliberately designed to reduce this dependency — a capable successor with AI tools can inherit the codebase — but the board should treat succession planning (Section 9.3) as a governance priority, not a contingency.

---

## 11. Third-Party Integrations

### 11.1 Resend (Transactional Email)

All SWA emails are sent through Resend's API.

| System | Emails Sent |
|--------|------------|
| SWA Website | Contact form replies to `info@singaporewomenassociation.org` |
| Admin Portal | Login codes, office booking confirmations, gala dinner guest registration links |
| GTW 2026 | Login codes, ticket confirmation emails (with BCC to volunteer), winner notifications |

**Sender address:** `contactus@singaporewomenassociation.org` with SPF and DKIM authentication configured — emails are less likely to be marked as spam.

**Resilience:** All emails are non-blocking. If Resend is temporarily unavailable, underlying operations (ticket sales, booking creation, guest check-in) still succeed. Email failures are logged for follow-up.

**Cost:** SWA's email volume is well within Resend's free tier.

### 11.2 Twilio (WhatsApp Notifications)

Optional WhatsApp notifications for GTW volunteers upon successful ticket submission. If Twilio is unavailable or credentials are not configured, ticket sales proceed normally — WhatsApp is an enhancement, not a dependency.

---

## 12. Roadmap

### 12.1 Immediate Priorities

| Item | System | Status |
|------|--------|--------|
| Member directory UI | Admin Portal | 🔄 In progress |
| Member photo upload form | Admin Portal | 🔄 In progress |
| Namecard management UI | Admin Portal | 🔄 In progress |
| GTW final testing | GTW 2026 | 🔄 In progress |
| Image library migration (Cloudinary → R2) | SWA Website | 📋 Next |
| Website rebuild trigger from portal | Admin Portal | 📋 Next |

### 12.2 Phase 2 — Membership Fee Management

- Membership type configuration (Ordinary, Life, etc.)
- Fee tracking dashboard (total collected, outstanding, overdue)
- Per-member payment history with payment proof upload to R2
- Admin payment confirmation workflow
- Automated payment reminders via scheduled email (Resend)
- Member self-service: view own membership status and upload payment proof

### 12.3 Phase 3 — Content Management and Form Migration

- A simple content editor in the Admin Portal for creating and publishing event posts to the SWA Website — eliminating the need for developer involvement in content updates
- Progressive migration of 16 Microsoft Forms to native SWA-hosted equivalents:
  - Priority 1: Volunteer registration, contact form
  - Priority 2: Gala table booking, advertisement booking, sponsor form
  - Priority 3: Programme enrolment forms (Laughter Yoga, Chair Yoga, IWD, etc.)
- Form submission dashboards in the Admin Portal

### 12.4 Planned Enhancements

- **Shared login across portal and GTW:** One login session covers both systems — a volunteer who is already logged into GTW would not need to log in separately to the portal, and vice versa.
- **Public website member directory from live database:** Member profiles on the public website would draw directly from the Admin Portal database, so changes appear on the website instantly without a rebuild.
- **E-ticket integration:** Automated e-ticket generation from the gala dinner guest list.
- **Multi-year GTW:** The GTW database is already designed to support multiple event years. Post-2026, a new event year can be set up without any code changes.

---

## 13. Conclusion

SWA's three-system digital ecosystem represents a deliberate architectural choice optimised for a charity operating on a volunteer budget:

1. **Zero recurring infrastructure cost.** The full stack — application servers, databases, file storage, session management, bot protection, and DDoS mitigation — runs within Cloudflare's free tier at current and projected scales.

2. **Risk isolation by design.** Each system fails independently. The public website cannot be brought down by event operations. A GTW fault cannot affect the admin portal.

3. **Event-grade resilience.** Every critical GTW draw operation has multiple independent safeguards — database-level locks, cryptographic randomness, permanent audit logging, and mandatory physical fallback procedures.

4. **No server maintenance.** No servers to provision, patch, or monitor. No database administration. No capacity planning. Cloudflare handles all infrastructure.

5. **Enterprise capability at zero IT cost.** All three systems are designed, built, and operated by SWA's CTO & AI Solutions Architect, C J Tay, single-handedly — through the strategic deployment of AI development agents. A digital estate of this scale and complexity would conventionally require a full IT team and annual expenditure of $30,000–$100,000 or more. SWA achieves equivalent capability at no recurring IT cost.

6. **Headroom for growth.** The architecture comfortably accommodates the planned Phase 2 (membership fees), Phase 3 (CMS and form migration), and further enhancements without any infrastructure cost increase.

**Items Requiring Board Action:**
1. Endorse and publish a formal PDPA data protection policy
2. Designate a Data Protection Officer or assign PDPA responsibility to a named role
3. Confirm that at least two named individuals have documented access to Cloudflare and domain registrar credentials, with a sealed copy held by the President or Secretary
4. Designate a successor technical lead and ensure introductory access has been arranged

---

## Appendix A: Cloudflare Resource Inventory

| Resource | Type | Used By |
|----------|------|---------|
| `swa-site` | Cloudflare Worker | SWA Website |
| `swa-portal` | Cloudflare Worker | Admin Portal |
| `swa-gtw` | Cloudflare Worker | GTW 2026 |
| `swa-portal` | D1 Database | Admin Portal |
| `swa-gtw` | D1 Database | GTW 2026 |
| `SWA_RATE_LIMIT` | KV Namespace | SWA Website |
| `SWA_SESSION` | KV Namespace | Admin Portal |
| `SWA_CONFIG` | KV Namespace | Admin Portal |
| `GTW_CONFIG` | KV Namespace | GTW 2026 |
| `swa-portal-uploads` | R2 Bucket | Admin Portal |
| `swa-gtw-assets` | R2 Bucket | GTW 2026 |

*Detailed technical identifiers (database IDs, namespace IDs) are maintained in the Technical Credentials Register held separately by the IT Administrator.*

---

## Appendix B: Key Technical Documentation

| Document | Location | Purpose |
|----------|----------|---------|
| Architecture Assessment | `swa-portal/docs/specs/SWA-Workers-Architecture-Assessment.md` | Three-worker vs one-worker analysis and recommendation |
| Cloudflare Migration Log | `swa2024/docs/cloudflare-workers-migration.md` | Netlify → Cloudflare migration record |
| GTW Master Summary | `gtw2026/docs/GTW-Implementation-Master-Summary-1.2.md` | Canonical GTW implementation reference |
| GTW Risk Report | `gtw2026/docs/GTW-Database-Design-and-Risk-Report.md` | Database rationale and risk register |
| GTW Implementation Risk Report | `gtw2026/docs/GTW-Implementation-Risk-Report.md` | 16 identified risks across 6 implementation phases |
| Portal Functional Spec | `swa-portal/docs/specs/SWAPortal-Functional-Specification.md` | Complete portal features, roles, APIs, data flows |
| Portal Implementation Plan | `swa-portal/docs/plans/SWAPortal-Implementation-Plan.md` | Phased delivery tracker with decisions log |
| GTW System Specification | `gtw2026/docs/GTW-System-Specification.md` | Full GTW design and rationale |
| Stale Session Risk Plan | `swa-portal/docs/plans/stale-session-privilege-escalation-plan.md` | Documented mitigation plan for known session limitation |

---

*This document is the authoritative functional specification for all SWA digital assets as of 23 May 2026. It should be reviewed and updated following any major architectural change, new system deployment, or annually at minimum.*

*Singapore Women's Association — www.singaporewomenassociation.org*
