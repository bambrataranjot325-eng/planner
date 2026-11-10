import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Mode } from './types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ModelSpec = z.object({
  provider: z.enum(['groq', 'anthropic']),
  model: z.string(),
  usd_per_mtok_in: z.number().nonnegative(),
  usd_per_mtok_out: z.number().nonnegative(),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

const Models = z.object({
  prompt_version: z.string(),
  first_pass: ModelSpec,
  bulk: ModelSpec.optional(), // cheaper model for newsletters and list mail
  escalation: ModelSpec,
  escalate_below_confidence: z.number(),
  review_below_confidence: z.number(),
  max_body_chars: z.number().int().positive(),
});
export type Models = z.infer<typeof Models>;

export function loadModels(): Models {
  return Models.parse(JSON.parse(readFileSync(join(root, 'config', 'models.json'), 'utf8')));
}

export function loadPrompt(version: string): string {
  return readFileSync(join(root, 'prompts', `${version}.md`), 'utf8').trim();
}

export const fixturesDir = join(root, 'fixtures');
export const reportsDir = process.env.REPORTS_DIR ?? join(root, 'reports');

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(20),
  USER_ID: z.string().uuid(),
  GOOGLE_CLIENT_ID: z.string().min(10),
  GOOGLE_CLIENT_SECRET: z.string().min(10),
  GROQ_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  MODE: z.enum(['preview', 'dry-run', 'live']).default('dry-run'),
  DEFAULT_TIMEZONE: z.string().default('America/New_York'),
  POLL_MINUTES: z.coerce.number().int().min(1).default(15),
  BACKFILL_DAYS: z.coerce.number().int().min(1).default(30),
  DRY_RUN_LIMIT: z.coerce.number().int().min(1).default(60),
  // During the first 30-day backfill, don't create items for things that have already happened.
  BACKFILL_SKIP_PAST: z.enum(['true', 'false']).default('true'),
  OAUTH_REDIRECT_URI: z.string().url().default('http://localhost:53682/oauth/callback'),
  BRIGHTSPACE_FEED_URL: z.string().url().optional(),
  BRIGHTSPACE_MINUTES: z.coerce.number().int().min(5).default(60),
  // Push services ask for a contact address in case a sender misbehaves. Any address of yours.
  PUSH_CONTACT: z.string().regex(/^(mailto:|https:\/\/)/).default('mailto:planner@example.com'),
});
export type Env = z.infer<typeof Env> & { MODE: Mode };

export function loadEnv(): Env {
  const r = Env.safeParse(process.env);
  if (!r.success) {
    const missing = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Bad or missing settings in .env:\n  ${missing}`);
  }
  return r.data;
}

/** Structured log line. Never pass tokens, keys or email bodies here. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
