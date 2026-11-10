import { HistoryExpiredError, type GmailApi } from './client.js';

export interface SyncState {
  cursor: { historyId?: string };
  backfillDone: boolean;
}

export interface SyncPlan {
  ids: string[]; // oldest first
  nextCursor: { historyId: string };
  kind: 'backfill' | 'delta' | 'recovery';
}

/**
 * Decide which messages to look at this run, without ever re-reading the whole mailbox.
 * - First run: the last `backfillDays` days of the inbox.
 * - After that: only what Gmail's history says was added since the saved cursor.
 * - If the cursor is too old for Gmail to replay: the last 7 days (already-seen ids are skipped later).
 * The new cursor is read BEFORE listing, so mail arriving mid-run is picked up next time, not lost.
 */
export async function planSync(api: GmailApi, state: SyncState, backfillDays: number, max = 2000): Promise<SyncPlan> {
  const profile = await api.getProfile();
  if (!state.backfillDone || !state.cursor.historyId) {
    const ids = await api.listMessageIds(`in:inbox newer_than:${backfillDays}d`, max);
    return { ids: ids.reverse(), nextCursor: { historyId: profile.historyId }, kind: 'backfill' };
  }
  try {
    const delta = await api.listAddedSince(state.cursor.historyId);
    return { ids: delta.ids, nextCursor: { historyId: delta.historyId ?? profile.historyId }, kind: 'delta' };
  } catch (e) {
    if (!(e instanceof HistoryExpiredError)) throw e;
    const ids = await api.listMessageIds('in:inbox newer_than:7d', max);
    return { ids: ids.reverse(), nextCursor: { historyId: profile.historyId }, kind: 'recovery' };
  }
}
