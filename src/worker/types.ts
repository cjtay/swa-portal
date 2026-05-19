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
};

export type RegRole = 'reg_admin' | 'reg_volunteer' | null;