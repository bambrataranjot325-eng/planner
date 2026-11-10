import type { ModelSpec } from '../config.js';
import type { LlmCall } from '../types.js';

export type LlmFn = (system: string, user: string) => Promise<LlmCall>;

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return await res.json();
      const text = (await res.text()).slice(0, 300);
      lastErr = new Error(`LLM HTTP ${res.status}: ${text}`);
      if (res.status !== 429 && res.status < 500) break; // not worth retrying
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error('LLM request failed');
}

export function makeLlm(spec: ModelSpec, keys: { groq?: string; anthropic?: string }): LlmFn {
  if (spec.provider === 'groq') {
    return async (system, user) => {
      if (!keys.groq) throw new Error('GROQ_API_KEY is not set');
      const data = await postJson(
        'https://api.groq.com/openai/v1/chat/completions',
        { authorization: `Bearer ${keys.groq}` },
        {
          model: spec.model,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
      );
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    };
  }
  return async (system, user) => {
    if (!keys.anthropic) throw new Error('ANTHROPIC_API_KEY is not set');
    const data = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': keys.anthropic, 'anthropic-version': '2023-06-01' },
      // The instructions are identical for every email, so they are cached and re-read at a tenth of the price.
      { model: spec.model, max_tokens: 4096, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: user }] },
    );
    const text = (data.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    return {
      text,
      inputTokens: data.usage?.input_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  };
}

/** Cached instructions are billed at 0.1x the input price when read and 1.25x when first stored. */
export function estimateCost(spec: ModelSpec, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): number {
  const input = inputTokens + cacheReadTokens * 0.1 + cacheWriteTokens * 1.25;
  return (input * spec.usd_per_mtok_in + outputTokens * spec.usd_per_mtok_out) / 1_000_000;
}
