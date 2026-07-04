export type Env = {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  SWA_SESSION: KVNamespace;
  SWA_CONFIG: KVNamespace;
  ASSETS: Fetcher;
  OTP_SECRET: string;
  SESSION_SECRET: string;
  RESEND_API_KEY: string;
  SWA_ADMIN_DOMAIN: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  // Dev-only auth bypass. MUST remain absent in production (not in
  // wrangler.jsonc vars, not set via `wrangler secret put`). When 'true',
  // the auth middleware short-circuits with a fake IT-admin session so
  // `npm run dev:worker` can be used without OTP login.
  DEV_BYPASS_AUTH?: string;
};

export type RegRole = 'reg_admin' | 'reg_volunteer' | null;