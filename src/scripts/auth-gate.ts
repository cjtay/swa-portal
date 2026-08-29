// Feature availability keys — mirrored from src/worker/lib/feature-flags.ts
// (the worker-side type is not importable from page scripts at runtime).
export type FeatureKey = 'namecards' | 'office_booking' | 'events';

export interface FeatureFlags {
  namecards: boolean;
  office_booking: boolean;
  events: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  email: string | null;
  name: string | null;
  role: string | null;
  regRole: string | null;
  is_admin: boolean;
  is_it_admin: boolean;
  is_purchase_approver: boolean;
  is_finance_approver: boolean;
  // IT-admin kill-switch for the approvals AI quotation comparison. False
  // hides the Analyse/Regenerate buttons (server also returns 503).
  ai_comparison_enabled: boolean;
  // Runtime feature availability (KV-overridden code defaults; see
  // src/worker/lib/feature-flags.ts). Disabled features hide their nav
  // items/cards and bounce direct page visits to the dashboard; the server
  // also gates their APIs with 503 FEATURE_DISABLED.
  features: FeatureFlags;
}

interface AuthGateOptions {
  requireAdmin?: boolean;
  requireItAdmin?: boolean;
  // Redirect to the dashboard when this feature is switched off. Applied
  // before role checks so a disabled feature hides for every role.
  feature?: FeatureKey;
  onAuthenticated?: (data: SessionResponse) => void;
  onError?: () => void;
}

function redirectLogin() {
  window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
}

export function requireAuth(options?: AuthGateOptions): void {
  const {
    requireAdmin = false,
    requireItAdmin = false,
    feature,
    onAuthenticated,
    onError,
  } = options || {};

  fetch('/api/session')
    .then((r) => r.json())
    .then((data: SessionResponse) => {
      if (!data.authenticated) {
        redirectLogin();
        return;
      }
      if (feature && data.features && !data.features[feature]) {
        window.location.href = '/';
        return;
      }
      if (requireAdmin && !data.is_admin) {
        window.location.href = '/';
        return;
      }
      if (requireItAdmin && !data.is_it_admin) {
        window.location.href = '/';
        return;
      }
      onAuthenticated?.(data);
    })
    .catch(() => {
      if (onError) {
        onError();
      } else {
        redirectLogin();
      }
    });
}

export function redirectIfAuthenticated(): void {
  const params = new URLSearchParams(window.location.search);
  const redirect = params.get('redirect') || '/';

  fetch('/api/session')
    .then((r) => r.json())
    .then((data: SessionResponse) => {
      if (data.authenticated) {
        window.location.href = redirect;
      }
    })
    .catch(() => {});
}

export function requireRegAdmin(
  onAuthenticated?: (data: SessionResponse) => void,
  opts?: { feature?: FeatureKey },
): void {
  requireAuth({
    feature: opts?.feature,
    onAuthenticated: (data) => {
      if (data.role !== 'admin' && data.regRole !== 'reg_admin') {
        window.location.href = '/';
        return;
      }
      onAuthenticated?.(data);
    },
  });
}

export function requireRegVolunteer(
  onAuthenticated?: (data: SessionResponse) => void,
  opts?: { feature?: FeatureKey },
): void {
  requireAuth({
    feature: opts?.feature,
    onAuthenticated: (data) => {
      if (
        data.role !== 'admin' &&
        data.role !== 'committee' &&
        data.regRole !== 'reg_admin' &&
        data.regRole !== 'reg_volunteer'
      ) {
        window.location.href = '/';
        return;
      }
      onAuthenticated?.(data);
    },
  });
}

export function requireItAdmin(
  onAuthenticated?: (data: SessionResponse) => void,
  opts?: { feature?: FeatureKey },
): void {
  requireAuth({
    requireItAdmin: true,
    feature: opts?.feature,
    onAuthenticated,
  });
}