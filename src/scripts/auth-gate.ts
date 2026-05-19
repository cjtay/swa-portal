interface SessionResponse {
  authenticated: boolean;
  email: string | null;
  name: string | null;
  role: string | null;
  regRole: string | null;
  is_admin: boolean;
  is_it_admin: boolean;
}

interface AuthGateOptions {
  requireAdmin?: boolean;
  requireItAdmin?: boolean;
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
      if (requireAdmin && !data.is_admin) {
        window.location.href = '/office-booking';
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

export function requireRegAdmin(onAuthenticated?: (data: SessionResponse) => void): void {
  requireAuth({
    onAuthenticated: (data) => {
      if (data.role !== 'admin' && data.regRole !== 'reg_admin') {
        window.location.href = '/';
        return;
      }
      onAuthenticated?.(data);
    },
  });
}

export function requireRegVolunteer(onAuthenticated?: (data: SessionResponse) => void): void {
  requireAuth({
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

export function requireItAdmin(onAuthenticated?: (data: SessionResponse) => void): void {
  requireAuth({
    requireItAdmin: true,
    onAuthenticated,
  });
}