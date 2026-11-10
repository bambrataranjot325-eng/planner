import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describeAdd, describeBlock, describeUpdate, expandAdd, updatePatch, type ChatMessage, type Proposal, type ProposalState } from '../lib/assistant';
import type { Attachment, DataSource } from '../lib/data';
import { zone } from '../lib/dates';
import type { Profile } from '../lib/planner';
import type { Item } from '../lib/types';
import { ArrowUp, Check, Close, Paperclip } from './Icons';

interface Shared { items: Item[]; profile: Profile; data: DataSource; reload: () => Promise<void>; say: (t: { text: string }) => void }
const MAX_BYTES = 4_500_000;
const SUGGESTIONS = ['Dentist on Thursday at 3pm', 'What is due this week?', 'Move my next meeting to Friday at 10'];

function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, media_type: file.type, data: String(r.result).split(',')[1] ?? '' });
    r.onerror = () => reject(new Error('could not read the file'));
    r.readAsDataURL(file);
  });
}

/** One proposal from the assistant: tick what you want, then apply. Nothing changes until you do. */
function ProposalCard({ message, shared, onState }: { message: ChatMessage; shared: Shared; onState: (id: string, s: ProposalState) => void }) {
  const p = message.proposal as Proposal;
  const st = message.proposal_state;
  const z = zone();
  const keys = [...p.add.map((_, i) => `a${i}`), ...p.update.map((_, i) => `u${i}`), ...p.remove.map((_, i) => `r${i}`), ...p.class_blocks.map((_, i) => `b${i}`)];
  const [on, setOn] = useState<Set<string>>(() => new Set(keys.filter((k) => !(k[0] === 'a' && !expandAdd(p.add[Number(k.slice(1))]!, z).length))));
  const [busy, setBusy] = useState(false);
  const toggle = (k: string) => setOn((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const find = (id: string) => shared.items.find((i) => i.id === id);
  const done = !!st?.applied_at;

  const apply = async () => {
    setBusy(true);
    try {
      const batch = crypto.randomUUID();
      const rows = p.add.filter((_, i) => on.has(`a${i}`)).flatMap((a) => expandAdd(a, z)).slice(0, 400);
      await shared.data.addItems(rows, batch);
      let updated = 0, removed = 0;
      for (const [i, u] of p.update.entries()) { const it = find(u.id); if (on.has(`u${i}`) && it) { const patch = updatePatch(u, it, z); if (Object.keys(patch).length) { await shared.data.update(u.id, patch); updated++; } } }
      for (const [i, id] of p.remove.entries()) if (on.has(`r${i}`) && find(id)) { await shared.data.update(id, { deleted_at: new Date().toISOString() }); removed++; }
      const blocks = p.class_blocks.filter((b, i) => on.has(`b${i}`) && !shared.profile.blocks.some((x) => x.label === b.label && x.start === b.start && x.days.join() === b.days.join()));
      if (blocks.length) await shared.data.saveProfile({ ...shared.profile, blocks: [...shared.profile.blocks, ...blocks] });
      const state: ProposalState = { applied_at: new Date().toISOString(), batch_id: rows.length ? batch : null, added: rows.length, updated, removed, blocks: blocks.length };
      await shared.data.chatSetState(message.id, state);
      onState(message.id, state);
      await shared.reload();
    } catch (e) { shared.say({ text: `That could not be applied: ${(e as Error).message}` }); }
    setBusy(false);
  };
  const undo = async () => {
    if (!st?.batch_id) return;
    setBusy(true);
    try {
      await shared.data.undoBatch(st.batch_id);
      const state = { ...st, undone_at: new Date().toISOString() };
      await shared.data.chatSetState(message.id, state);
      onState(message.id, state);
      await shared.reload();
    } catch (e) { shared.say({ text: `Undo failed: ${(e as Error).message}` }); }
    setBusy(false);
  };

  const Row = ({ k, title, sub, tone }: { k: string; title: string; sub: string; tone?: string }) => (
    <button type="button" className={`field-row pick ${tone ?? ''}${on.has(k) ? ' is-on' : ''}`} role="checkbox" aria-checked={on.has(k)} disabled={done} onClick={() => toggle(k)}>
      <i>{on.has(k) && <Check size={11} />}</i>
      <span>{title}<small>{sub}</small></span>
    </button>
  );
  const count = on.size;
  const summary = st ? [st.added && `${st.added} added`, st.updated && `${st.updated} changed`, st.removed && `${st.removed} moved to Trash`, st.blocks && `${st.blocks} class time${st.blocks === 1 ? '' : 's'} saved`].filter(Boolean).join(', ') : '';

  return (
    <div className="proposal">
      <div className="group">
        {p.add.map((a, i) => <Row key={`a${i}`} k={`a${i}`} tone={`cat-${a.category ?? 'other'}`} title={a.title} sub={[describeAdd(a, z), a.location, a.course].filter(Boolean).join(', ')} />)}
        {p.update.map((u, i) => { const it = find(u.id); return it ? <Row key={`u${i}`} k={`u${i}`} tone={`cat-${it.category}`} title={it.title} sub={`Change: ${describeUpdate(u, it, z)}`} /> : null; })}
        {p.remove.map((id, i) => { const it = find(id); return it ? <Row key={`r${i}`} k={`r${i}`} tone="is-remove" title={it.title} sub="Move to Trash" /> : null; })}
        {p.class_blocks.map((b, i) => <Row key={`b${i}`} k={`b${i}`} tone="is-session" title={b.label} sub={`Keep project work clear of this: ${describeBlock(b)}`} />)}
      </div>
      {done ? (
        <div className="proposal-foot">
          <span>{st!.undone_at ? 'Undone. The added items are in Trash.' : summary || 'Applied.'}</span>
          {!st!.undone_at && st!.batch_id && <button className="btn-text" disabled={busy} onClick={() => void undo()}>Undo additions</button>}
        </div>
      ) : (
        <button className="btn is-fill btn-wide" disabled={busy || !count} onClick={() => void apply()}>{busy ? 'Applying' : count ? `Apply ${count} ${count === 1 ? 'change' : 'changes'}` : 'Nothing selected'}</button>
      )}
    </div>
  );
}

export function Assistant({ shared, close }: { shared: Shared; close: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => { shared.data.chat().then(setMessages, () => { setMessages([]); setError('The conversation could not be loaded. Has 0008_assistant.sql been run?'); }); }, [shared.data]);
  useLayoutEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages, sending]);

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    setError('');
    const next = [...files];
    for (const f of [...list]) {
      if (!(f.type === 'application/pdf' || f.type.startsWith('image/'))) { setError(`${f.name} is not a PDF or an image.`); continue; }
      if (next.reduce((s, x) => s + x.data.length * 0.75, 0) + f.size > MAX_BYTES) { setError('Attachments are limited to about 4.5 MB in total. Try a smaller file or fewer pages.'); continue; }
      if (next.length >= 3) { setError('Up to three files at a time.'); break; }
      next.push(await readFile(f));
    }
    setFiles(next);
    if (picker.current) picker.current.value = '';
  };

  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    if ((!body && !files.length) || sending) return;
    const mine: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: body, attachments: files.map((f) => f.name), proposal: null, proposal_state: null, created_at: new Date().toISOString() };
    const sentFiles = files;
    setMessages((m) => [...(m ?? []), mine]);
    setText(''); setFiles([]); setError(''); setSending(true);
    try {
      const reply = await shared.data.chatSend(body, sentFiles);
      setMessages((m) => [...(m ?? []), reply]);
    } catch (e) {
      setMessages((m) => (m ?? []).filter((x) => x.id !== mine.id)); // put the unsent message back in the box
      setText(body); setFiles(sentFiles);
      setError(`That did not go through: ${(e as Error).message}`);
    }
    setSending(false);
  };
  const setState = (id: string, s: ProposalState) => setMessages((m) => (m ?? []).map((x) => (x.id === id ? { ...x, proposal_state: s } : x)));

  return (
    <div className="chat">
      <header className="sheet-bar">
        <b>Assistant</b>
        <span className="chat-tools">
          {!!messages?.length && <button className="btn-text" onClick={() => { if (confirm('Clear this conversation? Calendar items it added are kept.')) void shared.data.chatClear().then(() => setMessages([])); }}>Clear</button>}
          <button className="btn-round" onClick={close} aria-label="Close"><Close /></button>
        </span>
      </header>

      <div className="chat-log">
        {messages && !messages.length && (
          <div className="chat-empty">
            <b>Tell me what to put on your calendar</b>
            <span>Describe it in your own words, or attach a timetable, syllabus or exam schedule as a PDF or photo. You approve everything before it is added.</span>
            <div>{SUGGESTIONS.map((s) => <button key={s} className="btn" onClick={() => void send(s)}>{s}</button>)}</div>
          </div>
        )}
        {(messages ?? []).map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {(m.content || m.attachments.length > 0) && (
              <div className="bubble">
                {m.attachments.map((n) => <span className="file-chip" key={n}><Paperclip />{n}</span>)}
                {m.content}
              </div>
            )}
            {m.proposal && <ProposalCard message={m} shared={shared} onState={setState} />}
          </div>
        ))}
        {sending && <div className="msg msg-assistant"><div className="bubble is-thinking" aria-label="Thinking"><i /><i /><i /></div></div>}
        <div ref={end} />
      </div>

      <div className="composer">
        {error && <p className="form-note">{error}</p>}
        {files.length > 0 && <div className="composer-files">{files.map((f, i) => <span className="file-chip" key={i}><Paperclip />{f.name}<button onClick={() => setFiles(files.filter((_, k) => k !== i))} aria-label={`Remove ${f.name}`}><Close /></button></span>)}</div>}
        <div className="composer-row">
          <input ref={picker} type="file" accept="application/pdf,image/*" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
          <button className="btn-icon" onClick={() => picker.current?.click()} aria-label="Attach a PDF or photo"><Paperclip /></button>
          <textarea rows={1} placeholder="Message" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <button className="btn-icon is-accent" disabled={sending || (!text.trim() && !files.length)} onClick={() => void send()} aria-label="Send"><ArrowUp /></button>
        </div>
      </div>
    </div>
  );
}
