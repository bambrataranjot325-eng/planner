import { randomUUID } from 'node:crypto';
import type { ExistingItem } from '../types.js';
import { utcToLocal } from './dates.js';
import type { ExtractedItem } from './schema.js';
import type { ItemRow } from './write.js';

export interface Candidate {
  id: string;
  title: string;
  kind: 'event' | 'task';
  start_at: string | null;
  due_at: string | null;
}
export interface SourceRef {
  type: 'email' | 'brightspace';
  ref: string; // provider message id, or the feed event's UID
  link: string;
  sourceId: string | null;
  messageRowId: string | null;
}

/** Where items live. The database in live mode; memory in a dry-run, so the report shows what live would do. */
export interface ItemStore {
  /** Items the model should know about: this thread's, plus other open items around this date. */
  context(threadKey: string, zone: string, since: Date): Promise<ExistingItem[]>;
  /** Items that could be the same real-world thing as `row`. */
  nearby(row: ItemRow): Promise<Candidate[]>;
  insert(row: ItemRow, threadKey: string, link: string | null, origin: 'email' | 'brightspace'): Promise<string>;
  update(id: string, patch: Record<string, unknown>): Promise<void>;
  link(itemId: string, src: SourceRef): Promise<void>;
}

const STOP = new Set(['a', 'an', 'the', 'at', 'in', 'on', 'for', 'to', 'of', 'and', 'or', 'by', 'before', 'with', 'your', 'my', 'it', 'is']);

function tokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((t) => t && !STOP.has(t)),
  );
}

/**
 * Share of words two titles have in common (0 to 1). When every word of the shorter title appears in
 * the longer one ("Homework 8" inside "Submit Homework 8 on Brightspace") they count as the same.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  if (both === Math.min(ta.size, tb.size) && both >= 2) return 1;
  return both / (ta.size + tb.size - both);
}

function numbers(title: string): string {
  return [...tokens(title)].filter((t) => /^\d+$/.test(t)).sort().join(',');
}

/**
 * Is `row` the same real-world thing as an item we already have? Same kind, within a day of each other,
 * and mostly the same words. Different numbers ("Homework 8" vs "Homework 9") are never the same thing.
 */
export function findDuplicate(row: Pick<ItemRow, 'title' | 'kind' | 'start_at' | 'due_at'>, candidates: Candidate[]): Candidate | null {
  const date = row.start_at ?? row.due_at;
  let best: Candidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.kind !== row.kind) continue;
    if (numbers(c.title) !== numbers(row.title)) continue;
    const other = c.start_at ?? c.due_at;
    const score = titleSimilarity(row.title, c.title);
    let needed: number;
    if (date && other) {
      if (Math.abs(Date.parse(date) - Date.parse(other)) > 24 * 3_600_000) continue;
      needed = 0.6;
    } else if (!date && !other) {
      needed = 0.8;
    } else continue;
    if (score >= needed && score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export type Action = 'created' | 'updated' | 'merged' | 'completed' | 'cancelled' | 'ignored' | 'skipped_past';

export interface ApplyContext {
  knownIds: Set<string>; // ids the model was shown; it may only update these
  threadKey: string;
  src: SourceRef;
  skipPast: boolean; // true while backfilling old mail
  now: Date;
}

/** Decide what one extracted item does to the calendar, and do it. */
export async function applyItem(store: ItemStore, item: ExtractedItem, row: ItemRow, ctx: ApplyContext): Promise<{ action: Action; itemId: string | null }> {
  const target = item.updates_item_id && ctx.knownIds.has(item.updates_item_id) ? item.updates_item_id : null;
  const { review_state, ...ai } = row;

  if (target) {
    if (item.resolved) {
      await store.update(target, { status: 'done' });
      await store.link(target, ctx.src);
      return { action: 'completed', itemId: target };
    }
    if (item.cancelled) {
      // Marked cancelled but kept visible in Needs review until I confirm.
      await store.update(target, { status: 'cancelled', review_state: 'needs_review' });
      await store.link(target, ctx.src);
      return { action: 'cancelled', itemId: target };
    }
    // The database keeps any field I edited by hand; see items_protect_overrides.
    await store.update(target, { ...ai, ai_values: ai });
    await store.link(target, ctx.src);
    return { action: 'updated', itemId: target };
  }
  if (item.resolved || item.cancelled) return { action: 'ignored', itemId: null }; // nothing on the calendar to close

  const when = row.end_at ?? row.start_at ?? row.due_at;
  if (ctx.skipPast && when && Date.parse(when) < ctx.now.getTime()) return { action: 'skipped_past', itemId: null };

  const dup = findDuplicate(row, await store.nearby(row));
  if (dup) {
    await store.link(dup.id, ctx.src); // keep every source reference on the one item
    return { action: 'merged', itemId: dup.id };
  }
  const id = await store.insert(row, ctx.threadKey, ctx.src.link, 'email');
  await store.link(id, ctx.src);
  return { action: 'created', itemId: id };
}

/** In-memory store for dry-runs and tests. */
export class MemoryStore implements ItemStore {
  items: { id: string; row: ItemRow; status: string; threadKey: string; sources: string[] }[] = [];

  async context(threadKey: string, zone: string, since: Date): Promise<ExistingItem[]> {
    return this.items
      .filter((i) => {
        if (i.threadKey === threadKey) return true;
        if (i.status !== 'open') return false;
        const when = i.row.start_at ?? i.row.due_at;
        return !when || Date.parse(when) >= since.getTime();
      })
      .slice(-40)
      .map((i) => ({ id: i.id, title: i.row.title, kind: i.row.kind, when: utcToLocal(i.row.start_at ?? i.row.due_at, i.row.timezone ?? zone) }));
  }
  async nearby(): Promise<Candidate[]> {
    return this.items.map((i) => ({ id: i.id, title: i.row.title, kind: i.row.kind, start_at: i.row.start_at, due_at: i.row.due_at }));
  }
  async insert(row: ItemRow, threadKey: string): Promise<string> {
    const id = randomUUID();
    this.items.push({ id, row, status: 'open', threadKey, sources: [] });
    return id;
  }
  async update(id: string, patch: Record<string, unknown>): Promise<void> {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    const { status, ai_values: _ai, ...fields } = patch as { status?: string; ai_values?: unknown } & Partial<ItemRow>;
    if (status) it.status = status;
    it.row = { ...it.row, ...fields };
  }
  async link(itemId: string, src: SourceRef): Promise<void> {
    const it = this.items.find((i) => i.id === itemId);
    if (it && !it.sources.includes(src.ref)) it.sources.push(src.ref);
  }
}
