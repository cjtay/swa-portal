export const IT_ADMIN_EMAILS = [
	"cjtay@singaporewomenassociation.org",
	"angela.wong@singaporewomenassociation.org",
	"system@singaporewomenassociation.org",
] as const;

// Display names for IT admins. Used when an IT-admin email holds no members
// row (e.g. system@) — otherwise the topbar name falls back to the email
// prefix. A members row, when present, always wins.
export const IT_ADMIN_NAMES: Record<string, string> = {
	"cjtay@singaporewomenassociation.org": "C J Tay",
	"angela.wong@singaporewomenassociation.org": "Angela Wong",
	"system@singaporewomenassociation.org": "SWA System",
};

export const SESSION_COOKIE_NAME = "swa_session";
// Marker cookie set by `DELETE /api/session` when the dev bypass is active.
// While present, `getDevBypassSession` returns null so the portal behaves as
// logged-out — letting you reach `/login` and pick a different dev identity
// via the dev role-picker. Cleared by `POST /api/dev/login`. Production never
// sets it: `handleLogout` only emits it when `isDevBypassActive` is true.
export const DEV_LOGOUT_COOKIE_NAME = "swa_dev_logout";
export const SESSION_DEFAULT_EXPIRY_MS = 12 * 60 * 60 * 1000;
export const SESSION_EXTENDED_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const OTP_TTL_SECONDS = 300;

export const OTP_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
export const OTP_RATE_LIMIT_MAX_REQUESTS = 5;

export const VERIFY_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
export const VERIFY_RATE_LIMIT_MAX_ATTEMPTS_IP = 10;
export const VERIFY_RATE_LIMIT_MAX_ATTEMPTS_EMAIL = 5;
export const VERIFY_MAX_FAILURES_PER_OTP = 5;

// Authenticated API rate limiting (per-user per-endpoint)
export const API_RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 15 minutes
export const API_RATE_LIMIT_MAX_REQUESTS = 10;

// Default recipients for public form submission notifications.
// May be overridden per-event via KV (swa:volunteer_event_config.notifyEmail).
export const VOLUNTEER_NOTIFY_EMAILS = [
	"cjtay@singaporewomenassociation.org",
	"jolene.lim@singaporewomenassociation.org",
	"angela.wong@singaporewomenassociation.org",
];

// Laughter Yoga form — recipients for new submission notifications.
// May be overridden per-event via KV (swa:laughter_yoga_config.notifyEmail).
export const LAUGHTER_YOGA_NOTIFY_EMAILS = [
	"cjtay@singaporewomenassociation.org",
	"jolene.lim@singaporewomenassociation.org",
	"angela.wong@singaporewomenassociation.org",
	"roxanne.zhang@singaporewomenassociation.org",
];

// Membership application form — recipients for new submission notifications.
export const MEMBERSHIP_NOTIFY_EMAILS = [
	"cjtay@singaporewomenassociation.org",
	'jolene.lim@singaporewomenassociation.org',
	'angela.wong@singaporewomenassociation.org',
];

// Restricted set of admins who can approve or reject membership applications.
// Other admins retain member/booking CRUD but cannot transition
// membership_applications.status. See docs/plans/membership-lifecycle-plan.md §3.
//
// The approve/reject gate is `isMembershipApprover(email)` (defined below),
// which checks membership in MEMBERSHIP_APPROVER_EMAILS OR IT_ADMIN_EMAILS.
// Per 14-07-2026 SWA review: IT admins can also approve/reject.
export const MEMBERSHIP_APPROVER_EMAILS = [
	'angela.wong@singaporewomenassociation.org',
	'roxanne.zhang@singaporewomenassociation.org',
	"cjtay@singaporewomenassociation.org",
] as const;

/**
 * Returns true if the given email is authorised to approve or reject
 * membership applications. The approver set is the union of
 * MEMBERSHIP_APPROVER_EMAILS and IT_ADMIN_EMAILS.
 *
 * Per 14-07-2026 SWA review: "IT admin to be able to approve or reject
 * membership" in addition to the named approvers.
 */
export function isMembershipApprover(email: string): boolean {
	const lower = email.toLowerCase();
	return (
		(IT_ADMIN_EMAILS as readonly string[]).includes(lower) ||
		(MEMBERSHIP_APPROVER_EMAILS as readonly string[]).includes(lower)
	);
}

// First-year membership fee tier (per 2026-07-13 SWA review).
// Tier resolved by submission month: Jan–Jun → $20; Jul–Dec → $10.
// Renewal fee is $20 every year, anchored to 31 January.
//
// Per 14-07-2026 SWA review: fees are hardcoded here as the single source
// of truth — no KV storage. The registration form reads these constants
// via /api/membership/config. The legacy membership_types D1 table is
// dormant and no longer read. See docs/plans/membership-lifecycle-plan.md §3.
export const MEMBERSHIP_FIRST_YEAR_FEE_BEFORE_JULY = 20;
export const MEMBERSHIP_FIRST_YEAR_FEE_FROM_JULY = 10;
export const MEMBERSHIP_RENEWAL_FEE = 20;

// PayNow merchant details for the membership application QR.
// UEN is the same SWA entity used across SWA online properties (e.g. gtw2026).
export const SWA_UEN = "S54SS0010L";
export const SWA_PAYNOW_MERCHANT_NAME = "SWA";

// IP rate limit for the public membership submission endpoint.
export const MEMBERSHIP_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
export const MEMBERSHIP_RATE_LIMIT_MAX_REQUESTS = 10;

// Max upload size for PayNow screenshot + signature image (10 MB each).
export const MEMBERSHIP_MAX_FILE_BYTES = 10 * 1024 * 1024;

// ── Namecard (public /c/* surface) ─────────────────────────────────────────
//
// IP-keyed rate limit for the public namecard endpoints: /c/:slug and its
// contact.vcf, card.svg and photo routes. The HTML page joined the limit on
// the 2026-08-23 restore; at 60 requests per 60 seconds a genuine QR-scan
// load never comes close. See docs/specs/features/namecards.md §5.4.
export const NAMECARD_PUBLIC_RATE_LIMIT_WINDOW_SECONDS = 60;
export const NAMECARD_PUBLIC_RATE_LIMIT_MAX_REQUESTS = 60;

// Hard server-side cap on namecard photo uploads. The admin upload form
// also resizes client-side to ~800×800, but the server enforces this
// regardless of what the client sends. See docs/specs/features/namecards.md §4.2.
export const NAMECARD_PHOTO_MAX_BYTES = 2 * 1024 * 1024;

// The SWA office address, shown on EVERY public namecard (HTML page, vCard,
// card image) instead of any member's personal address. Source: the footer of
// https://www.singaporewomenassociation.org (checked 2026-08-23). Personal
// address fields on members are never rendered on /c/*.
export const SWA_OFFICE_ADDRESS = {
	line1: "409 Serangoon Central, #01-303",
	line2: "",
	postal_code: "Singapore 550409",
	country: "Singapore",
} as const;

// Member categories that may have a public namecard. Cards are auto-generated
// for these categories; the public /c/* routes serve only these categories
// (read-time gate — a demoted member's card 404s immediately).
export const NAMECARD_BOARD_CATEGORIES = ["committee", "advisor"] as const;

// ── Approval workflow (two-stage: purchase, then finance) ──────────────────
//
// See docs/plans/Approval-Workflow-Implementation-Plan.md (v2). Roles follow
// the MEMBERSHIP_APPROVER_EMAILS email-list pattern.
//
// Stage one — purchase approvers. The union with IT_ADMIN_EMAILS also counts
// (Angela is already an IT admin, so she is a purchase approver
// automatically). During development the list holds the shared test inbox
// only; production addresses are swapped in before go-live (owner-gated,
// plan §16).
export const APPROVAL_PURCHASE_APPROVER_EMAILS = [
	// Dev/test only (shared inbox the owner controls):
	"approval@singaporewomenassociation.org",
	// Production (swap in at ship time):
	'roxanne.zhang@singaporewomenassociation.org',
	'angela.wong@singaporewomenassociation.org',
] as const;

// Stage two — finance approvers. IT admins are deliberately NOT added here:
// finance approval stays with YS and Joyce only, so an IT account can never
// approve a payment voucher (plan §3).
export const APPROVAL_FINANCE_APPROVER_EMAILS = [
	// Dev/test only (shared inbox the owner controls):
	"finance@singaporewomenassociation.org",
	// Dev-only Assistant Treasurer stand-in (compliance plan §5, settled
	// decision 1) — the second finance signature in local testing.
	// "internal@singaporewomenassociation.org",
	// Production — owner confirms YS's and Joyce's real addresses at ship time:
	'wong.ys@singaporewomenassociation.org',
	'joyce.yeo@singaporewomenassociation.org',
] as const;

/**
 * True if the email may approve or reject at the purchase stage. The approver
 * set is the union of APPROVAL_PURCHASE_APPROVER_EMAILS and IT_ADMIN_EMAILS.
 */
export function isPurchaseApprover(email: string): boolean {
	const lower = email.toLowerCase();
	return (
		(IT_ADMIN_EMAILS as readonly string[]).includes(lower) ||
		(APPROVAL_PURCHASE_APPROVER_EMAILS as readonly string[]).includes(lower)
	);
}

/**
 * True if the email may approve or reject at the finance stage. IT admins are
 * excluded by design — see APPROVAL_FINANCE_APPROVER_EMAILS above.
 */
export function isFinanceApprover(email: string): boolean {
	return (APPROVAL_FINANCE_APPROVER_EMAILS as readonly string[]).includes(email.toLowerCase());
}

/**
 * True if the session may create approval items, edit them, prepare vouchers
 * and record payments. Today this is the admin tier only (Jolene). The owner
 * may widen this later; widening means changing this one function, not
 * hunting through handlers (plan §3).
 */
export function canRaiseApprovalItem(session: { email: string; role: string }): boolean {
	return session.role === "admin";
}

// View-only approvals auditors (R2, owner discussion 2026-08-29). Chosen by
// email list — the same pattern as the approver lists — NOT a member
// category. An auditor can open /approvals, read the board, filter by the
// status tabs and open the drawer and its documents, but can never create,
// edit, prepare vouchers, approve, reject, pay, remind or export (R3 keeps
// export admin/IT-admin only). The middleware admits auditors to GET
// approvals endpoints only.
export const APPROVAL_AUDITOR_EMAILS = [
	// Dev/test placeholder — the owner swaps in the real auditor(s) at ship
	// time, same as the approver lists.
	"audit@singaporewomenassociation.org",
] as const;

/** True if the email is a view-only approvals auditor (R2). */
export function isApprovalsAuditor(email: string): boolean {
	return (APPROVAL_AUDITOR_EMAILS as readonly string[]).includes(email.toLowerCase());
}

// Item categories, each with a label and the default for approval_required.
// The three recurring types skip the purchase stage; every other type needs
// it. The create form can flip the default per item (plan §5).
export interface ApprovalCategory {
	key: string;
	label: string;
	requiresApproval: boolean;
}

export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = [
	{ key: "quotation", label: "Quotation", requiresApproval: true },
	{ key: "invoice", label: "Invoice", requiresApproval: true },
	{ key: "reimbursement", label: "Reimbursement", requiresApproval: true },
	{ key: "event_expense", label: "Event expense", requiresApproval: true },
	{ key: "office_maintenance", label: "Office maintenance", requiresApproval: false },
	{ key: "vendor_payment", label: "Vendor payment", requiresApproval: false },
	{ key: "payroll", label: "Payroll", requiresApproval: false },
	{ key: "other", label: "Other", requiresApproval: true },
];

// Attachment caps: 10 files per item, 10 MB per file (plan §9).
export const APPROVAL_MAX_FILES_PER_ITEM = 10;
export const APPROVAL_MAX_FILE_BYTES = 10 * 1024 * 1024;

// ── Finance-policy money rules ─────────────────────────────────────────────
//
// Thresholds from the "Finance Policy, Accounting and Procedure Manual",
// SWA, version 2, 15 December 2024. Amounts are the requested amount before
// GST. This file is the SINGLE place the numbers live (R8): the feature
// spec and user guide print the matrix but reference these constants, so a
// future policy change is a one-file edit.
// See docs/plans/approvals-finance-compliance-implementation-plan.md §3.
export const APPROVAL_QUOTE_RULE_THRESHOLD = 1_000; // declarations + quotes/waiver
export const APPROVAL_TWO_STAGE_THRESHOLD = 5_000; // both stages forced on
export const APPROVAL_BOARD_APPROVAL_THRESHOLD = 10_000;
export const APPROVAL_INVITATION_REMINDER_THRESHOLD = 6_000; // form reminder only
export const APPROVAL_TENDER_REMINDER_THRESHOLD = 90_000; // form reminder only

/**
 * True if the email may decide (approve or reject) the PURCHASE stage of an
 * item with the given requested amount (before GST, null when unknown).
 *
 * Finance Policy §3.2 puts purchases "Below $1000" with the
 * Treasurer/Secretary, so below the quote-rule threshold the finance
 * approvers (Treasurer/Assistant Treasurer) join the purchase approvers at
 * this stage — the Treasurer signs the small purchase and the President is
 * not needed. At S$1,000 and above only purchase approvers decide, as
 * before. A null/unknown amount fails closed: purchase approvers only.
 */
export function canDecidePurchaseStage(email: string, amount: number | null): boolean {
	if (isPurchaseApprover(email)) return true;
	if (amount === null || amount >= APPROVAL_QUOTE_RULE_THRESHOLD) return false;
	return isFinanceApprover(email);
}

// Office held by each approver address, shown beside the decider's name on
// the board, drawer, emails and voucher print. Local dev uses the shared
// test addresses; production addresses are owner-swapped at ship time.
// system@ holds no office and stays unmapped on purpose.
export const APPROVAL_OFFICE_LABELS: Record<string, string> = {
	// "approval@singaporewomenassociation.org": "President",
	// "cjtay@singaporewomenassociation.org": "1st Vice President",
	// "finance@singaporewomenassociation.org": "Treasurer",
	// "internal@singaporewomenassociation.org": "Assistant Treasurer",
	// Production (owner swaps in at ship time):
	'roxanne.zhang@singaporewomenassociation.org': 'President',
	'angela.wong@singaporewomenassociation.org': '1st Vice President',
	'wong.ys@singaporewomenassociation.org': 'Treasurer',
	'joyce.yeo@singaporewomenassociation.org': 'Assistant Treasurer',
};

/** The office label for an approver email, or null when none is mapped. */
export function approvalOfficeFor(email: string): string | null {
	return APPROVAL_OFFICE_LABELS[email.toLowerCase()] ?? null;
}
