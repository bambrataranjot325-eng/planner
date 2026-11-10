import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { demoItems } from './demo';
import type { AuditEntry, Item, ItemDraft, SourceInfo } from './types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const wantsDemo = new URLSearchParams(location.search).has('demo');

/** No keys configured (or ?demo): run on sample data so the app can be looked at without an account. */
export const isDemo = wantsDemo || !url || !key || url.includes('YOUR-PROJECT');
export const supabase: SupabaseClient | null = isDemo ? null : createClient(url!, key!);

export interface DataSource {
  list(): Promise<Item[]>;
  create(draft: ItemDraft): Promise<Item>;
  update(id: string, patch: Partial<Item>): Promise<Item>;
  history(id: string): Promise<AuditEntry[]>;
  sources(id: string): Promise<SourceInfo[]>;
  subscribe(onChange: () => void): () => void;
}

function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

class SupabaseSource implements DataSource {
  constructor(private sb: SupabaseClient, private userId: string) {}

  async list() {
    return must(await this.sb.from('items').select('*').is('deleted_at', null).order('created_at').limit(3000)) as Item[];
  }
  async create(draft: ItemDraft) {
    const row = { ...draft, user_id: this.userId, origin: 'manual', review_state: 'accepted', status: 'open' };
    return must(await this.sb.from('items').insert(row).select('*').single()) as Item;
  }
  async update(id: string, patch: Partial<Item>) {
    return must(await this.sb.from('items').update(patch).eq('id', id).select('*').single()) as Item;
  }
  async history(id: string) {
    return must(await this.sb.from('audit_log').select('id, action, actor, changes, at').eq('row_id', id).order('at', { ascending: false }).limit(40)) as AuditEntry[];
  }
  async sources(id: string) {
    const rows = must(
      await this.sb.from('item_sources').select('source_type, link, source_messages(subject, sender, received_at)').eq('item_id', id).order('created_at'),
    ) as any[];
    return rows.map((r) => {
      const m = Array.isArray(r.source_messages) ? r.source_messages[0] : r.source_messages;
      return { source_type: r.source_type, link: r.link, subject: m?.subject ?? null, sender: m?.sender ?? null, received_at: m?.received_at ?? null };
    });
  }
  subscribe(onChange: () => void) {
    const ch = this.sb.channel('items-live').on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, onChange).subscribe();
    return () => void this.sb.removeChannel(ch);
  }
  /** Tell the server which timezone this device is in, so "by Friday" and the morning summary use it. */
  async reportTimezone() {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await this.sb.from('user_settings').upsert({ user_id: this.userId, timezone, timezone_reported_at: new Date().toISOString() });
  }
}

class DemoSource implements DataSource {
  private items = demoItems();
  async list() { return this.items.filter((i) => !i.deleted_at); }
  async create(draft: ItemDraft) {
    const t = new Date().toISOString();
    const item = { ...this.items[0]!, ...draft, id: `demo-new-${Date.now()}`, origin: 'manual', status: 'open', review_state: 'accepted', overridden_fields: [], ai_values: {}, confidence: null, description: null, timezone: null, priority_reason: null, created_at: t, updated_at: t } as Item;
    this.items.push(item);
    return item;
  }
  async update(id: string, patch: Partial<Item>) {
    const i = this.items.findIndex((x) => x.id === id);
    this.items[i] = { ...this.items[i]!, ...patch, updated_at: new Date().toISOString() };
    return this.items[i]!;
  }
  async history(id: string): Promise<AuditEntry[]> {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.origin === 'manual') return [];
    const out: AuditEntry[] = [{ id: 1, action: 'insert', actor: 'worker', changes: {}, at: it.created_at }];
    if (it.title === 'Essay 2 draft') {
      const d = (n: number) => new Date(Date.parse(it.due_at!) - n * 86_400_000).toISOString();
      out.unshift({ id: 2, action: 'update', actor: 'worker', changes: { due_at: { old: d(3), new: it.due_at } }, at: it.updated_at });
      out.unshift({ id: 3, action: 'update', actor: 'user', changes: { title: { old: 'Submit Essay 2 draft on Brightspace', new: it.title } }, at: it.updated_at });
    }
    return out;
  }
  async sources(id: string): Promise<SourceInfo[]> {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.origin !== 'email') return [];
    return [{ source_type: 'email', link: null, subject: it.title.replace(/^(Attend|Submit|Pay|Reply to) /, 'Re: '), sender: 'Sample sender', received_at: it.created_at }];
  }
  subscribe() { return () => {}; }
}

export function makeSource(userId: string | null): DataSource & { reportTimezone?: () => Promise<void> } {
  return supabase && userId ? new SupabaseSource(supabase, userId) : new DemoSource();
}

const CACHE = 'planner.items.v1';
/** Last known items, so the calendar paints at once and still shows something with no connection. */
export const readCache = (): Item[] => {
  try { return JSON.parse(localStorage.getItem(CACHE) ?? '[]') as Item[]; } catch { return []; }
};
export const writeCache = (items: Item[]) => {
  try { localStorage.setItem(CACHE, JSON.stringify(items)); } catch { /* storage full or blocked: the cache is optional */ }
};
export const clearCache = () => { try { localStorage.removeItem(CACHE); } catch { /* ignore */ } };
