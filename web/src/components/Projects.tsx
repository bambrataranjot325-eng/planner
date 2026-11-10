import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import type { DataSource, PlanMeta } from '../lib/data';
import { fromIso, itemWhen, now } from '../lib/dates';
import { busyFromItems, findIssues, learnedPace, manualMilestones, plan, remainingMilestones, suggestDeadline, type Milestone, type PlanResult, type Profile } from '../lib/planner';
import type { Item, Project, ProjectPlan } from '../lib/types';
import { Check, Close, Plus } from './Icons';

const hrs = (min: number) => { const h = Math.round((min / 60) * 10) / 10; return `${h} h`; };
const dayTime = (iso: string) => fromIso(iso).toFormat('ccc d LLL, h:mm a');
const sessionsOf = (items: Item[], id: string) => items.filter((i) => i.project_id === id && i.origin === 'plan' && !i.deleted_at);

function progress(planRow: ProjectPlan | undefined, sessions: Item[]) {
  const done = sessions.filter((s) => s.status === 'done').reduce((sum, s) => sum + (s.planned_minutes ?? 0), 0);
  const total = Math.max(planRow?.total_minutes ?? 0, done + sessions.filter((s) => s.status === 'open').reduce((sum, s) => sum + (s.planned_minutes ?? 0), 0));
  return { done, total, pct: total ? Math.min(100, Math.round((done / total) * 100)) : 0 };
}

interface Shared {
  items: Item[]; projects: Project[]; plans: ProjectPlan[]; profile: Profile;
  data: DataSource; reload: () => Promise<void>; say: (t: { text: string }) => void;
  mutate: (id: string, patch: Partial<Item>) => void;
}

const linkedOf = (items: Item[], id: string) => items.filter((i) => i.project_id === id && i.origin !== 'plan' && !i.deleted_at);
const whenShort = (i: Item) => { const w = itemWhen(i); return w ? w.toFormat('ccc d LLL') : 'no date'; };

/** Choose calendar items to attach to a project. What they say is given to the AI as context. */
function ItemPicker({ items, selected, onToggle }: { items: Item[]; selected: string[]; onToggle: (item: Item) => void }) {
  const [q, setQ] = useState('');
  const t = now().minus({ days: 1 }).toMillis();
  const pool = items
    .filter((i) => i.origin !== 'plan' && !i.deleted_at && i.review_state === 'accepted' && !['dismissed', 'cancelled'].includes(i.status))
    .filter((i) => selected.includes(i.id) || ((itemWhen(i)?.toMillis() ?? Infinity) >= t && i.status === 'open'))
    .filter((i) => !q.trim() || `${i.title} ${i.course ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)) || (itemWhen(a)?.toMillis() ?? Infinity) - (itemWhen(b)?.toMillis() ?? Infinity));
  return (
    <div className="group">
      <input className="field" placeholder="Search your calendar" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items to attach" />
      {pool.slice(0, 7).map((i) => (
        <button type="button" key={i.id} className={`field-row pick cat-${i.category}${selected.includes(i.id) ? ' is-on' : ''}`} role="checkbox" aria-checked={selected.includes(i.id)} onClick={() => onToggle(i)}>
          <i>{selected.includes(i.id) && <Check size={11} />}</i>
          <span>{i.title}<small>{[i.kind === 'task' ? `due ${whenShort(i)}` : whenShort(i), i.course].filter(Boolean).join(', ')}</small></span>
        </button>
      ))}
      {!pool.length && <div className="field-row"><span><small>Nothing matches.</small></span></div>}
      {pool.length > 7 && <div className="field-row"><span><small>{pool.length - 7} more. Type to narrow it down.</small></span></div>}
    </div>
  );
}

/* ---------- list ---------- */
export function ProjectsView({ items, projects, plans, onOpen, onNew, onSettings }: Pick<Shared, 'items' | 'projects' | 'plans'> & { onOpen: (p: Project) => void; onNew: () => void; onSettings: () => void }) {
  const t = now();
  return (
    <div className="agenda projects">
      <div className="projects-bar">
        <button className="btn is-fill" onClick={onNew}><Plus /> New project</button>
        <button className="btn" onClick={onSettings}>Planning settings</button>
      </div>
      {!projects.length && (
        <div className="empty">
          <b>No projects yet</b>
          <span>Describe a piece of work and when it is due. You get a timeline of work sessions that fits around your calendar.</span>
        </div>
      )}
      <div className="group">
        {projects.map((p) => {
          const current = plans.find((x) => x.id === p.current_plan_id);
          const sess = sessionsOf(items, p.id);
          const pr = progress(current, sess);
          const issues = findIssues(p.deadline, current?.deadline ?? null, sess, items, t);
          const flagged = p.status === 'open' && (issues.deadlineMoved || issues.missed.length > 0 || issues.clashes.length > 0);
          const next = sess.filter((s) => s.status === 'open' && Date.parse((s.start_at ?? s.due_at)!) > t.toMillis()).sort((a, b) => (a.start_at ?? a.due_at)!.localeCompare((b.start_at ?? b.due_at)!))[0];
          return (
            <div key={p.id} className={`row proj-row${p.status === 'done' ? ' is-done' : ''}`} role="button" tabIndex={0} onClick={() => onOpen(p)} onKeyDown={(e) => e.key === 'Enter' && onOpen(p)}>
              <div className="row-main">
                <b>{p.name}</b>
                <span>{[p.course, p.deadline && `due ${fromIso(p.deadline).toFormat('ccc d LLL')}`, next && `next: ${dayTime((next.start_at ?? next.due_at)!)}`].filter(Boolean).join(', ') || 'No plan yet'}</span>
                <div className="bar" aria-label={`${pr.pct}% done`}><i style={{ width: `${pr.pct}%` }} /></div>
              </div>
              {flagged ? <em className="row-flag">Needs a look</em> : <em className="row-tag">{hrs(pr.done)} of {hrs(pr.total)}</em>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- plan preview (used for new plans and replans) ---------- */
function PlanPreview({ result, deadline, suggested, onDeadline, milestones, onHours, zoneNote }: { result: PlanResult; deadline: DateTime; suggested: boolean; onDeadline: (d: DateTime) => void; milestones: Milestone[]; onHours: (i: number, hours: number) => void; zoneNote?: string }) {
  const byDay = new Map<string, typeof result.sessions>();
  for (const s of result.sessions) {
    const k = fromIso((s.start_at ?? s.due_at)!).toFormat('cccc d LLLL');
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  return (
    <>
      <div className="group">
        <label className="field-row"><span>{suggested ? 'Suggested deadline' : 'Deadline'}</span>
          <input type="datetime-local" value={deadline.toFormat("yyyy-LL-dd'T'HH:mm")} onChange={(e) => { const d = DateTime.fromISO(e.target.value); if (d.isValid) onDeadline(d); }} />
        </label>
        <div className="field-row"><span>Total work</span><em>{hrs(result.totalMinutes)}</em></div>
      </div>
      {result.shortfallMinutes > 0 && <div className="notice"><b>It does not all fit</b><span>{hrs(result.shortfallMinutes)} could not be placed before the deadline. Move the deadline later, lower the hours, or raise your daily limit in Planning settings.</span></div>}
      <section>
        <h2>Why it looks like this</h2>
        <ul className="why">{[...(zoneNote ? [zoneNote] : []), ...result.explanation].map((l, i) => <li key={i}>{l}</li>)}</ul>
      </section>
      <section>
        <h2>Milestones (hours are editable)</h2>
        <div className="group">
          {milestones.map((m, i) => (
            <label className="field-row" key={i}>
              <span>{m.title}<small>{result.milestones[i]?.due ? `done by ${fromIso(result.milestones[i]!.due!).toFormat('ccc d LLL')}` : 'not placed'}</small></span>
              <input type="number" min={0.25} max={200} step={0.25} value={Math.round((m.minutes / 60) * 100) / 100} onChange={(e) => onHours(i, Number(e.target.value))} aria-label={`Hours for ${m.title}`} />
            </label>
          ))}
        </div>
      </section>
      <section>
        <h2>{result.sessions[0]?.kind === 'task' ? 'Weekly targets' : 'Work sessions'}</h2>
        <div className="group">
          {[...byDay.entries()].map(([day, list]) => (
            <div className="field-row is-stack" key={day}>
              <span>{day}</span>
              <small>{list.map((s) => (s.start_at ? `${fromIso(s.start_at).toFormat('h:mm a')} ${s.title.split(': ').slice(1).join(': ')}` : s.title.split(': ').slice(1).join(': '))).join('; ')}</small>
            </div>
          ))}
          {!result.sessions.length && <div className="field-row"><span>Nothing could be placed</span></div>}
        </div>
      </section>
    </>
  );
}

/** Holds the editable state of a plan being previewed and recomputes it as the deadline or hours change. */
function usePlanner(shared: Shared, projectName: string, projectId: string | null, granularity: 'daily' | 'weekly') {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [deadline, setDeadline] = useState<DateTime | null>(null);
  const [suggested, setSuggested] = useState(false);
  const pace = useMemo(() => learnedPace(shared.items), [shared.items]);
  const t = useMemo(() => now(), []);
  const context = useMemo(() => busyFromItems(shared.items, projectId, t), [shared.items, projectId, t]);
  const input = { projectName, milestones, now: t, profile: shared.profile, busy: context.busy, otherMinutesByDay: context.otherMinutesByDay, granularity };
  const result = useMemo(() => (deadline && milestones.length ? plan({ ...input, deadline }) : null), [deadline, milestones, granularity, shared.profile, context]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (ms: Milestone[], given: DateTime | null, applyPace: boolean) => {
    const scaled = applyPace && pace && pace !== 1 ? ms.map((m) => ({ ...m, minutes: Math.round((m.minutes * pace) / 15) * 15 })) : ms;
    setMilestones(scaled);
    setSuggested(!given);
    setDeadline(given ?? suggestDeadline({ ...input, milestones: scaled }));
  };
  const setHours = (i: number, h: number) => setMilestones((list) => list.map((m, k) => (k === i ? { ...m, minutes: Math.max(15, Math.round((h * 60) / 15) * 15) } : m)));
  const paceNote = pace && pace !== 1 ? `Estimates were ${pace > 1 ? 'raised' : 'lowered'} ${Math.round(Math.abs(pace - 1) * 100)}% because your finished sessions have run ${pace > 1 ? 'over' : 'under'}.` : undefined;
  return { milestones, deadline, suggested, result, start, setHours, setDeadline: (d: DateTime) => { setDeadline(d); setSuggested(false); }, paceNote, granularity };
}

async function commit(shared: Shared, projectId: string, pl: ReturnType<typeof usePlanner>, madeBy: 'ai' | 'manual', rationale: string | null) {
  const r = pl.result!;
  const meta: PlanMeta = {
    deadline: pl.deadline!.toUTC().toISO({ suppressMilliseconds: true })!, total_minutes: r.totalMinutes, buffer_pct: shared.profile.buffer_pct, granularity: pl.granularity, made_by: madeBy,
    milestones: r.milestones, explanation: [...(rationale ? [rationale] : []), ...(pl.paceNote ? [pl.paceNote] : []), ...r.explanation],
  };
  await shared.data.applyPlan(projectId, meta, r.sessions);
  await shared.reload();
}

/* ---------- new project ---------- */
export function NewProject({ shared, close, seed }: { shared: Shared; close: () => void; seed?: Item | null }) {
  const seedDue = seed && itemWhen(seed) && itemWhen(seed)! > now() ? itemWhen(seed)! : null;
  const [name, setName] = useState(seed?.title ?? '');
  const [description, setDescription] = useState(seed?.summary ?? '');
  const [course, setCourse] = useState(seed?.course ?? '');
  const [hasDeadline, setHasDeadline] = useState(true);
  const [deadlineInput, setDeadlineInput] = useState((seedDue ?? now().plus({ days: 10 }).set({ hour: 17, minute: 0 })).toFormat("yyyy-LL-dd'T'HH:mm"));
  const [attached, setAttached] = useState<string[]>(seed ? [seed.id] : []);
  const [deadlineFrom, setDeadlineFrom] = useState<string | null>(seedDue ? seed!.title : null);
  const toggleAttach = (it: Item) => {
    const adding = !attached.includes(it.id);
    setAttached(adding ? [...attached, it.id] : attached.filter((x) => x !== it.id));
    const w = itemWhen(it);
    // Attaching a deadline is the usual reason to make a project: take its date unless one was already taken.
    if (adding && it.kind === 'task' && w && w > now() && !deadlineFrom) { setHasDeadline(true); setDeadlineInput(w.toFormat("yyyy-LL-dd'T'HH:mm")); setDeadlineFrom(it.title); }
    if (adding && !course && it.course) setCourse(it.course);
  };
  const [granularity, setGranularity] = useState<'daily' | 'weekly'>('daily');
  const [manualHours, setManualHours] = useState('');
  const [step, setStep] = useState<'form' | 'thinking' | 'preview' | 'saving'>('form');
  const [error, setError] = useState('');
  const [madeBy, setMadeBy] = useState<'ai' | 'manual'>('ai');
  const [rationale, setRationale] = useState<string | null>(null);
  const pl = usePlanner(shared, name.trim() || 'Project', null, granularity);
  const given = hasDeadline ? DateTime.fromISO(deadlineInput) : null;

  const estimate = async (useAI: boolean) => {
    setError('');
    if (!useAI) {
      const h = Number(manualHours);
      if (!(h > 0)) { setError('Enter how many hours you think it needs.'); return; }
      setMadeBy('manual'); setRationale(null);
      pl.start(manualMilestones(h), given, false);
      setStep('preview');
      return;
    }
    setStep('thinking');
    try {
      const out = await shared.data.estimate({ name: name.trim(), description: description.trim(), course: course.trim() || null, deadline: given ? given.toUTC().toISO() : null, item_ids: attached });
      setMadeBy('ai'); setRationale(out.rationale);
      pl.start(out.milestones.map((m) => ({ title: m.title.slice(0, 60), minutes: Math.max(15, Math.round((m.hours * 60) / 15) * 15) })), given, true);
      setStep('preview');
    } catch (e) {
      setStep('form');
      setError(`The AI estimate is not available right now (${(e as Error).message}). Enter the hours yourself below and plan without it.`);
    }
  };
  const save = async () => {
    setStep('saving');
    try {
      const p = await shared.data.createProject({ name: name.trim(), description: description.trim() || null, course: course.trim() || null, deadline: pl.deadline!.toUTC().toISO(), granularity });
      await Promise.all(attached.map((id) => shared.data.update(id, { project_id: p.id })));
      await commit(shared, p.id, pl, madeBy, rationale);
      close();
    } catch (e) { setStep('preview'); setError(`It could not be saved: ${(e as Error).message}`); }
  };

  return (
    <div className="editor">
      <header className="sheet-bar">
        <button className="btn-text" onClick={step === 'preview' ? () => setStep('form') : close}>{step === 'preview' ? 'Back' : 'Cancel'}</button>
        <b>{step === 'preview' || step === 'saving' ? 'Proposed plan' : 'New project'}</b>
        {step === 'preview' || step === 'saving' ? <button className="btn-text is-strong" disabled={step === 'saving' || !pl.result?.sessions.length} onClick={save}>{step === 'saving' ? 'Adding' : 'Add to calendar'}</button> : <span style={{ width: '3rem' }} />}
      </header>

      {(step === 'form' || step === 'thinking') && (
        <>
          <div className="group">
            <input className="field field-title" placeholder="Project name" value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} aria-label="Project name" />
            <textarea className="field" rows={4} placeholder="What does it involve? The more specific, the better the estimate." value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
            <input className="field" placeholder="Course (optional)" value={course} onChange={(e) => setCourse(e.target.value)} aria-label="Course" />
          </div>
          <div className="group">
            <label className="field-row"><span>I have a deadline</span><input type="checkbox" className="switch" checked={hasDeadline} onChange={(e) => setHasDeadline(e.target.checked)} /></label>
            {hasDeadline ? <label className="field-row"><span>Due{deadlineFrom && <small>from “{deadlineFrom.slice(0, 40)}”</small>}</span><input type="datetime-local" value={deadlineInput} onChange={(e) => { setDeadlineInput(e.target.value); setDeadlineFrom(null); }} /></label>
              : <div className="field-row"><span><small>A deadline will be suggested from how much free time you have.</small></span></div>}
          </div>
          <section>
            <h2>Related calendar items{attached.length ? ` (${attached.length} attached)` : ''}</h2>
            <p className="hint">Attach the deadline, exam or emails this project is about. The estimate reads them, and the emails they came from, for context.</p>
            <ItemPicker items={shared.items} selected={attached} onToggle={toggleAttach} />
          </section>
          <div className="seg" role="tablist" aria-label="Timeline detail" style={{ marginTop: '1rem' }}>
            <button role="tab" aria-selected={granularity === 'daily'} className={granularity === 'daily' ? 'is-on' : ''} onClick={() => setGranularity('daily')}>Daily sessions</button>
            <button role="tab" aria-selected={granularity === 'weekly'} className={granularity === 'weekly' ? 'is-on' : ''} onClick={() => setGranularity('weekly')}>Weekly targets</button>
          </div>
          {error && <p className="form-note">{error}</p>}
          <button className="btn is-fill btn-wide" style={{ marginTop: '1rem' }} disabled={!name.trim() || step === 'thinking' || (hasDeadline && !given?.isValid)} onClick={() => void estimate(true)}>{step === 'thinking' ? 'Estimating the work' : 'Plan it'}</button>
          <div className="group">
            <label className="field-row"><span>Or give the hours yourself</span><input type="number" min={0.5} step={0.5} placeholder="Hours" value={manualHours} onChange={(e) => setManualHours(e.target.value)} /></label>
          </div>
          {manualHours && <button className="btn btn-wide" style={{ marginTop: '0.625rem' }} disabled={!name.trim()} onClick={() => void estimate(false)}>Plan with my hours</button>}
        </>
      )}

      {(step === 'preview' || step === 'saving') && pl.result && pl.deadline && (
        <>
          {error && <p className="form-note">{error}</p>}
          <PlanPreview result={pl.result} deadline={pl.deadline} suggested={pl.suggested} onDeadline={pl.setDeadline} milestones={pl.milestones} onHours={pl.setHours} zoneNote={[rationale, pl.paceNote].filter(Boolean).join(' ') || undefined} />
        </>
      )}
    </div>
  );
}

/* ---------- project detail ---------- */
export function ProjectDetail({ project, shared, close }: { project: Project; shared: Shared; close: () => void }) {
  const { items, plans, data, reload, say } = shared;
  const current = plans.find((p) => p.id === project.current_plan_id);
  const versions = plans.filter((p) => p.project_id === project.id).sort((a, b) => b.version - a.version);
  const sess = sessionsOf(items, project.id);
  const pr = progress(current, sess);
  const t = now();
  const issues = findIssues(project.deadline, current?.deadline ?? null, sess, items, t);
  const upcoming = sess.filter((s) => s.status === 'open' && Date.parse((s.end_at ?? s.due_at ?? s.start_at)!) > t.toMillis()).sort((a, b) => (a.start_at ?? a.due_at)!.localeCompare((b.start_at ?? b.due_at)!));
  const linked = linkedOf(items, project.id);
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<'view' | 'replan' | 'busy'>('view');
  const [confirming, setConfirming] = useState(false);
  const [deadlineEdit, setDeadlineEdit] = useState(project.deadline ? fromIso(project.deadline).toFormat("yyyy-LL-dd'T'HH:mm") : '');
  const pl = usePlanner(shared, project.name, project.id, current?.granularity ?? project.granularity);
  const run = async (fn: () => Promise<unknown>, fail: string) => { setMode('busy'); try { await fn(); } catch (e) { say({ text: `${fail}: ${(e as Error).message}` }); } setMode('view'); };

  const startReplan = () => {
    if (!current) return;
    pl.start(remainingMilestones(current.milestones, sess), project.deadline ? fromIso(project.deadline) : null, false);
    setMode('replan');
  };
  /** Ask the AI again, now that the attached items have changed, and plan whatever is not already done. */
  const reestimate = () => run(async () => {
    const out = await data.estimate({ name: project.name, description: project.description ?? '', course: project.course, deadline: project.deadline, item_ids: linked.map((i) => i.id) });
    const fresh = out.milestones.map((m) => ({ title: m.title.slice(0, 60), minutes: Math.max(15, Math.round((m.hours * 60) / 15) * 15) }));
    pl.start(remainingMilestones(fresh, sess), project.deadline ? fromIso(project.deadline) : null, true);
    setTimeout(() => setMode('replan'), 0);
  }, 'The AI estimate is not available');
  const restore = (v: ProjectPlan) => run(async () => {
    const meta: PlanMeta = { deadline: v.deadline, total_minutes: v.total_minutes, buffer_pct: v.buffer_pct, granularity: v.granularity, made_by: v.made_by, milestones: v.milestones, explanation: [`Restored from version ${v.version}. Sessions that were already in the past are left out.`, ...v.explanation] };
    await data.applyPlan(project.id, meta, v.sessions);
    await reload();
  }, 'That version could not be restored');
  const saveDeadline = () => { const d = DateTime.fromISO(deadlineEdit); if (d.isValid) void run(async () => { await data.updateProject(project.id, { deadline: d.toUTC().toISO() }); await reload(); }, 'The deadline could not be changed'); };

  if (mode === 'replan' && pl.result && pl.deadline) {
    return (
      <div className="editor">
        <header className="sheet-bar">
          <button className="btn-text" onClick={() => setMode('view')}>Cancel</button>
          <b>New plan for what is left</b>
          <button className="btn-text is-strong" disabled={!pl.result.sessions.length} onClick={() => void run(async () => { await commit(shared, project.id, pl, current?.made_by ?? 'manual', 'Replanned around what is done and what has changed.'); }, 'The new plan could not be saved')}>Use this plan</button>
        </header>
        <PlanPreview result={pl.result} deadline={pl.deadline} suggested={pl.suggested} onDeadline={pl.setDeadline} milestones={pl.milestones} onHours={pl.setHours} zoneNote="Finished sessions are kept. Unfinished ones are replaced by the sessions below." />
      </div>
    );
  }

  const problems = [issues.deadlineMoved && 'the deadline changed', issues.missed.length > 0 && `${issues.missed.length} session${issues.missed.length === 1 ? ' was' : 's were'} missed`, issues.clashes.length > 0 && `${issues.clashes.length} session${issues.clashes.length === 1 ? '' : 's'} now clash${issues.clashes.length === 1 ? 'es' : ''} with something else`].filter(Boolean) as string[];
  return (
    <div className="detail is-session">
      <header className="sheet-bar">
        <span className="detail-cat"><i />{project.course ?? 'Project'}</span>
        <button className="btn-round" onClick={close} aria-label="Close"><Close /></button>
      </header>
      <h1 className={project.status === 'done' ? 'is-done' : ''}>{project.name}</h1>
      {project.deadline && <p className="detail-when">Due {fromIso(project.deadline).toFormat("cccc d LLLL 'at' h:mm a")}</p>}
      {project.description && <p className="detail-summary">{project.description}</p>}
      <div className="bar is-big" aria-label={`${pr.pct}% done`}><i style={{ width: `${pr.pct}%` }} /></div>
      <p className="detail-where">{hrs(pr.done)} done of {hrs(pr.total)}</p>

      {project.status === 'open' && problems.length > 0 && (
        <div className="notice">
          <b>This plan needs a look</b>
          <span>{problems.join(', ').replace(/^./, (c) => c.toUpperCase())}. Nothing has been changed for you.</span>
          <div><button className="btn is-fill" disabled={mode === 'busy'} onClick={startReplan}>Replan what is left</button></div>
        </div>
      )}

      {current && (
        <section>
          <h2>Why it looks like this</h2>
          <ul className="why">{current.explanation.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </section>
      )}
      {current && (
        <section>
          <h2>Milestones</h2>
          <div className="group">{current.milestones.map((m, i) => <div className="field-row" key={i}><span>{m.title}</span><em>{hrs(m.minutes)}{m.due ? `, by ${fromIso(m.due).toFormat('ccc d LLL')}` : ''}</em></div>)}</div>
        </section>
      )}
      <section>
        <h2>Coming up</h2>
        <div className="group">
          {upcoming.slice(0, 6).map((s) => <div className="field-row" key={s.id}><span>{s.title.split(': ').slice(1).join(': ') || s.title}</span><em>{s.start_at ? dayTime(s.start_at) : `by ${fromIso(s.due_at!).toFormat('ccc d LLL')}`}</em></div>)}
          {!upcoming.length && <div className="field-row"><span>Nothing scheduled</span>{project.status === 'open' && current && <button className="btn-text" onClick={startReplan}>Plan it</button>}</div>}
          {upcoming.length > 6 && <div className="field-row"><span><small>and {upcoming.length - 6} more</small></span></div>}
        </div>
      </section>
      <section>
        <h2>Related calendar items</h2>
        <div className="group">
          {linked.map((i) => (
            <div className={`field-row cat-${i.category}`} key={i.id}>
              <span>{i.title}<small>{[i.kind === 'task' ? `due ${whenShort(i)}` : whenShort(i), i.status === 'done' && 'done'].filter(Boolean).join(', ')}</small></span>
              <button className="btn-text" onClick={() => shared.mutate(i.id, { project_id: null })}>Remove</button>
            </div>
          ))}
          {!linked.length && <div className="field-row"><span><small>None attached. Attach the deadline or emails this is about to give the estimate more to go on.</small></span></div>}
          <div className="field-row"><button className="btn-text" onClick={() => setPicking(!picking)}>{picking ? 'Done choosing' : 'Attach items'}</button>
            {linked.length > 0 && project.status === 'open' && <button className="btn-text" disabled={mode === 'busy'} onClick={() => void reestimate()}>{mode === 'busy' ? 'Estimating' : 'Re-estimate with these'}</button>}</div>
        </div>
        {picking && <ItemPicker items={items} selected={linked.map((i) => i.id)} onToggle={(it) => shared.mutate(it.id, { project_id: it.project_id === project.id ? null : project.id })} />}
      </section>
      <section>
        <h2>Deadline</h2>
        <div className="group"><label className="field-row"><span>Due</span><input type="datetime-local" value={deadlineEdit} onChange={(e) => setDeadlineEdit(e.target.value)} onBlur={() => deadlineEdit && DateTime.fromISO(deadlineEdit).toMillis() !== (project.deadline ? fromIso(project.deadline).toMillis() : 0) && saveDeadline()} /></label></div>
      </section>
      {versions.length > 1 && (
        <section>
          <h2>Plan versions</h2>
          <div className="group">
            {versions.map((v) => (
              <div className="field-row" key={v.id}>
                <span>Version {v.version}{v.id === project.current_plan_id ? ' (current)' : ''}<small>{fromIso(v.created_at).toFormat('d LLL, h:mm a')}, {hrs(v.total_minutes)}, due {fromIso(v.deadline).toFormat('d LLL')}, {v.sessions.length} {v.granularity === 'weekly' ? 'targets' : 'sessions'}</small></span>
                {v.id !== project.current_plan_id && <button className="btn-text" disabled={mode === 'busy'} onClick={() => void restore(v)}>Restore</button>}
              </div>
            ))}
          </div>
        </section>
      )}
      <footer className="detail-foot">
        {confirming ? (
          <>
            <span>Delete this project and its work sessions? This cannot be undone.</span>
            <button className="btn is-danger" onClick={() => void run(async () => { await data.deleteProject(project.id); await reload(); close(); }, 'It could not be deleted')}>Delete project</button>
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn" disabled={mode === 'busy'} onClick={() => void run(async () => { await data.updateProject(project.id, { status: project.status === 'done' ? 'open' : 'done' }); await reload(); }, 'It could not be updated')}>{project.status === 'done' ? 'Reopen project' : 'Mark project done'}</button>
            <button className="btn is-danger-text" onClick={() => setConfirming(true)}>Delete</button>
          </>
        )}
      </footer>
    </div>
  );
}

/* ---------- planning settings ---------- */
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function ProfileEditor({ shared, close }: { shared: Shared; close: () => void }) {
  const [p, setP] = useState<Profile>(shared.profile);
  const [block, setBlock] = useState({ label: '', days: [] as number[], start: '09:00', end: '10:00' });
  const [saving, setSaving] = useState(false);
  const setDay = (d: string, v: { start: string; end: string } | null) => setP((x) => ({ ...x, working_hours: { ...x.working_hours, [d]: v } }));
  const save = async () => {
    setSaving(true);
    try { await shared.data.saveProfile(p); await shared.reload(); close(); } catch (e) { shared.say({ text: `Settings could not be saved: ${(e as Error).message}` }); setSaving(false); }
  };
  return (
    <div className="editor">
      <header className="sheet-bar">
        <button className="btn-text" onClick={close}>Cancel</button>
        <b>Planning settings</b>
        <button className="btn-text is-strong" disabled={saving} onClick={() => void save()}>Save</button>
      </header>
      <p className="review-intro">Project work is only ever scheduled inside these hours, around your classes and calendar.</p>
      <section>
        <h2>Hours you can work on projects</h2>
        <div className="group">
          {DAYS.map((name, i) => {
            const k = String(i + 1), wh = p.working_hours[k];
            return (
              <div className="field-row hours-row" key={k}>
                <label><input type="checkbox" checked={!!wh} onChange={(e) => setDay(k, e.target.checked ? { start: '09:00', end: '18:00' } : null)} /> {name}</label>
                {wh ? <span><input type="time" value={wh.start} onChange={(e) => setDay(k, { ...wh, start: e.target.value })} aria-label={`${name} from`} /> to <input type="time" value={wh.end} onChange={(e) => setDay(k, { ...wh, end: e.target.value })} aria-label={`${name} until`} /></span> : <em>Off</em>}
              </div>
            );
          })}
        </div>
      </section>
      <section>
        <h2>Limits</h2>
        <div className="group">
          <label className="field-row"><span>Most project work in a day</span><select value={p.max_hours_per_day} onChange={(e) => setP({ ...p, max_hours_per_day: Number(e.target.value) })}>{[1, 1.5, 2, 3, 4, 5, 6, 8].map((h) => <option key={h} value={h}>{h} hours</option>)}</select></label>
          <label className="field-row"><span>Session length</span><select value={p.session_minutes} onChange={(e) => setP({ ...p, session_minutes: Number(e.target.value) })}>{[30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></label>
          <label className="field-row"><span>Spare time kept before a deadline</span><select value={p.buffer_pct} onChange={(e) => setP({ ...p, buffer_pct: Number(e.target.value) })}>{[0, 10, 20, 30, 40].map((b) => <option key={b} value={b}>{b}%</option>)}</select></label>
          <label className="field-row"><span>I work best</span><select value={p.energy} onChange={(e) => setP({ ...p, energy: e.target.value as Profile['energy'] })}><option value="any">Any time</option><option value="morning">In the morning</option><option value="afternoon">In the afternoon</option><option value="evening">In the evening</option></select></label>
        </div>
      </section>
      <section>
        <h2>Classes and fixed commitments</h2>
        <div className="group">
          {p.blocks.map((b, i) => (
            <div className="field-row" key={i}>
              <span>{b.label}<small>{b.days.map((d) => DAYS[d - 1]!.slice(0, 3)).join(', ')}, {b.start} to {b.end}</small></span>
              <button className="btn-text" onClick={() => setP({ ...p, blocks: p.blocks.filter((_, k) => k !== i) })}>Remove</button>
            </div>
          ))}
          {!p.blocks.length && <div className="field-row"><span><small>None yet. Events already on your calendar are avoided automatically; add weekly classes here.</small></span></div>}
        </div>
        <div className="group">
          <input className="field" placeholder="Name, e.g. Data Structures lecture" value={block.label} onChange={(e) => setBlock({ ...block, label: e.target.value })} aria-label="Commitment name" />
          <div className="field-row days-row">{DAYS.map((d, i) => <button key={d} type="button" className={`day-chip${block.days.includes(i + 1) ? ' is-on' : ''}`} aria-pressed={block.days.includes(i + 1)} onClick={() => setBlock({ ...block, days: block.days.includes(i + 1) ? block.days.filter((x) => x !== i + 1) : [...block.days, i + 1].sort() })}>{d.slice(0, 2)}</button>)}</div>
          <div className="field-row hours-row"><span>From <input type="time" value={block.start} onChange={(e) => setBlock({ ...block, start: e.target.value })} aria-label="From" /> to <input type="time" value={block.end} onChange={(e) => setBlock({ ...block, end: e.target.value })} aria-label="Until" /></span>
            <button className="btn-text is-strong" disabled={!block.label.trim() || !block.days.length || block.end <= block.start} onClick={() => { setP({ ...p, blocks: [...p.blocks, { ...block, label: block.label.trim() }] }); setBlock({ label: '', days: [], start: '09:00', end: '10:00' }); }}>Add</button></div>
        </div>
      </section>
    </div>
  );
}
