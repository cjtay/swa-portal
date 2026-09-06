import type { AppContext } from '../types';
import { handleApiError } from '../lib/error-handler';
import {
  isPurchaseApprover,
  isFinanceApprover,
  isApprovalsAuditor,
  APPROVAL_QUOTE_RULE_THRESHOLD,
} from '../../constants/portal';
import { getFeatureFlags } from '../lib/feature-flags';
import { getArrivalStats } from '../lib/reg/guests';

// GET /api/dashboard/summary — role-scoped counts for the dashboard's
// "needs your attention" panel and status strip.
//
// One request, one response, and each section is included only when the
// caller's role may see it — mirroring the middleware rules that guard the
// underlying surfaces (handlers re-check finer rules is the established
// convention). A plain committee member never receives the approvals key at
// all: financial data stays off their dashboard, exactly as the board is
// locked to them in gate 7c.
//
// Sections:
//   approvals — admin, either approver list, or the R2 view-only auditor.
//   forms     — admin or committee base role (the /api/admin/forms audience).
//   events    — events feature ON and the caller can see any event surface.
//
// GET reads are cheap parallel COUNT(*)s; no personal rows are returned.

const APPROVAL_STATUSES = [
  'pending',
  'purchase_approved',
  'finance_check',
  'finance_approved',
  'rejected',
  'paid',
] as const;

const RECENT_WINDOW_SQL = "created_at >= datetime('now', '-30 days')";

export async function handleDashboardSummary(c: AppContext) {
  const endpoint = 'dashboard-summary';
  const email = (c.get as unknown as (k: string) => unknown)('sessionEmail') as string || '';
  const role = (c.get as unknown as (k: string) => unknown)('sessionRole') as string || '';
  const regRole = ((c.get as unknown as (k: string) => unknown)('sessionRegRole') as string | null) ?? null;

  const isAdmin = role === 'admin';
  const isCommittee = role === 'committee';
  const canSeeApprovals = isAdmin || isPurchaseApprover(email) || isFinanceApprover(email) || isApprovalsAuditor(email);
  const canSeeForms = isAdmin || isCommittee;

  try {
    const payload: Record<string, unknown> = { success: true };

    // --- Approvals -------------------------------------------------------
    if (canSeeApprovals) {
      const [countResult, smallResult] = await Promise.all([
        c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM approval_items GROUP BY status').all(),
        c.env.DB.prepare(
          'SELECT COUNT(*) AS n FROM approval_items ' +
            'WHERE status = ? AND requested_amount IS NOT NULL AND requested_amount < ?',
        )
          .bind('pending', APPROVAL_QUOTE_RULE_THRESHOLD)
          .first<{ n: number }>(),
      ]);

      const counts: Record<string, number> = {
        pending: 0,
        purchase_approved: 0,
        finance_check: 0,
        finance_approved: 0,
        rejected: 0,
        paid: 0,
      };
      let all = 0;
      for (const row of (countResult.results || []) as Array<{ status: string; n: number }>) {
        if ((APPROVAL_STATUSES as readonly string[]).includes(row.status)) {
          counts[row.status] = Number(row.n);
          all += Number(row.n);
        }
      }
      counts.all = all;

      // Small-purchase authority (policy §3.2): pending items under
      // S$1,000 are decidable by the finance approvers too — a separate
      // count so the dashboard can show both queues honestly. Null
      // amounts fail closed and are never counted here.
      payload.approvals = {
        counts,
        pending_under_1000: Number(smallResult?.n || 0),
      };
    }

    // --- Online forms ----------------------------------------------------
    if (canSeeForms) {
      const [membershipRes, volunteerRes, laughterRes] = await Promise.all([
        c.env.DB.prepare("SELECT COUNT(*) AS n FROM membership_applications WHERE status = 'pending'").first<{ n: number }>(),
        c.env.DB.prepare(`SELECT COUNT(*) AS n FROM volunteer_registrations WHERE ${RECENT_WINDOW_SQL}`).first<{ n: number }>(),
        c.env.DB.prepare(`SELECT COUNT(*) AS n FROM laughter_yoga_registrations WHERE ${RECENT_WINDOW_SQL}`).first<{ n: number }>(),
      ]);
      payload.forms = {
        membership_pending: Number(membershipRes?.n || 0),
        // The volunteer and laughter tables carry no status column — the
        // honest attention signal is how fresh the queue is, so these
        // count submissions received in the last 30 days.
        volunteer_recent: Number(volunteerRes?.n || 0),
        laughter_recent: Number(laughterRes?.n || 0),
      };
    }

    // --- Events (arrivals) -----------------------------------------------
    const features = await getFeatureFlags(c.env, c.req.url);
    const canSeeEvents =
      features.events && (isAdmin || isCommittee || regRole === 'reg_admin' || regRole === 'reg_volunteer');
    if (canSeeEvents) {
      const stats = await getArrivalStats(c.env.DB);
      payload.events = {
        total_expected: stats.totalExpected,
        total_arrived: stats.totalArrived,
        walk_in_count: stats.walkInCount,
        arrival_pct: stats.arrivalPct,
      };
    }

    return c.json(payload);
  } catch (err) {
    return handleApiError(c, endpoint, err, 'Could not load the dashboard summary.', {
      error_type: 'D1_DASHBOARD_SUMMARY',
      http_status: 500,
    });
  }
}
