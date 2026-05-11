export type Env = {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  SWA_SESSION: KVNamespace;
  ASSETS: Fetcher;
  OTP_SECRET: string;
  RESEND_API_KEY: string;
  SWA_ADMIN_DOMAIN: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_SITE_KEY: string;
};