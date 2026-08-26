// Tests for the AI quotation comparison feature
// (docs/plans/AI-Quotation-Comparison-Plan.md).
//
// Two layers:
// 1. Library tests run the real pipeline against a FAKE AI binding — no
//    Workers AI quota is ever spent in the test run (the binding in
//    wrangler.jsonc proxies to the live service).
// 2. Endpoint guard tests exercise the paths that return BEFORE any AI call
//    (role gate, kill-switch 503, daily breaker 429, validation 400) via
//    SELF.fetch, following the approvals.test.ts cookie-minting pattern.
//
// KV state (SWA_CONFIG ai keys, SWA_SESSION breaker keys) is cleaned between
// tests because the whole file shares one Miniflare instance.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signHmac, base64urlEncode } from '../../lib/crypto';
import { SESSION_COOKIE_NAME, IT_ADMIN_EMAILS, APPROVAL_CATEGORIES } from '../../../constants/portal';
import { applyMigrations, seedMember } from '../../../../test/db-helpers';
import type { Env, AiBinding } from '../../types';
import {
  AI_MODEL_COMPARE,
  AI_MODEL_EXTRACT,
  AI_ANALYSES_PER_DAY,
  convertToSgd,
  consumeDailyAnalysisQuota,
  extractJson,
  isAiComparisonEnabled,
  parseAiComparisonJson,
  parseExtractedQuote,
  runAiComparison,
  type AiComparisonInput,
} from '../ai-comparison';

const ADMIN_EMAIL = 'ai-test-admin@example.com';
const FINANCE_EMAIL = 'finance@singaporewomenassociation.org';
const AI_CONFIG_KEY = 'swa:ai_config';
const FX_CACHE_KEY = 'swa:ai_fx_cache';

// ── helpers ────────────────────────────────────────────────────────────────

async function mintCookie(email: string, role: string): Promise<string> {
  const payload = base64urlEncode(
    JSON.stringify({ email, name: `Test ${role}`, role, regRole: null, exp: Date.now() + 60 * 60 * 1000 }),
  );
  const signature = await signHmac(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}`;
}

async function cleanAiKv(): Promise<void> {
  await env.SWA_CONFIG.delete(AI_CONFIG_KEY);
  await env.SWA_CONFIG.delete(FX_CACHE_KEY);
  const listed = await env.SWA_SESSION.list({ prefix: 'swa:rl:ai-analysis-daily' });
  for (const key of listed.keys) await env.SWA_SESSION.delete(key.name);
}

/** Seed the FX cache so no test ever fetches the live FX API. */
async function seedFx(): Promise<void> {
  // 1 SGD = 0.75 USD → 150 USD = 200 SGD exactly.
  await env.SWA_CONFIG.put(FX_CACHE_KEY, JSON.stringify({ date: '2026-08-26', rates: { SGD: 1, USD: 0.75, MYR: 3.5 } }));
}

function pdfInput(name = 'quote.pdf'): AiComparisonInput {
  return { filename: name, mime: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 some quotation').buffer as ArrayBuffer };
}

function imageInput(name = 'photo.jpg'): AiComparisonInput {
  return { filename: name, mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer };
}

// The fake binding answers extraction (image vs text) and comparison calls
// with canned JSON; toMarkdown returns fixed PDF text.
const PDF_TEXT_QUOTE = { vendor: 'Text Vendor Pte Ltd', itemName: 'Foldable tables', totalPrice: 1000, currency: 'SGD' };
const IMAGE_TEXT_QUOTE = { vendor: 'Photo Vendor Sdn Bhd', itemName: 'Foldable tables', totalPrice: 150, currency: 'USD' };

function makeFakeAi(overrides: Partial<AiBinding> = {}): AiBinding {
  return {
    async run(model, inputs) {
      if (model === AI_MODEL_EXTRACT) {
        const quote = (inputs as { image?: unknown }).image ? IMAGE_TEXT_QUOTE : PDF_TEXT_QUOTE;
        return { response: '```json\n' + JSON.stringify({ ...quote, unitPrice: null, description: null, gst: null, validity: null, leadTime: null }) + '\n```' };
      }
      if (model === AI_MODEL_COMPARE) {
        return { response: JSON.stringify({ summary: 'Text Vendor is cheaper overall.', recommendation: 'Choose Text Vendor Pte Ltd.' }) };
      }
      throw new Error('unexpected model ' + model);
    },
    async toMarkdown() {
      return { format: 'markdown' as const, data: 'Quotation from Text Vendor Pte Ltd. Total: S$1,000.00.' };
    },
    ...overrides,
  };
}

function fakeEnv(ai: AiBinding): Env {
  // Structurally complete enough for runAiComparison: it only touches AI and
  // SWA_CONFIG.
  return { AI: ai, SWA_CONFIG: env.SWA_CONFIG } as unknown as Env;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedMember(env.DB, { name: 'AI Test Admin', email: ADMIN_EMAIL, category: 'admin' });
  await seedMember(env.DB, { name: 'Finance Approver', email: FINANCE_EMAIL, category: 'committee' });
});

beforeEach(async () => {
  await cleanAiKv();
});

// ── pure helpers ───────────────────────────────────────────────────────────

describe('extractJson', () => {
  it('parses raw, fenced and prose-wrapped JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} hope that helps')).toEqual({ a: 1 });
  });

  it('returns null for unparseable text', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});

describe('parseExtractedQuote', () => {
  it('normalises fields and keeps unknowns null', () => {
    const q = parseExtractedQuote({ vendor: '  V ', unitPrice: 'S$1,234.50', currency: 'sgd', bogus: 'x' });
    expect(q.vendor).toBe('V');
    expect(q.unitPrice).toBe(1234.5);
    expect(q.currency).toBe('sgd');
    expect(q.itemName).toBeNull();
  });
});

describe('convertToSgd', () => {
  const fx = { date: '2026-08-26', rates: { SGD: 1, USD: 0.75, MYR: 3.5 } };
  it('passes SGD through', () => {
    expect(convertToSgd(150, 'SGD', fx)).toBe(150);
  });
  it('divides by the per-1-SGD rate (150 USD at 0.75 = 200 SGD)', () => {
    expect(convertToSgd(150, 'USD', fx)).toBe(200);
  });
  it('returns null for unknown currency or missing table', () => {
    expect(convertToSgd(150, 'EUR', fx)).toBeNull();
    expect(convertToSgd(150, 'USD', null)).toBeNull();
  });
  it('returns null for unusable amounts', () => {
    expect(convertToSgd(null, 'USD', fx)).toBeNull();
    expect(convertToSgd(Number.NaN, 'USD', fx)).toBeNull();
  });
});

// ── kill-switch + breaker ──────────────────────────────────────────────────

describe('isAiComparisonEnabled', () => {
  it('defaults to enabled when the key is missing', async () => {
    expect(await isAiComparisonEnabled(env.SWA_CONFIG)).toBe(true);
  });
  it('is disabled only by {"enabled": false}', async () => {
    await env.SWA_CONFIG.put(AI_CONFIG_KEY, JSON.stringify({ enabled: false }));
    expect(await isAiComparisonEnabled(env.SWA_CONFIG)).toBe(false);
    await env.SWA_CONFIG.put(AI_CONFIG_KEY, JSON.stringify({ enabled: true }));
    expect(await isAiComparisonEnabled(env.SWA_CONFIG)).toBe(true);
  });
  it('treats malformed KV as enabled (safe default)', async () => {
    await env.SWA_CONFIG.put(AI_CONFIG_KEY, 'not json');
    expect(await isAiComparisonEnabled(env.SWA_CONFIG)).toBe(true);
  });
});

describe('consumeDailyAnalysisQuota', () => {
  it('allows and increments below the cap', async () => {
    expect(await consumeDailyAnalysisQuota(env.SWA_SESSION)).toBe(true);
    expect(await consumeDailyAnalysisQuota(env.SWA_SESSION)).toBe(true);
  });
  it('refuses at the cap', async () => {
    const key = `swa:rl:ai-analysis-daily:${new Date().toISOString().slice(0, 10)}`;
    await env.SWA_SESSION.put(key, String(AI_ANALYSES_PER_DAY));
    expect(await consumeDailyAnalysisQuota(env.SWA_SESSION)).toBe(false);
  });
});

// ── pipeline with fake AI ──────────────────────────────────────────────────

describe('runAiComparison', () => {
  it('reads PDF + photo, converts to S$ in code, and writes the narrative', async () => {
    await seedFx();
    const analysis = await runAiComparison(fakeEnv(makeFakeAi()), [pdfInput(), imageInput()], ADMIN_EMAIL);

    expect(analysis.version).toBe(1);
    expect(analysis.files.map((f) => f.status)).toEqual(['ok', 'ok']);
    expect(analysis.quotes).toHaveLength(2);

    const pdf = analysis.quotes.find((q) => q.filename === 'quote.pdf')!;
    expect(pdf.vendor).toBe('Text Vendor Pte Ltd');
    expect(pdf.totalPrice).toBe(1000);
    expect(pdf.totalPriceSgd).toBe(1000); // SGD passthrough

    const photo = analysis.quotes.find((q) => q.filename === 'photo.jpg')!;
    expect(photo.totalPrice).toBe(150);
    expect(photo.totalPriceSgd).toBe(200); // 150 / 0.75

    expect(analysis.summary).toBe('Text Vendor is cheaper overall.');
    expect(analysis.recommendation).toBe('Choose Text Vendor Pte Ltd.');
    expect(analysis.fx?.date).toBe('2026-08-26');
  });

  it('skips unsupported types and records per-file errors, never silently', async () => {
    await seedFx();
    const failingVision: AiBinding = makeFakeAi({
      async run(model, inputs) {
        if (model === AI_MODEL_EXTRACT) {
          // Only the photo (vision) call fails; the PDF text path works.
          if ((inputs as { image?: unknown }).image) throw new Error('vision exploded');
          return { response: JSON.stringify(PDF_TEXT_QUOTE) };
        }
        return { response: '{}' };
      },
    });
    const analysis = await runAiComparison(fakeEnv(failingVision), [
      { filename: 'contract.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: new ArrayBuffer(4) },
      imageInput('broken.jpg'),
      pdfInput('good.pdf'),
    ], ADMIN_EMAIL);

    expect(analysis.files.find((f) => f.filename === 'contract.docx')?.status).toBe('skipped');
    expect(analysis.files.find((f) => f.filename === 'broken.jpg')?.status).toBe('error');
    expect(analysis.files.find((f) => f.filename === 'good.pdf')?.status).toBe('ok');
    expect(analysis.quotes).toHaveLength(1);
  });

  it('returns empty quotes and a null summary when nothing can be read', async () => {
    await seedFx();
    // A scanned PDF: toMarkdown succeeds but returns no text → honest skip.
    const emptyAi: AiBinding = makeFakeAi({
      async toMarkdown() {
        return { format: 'markdown' as const, data: '   ' };
      },
    });
    const analysis = await runAiComparison(fakeEnv(emptyAi), [pdfInput('blank.pdf')], ADMIN_EMAIL);
    expect(analysis.quotes).toHaveLength(0);
    expect(analysis.summary).toBeNull();
    expect(analysis.files[0].status).toBe('skipped');
  });
});

// ── client-supplied JSON validation ────────────────────────────────────────

describe('parseAiComparisonJson', () => {
  const valid = JSON.stringify({
    version: 1,
    generatedAt: '2026-08-26T10:00:00.000Z',
    generatedBy: ADMIN_EMAIL,
    models: { extract: AI_MODEL_EXTRACT, compare: AI_MODEL_COMPARE },
    fx: { date: '2026-08-26', source: 'open.er-api.com' },
    files: [{ filename: 'a.pdf', status: 'ok', note: null }],
    quotes: [{ filename: 'a.pdf', vendor: 'V', unitPriceSgd: 10, totalPriceSgd: 100 }],
    summary: 's',
    recommendation: 'r',
  });

  it('accepts a well-formed analysis', () => {
    expect(parseAiComparisonJson(valid)?.quotes).toHaveLength(1);
  });
  it('rejects malformed, wrong-version and oversized payloads', () => {
    expect(parseAiComparisonJson('not json')).toBeNull();
    expect(parseAiComparisonJson('{"version":2}')).toBeNull();
    // Missing the files/quotes arrays entirely.
    expect(parseAiComparisonJson('{"version":1,"generatedAt":"x","generatedBy":"y"}')).toBeNull();
    expect(parseAiComparisonJson('x'.repeat(200 * 1024))).toBeNull();
  });
});

// ── endpoint guards (all return before any AI call) ────────────────────────

describe('AI analyse endpoints — guards', () => {
  it('finance approver gets 403 on analyse-preview', async () => {
    const res = await SELF.fetch('https://example.com/api/approvals/analyse-preview', {
      method: 'POST',
      headers: { Cookie: await mintCookie(FINANCE_EMAIL, 'committee') },
    });
    expect(res.status).toBe(403);
  });

  it('kill-switch returns 503 and the session flag reads false', async () => {
    await env.SWA_CONFIG.put(AI_CONFIG_KEY, JSON.stringify({ enabled: false }));
    const cookie = await mintCookie(ADMIN_EMAIL, 'admin');

    const res = await SELF.fetch('https://example.com/api/approvals/analyse-preview', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: new FormData(), // would be invalid anyway — 503 must win
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error_code?: string };
    expect(body.error_code).toBe('FEATURE_DISABLED');

    const session = (await (await SELF.fetch('https://example.com/api/session', { headers: { Cookie: cookie } })).json()) as {
      ai_comparison_enabled?: boolean;
    };
    expect(session.ai_comparison_enabled).toBe(false);
  });

  it('daily breaker returns 429 before any AI runs', async () => {
    const key = `swa:rl:ai-analysis-daily:${new Date().toISOString().slice(0, 10)}`;
    await env.SWA_SESSION.put(key, String(AI_ANALYSES_PER_DAY));
    const res = await SELF.fetch('https://example.com/api/approvals/analyse-preview', {
      method: 'POST',
      headers: { Cookie: await mintCookie(ADMIN_EMAIL, 'admin') },
      body: new FormData(),
    });
    expect(res.status).toBe(429);
  });

  it('fewer than two files returns 400', async () => {
    const form = new FormData();
    form.append('files', new File(['%PDF-1.4 x'], 'one.pdf', { type: 'application/pdf' }));
    const res = await SELF.fetch('https://example.com/api/approvals/analyse-preview', {
      method: 'POST',
      headers: { Cookie: await mintCookie(ADMIN_EMAIL, 'admin') },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('analyse on an item without comparison rows returns 400 (before AI)', async () => {
    const createRes = await SELF.fetch('https://example.com/api/approvals', {
      method: 'POST',
      headers: { Cookie: await mintCookie(ADMIN_EMAIL, 'admin') },
      body: (() => {
        const form = new FormData();
        form.append('category', APPROVAL_CATEGORIES[0].key);
        form.append('title', 'AI guard test');
        return form;
      })(),
    });
    const created = (await createRes.json()) as { success: boolean; id: number };
    expect(created.success).toBe(true);

    const res = await SELF.fetch(`https://example.com/api/approvals/${created.id}/analyse`, {
      method: 'POST',
      headers: { Cookie: await mintCookie(ADMIN_EMAIL, 'admin') },
    });
    expect(res.status).toBe(400);
  });
});

// ── settings key ───────────────────────────────────────────────────────────

describe('swa:ai_config settings key', () => {
  it('POST stores a boolean config and GET reads it back (IT admin)', async () => {
    const itAdminCookie = await mintCookie((IT_ADMIN_EMAILS as readonly string[])[0], 'admin');
    await seedMember(env.DB, {
      name: 'IT Admin',
      email: (IT_ADMIN_EMAILS as readonly string[])[0],
      category: 'admin',
    });

    const post = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: itAdminCookie },
      body: JSON.stringify({ key: AI_CONFIG_KEY, value: { enabled: false } }),
    });
    expect(post.status).toBe(200);

    const get = await SELF.fetch(`https://example.com/api/admin/settings?key=${AI_CONFIG_KEY}`, {
      headers: { Cookie: itAdminCookie },
    });
    const body = (await get.json()) as { success: boolean; value: { enabled: boolean } };
    expect(body.success).toBe(true);
    expect(body.value.enabled).toBe(false);
  });

  it('rejects a non-boolean value', async () => {
    const itAdminCookie = await mintCookie((IT_ADMIN_EMAILS as readonly string[])[0], 'admin');
    const res = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: itAdminCookie },
      body: JSON.stringify({ key: AI_CONFIG_KEY, value: { enabled: 'yes' } }),
    });
    expect(res.status).toBe(400);
  });
});
