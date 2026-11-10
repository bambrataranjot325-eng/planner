import type { Models, ModelSpec } from '../config.js';
import type { ExistingItem, UsageRecord } from '../types.js';
import { estimateCost, type LlmFn } from './llm.js';
import { parseExtraction, type ExtractedItem } from './schema.js';

export interface ExtractInput {
  from: string;
  subject: string;
  receivedAnchor: string; // "Tuesday 2026-11-10 14:05 (America/New_York)"
  body: string; // cleaned and redacted
  existing: ExistingItem[];
  bulk?: boolean; // newsletter, digest or list mail
}

export interface ExtractOutcome {
  items: ExtractedItem[];
  usage: UsageRecord[];
  escalated: boolean;
  failed: boolean;
  error?: string;
}

/** Exactly what is sent to the model as the user message. Preview mode prints this. */
export function buildUserPrompt(input: ExtractInput): string {
  const existing = input.existing.length
    ? input.existing
        .map((e) => `- id ${e.id} | ${e.kind} | ${e.when ?? 'no date'} | ${e.title}`)
        .join('\n')
    : '(none)';
  return [
    `From: ${input.from}`,
    `Subject: ${input.subject}`,
    `Received: ${input.receivedAnchor}`,
    `Bulk mail: ${input.bulk ? 'yes' : 'no'}`,
    '',
    'Existing items (this thread, and other open items):',
    existing,
    '',
    'Body:',
    input.body || '(empty)',
  ].join('\n');
}

async function runModel(
  call: LlmFn,
  spec: ModelSpec,
  purpose: string,
  system: string,
  user: string,
  usage: UsageRecord[],
): Promise<{ items: ExtractedItem[] | null; error?: string }> {
  let prompt = user;
  let error = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    // One retry on a malformed reply, telling the model what was wrong.
    const res = await call(system, prompt);
    usage.push({
      provider: spec.provider,
      model: spec.model,
      purpose: attempt === 0 ? purpose : `${purpose}_retry`,
      inputTokens: res.inputTokens + (res.cacheReadTokens ?? 0) + (res.cacheWriteTokens ?? 0),
      outputTokens: res.outputTokens,
      estCostUsd: estimateCost(spec, res.inputTokens, res.outputTokens, res.cacheReadTokens, res.cacheWriteTokens),
    });
    const parsed = parseExtraction(res.text);
    if (parsed.ok) return { items: parsed.value.items };
    error = parsed.error;
    prompt = `${user}\n\nYour previous reply was rejected: ${error}\nReturn only the JSON object in the required shape.`;
  }
  return { items: null, error };
}

/**
 * First pass on the cheap model. Escalate to the stronger model when the cheap one
 * returns something malformed twice, or is unsure about any item.
 */
export async function extract(
  input: ExtractInput,
  system: string,
  models: Models,
  llm: { firstPass: LlmFn; escalation: LlmFn; bulk?: LlmFn },
): Promise<ExtractOutcome> {
  const usage: UsageRecord[] = [];
  const user = buildUserPrompt(input);
  let first: { items: ExtractedItem[] | null; error?: string };
  try {
    // Mass mail goes to the cheaper model when one is configured.
    const cheap = input.bulk && llm.bulk && models.bulk;
    first = cheap ? await runModel(llm.bulk!, models.bulk!, 'extract_bulk', system, user, usage) : await runModel(llm.firstPass, models.first_pass, 'extract', system, user, usage);
  } catch (e) {
    first = { items: null, error: (e as Error).message };
  }

  const unsure = first.items?.some((i) => i.confidence < models.escalate_below_confidence) ?? false;
  if (first.items && !unsure) return { items: first.items, usage, escalated: false, failed: false };

  let second: { items: ExtractedItem[] | null; error?: string };
  try {
    second = await runModel(llm.escalation, models.escalation, 'extract_escalated', system, user, usage);
  } catch (e) {
    second = { items: null, error: (e as Error).message };
  }
  if (second.items) return { items: second.items, usage, escalated: true, failed: false };
  if (first.items) return { items: first.items, usage, escalated: true, failed: false }; // keep the unsure answer; it goes to review
  return { items: [], usage, escalated: true, failed: true, error: second.error ?? first.error };
}
