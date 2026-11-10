import type { Session } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, IconAgenda, IconMonth, IconProjects, IconToday, IconWeek, Plus, Sliders, Tray } from './components/Icons';
import { NewProject, ProfileEditor, ProjectDetail, ProjectsView } from './components/Projects';
import { DEFAULT_PROFILE, type Profile } from './lib/planner';
import { ItemDetail, ItemEditor } from './components/ItemSheet';
import { FilterList, ReviewQueue, Sidebar, SignIn } from './components/Panels';
import { Sheet } from './components/Sheet';
import { AgendaView, MonthView, TimeGrid } from './components/Views';
import { clearCache, isDemo, makeSource, readCache, supabase, writeCache } from './lib/data';
import { groupByDay, matchesFilters, now, weekDays } from './lib/dates';
import { NO_FILTERS, type Filters, type Item, type ItemDraft, type Project, type ProjectPlan, type ViewName } from './lib/types';

type SheetState = { kind: 'item'; id: string | null; at: DateTime; editing: boolean } | { kind: 'review' } | { kind: 'filters' } | { kind: 'project'; id: string } | { kind: 'project-new' } | { kind: 'profile' } | null;
interface Toast { text: string; action?: { label: string; run: () => void } }

const VIEWS: { name: ViewName; label: string; icon: () => React.ReactNode }[] = [
  { name: 'today', label: 'Day', icon: IconToday },
  { name: 'week', label: 'Week', icon: IconWeek },
  { name: 'month', label: 'Month', icon: IconMonth },
  { name: 'agenda', label: 'Agenda', icon: IconAgenda },
  { name: 'projects', label: 'Projects', icon: IconProjects },
];

const stored = <T,>(key: string, fallback: T): T => {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { return fallback; }
};

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(isDemo ? null : undefined);
  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div className="boot" />;
  if (!isDemo && !session) return <SignIn />;
  return <Calendar key={session?.user.id ?? 'demo'} session={session} />;
}

function Calendar({ session }: { session: Session | null }) {
  const data = useMemo(() => makeSource(session?.user.id ?? null), [session?.user.id]);
  const [items, setItems] = useState<Item[]>(() => (isDemo ? [] : readCache()));
  const [view, setView] = useState<ViewName>(() => stored('planner.view', { v: (matchMedia('(max-width: 760px)').matches ? 'agenda' : 'week') as ViewName }).v);
  const [cursor, setCursor] = useState<DateTime>(() => now().startOf('day'));
  const [filters, setFiltersState] = useState<Filters>(() => stored('planner.filters', NO_FILTERS));
  const [sheet, setSheet] = useState<SheetState>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [status, setStatus] = useState(isDemo ? '' : 'Updating');
  const [proj, setProj] = useState<{ projects: Project[]; plans: ProjectPlan[] }>({ projects: [], plans: [] });
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [projectsReady, setProjectsReady] = useState(true);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const say = useCallback((t: Toast) => setToast(t), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.action ? 6000 : 3500);
    return () => clearTimeout(id);
  }, [toast]);

  const load = useCallback(async () => {
    try {
      const list = await data.list();
      setItems(list);
      if (!isDemo) writeCache(list);
      setStatus(isDemo ? '' : `Updated ${now().toFormat('h:mm a')}`);
      try {
        const [p, prof] = await Promise.all([data.projects(), data.profile()]);
        setProj(p); setProfile(prof); setProjectsReady(true);
      } catch { setProjectsReady(false); } // the projects tables are not there yet
    } catch {
      setStatus(navigator.onLine ? 'Could not update. Showing saved items.' : 'Offline. Showing saved items.');
    }
  }, [data]);

  useEffect(() => {
    void load();
    void data.reportTimezone?.().catch(() => {});
    let timer: ReturnType<typeof setTimeout>;
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void load(), 250); };
    const unsub = data.subscribe(soon);
    const onVisible = () => document.visibilityState === 'visible' && soon();
    window.addEventListener('online', soon);
    document.addEventListener('visibilitychange', onVisible);
    return () => { unsub(); clearTimeout(timer); window.removeEventListener('online', soon); document.removeEventListener('visibilitychange', onVisible); };
  }, [data, load]);

  useEffect(() => { try { localStorage.setItem('planner.view', JSON.stringify({ v: view })); } catch { /* optional */ } }, [view]);
  const setFilters = (f: Filters) => { setFiltersState(f); try { localStorage.setItem('planner.filters', JSON.stringify(f)); } catch { /* optional */ } };

  /** Change an item: the screen updates at once, then the server confirms or the change is rolled back. */
  const mutate = useCallback((id: string, patch: Partial<Item>) => {
    const before = itemsRef.current.find((i) => i.id === id);
    if (!before) return;
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    data.update(id, patch).then(
      (saved) => setItems((list) => list.map((i) => (i.id === id ? saved : i))),
      () => { setItems((list) => list.map((i) => (i.id === id ? before : i))); say({ text: 'That change could not be saved. Check your connection and try again.' }); },
    );
  }, [data, say]);

  const toggleDone = useCallback((item: Item) => mutate(item.id, { status: item.status === 'done' ? 'open' : 'done' }), [mutate]);

  const remove = useCallback((item: Item) => {
    setItems((list) => list.filter((i) => i.id !== item.id));
    const restore = () => { setItems((list) => [...list, item]); void data.update(item.id, { deleted_at: null }).catch(() => say({ text: 'Could not restore it.' })); };
    data.update(item.id, { deleted_at: new Date().toISOString() }).then(
      () => say({ text: 'Moved to Trash', action: { label: 'Undo', run: restore } }),
      () => { setItems((list) => [...list, item]); say({ text: 'It could not be deleted. Try again.' }); },
    );
  }, [data, say]);

  const create = useCallback((draft: ItemDraft) => {
    data.create(draft).then((saved) => setItems((list) => [...list, saved]), () => say({ text: 'It could not be added. Check your connection and try again.' }));
  }, [data, say]);

  const visible = useMemo(() => items.filter((i) => matchesFilters(i, filters)), [items, filters]);
  const byDay = useMemo(() => groupByDay(visible), [visible]);
  const review = useMemo(() => items.filter((i) => i.review_state === 'needs_review' && !i.deleted_at && i.status !== 'dismissed'), [items]);
  const open = sheet?.kind === 'item' && sheet.id ? items.find((i) => i.id === sheet.id) ?? null : null;
  const hiddenCount = filters.hiddenCategories.length + filters.hiddenCourses.length + filters.hiddenOrigins.length + filters.hiddenPriorities.length;

  const shared = { items, projects: proj.projects, plans: proj.plans, profile, data, reload: load, say };
  const openProject = sheet?.kind === 'project' ? proj.projects.find((p) => p.id === sheet.id) ?? null : null;
  const step = (dir: number) => setCursor((c) => (view === 'month' ? c.plus({ months: dir }) : view === 'week' ? c.plus({ weeks: dir }) : c.plus({ days: dir })));
  const newItem = (at?: DateTime) => setSheet({ kind: 'item', id: null, editing: true, at: at ?? cursor.set({ hour: Math.min(22, now().hour + 1), minute: 0 }) });
  const openItem = (item: Item) => setSheet({ kind: 'item', id: item.id, editing: false, at: cursor });

  const dated = view !== 'agenda' && view !== 'projects';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (sheet || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
      if (e.key === 't') setCursor(now().startOf('day'));
      else if (e.key === 'n') view === 'projects' ? setSheet({ kind: 'project-new' }) : newItem();
      else if (e.key === 'ArrowLeft' && dated) step(-1);
      else if (e.key === 'ArrowRight' && dated) step(1);
      else if (['1', '2', '3', '4', '5'].includes(e.key)) setView(VIEWS[Number(e.key) - 1]!.name);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const isToday = cursor.hasSame(now(), 'day');
  const phone = matchMedia('(max-width: 760px)').matches;
  const title =
    view === 'projects' ? <><b>Projects</b></>
    : view === 'agenda' ? <><b>Upcoming</b></>
    : view === 'today' ? <><b>{isToday ? 'Today' : cursor.toFormat('cccc')}</b> {cursor.toFormat(phone ? 'd LLL' : 'd LLLL')}</>
    : <><b>{cursor.toFormat('LLLL')}</b> {cursor.toFormat('yyyy')}</>;

  return (
    <div className="app">
      <Sidebar items={items} filters={filters} setFilters={setFilters} reviewCount={review.length} onOpenReview={() => setSheet({ kind: 'review' })} email={session?.user.email ?? null} status={status}
        onSignOut={() => { clearCache(); void supabase?.auth.signOut(); }} />

      <main className="main">
        <header className="toolbar">
          <h1 className="toolbar-title">{title}</h1>
          <div className="toolbar-right">
            {dated && (
              <div className="nav">
                <button className="btn-icon" onClick={() => step(-1)} aria-label="Earlier"><ChevronLeft /></button>
                <button className="btn-pill" onClick={() => setCursor(now().startOf('day'))} disabled={isToday && view !== 'month'}>Today</button>
                <button className="btn-icon" onClick={() => step(1)} aria-label="Later"><ChevronRight /></button>
              </div>
            )}
            <div className="seg seg-views" role="tablist" aria-label="View">
              {VIEWS.map((v) => <button key={v.name} role="tab" aria-selected={view === v.name} className={view === v.name ? 'is-on' : ''} onClick={() => setView(v.name)}>{v.label}</button>)}
            </div>
            <button className="btn-icon only-phone" onClick={() => setSheet({ kind: 'review' })} aria-label={`Needs review, ${review.length}`} disabled={!review.length}><Tray />{review.length > 0 && <sup>{review.length}</sup>}</button>
            <button className="btn-icon only-phone" onClick={() => setSheet({ kind: 'filters' })} aria-label="Filters"><Sliders />{hiddenCount > 0 && <sup>{hiddenCount}</sup>}</button>
            <button className="btn-icon is-accent" onClick={() => (view === 'projects' ? setSheet({ kind: 'project-new' }) : newItem())} aria-label={view === 'projects' ? 'New project' : 'New event or task'}><Plus /></button>
          </div>
        </header>

        <div className={`view view-${view === 'projects' ? 'agenda' : view}`}>
          {view === 'today' && <TimeGrid days={[cursor]} byDay={byDay} onOpen={openItem} onToggleDone={toggleDone} onCreate={newItem} />}
          {view === 'week' && <TimeGrid days={weekDays(cursor)} byDay={byDay} onOpen={openItem} onToggleDone={toggleDone} onCreate={newItem} />}
          {view === 'month' && <MonthView cursor={cursor} byDay={byDay} onOpen={openItem} onToggleDone={toggleDone} onPickDay={(d) => { setCursor(d); setView('today'); }} />}
          {view === 'agenda' && <AgendaView items={visible} byDay={byDay} onOpen={openItem} onToggleDone={toggleDone} />}
          {view === 'projects' && (projectsReady
            ? <ProjectsView items={items} projects={proj.projects} plans={proj.plans} onOpen={(p) => setSheet({ kind: 'project', id: p.id })} onNew={() => setSheet({ kind: 'project-new' })} onSettings={() => setSheet({ kind: 'profile' })} />
            : <div className="agenda"><div className="empty"><b>Projects need a database update</b><span>Run 0006_projects.sql in the Supabase SQL editor, then reload this page.</span></div></div>)}
        </div>

        <nav className="tabbar" aria-label="View">
          {VIEWS.map((v) => <button key={v.name} className={view === v.name ? 'is-on' : ''} aria-current={view === v.name} onClick={() => setView(v.name)}><v.icon /><span>{v.label}</span></button>)}
        </nav>
      </main>

      {sheet?.kind === 'item' && (sheet.id === null || open) && (
        <Sheet key={`item-${sheet.id ?? 'new'}`} label={open ? open.title : 'New item'} onClosed={() => setSheet(null)}>
          {(close) => sheet.editing ? (
            <ItemEditor item={open} at={sheet.at} onCancel={open ? () => setSheet({ ...sheet, editing: false }) : close}
              onSave={(changes, full) => {
                if (open) { if (Object.keys(changes).length) mutate(open.id, changes); setSheet({ ...sheet, editing: false }); }
                else { create(full); close(); }
              }} />
          ) : (
            <ItemDetail item={open!} data={data} mutate={mutate} onDelete={remove} onEdit={() => setSheet({ ...sheet, editing: true })} close={close} projectName={proj.projects.find((p) => p.id === open!.project_id)?.name} />
          )}
        </Sheet>
      )}
      {sheet?.kind === 'review' && (
        <Sheet label="Needs review" wide onClosed={() => setSheet((s) => (s?.kind === 'review' ? null : s))}>
          {(close) => <ReviewQueue items={review} mutate={mutate} close={close} onEdit={(it) => setSheet({ kind: 'item', id: it.id, editing: true, at: cursor })} />}
        </Sheet>
      )}
      {sheet?.kind === 'project-new' && <Sheet label="New project" wide onClosed={() => setSheet(null)}>{(close) => <NewProject shared={shared} close={close} />}</Sheet>}
      {sheet?.kind === 'project' && openProject && <Sheet key={`project-${openProject.id}`} label={openProject.name} wide onClosed={() => setSheet(null)}>{(close) => <ProjectDetail project={openProject} shared={shared} close={close} />}</Sheet>}
      {sheet?.kind === 'profile' && <Sheet label="Planning settings" wide onClosed={() => setSheet(null)}>{(close) => <ProfileEditor shared={shared} close={close} />}</Sheet>}
      {sheet?.kind === 'filters' && (
        <Sheet label="Filters" onClosed={() => setSheet(null)}>
          {(close) => (<><header className="sheet-bar"><b>Show on calendar</b><button className="btn-text is-strong" onClick={close}>Done</button></header><FilterList items={items} filters={filters} setFilters={setFilters} /></>)}
        </Sheet>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.action && <button className="btn-text" onClick={() => { toast.action!.run(); setToast(null); }}>{toast.action.label}</button>}
        </div>
      )}
    </div>
  );
}
