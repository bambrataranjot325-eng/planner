import { useState } from 'react';
import { supabase } from '../lib/data';
import { fullWhen } from '../lib/dates';
import { CATEGORIES, CATEGORY_LABEL, ORIGIN_LABEL, PRIORITIES, type Filters, type Item, type Origin } from '../lib/types';
import { Check, Close, Tray } from './Icons';

function Tick({ on, label, tone, onChange }: { on: boolean; label: string; tone?: string; onChange: (on: boolean) => void }) {
  return (
    <button className={`tick ${tone ?? ''}${on ? ' is-on' : ''}`} role="checkbox" aria-checked={on} onClick={() => onChange(!on)}>
      <i>{on && <Check size={11} />}</i>
      <span>{label}</span>
    </button>
  );
}

function toggle<T>(list: T[], value: T, shown: boolean): T[] {
  return shown ? list.filter((x) => x !== value) : [...list, value];
}

/** Tick lists for what the calendar shows. Used in the sidebar and in the phone's filter sheet. */
export function FilterList({ items, filters, setFilters }: { items: Item[]; filters: Filters; setFilters: (f: Filters) => void }) {
  const courses = [...new Set(items.map((i) => i.course).filter((c): c is string => !!c))].sort();
  const origins = (Object.keys(ORIGIN_LABEL) as Origin[]).filter((o) => o === 'email' || o === 'manual' || items.some((i) => i.origin === o));
  return (
    <div className="filters">
      <h3>Categories</h3>
      {CATEGORIES.map((c) => <Tick key={c} tone={`cat-${c}`} label={CATEGORY_LABEL[c]} on={!filters.hiddenCategories.includes(c)} onChange={(on) => setFilters({ ...filters, hiddenCategories: toggle(filters.hiddenCategories, c, on) })} />)}
      {courses.length > 0 && <h3>Courses</h3>}
      {courses.map((c) => <Tick key={c} label={c} on={!filters.hiddenCourses.includes(c)} onChange={(on) => setFilters({ ...filters, hiddenCourses: toggle(filters.hiddenCourses, c, on) })} />)}
      <h3>Came from</h3>
      {origins.map((o) => <Tick key={o} label={ORIGIN_LABEL[o]} on={!filters.hiddenOrigins.includes(o)} onChange={(on) => setFilters({ ...filters, hiddenOrigins: toggle(filters.hiddenOrigins, o, on) })} />)}
      <h3>Priority</h3>
      {PRIORITIES.map((p) => <Tick key={p} label={p[0]!.toUpperCase() + p.slice(1)} on={!filters.hiddenPriorities.includes(p)} onChange={(on) => setFilters({ ...filters, hiddenPriorities: toggle(filters.hiddenPriorities, p, on) })} />)}
      <h3>Show</h3>
      <Tick label="Possible events" on={filters.showPossible} onChange={(on) => setFilters({ ...filters, showPossible: on })} />
      <Tick label="Done items" on={filters.showDone} onChange={(on) => setFilters({ ...filters, showDone: on })} />
    </div>
  );
}

interface SidebarProps {
  items: Item[]; filters: Filters; setFilters: (f: Filters) => void;
  reviewCount: number; onOpenReview: () => void;
  email: string | null; onSignOut: () => void; status: string;
}

export function Sidebar(p: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <button className="review-link" onClick={p.onOpenReview} disabled={!p.reviewCount}>
          <Tray />
          <span>Needs review</span>
          {p.reviewCount > 0 && <b>{p.reviewCount}</b>}
        </button>
        <FilterList items={p.items} filters={p.filters} setFilters={p.setFilters} />
      </div>
      <div className="sidebar-foot">
        <span>{p.status}</span>
        {p.email ? <button className="btn-text" onClick={p.onSignOut}>Sign out {p.email}</button> : <span>Sample data. Nothing is saved.</span>}
      </div>
    </aside>
  );
}

export function ReviewQueue({ items, mutate, onEdit, close }: { items: Item[]; mutate: (id: string, patch: Partial<Item>) => void; onEdit: (item: Item) => void; close: () => void }) {
  return (
    <div className="review">
      <header className="sheet-bar">
        <b>Needs review</b>
        <button className="btn-round" onClick={close} aria-label="Close"><Close /></button>
      </header>
      <p className="review-intro">These were found automatically but might be wrong. Nothing here is on your calendar until you accept it.</p>
      {!items.length && <div className="empty"><b>All clear</b><span>Uncertain items will wait here for you.</span></div>}
      {items.map((it) => (
        <article key={it.id} className={`review-card cat-${it.category}`}>
          <h2><i />{it.title}</h2>
          <p className="detail-when">{it.status === 'cancelled' ? 'Cancelled by a later email. ' : ''}{fullWhen(it)}</p>
          {it.summary && <p>{it.summary}</p>}
          <div className="review-actions">
            {it.status === 'cancelled' ? (
              <>
                <button className="btn is-fill" onClick={() => mutate(it.id, { status: 'dismissed', review_state: 'accepted' })}>Remove</button>
                <button className="btn" onClick={() => mutate(it.id, { status: 'open', review_state: 'accepted' })}>Keep it</button>
              </>
            ) : (
              <>
                <button className="btn is-fill" onClick={() => mutate(it.id, { review_state: 'accepted' })}>Accept</button>
                <button className="btn" onClick={() => onEdit(it)}>Edit</button>
                <button className="btn" onClick={() => mutate(it.id, { status: 'dismissed', review_state: 'accepted' })}>Dismiss</button>
              </>
            )}
            {it.confidence != null && it.status !== 'cancelled' && <span>{Math.round(it.confidence * 100)}% sure</span>}
          </div>
        </article>
      ))}
    </div>
  );
}

export function SignIn() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const send = async () => {
    if (!supabase || !email.includes('@')) return;
    setState('sending');
    setError('');
    // shouldCreateUser: false means only the account that already exists can sign in.
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: location.origin } });
    if (error) {
      setState('idle');
      setError(/not allowed|not found|signups/i.test(error.message) ? 'That address has no account here.' : /rate|seconds/i.test(error.message) ? 'Too many tries. Wait a minute, then send again.' : `The link could not be sent: ${error.message}`);
    } else setState('sent');
  };
  return (
    <main className="signin">
      <img src="/icon-192.png" alt="" width={72} height={72} />
      <h1>Planner</h1>
      {state === 'sent' ? (
        <>
          <p>Check {email} for a sign-in link. Open it on this device.</p>
          <button className="btn-text" onClick={() => setState('idle')}>Use a different address</button>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <p>Enter your email and we’ll send a link that signs you in. No password.</p>
          <input className="field" type="email" inputMode="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" required />
          {error && <p className="form-note">{error}</p>}
          <button className="btn is-fill btn-wide" type="submit" disabled={state === 'sending'}>{state === 'sending' ? 'Sending' : 'Email me a sign-in link'}</button>
        </form>
      )}
      <a className="btn-text" href="?demo">Look around with sample data</a>
    </main>
  );
}
