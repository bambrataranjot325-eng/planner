import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { demoItems } from './demo';
import { DEFAULT_PROFILE, type PlannedSession, type Profile } from './planner';
import type { AuditEntry, Item, ItemDraft, Project, ProjectPlan, SourceInfo } from './types';

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
  profile(): Promise<Profile>;
  saveProfile(p: Profile): Promise<void>;
  projects(): Promise<{ projects: Project[]; plans: ProjectPlan[] }>;
  createProject(d: ProjectDraft): Promise<Project>;
  updateProject(id: string, patch: Partial<Project>): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  /** Retire the old plan, trash its unfinished sessions and add the new ones, all at once. */
  applyPlan(projectId: string, plan: PlanMeta, sessions: PlannedSession[]): Promise<void>;
  /** Ask the AI to break the project into milestones with hours. Throws if it is unavailable. */
  estimate(input: { name: string; description: string; course: string | null; deadline: string | null }): Promise<{ milestones: { title: string; hours: number }[]; rationale: string }>;
}

export type ProjectDraft = Pick<Project, 'name' | 'description' | 'course' | 'deadline' | 'granularity'>;
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
    must(await this.sb.from('projects').delete().eq('id', id).select('id'));
  }
  async applyPlan(projectId: string, plan: PlanMeta, sessions: PlannedSession[]) {
    must(await this.sb.rpc('apply_plan', { p_project: projectId, p_plan: plan, p_sessions: sessions }));
  }
  async estimate(input: { name: string; description: string; course: string | null; deadline: string | null }) {
    const { data, error } = await this.sb.functions.invoke('plan-project', { body: input });
    if (error) {
      let detail = error.message;
      try { detail = (await (error as { context?: Response }).context?.json())?.error ?? detail; } catch { /* keep the generic message */ }
      throw new Error(detail);
    }
    if (!data?.milestones?.length) throw new Error('The AI returned no plan');
    return data as { milestones: { title: string; hours: number }[]; rationale: string };
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
    this.items = this.items.filter((i) => i.project_id !== id);
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
  async estimate(input: { name: string }) {
    await new Promise((r) => setTimeout(r, 900));
    return { milestones: [{ title: 'Research and outline', hours: 2 }, { title: 'First draft', hours: 4 }, { title: 'Revise', hours: 2.5 }, { title: 'Proofread and submit', hours: 1 }], rationale: `A sample estimate for "${input.name}". With your own account, Claude sizes this from the description.` };
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
