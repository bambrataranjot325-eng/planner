import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ExistingItem, Mode, SenderRule, UsageRecord } from './types.js';
import { utcToLocal } from './pipeline/dates.js';
import type { Candidate, ItemStore, SourceRef } from './pipeline/store.js';
import type { ItemRow } from './pipeline/write.js';

export interface SourceRow {
  id: string;
  label: string;
  account: string;
  status: string;
  cursor: { historyId?: string };
  backfill_done: boolean;
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`Supabase ${what}: ${res.error.message}`);
  return res.data;
}

export class Db {
  readonly sb: SupabaseClient;
  constructor(url: string, serviceKey: string, readonly userId: string) {
    this.sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async settings(defaultZone: string): Promise<{ timezone: string; capUsd: number }> {
    const rows = check(await this.sb.from('user_settings').select('timezone, llm_monthly_cap_usd').eq('user_id', this.userId), 'read settings');
    if (rows && rows.length) return { timezone: rows[0]!.timezone, capUsd: Number(rows[0]!.llm_monthly_cap_usd) };
    check(await this.sb.from('user_settings').insert({ user_id: this.userId, timezone: defaultZone }), 'create settings');
    return { timezone: defaultZone, capUsd: 5 };
  }

  async gmailSources(): Promise<SourceRow[]> {
    return check(
      await this.sb.from('sources').select('id, label, account, status, cursor, backfill_done').eq('user_id', this.userId).eq('kind', 'gmail'),
      'read sources',
    ) as SourceRow[];
  }

  async upsertGmailSource(account: string, label: string): Promise<string> {
    const rows = check(
      await this.sb
        .from('sources')
        .upsert({ user_id: this.userId, kind: 'gmail', account, label, status: 'active', last_error: null }, { onConflict: 'user_id,kind,account' })
        .select('id'),
      'save source',
    );
    return rows![0]!.id as string;
  }

  async getSecret(sourceId: string): Promise<string | null> {
    return check(await this.sb.rpc('get_source_secret', { p_source_id: sourceId }), 'read secret') as string | null;
  }
  async setSecret(sourceId: string, secret: string): Promise<void> {
    check(await this.sb.rpc('set_source_secret', { p_source_id: sourceId, p_secret: secret }), 'store secret');
  }

  async updateSource(id: string, patch: Record<string, unknown>): Promise<void> {
    check(await this.sb.from('sources').update(patch).eq('id', id), 'update source');
  }

  async senderRules(): Promise<SenderRule[]> {
    return check(await this.sb.from('sender_rules').select('pattern, action').eq('user_id', this.userId), 'read sender rules') as SenderRule[];
  }

  /** Message ids that are fully handled. "pending" ones (a run died midway) are processed again. */
  async finishedMessageIds(sourceId: string, ids: string[]): Promise<Set<string>> {
    const done = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const rows = check(
        await this.sb
          .from('source_messages')
          .select('provider_message_id')
          .eq('source_id', sourceId)
          .neq('extraction_status', 'pending')
          .in('provider_message_id', ids.slice(i, i + 200)),
        'read processed messages',
      );
      for (const r of rows ?? []) done.add(r.provider_message_id as string);
    }
    return done;
  }

  async upsertMessage(row: Record<string, unknown>): Promise<string> {
    const rows = check(
      await this.sb.from('source_messages').upsert({ user_id: this.userId, ...row }, { onConflict: 'source_id,provider_message_id' }).select('id'),
      'save message',
    );
    return rows![0]!.id as string;
  }
  async updateMessage(id: string, patch: Record<string, unknown>): Promise<void> {
    check(await this.sb.from('source_messages').update(patch).eq('id', id), 'update message');
  }
  async messageAlreadyHasItems(messageRowId: string): Promise<boolean> {
    const rows = check(await this.sb.from('item_sources').select('id').eq('message_id', messageRowId).limit(1), 'read item sources');
    return !!rows && rows.length > 0;
  }

  async startRun(sourceId: string | null, mode: Mode): Promise<string> {
    const rows = check(await this.sb.from('worker_runs').insert({ user_id: this.userId, source_id: sourceId, mode }).select('id'), 'start run');
    return rows![0]!.id as string;
  }
  async finishRun(id: string, stats: Record<string, unknown>, error: string | null): Promise<void> {
    check(await this.sb.from('worker_runs').update({ finished_at: new Date().toISOString(), stats, error }).eq('id', id), 'finish run');
  }

  async recordUsage(runId: string, promptVersion: string, usage: UsageRecord[]): Promise<void> {
    if (!usage.length) return;
    check(
      await this.sb.from('llm_usage').insert(
        usage.map((u) => ({
          user_id: this.userId,
          run_id: runId,
          provider: u.provider,
          model: u.model,
          prompt_version: promptVersion,
          purpose: u.purpose,
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          est_cost_usd: u.estCostUsd,
        })),
      ),
      'record usage',
    );
  }

  async monthSpendUsd(): Promise<number> {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const rows = check(
      await this.sb.from('llm_usage').select('est_cost_usd').eq('user_id', this.userId).gte('created_at', start.toISOString()),
      'read spend',
    );
    return (rows ?? []).reduce((sum: number, r: any) => sum + Number(r.est_cost_usd), 0);
  }

  /** One open alert per kind and source, so a broken inbox doesn't raise a new alert every 15 minutes. */
  async alert(kind: string, message: string, sourceId: string | null = null): Promise<void> {
    let q = this.sb.from('alerts').select('id').eq('user_id', this.userId).eq('kind', kind).is('acknowledged_at', null).limit(1);
    q = sourceId ? q.eq('source_id', sourceId) : q.is('source_id', null);
    const open = check(await q, 'read alerts');
    if (open && open.length) return;
    check(await this.sb.from('alerts').insert({ user_id: this.userId, kind, message, source_id: sourceId }), 'create alert');
  }
}

/** Items in Supabase (live mode). */
export class DbItemStore implements ItemStore {
  constructor(private db: Db) {}

  async context(threadKey: string, zone: string, since: Date): Promise<ExistingItem[]> {
    const cols = 'id, title, kind, start_at, due_at, timezone';
    const base = () => this.db.sb.from('items').select(cols).eq('user_id', this.db.userId).is('deleted_at', null);
    const thread = check(await base().eq('thread_key', threadKey), 'read thread items') ?? [];
    const iso = since.toISOString();
    const open =
      check(
        await base().eq('status', 'open').or(`start_at.gte.${iso},due_at.gte.${iso}`).order('created_at', { ascending: false }).limit(40),
        'read open items',
      ) ?? [];
    const seen = new Set<string>();
    return [...thread, ...open]
      .filter((r: any) => !seen.has(r.id) && seen.add(r.id))
      .map((r: any) => ({ id: r.id, title: r.title, kind: r.kind, when: utcToLocal(r.start_at ?? r.due_at, r.timezone ?? zone) }));
  }

  async nearby(row: ItemRow): Promise<Candidate[]> {
    const cols = 'id, title, kind, start_at, due_at';
    const base = () => this.db.sb.from('items').select(cols).eq('user_id', this.db.userId).eq('kind', row.kind).is('deleted_at', null);
    const date = row.start_at ?? row.due_at;
    if (date) {
      const lo = new Date(Date.parse(date) - 24 * 3_600_000).toISOString();
      const hi = new Date(Date.parse(date) + 24 * 3_600_000).toISOString();
      return (check(await base().or(`and(start_at.gte.${lo},start_at.lte.${hi}),and(due_at.gte.${lo},due_at.lte.${hi})`).limit(100), 'read nearby items') ?? []) as Candidate[];
    }
    const month = new Date(Date.now() - 30 * 86_400_000).toISOString();
    return (check(await base().is('start_at', null).is('due_at', null).gte('created_at', month).limit(100), 'read undated items') ?? []) as Candidate[];
  }

  async insert(row: ItemRow, threadKey: string, link: string): Promise<string> {
    const { review_state, ...ai } = row;
    const rows = check(
      await this.db.sb.from('items').insert({ user_id: this.db.userId, ...ai, review_state, ai_values: ai, origin: 'email', thread_key: threadKey, link }).select('id'),
      'create item',
    );
    return rows![0]!.id as string;
  }

  async update(id: string, patch: Record<string, unknown>): Promise<void> {
    check(await this.db.sb.from('items').update(patch).eq('id', id).eq('user_id', this.db.userId), 'update item');
  }

  async link(itemId: string, src: SourceRef): Promise<void> {
    check(
      await this.db.sb
        .from('item_sources')
        .upsert(
          { user_id: this.db.userId, item_id: itemId, source_type: 'email', source_id: src.sourceId, message_id: src.messageRowId, ref: src.ref, link: src.link },
          { onConflict: 'item_id,source_type,ref', ignoreDuplicates: true },
        ),
      'link item source',
    );
  }
}
