export type Mode = 'preview' | 'dry-run' | 'live';

export interface ParsedMessage {
  id: string;
  threadId: string;
  labels: string[];
  headers: Record<string, string>; // lower-cased header names
  from: string;
  subject: string;
  receivedAt: Date;
  bodyText: string;
}

export interface SenderRule {
  pattern: string;
  action: 'block' | 'allow';
}

export interface FilterResult {
  decision: 'pass' | 'skip';
  reason: string;
}

export interface ExistingItem {
  id: string;
  title: string;
  kind: 'event' | 'task';
  when: string | null; // local wall-clock, for the prompt
}

export interface LlmCall {
  text: string;
  /** Billed at the cached rate (the fixed instructions, re-read from cache). */
  cacheReadTokens?: number;
  /** Billed at the cache-write rate (the first time the instructions are stored). */
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageRecord {
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}
