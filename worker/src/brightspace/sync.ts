import { createHash } from 'node:crypto';
import { log } from '../config.js';
import type { Db, SourceRow } from '../db.js';
import { findDuplicate, type ItemStore } from '../pipeline/store.js';
import { parseIcs } from './ics.js';
import { mapFeed } from './map.js';

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Poll the Brightspace calendar feed and bring the calendar in line with it.
 * - An event already linked to an item updates that item (fields I edited by hand are kept by the database).
 * - A new event that matches an existing item, such as a deadline an email already produced, is linked to
 *   it instead of duplicated; from then on the feed keeps its date current.
 * - Anything else becomes a new item. Nothing is ever deleted or marked done from here.
 */
export async function syncBrightspace(db: Db, store: ItemStore, source: SourceRow, zone: string, fetchFn: Fetch = (u) => fetch(u, { signal: AbortSignal.timeout(30_000) })): Promise<Record<string, unknown>> {
  const stats: Record<string, unknown> = { events: 0, created: 0, linked_to_existing: 0, checked: 0, unchanged: false };
  const runId = await db.startRun(source.id, 'live');
  let error: string | null = null;
  try {
    const url = await db.getSecret(source.id);
    if (!url) throw new FeedGone('no feed address saved');
    const res = await fetchFn(url); // the address is a secret: never logged, never put in an error
    if ([401, 403, 404, 410].includes(res.status)) throw new FeedGone(`the feed answered ${res.status}`);
    if (!res.ok) throw new Error(`Brightspace feed answered ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Brightspace did not return a calendar');

    const hash = createHash('sha256').update(text).digest('hex');
    if (hash === source.cursor.hash) {
      stats.unchanged = true; // nothing new since last time; skip the database work
    } else {
      const events = parseIcs(text);
      const { items, skipped } = mapFeed(events, zone, new Date());
      stats.events = events.length;
      stats.skipped = skipped;
      for (const it of items) {
        const src = { type: 'brightspace' as const, ref: it.uid, link: it.link ?? '', sourceId: source.id, messageRowId: null };
        const { review_state, ...ai } = it.row;
        const existing = await db.itemIdBySourceRef('brightspace', it.uid);
        if (existing) {
          await store.update(existing, { ...ai, ai_values: ai, ...(it.link ? { link: it.link } : {}) });
          stats.checked = (stats.checked as number) + 1;
          continue;
        }
        const dup = findDuplicate(it.row, await store.nearby(it.row));
        if (dup) {
          await store.link(dup.id, src);
          stats.linked_to_existing = (stats.linked_to_existing as number) + 1;
          continue;
        }
        const id = await store.insert(it.row, `bs:${it.uid}`, it.link, 'brightspace');
        await store.link(id, src);
        stats.created = (stats.created as number) + 1;
      }
    }
    await db.updateSource(source.id, { cursor: { hash }, backfill_done: true, last_success_at: new Date().toISOString(), last_error: null, status: 'active' });
  } catch (e) {
    error = (e as Error).message;
    if (e instanceof FeedGone) {
      await db.updateSource(source.id, { status: 'needs_reauth', last_error: 'The Brightspace feed address stopped working', last_error_at: new Date().toISOString() });
      await db.alert('needs_reauth', 'Your Brightspace calendar feed stopped working. Copy a fresh address from Brightspace and run "make connect-brightspace" on the server.', source.id);
    } else {
      await db.updateSource(source.id, { last_error: error.slice(0, 300), last_error_at: new Date().toISOString() });
    }
  } finally {
    await db.finishRun(runId, stats, error);
    log('brightspace_finished', { ...stats, ...(error ? { error: error.slice(0, 200) } : {}) });
  }
  return stats;
}

export class FeedGone extends Error {}
