import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import type { DataSource } from '../lib/data';
import { describeChange, fromInput, fromIso, fullWhen, isAllDay, toInput } from '../lib/dates';
import { CATEGORIES, CATEGORY_LABEL, ORIGIN_LABEL, PRIORITIES, type AuditEntry, type Category, type Item, type ItemDraft, type Kind, type Priority, type SourceInfo } from '../lib/types';
import { Check, Close } from './Icons';

interface FormState {
  title: string; kind: Kind; allDay: boolean; start: string; end: string; due: string;
  location: string; course: string; category: Category; priority: Priority; summary: string; link: string;
}

function toForm(item: Item | null, at: DateTime): FormState {
  if (!item) {
    const s = at.toFormat("yyyy-LL-dd'T'HH:mm");
    return { title: '', kind: 'event', allDay: false, start: s, end: at.plus({ hours: 1 }).toFormat("yyyy-LL-dd'T'HH:mm"), due: s, location: '', course: '', category: 'personal', priority: 'medium', summary: '', link: '' };
  }
  const allDay = isAllDay(item);
  return {
    title: item.title, kind: item.kind, allDay,
    start: toInput(item.start_at, allDay), end: toInput(item.end_at, allDay), due: toInput(item.due_at, allDay),
    location: item.location ?? '', course: item.course ?? '', category: item.category, priority: item.priority, summary: item.summary ?? '', link: item.link ?? '',
  };
}

function toDraft(f: FormState): ItemDraft {
  const event = f.kind === 'event';
  return {
    title: f.title.trim().slice(0, 80),
    kind: f.kind,
    all_day: event && f.allDay,
    start_at: event ? fromInput(f.start, f.allDay ? 'start' : undefined) : null,
    end_at: event ? fromInput(f.end, f.allDay ? 'end' : undefined) : null,
    due_at: event ? null : fromInput(f.due, f.allDay ? 'end' : undefined),
    due_precision: event || !f.due ? null : f.allDay ? 'date_only' : 'exact',
    location: f.location.trim() || null,
    course: f.course.trim() || null,
    category: f.category,
    priority: f.priority,
    summary: f.summary.trim() || null,
    link: f.link.trim() || null,
  };
}

export function ItemEditor({ item, at, onSave, onCancel }: { item: Item | null; at: DateTime; onSave: (changes: Partial<ItemDraft>, full: ItemDraft) => void; onCancel: () => void }) {
  const initial = useMemo(() => toForm(item, at), [item, at]);
  const [f, setF] = useState(initial);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const draft = toDraft(f);
  const problem = !draft.title ? 'Give it a title' : draft.kind === 'event' && !draft.start_at ? 'Choose when it starts' : draft.start_at && draft.end_at && draft.end_at < draft.start_at ? 'It ends before it starts' : null;
  const dateType = f.allDay ? 'date' : 'datetime-local';
  // Switching between a date and a date-time input keeps the day that was chosen.
  const flipAllDay = (on: boolean) => setF((p) => {
    const conv = (v: string) => (!v ? v : on ? v.slice(0, 10) : `${v.slice(0, 10)}T09:00`);
    return { ...p, allDay: on, start: conv(p.start), end: on ? conv(p.end) : p.end ? `${p.end.slice(0, 10)}T10:00` : '', due: on ? conv(p.due) : p.due ? `${p.due.slice(0, 10)}T17:00` : '' };
  });

  const submit = () => {
    if (problem) return;
    // Send only what changed, so untouched AI-filled fields are not marked as edited by me.
    const before = toDraft(initial) as unknown as Record<string, unknown>;
    const after = draft as unknown as Record<string, unknown>;
    const changes = Object.fromEntries(Object.entries(after).filter(([k, v]) => v !== before[k])) as Partial<ItemDraft>;
    onSave(changes, draft);
  };

  return (
    <form className="editor" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <header className="sheet-bar">
        <button type="button" className="btn-text" onClick={onCancel}>Cancel</button>
        <b>{item ? 'Edit' : 'New'}</b>
        <button type="submit" className="btn-text is-strong" disabled={!!problem}>{item ? 'Save' : 'Add'}</button>
      </header>

      <div className="seg" role="tablist" aria-label="Kind">
        {(['event', 'task'] as Kind[]).map((k) => (
          <button type="button" key={k} role="tab" aria-selected={f.kind === k} className={f.kind === k ? 'is-on' : ''} onClick={() => set('kind', k)}>{k === 'event' ? 'Event' : 'Task'}</button>
        ))}
      </div>

      <div className="group">
        <input className="field field-title" placeholder="Title" value={f.title} maxLength={80} autoFocus={!item} onChange={(e) => set('title', e.target.value)} aria-label="Title" />
        <input className="field" placeholder="Location" value={f.location} onChange={(e) => set('location', e.target.value)} aria-label="Location" />
      </div>

      <div className="group">
        <label className="field-row">
          <span>{f.kind === 'event' ? 'All day' : 'No set time'}</span>
          <input type="checkbox" className="switch" checked={f.allDay} onChange={(e) => flipAllDay(e.target.checked)} />
        </label>
        {f.kind === 'event' ? (
          <>
            <label className="field-row"><span>Starts</span><input type={dateType} value={f.start} onChange={(e) => set('start', e.target.value)} /></label>
            <label className="field-row"><span>Ends</span><input type={dateType} value={f.end} min={f.start} onChange={(e) => set('end', e.target.value)} /></label>
          </>
        ) : (
          <label className="field-row"><span>Due</span><input type={dateType} value={f.due} onChange={(e) => set('due', e.target.value)} /></label>
        )}
      </div>

      <div className="group">
        <label className="field-row"><span>Category</span>
          <select value={f.category} onChange={(e) => set('category', e.target.value as Category)}>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>
        </label>
        <label className="field-row"><span>Priority</span>
          <select value={f.priority} onChange={(e) => set('priority', e.target.value as Priority)}>{PRIORITIES.map((p) => <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>)}</select>
        </label>
        <label className="field-row"><span>Course</span><input type="text" placeholder="None" value={f.course} onChange={(e) => set('course', e.target.value)} /></label>
      </div>

      <div className="group">
        <textarea className="field" placeholder="Notes" rows={3} value={f.summary} onChange={(e) => set('summary', e.target.value)} aria-label="Notes" />
        <input className="field" type="url" placeholder="Link" value={f.link} onChange={(e) => set('link', e.target.value)} aria-label="Link" />
      </div>
      {problem && f.title !== initial.title && <p className="form-note">{problem}</p>}
    </form>
  );
}

const FIELD_NAME: Record<string, string> = { title: 'Title', summary: 'Notes', start_at: 'Start', end_at: 'End', due_at: 'Due date', location: 'Location', course: 'Course', priority: 'Priority', category: 'Category', kind: 'Kind', all_day: 'All day', due_precision: 'Time', description: 'Description', timezone: 'Timezone' };

function showValue(field: string, v: unknown): string {
  if (v == null || v === '') return 'nothing';
  if (field.endsWith('_at') && typeof v === 'string') return fromIso(v).toFormat('ccc d LLL, h:mm a');
  return String(v);
}

interface DetailProps {
  item: Item;
  data: DataSource;
  mutate: (id: string, patch: Partial<Item>) => void;
  onDelete: (item: Item) => void;
  onEdit: () => void;
  close: () => void;
}

export function ItemDetail({ item, data, mutate, onDelete, onEdit, close }: DetailProps) {
  const [history, setHistory] = useState<AuditEntry[] | null>(null);
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let live = true;
    data.history(item.id).then((h) => live && setHistory(h)).catch(() => live && setHistory([]));
    data.sources(item.id).then((s) => live && setSources(s)).catch(() => live && setSources([]));
    return () => { live = false; };
  }, [data, item.id, item.updated_at]);

  const done = item.status === 'done';
  const edited = item.overridden_fields.filter((f) => f in item.ai_values && item.ai_values[f] !== (item as unknown as Record<string, unknown>)[f]);
  const lines = (history ?? []).flatMap((h) => {
    const who = h.actor === 'user' ? 'You' : 'Automatic';
    if (h.action === 'insert') return [{ key: `${h.id}`, text: h.actor === 'user' ? 'You added this' : `Created from ${ORIGIN_LABEL[item.origin].toLowerCase()}`, at: h.at }];
    return Object.entries(h.changes).map(([f, c]) => ({ f, text: describeChange(f, c.old, c.new) })).filter((x) => x.text).map((x) => ({ key: `${h.id}-${x.f}`, text: `${x.text} (${who.toLowerCase()})`, at: h.at }));
  });

  return (
    <div className={`detail cat-${item.category}`}>
      <header className="sheet-bar">
        <span className="detail-cat"><i />{CATEGORY_LABEL[item.category]}{item.course ? `, ${item.course}` : ''}</span>
        <button className="btn-round" onClick={close} aria-label="Close"><Close /></button>
      </header>

      <h1 className={done ? 'is-done' : ''}>{item.title}</h1>
      <p className="detail-when">{fullWhen(item)}</p>
      {item.location && <p className="detail-where">{item.location}</p>}

      {item.review_state === 'needs_review' && item.status !== 'cancelled' && (
        <div className="notice">
          <b>Check this one</b>
          <span>It was found automatically and may be wrong{item.confidence != null ? ` (${Math.round(item.confidence * 100)}% sure)` : ''}. It stays off your calendar until you accept it.</span>
          <div><button className="btn is-fill" onClick={() => { mutate(item.id, { review_state: 'accepted' }); close(); }}>Accept</button><button className="btn" onClick={() => { mutate(item.id, { status: 'dismissed', review_state: 'accepted' }); close(); }}>Dismiss</button></div>
        </div>
      )}
      {item.optional && item.review_state === 'accepted' && item.status === 'open' && (
        <div className="notice is-quiet">
          <b>Possible</b>
          <span>This is something you could {item.kind === 'event' ? 'go to' : 'do'}, found in a newsletter or announcement. It isn't a commitment.</span>
          <div><button className="btn is-fill" onClick={() => mutate(item.id, { optional: false })}>{item.kind === 'event' ? 'I’m going' : 'I’ll do it'}</button><button className="btn" onClick={() => { mutate(item.id, { status: 'dismissed' }); close(); }}>Not interested</button></div>
        </div>
      )}
      {item.status === 'cancelled' && (
        <div className="notice">
          <b>This was cancelled</b>
          <span>A later email said it is off. Remove it from your calendar?</span>
          <div><button className="btn is-fill" onClick={() => { mutate(item.id, { status: 'dismissed', review_state: 'accepted' }); close(); }}>Remove</button><button className="btn" onClick={() => mutate(item.id, { status: 'open', review_state: 'accepted' })}>Keep it</button></div>
        </div>
      )}

      {item.summary && <p className="detail-summary">{item.summary}</p>}

      {item.status !== 'cancelled' && !item.optional && (
        <button className={`btn btn-wide${done || item.kind === 'event' ? '' : ' is-fill'}`} onClick={() => mutate(item.id, { status: done ? 'open' : 'done' })}>
          {done ? 'Mark as not done' : <><Check size={16} /> Mark as done</>}
        </button>
      )}

      <div className="group">
        <div className="field-row"><span>Priority</span><em>{item.priority[0]!.toUpperCase() + item.priority.slice(1)}{item.priority_reason ? `, ${item.priority_reason.toLowerCase()}` : ''}</em></div>
        <div className="field-row"><span>Came from</span><em>{ORIGIN_LABEL[item.origin]}</em></div>
        {item.link && <a className="field-row is-link" href={item.link} target="_blank" rel="noreferrer"><span>{item.origin === 'email' ? 'Open the email' : 'Open link'}</span></a>}
      </div>

      {edited.length > 0 && (
        <section>
          <h2>Edited by you</h2>
          <div className="group">
            {edited.map((f) => (
              <div className="field-row" key={f}>
                <span>{FIELD_NAME[f] ?? f}<small>Automatic value: {showValue(f, item.ai_values[f])}</small></span>
                <button className="btn-text" onClick={() => mutate(item.id, { [f]: item.ai_values[f], overridden_fields: item.overridden_fields.filter((x) => x !== f) } as Partial<Item>)}>Revert</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {sources && sources.length > 0 && (
        <section>
          <h2>Why this was created</h2>
          <div className="group">
            {sources.map((s, i) => (
              <div className="field-row is-stack" key={i}>
                <span>{s.subject ?? ORIGIN_LABEL[s.source_type]}</span>
                <small>{[s.sender?.replace(/<[^>]+>/, '').trim(), s.received_at && fromIso(s.received_at).toFormat('d LLL, h:mm a')].filter(Boolean).join(', ')}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      {lines.length > 0 && (
        <section>
          <h2>History</h2>
          <ul className="history">{lines.map((l) => <li key={l.key}><span>{l.text}</span><time>{fromIso(l.at).toFormat('d LLL, h:mm a')}</time></li>)}</ul>
        </section>
      )}

      <footer className="detail-foot">
        {confirming ? (
          <>
            <span>Move to Trash? It stays there for 30 days.</span>
            <button className="btn is-danger" onClick={() => { onDelete(item); close(); }}>Move to Trash</button>
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onEdit}>Edit</button>
            <button className="btn is-danger-text" onClick={() => setConfirming(true)}>Delete</button>
          </>
        )}
      </footer>
    </div>
  );
}
