// Session cookie construction shared by verify-otp (initial issue), the auth
// middleware (re-sign on role change — see session-revalidation.ts) and tests.
import { SESSION_COOKIE_NAME } from '../../constants/portal';
import { signHmac, base64urlEncode } from './crypto';

export interface SessionPayload {
  email: string;
  name: string;
  role: string;
  regRole: string | null;
  exp: number;
}

export async function signSessionCookie(payload: SessionPayload, secret: string): Promise<string> {
  const encoded = base64urlEncode(JSON.stringify(payload));
  const signature = await signHmac(encoded, secret);
  return `${encoded}.${signature}`;
}

export function sessionCookieHeader(cookieValue: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, maxAgeSeconds)}`;
}

export function clearedSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
