import type { Context } from 'hono';

// Minimal structural type for the Workers AI binding (wrangler.jsonc
// "ai.binding"). Only the two operations this portal uses — model inference
// via run() and document→text conversion via toMarkdown() — are declared, so
// the worker code never depends on the generated runtime-types file.
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRunTextResult {
  // The runtime returns the model text here, OR an already-parsed object when
  // the call used guided_json (verified against the live service 2026-08-26).
  response?: string | Record<string, unknown>;
  // Chat-completions shape (the runtime also returns choices[].message.content).
  choices?: Array<{ message?: { content?: string | Array<Record<string, unknown>> } }>;
  errors?: unknown[];
}

export interface AiToMarkdownResult {
  id?: string;
  name?: string;
  format?: 'markdown' | 'text' | 'error';
  mimetype?: string;
  tokens?: number;
  data?: string;
  error?: string;
}

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<AiRunTextResult>;
  toMarkdown(
    files: Array<{ name: string; blob: Blob } | { name: string; blob: Blob }[]> | { name: string; blob: Blob },
  ): Promise<AiToMarkdownResult | AiToMarkdownResult[]>;
}

export type Env = {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  SWA_SESSION: KVNamespace;
  SWA_CONFIG: KVNamespace;
  ASSETS: Fetcher;
  AI: AiBinding;
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
  // Optional local-only override for every auto-triggered email recipient
  // (comma-separated). Only read when the local-dev SESSION_SECRET anchor is
  // present, so it can never reroute staging/production mail. Intended for
  // .dev.vars; leave unset everywhere else. See lib/notify-recipients.ts.
  NOTIFY_RECIPIENTS_OVERRIDE?: string;
};

export type RegRole = 'reg_admin' | 'reg_volunteer' | null;

export type AppVariables = {
  sessionEmail: string;
  sessionName: string;
  sessionRole: string;
  sessionRegRole: string | null;
};

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};

export type AppContext = Context<AppEnv>;