import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { demoItems } from './demo';
import type { ChatMessage, NewRow, ProposalState } from './assistant';
import { DEFAULT_PROFILE, type PlannedSession, type Profile } from './planner';
import type { AuditEntry, Item, ItemDraft, Project, ProjectPlan, SourceInfo } from './types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const wantsDemo = new URLSearchParams(location.search).has('demo');

/** No keys configured (or ?demo): run on sample data so the app can be looked at without an account. */
export const isDemo = wantsDemo || !url || !key || url.includes('YOUR-PROJECT');
/** Where this project's Edge Functions live (used to build the widget's address). */
export const functionsUrl = isDemo ? 'https://YOUR-PROJECT.supabase.co/functions/v1' : `${url!.replace(/\/$/, '')}/functions/v1`;
export const supabase: SupabaseClient | null = isDemo ? null : createClient(url!, key!);

export interface DataSource {
  list(): Promise<Item[]>;
  create(draft: ItemDraft): Promise<Item>;
  update(id: string, patch: Partial<Item>): Promise<Item>;
  history(id: string): Promise<AuditEntry[]>;
  sources(id: string): Promise<SourceInfo[]>;
  subscribe(onChange: () => void): () => void;
  profile(): Promise<Profile>;
  saveProfile(p: Profile): Promise<void>;
  projects(): Promise<{ projects: Project[]; plans: ProjectPlan[] }>;
  createProject(d: ProjectDraft): Promise<Project>;
  updateProject(id: string, patch: Partial<Project>): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  /** Retire the old plan, trash its unfinished sessions and add the new ones, all at once. */
  applyPlan(projectId: string, plan: PlanMeta, sessions: PlannedSession[]): Promise<void>;
  /** Ask the AI to break the project into milestones with hours. Throws if it is unavailable. */
  estimate(input: EstimateInput): Promise<{ milestones: { title: string; hours: number }[]; rationale: string }>;
  settings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings> & { push_test_at?: string }): Promise<void>;
  /** Register or forget this device for push notifications. */
  pushSubscribe(sub: PushSub): Promise<void>;
  pushUnsubscribe(endpoint: string): Promise<void>;
  /** The saved assistant conversation, oldest first. */
  chat(): Promise<ChatMessage[]>;
  /** Send a message (and files) to the assistant. Returns its reply; nothing on the calendar changes. */
  chatSend(text: string, attachments: Attachment[]): Promise<ChatMessage>;
  chatSetState(id: string, state: ProposalState): Promise<void>;
  chatClear(): Promise<void>;
  /** Add the rows from one accepted proposal, tagged so they can be undone together. */
  addItems(rows: NewRow[], batchId: string): Promise<void>;
  undoBatch(batchId: string): Promise<void>;
}

/** `item_ids` are calendar items attached to the project; the AI reads them, and the emails they came from, as context. */
export interface EstimateInput { name: string; description: string; course: string | null; deadline: string | null; item_ids: string[]; background?: string | null }

export type ProjectDraft = Pick<Project, 'name' | 'description' | 'course' | 'deadline' | 'granularity' | 'background'>;
export interface AppSettings { remind_minutes: number; daily_summary_time: string | null; push_public_key: string | null; widget_token: string | null }
export interface PushSub { endpoint: string; p256dh: string; auth: string; device: string }
export interface Attachment { name: string; media_type: string; data: string } // data is base64
export interface PlanMeta {
  deadline: string; total_minutes: number; buffer_pct: number; granularity: 'daily' | 'weekly'; made_by: 'ai' | 'manual';
  milestones: { title: string; minutes: number; due?: string }[]; explanation: string[];
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
  async profile() {
    const row = must(await this.sb.from('personal_profile').select('*').eq('user_id', this.userId).maybeSingle()) as Partial<Profile> | null;
    return { ...DEFAULT_PROFILE, ...(row ?? {}), max_hours_per_day: Number(row?.max_hours_per_day ?? DEFAULT_PROFILE.max_hours_per_day) } as Profile;
  }
  async saveProfile(p: Profile) {
    const { working_hours, blocks, max_hours_per_day, session_minutes, buffer_pct, energy, goals, notes } = p;
    const stamp = { source: 'manual', confirmed_at: new Date().toISOString() };
    must(await this.sb.from('personal_profile').upsert({ user_id: this.userId, working_hours, blocks, max_hours_per_day, session_minutes, buffer_pct, energy, goals: goals ?? null, notes: notes ?? null, field_meta: { working_hours: stamp, blocks: stamp, limits: stamp } }).select('user_id'));
  }
  async projects() {
    const projects = must(await this.sb.from('projects').select('*').neq('status', 'archived').order('created_at')) as Project[];
    const plans = must(await this.sb.from('project_plans').select('*').order('version')) as ProjectPlan[];
    return { projects, plans };
  }
  async createProject(d: ProjectDraft) {
    return must(await this.sb.from('projects').insert({ ...d, user_id: this.userId }).select('*').single()) as Project;
  }
  async updateProject(id: string, patch: Partial<Project>) {
    return must(await this.sb.from('projects').update(patch).eq('id', id).select('*').single()) as Project;
  }
  async deleteProject(id: string) {
    must(await this.sb.rpc('delete_project', { p_project: id })); // removes its sessions, keeps attached items
  }
  async applyPlan(projectId: string, plan: PlanMeta, sessions: PlannedSession[]) {
    must(await this.sb.rpc('apply_plan', { p_project: projectId, p_plan: plan, p_sessions: sessions }));
  }
  async estimate(input: EstimateInput) {
    const { data, error } = await this.sb.functions.invoke('plan-project', { body: input });
    if (error) {
      let detail = error.message;
      try { detail = (await (error as { context?: Response }).context?.json())?.error ?? detail; } catch { /* keep the generic message */ }
      throw new Error(detail);
    }
    if (!data?.milestones?.length) throw new Error('The AI returned no plan');
    return data as { milestones: { title: string; hours: number }[]; rationale: string };
  }
  async settings() {
    const row = must(await this.sb.from('user_settings').select('remind_minutes, daily_summary_time, push_public_key, widget_token').eq('user_id', this.userId).maybeSingle()) as AppSettings | null;
    return row ?? { remind_minutes: 30, daily_summary_time: '08:00', push_public_key: null, widget_token: null };
  }
  async saveSettings(patch: Partial<AppSettings> & { push_test_at?: string }) {
    must(await this.sb.from('user_settings').update(patch).eq('user_id', this.userId).select('user_id'));
  }
  async pushSubscribe(sub: PushSub) {
    must(await this.sb.from('push_subscriptions').upsert({ ...sub, user_id: this.userId }, { onConflict: 'endpoint' }).select('id'));
  }
  async pushUnsubscribe(endpoint: string) {
    must(await this.sb.from('push_subscriptions').delete().eq('endpoint', endpoint).select('id'));
  }
  async chat() {
    const rows = must(await this.sb.from('chat_messages').select('*').order('created_at', { ascending: false }).limit(80)) as ChatMessage[];
    return rows.reverse();
  }
  async chatSend(text: string, attachments: Attachment[]) {
    const { data, error } = await this.sb.functions.invoke('assistant', { body: { text, attachments, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    if (error) {
      let detail = error.message;
      try { detail = (await (error as { context?: Response }).context?.json())?.error ?? detail; } catch { /* keep the generic message */ }
      throw new Error(detail);
    }
    if (!data?.message) throw new Error('The assistant sent nothing back');
    return data.message as ChatMessage;
  }
  async chatSetState(id: string, state: ProposalState) {
    must(await this.sb.from('chat_messages').update({ proposal_state: state }).eq('id', id).select('id'));
  }
  async chatClear() {
    must(await this.sb.from('chat_messages').delete().eq('user_id', this.userId).select('id'));
  }
  async addItems(rows: NewRow[], batchId: string) {
    if (!rows.length) return;
    must(await this.sb.from('items').insert(rows.map((r) => ({ ...r, user_id: this.userId, origin: 'manual', review_state: 'accepted', status: 'open', import_batch: batchId }))).select('id'));
  }
  async undoBatch(batchId: string) {
    must(await this.sb.from('items').update({ deleted_at: new Date().toISOString() }).eq('import_batch', batchId).is('deleted_at', null).select('id'));
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

  private st: AppSettings = { remind_minutes: 30, daily_summary_time: '08:00', push_public_key: null, widget_token: null };
  async settings() { return this.st; }
  async saveSettings(patch: Partial<AppSettings>) { this.st = { ...this.st, ...patch }; }
  async pushSubscribe() {}
  async pushUnsubscribe() {}
  private msgs: ChatMessage[] = [];
  async chat() { return this.msgs; }
  async chatSend(text: string, attachments: Attachment[]) {
    await new Promise((r) => setTimeout(r, 900));
    const t = new Date();
    const day = (n: number) => new Date(t.getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const mon = (() => { const d = new Date(t); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d.toISOString().slice(0, 10); })();
    this.msgs.push({ id: `demo-u-${t.getTime()}`, role: 'user', content: text, attachments: attachments.map((a) => a.name), proposal: null, proposal_state: null, created_at: t.toISOString() });
    const reply: ChatMessage = attachments.length
      ? { id: `demo-a-${t.getTime()}`, role: 'assistant', attachments: [], proposal_state: null, created_at: t.toISOString(), content: 'This is sample data, so I did not really read the file. With your own account I would read it; here is the kind of proposal a timetable produces.',
          proposal: { update: [], remove: [], add: [
            { title: 'Operating Systems lecture', kind: 'event', start_local: `${mon}T09:30`, end_local: `${mon}T10:50`, course: 'CS-UY 3224', category: 'study', location: 'JAB 475', repeat: { weekdays: [1, 3], until: day(40) } },
            { title: 'Operating Systems lab', kind: 'event', start_local: `${day(((12 - t.getDay()) % 7) || 7)}T14:00`, end_local: `${day(((12 - t.getDay()) % 7) || 7)}T16:00`, course: 'CS-UY 3224', category: 'study', repeat: { weekdays: [5], until: day(40) } },
            { title: 'Operating Systems final exam', kind: 'event', start_local: `${day(44)}T13:00`, end_local: `${day(44)}T15:00`, course: 'CS-UY 3224', category: 'study', priority: 'high' },
          ], class_blocks: [{ label: 'Operating Systems lecture', days: [1, 3], start: '09:30', end: '10:50' }, { label: 'Operating Systems lab', days: [5], start: '14:00', end: '16:00' }] } }
      : { id: `demo-a-${t.getTime()}`, role: 'assistant', attachments: [], proposal_state: null, created_at: t.toISOString(), content: 'This is sample data, so I am not really reading your message. With your own account I would work out the date and details; here is a sample proposal.',
          proposal: { update: [], remove: [], class_blocks: [], add: [{ title: text.replace(/^add\s+/i, '').slice(0, 60) || 'New event', kind: 'event', start_local: `${day(2)}T15:00`, end_local: `${day(2)}T16:00`, category: 'personal' }] } };
    this.msgs.push(reply);
    return reply;
  }
  async chatSetState(id: string, state: ProposalState) { const m = this.msgs.find((x) => x.id === id); if (m) m.proposal_state = state; }
  async chatClear() { this.msgs = []; }
  async addItems(rows: NewRow[], batchId: string) {
    const t = new Date().toISOString();
    rows.forEach((r, k) => this.items.push({ ...this.items[0]!, ...r, id: `${batchId}-${k}`, origin: 'manual', status: 'open', review_state: 'accepted', optional: false, description: null, priority_reason: null, link: null, confidence: null, overridden_fields: [], ai_values: {}, deleted_at: null, project_id: null, plan_id: null, import_batch: batchId, created_at: t, updated_at: t } as Item));
  }
  async undoBatch(batchId: string) { const t = new Date().toISOString(); for (const i of this.items) if (i.import_batch === batchId) i.deleted_at = t; }

  private prof: Profile = DEFAULT_PROFILE;
  private projs: Project[] = [];
  private plans: ProjectPlan[] = [];
  async profile() { return this.prof; }
  async saveProfile(p: Profile) { this.prof = p; }
  async projects() { return { projects: this.projs.filter((p) => p.status !== 'archived'), plans: this.plans }; }
  async createProject(d: ProjectDraft) {
    const p: Project = { ...d, id: `demo-proj-${Date.now()}`, status: 'open', current_plan_id: null, created_at: new Date().toISOString() };
    this.projs.push(p);
    return p;
  }
  async updateProject(id: string, patch: Partial<Project>) {
    const i = this.projs.findIndex((p) => p.id === id);
    this.projs[i] = { ...this.projs[i]!, ...patch };
    return this.projs[i]!;
  }
  async deleteProject(id: string) {
    this.projs = this.projs.filter((p) => p.id !== id);
    this.items = this.items.filter((i) => !(i.project_id === id && i.origin === 'plan'));
    for (const i of this.items) if (i.project_id === id) i.project_id = null;
  }
  async applyPlan(projectId: string, plan: PlanMeta, sessions: PlannedSession[]) {
    const now = Date.now(), t = new Date().toISOString();
    const id = `demo-plan-${now}`;
    const proj = this.projs.find((p) => p.id === projectId)!;
    for (const pl of this.plans) if (pl.project_id === projectId && !pl.superseded_at) pl.superseded_at = t;
    this.plans.push({ ...plan, id, project_id: projectId, version: this.plans.filter((p) => p.project_id === projectId).length + 1, sessions, created_at: t, superseded_at: null });
    for (const it of this.items) if (it.project_id === projectId && it.origin === 'plan' && it.status === 'open' && Date.parse((it.start_at ?? it.due_at)!) > now) it.deleted_at = t;
    sessions.forEach((s, k) => this.items.push({ ...this.items[0]!, ...s, id: `${id}-${k}`, origin: 'plan', project_id: projectId, plan_id: id, status: 'open', review_state: 'accepted', optional: false, all_day: false, due_precision: s.kind === 'task' ? 'date_only' : null, category: proj.course ? 'study' : 'work', course: proj.course, priority: 'medium', priority_reason: null, location: null, link: null, timezone: null, confidence: null, overridden_fields: [], ai_values: {}, actual_minutes: null, deleted_at: null, description: null, action_required: false, created_at: t, updated_at: t } as Item));
    Object.assign(proj, { current_plan_id: id, deadline: plan.deadline, granularity: plan.granularity });
  }
  async estimate(input: EstimateInput) {
    await new Promise((r) => setTimeout(r, 900));
    const ctx = input.item_ids.length ? ` It took ${input.item_ids.length} attached item${input.item_ids.length === 1 ? '' : 's'} into account.` : '';
    return { milestones: [{ title: 'Research and outline', hours: 2 }, { title: 'First draft', hours: 4 }, { title: 'Revise', hours: 2.5 }, { title: 'Proofread and submit', hours: 1 }], rationale: `A sample estimate for "${input.name}". With your own account, Claude sizes this from the description.${ctx}` };
  }
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
