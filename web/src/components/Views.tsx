import { DateTime } from 'luxon';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dayKey, isAllDay, itemWhen, layoutDay, monthGrid, now, timeLabel } from '../lib/dates';
import type { Item } from '../lib/types';
import { Check } from './Icons';

const HOUR = 52; // px per hour on the time grid

interface Common {
  byDay: Map<string, Item[]>;
  onOpen: (item: Item) => void;
  onToggleDone: (item: Item) => void;
}

function TaskCircle({ item, onToggle }: { item: Item; onToggle: (i: Item) => void }) {
  return (
    <button
      className={`circle${item.status === 'done' ? ' is-on' : ''}`}
      aria-label={item.status === 'done' ? `Mark "${item.title}" not done` : `Mark "${item.title}" done`}
      onClick={(e) => { e.stopPropagation(); onToggle(item); }}
    >
      {item.status === 'done' && <Check size={12} />}
    </button>
  );
}

function cls(item: Item, base: string) {
  return `${base} cat-${item.category}${item.status === 'done' ? ' is-done' : ''}${item.status === 'cancelled' ? ' is-cancelled' : ''}${item.kind === 'task' ? ' is-task' : ''}${item.optional ? ' is-optional' : ''}${item.origin === 'plan' ? ' is-session' : ''}`;
}

/** Day and week views: an all-day strip above an hour grid. */
export function TimeGrid({ days, byDay, onOpen, onToggleDone, onCreate }: Common & { days: DateTime[]; onCreate: (at: DateTime) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  const today = dayKey(now());
  const single = days.length === 1;

  useLayoutEffect(() => {
    const n = now();
    scroller.current?.scrollTo({ top: Math.max(0, (n.hour + n.minute / 60 - 1.5) * HOUR) });
  }, [single]);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 60_000); // keep the "now" line moving
    return () => clearInterval(id);
  }, []);

  const n = now();
  const nowTop = (n.hour + n.minute / 60) * HOUR;

  return (
    <div className={`tg${single ? ' tg-single' : ''}`} style={{ ['--days' as string]: days.length }}>
      <div className="tg-head">
        <div className="tg-gutter" />
        {days.map((d) => {
          const k = dayKey(d);
          const allDay = (byDay.get(k) ?? []).filter(isAllDay);
          return (
            <div className="tg-dayhead" key={k}>
              {!single && (
                <div className={`tg-date${k === today ? ' is-today' : ''}`}>
                  <span>{d.toFormat('ccc')}</span>
                  <b>{d.day}</b>
                </div>
              )}
              <div className="tg-allday">
                {allDay.map((it) => (
                  <div key={it.id} className={cls(it, 'chip')} role="button" tabIndex={0} onClick={() => onOpen(it)} onKeyDown={(e) => e.key === 'Enter' && onOpen(it)}>
                    {it.kind === 'task' && <TaskCircle item={it} onToggle={onToggleDone} />}
                    <span>{it.title}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="tg-scroll" ref={scroller}>
        <div className="tg-body" style={{ height: 24 * HOUR }}>
          <div className="tg-gutter">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} style={{ top: (i + 1) * HOUR }}>{DateTime.fromObject({ hour: i + 1 }).toFormat('h a')}</span>
            ))}
          </div>
          {days.map((d) => {
            const k = dayKey(d);
            const placed = layoutDay(byDay.get(k) ?? []);
            return (
              <div
                className="tg-col"
                key={k}
                onDoubleClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                  const mins = Math.floor((y / HOUR) * 2) * 30; // snap to the half hour
                  onCreate(d.startOf('day').plus({ minutes: mins }));
                }}
              >
                {placed.map((p) => (
                  <div
                    key={p.item.id}
                    className={cls(p.item, 'block')}
                    role="button"
                    tabIndex={0}
                    style={{ top: (p.top / 60) * HOUR + 1, height: Math.max(22, (p.height / 60) * HOUR - 2), left: `calc(${(p.col / p.cols) * 100}% + 1px)`, width: `calc(${100 / p.cols}% - 3px)` }}
                    onClick={() => onOpen(p.item)}
                    onKeyDown={(e) => e.key === 'Enter' && onOpen(p.item)}
                  >
                    {p.item.kind === 'task' && <TaskCircle item={p.item} onToggle={onToggleDone} />}
                    <div className="block-text">
                      <b>{p.item.title}</b>
                      {p.height >= 45 && <span>{timeLabel(p.item)}{p.item.location ? `, ${p.item.location}` : ''}</span>}
                    </div>
                  </div>
                ))}
                {k === today && <div className="tg-now" style={{ top: nowTop }}><i /></div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function MonthView({ cursor, byDay, onOpen, onPickDay }: Common & { cursor: DateTime; onPickDay: (d: DateTime) => void }) {
  const days = monthGrid(cursor);
  const today = dayKey(now());
  return (
    <div className="month">
      <div className="month-head">
        {days.slice(0, 7).map((d) => <span key={d.weekday}>{d.toFormat('ccc')}</span>)}
      </div>
      <div className="month-grid">
        {days.map((d) => {
          const k = dayKey(d);
          const list = byDay.get(k) ?? [];
          return (
            <div key={k} className={`month-cell${d.month !== cursor.month ? ' is-out' : ''}${k === today ? ' is-today' : ''}`} onClick={() => onPickDay(d)}>
              <b className="month-num">{d.day === 1 ? d.toFormat('d LLL') : d.day}</b>
              <div className="month-items">
                {list.slice(0, 3).map((it) => (
                  <div key={it.id} className={cls(it, 'chip')} role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onOpen(it); }} onKeyDown={(e) => e.key === 'Enter' && onOpen(it)}>
                    <span>{it.title}</span>
                    {!isAllDay(it) && <time>{itemWhen(it)!.toFormat('h:mm')}</time>}
                  </div>
                ))}
                {list.length > 3 && <div className="month-more">{list.length - 3} more</div>}
              </div>
              <div className="month-dots" aria-hidden="true">
                {list.slice(0, 4).map((it) => <i key={it.id} className={`cat-${it.category}${it.optional ? ' is-optional' : ''}`} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ item, onOpen, onToggleDone }: { item: Item } & Pick<Common, 'onOpen' | 'onToggleDone'>) {
  return (
    <div className={cls(item, 'row')} role="button" tabIndex={0} onClick={() => onOpen(item)} onKeyDown={(e) => e.key === 'Enter' && onOpen(item)}>
      {item.kind === 'task' ? <TaskCircle item={item} onToggle={onToggleDone} /> : <i className="row-bar" />}
      <div className="row-main">
        <b>{item.title}</b>
        <span>{[timeLabel(item), item.course, item.location].filter(Boolean).join(', ')}</span>
      </div>
      {item.optional && <em className="row-tag">Possible</em>}
      {item.priority === 'high' && item.status === 'open' && !item.optional && <em className="row-flag">High</em>}
    </div>
  );
}

/** A running list: anything overdue, then each coming day, then things with no date. */
export function AgendaView({ items, byDay, onOpen, onToggleDone }: Common & { items: Item[] }) {
  const today = now().startOf('day');
  const overdue = items.filter((i) => i.kind === 'task' && i.status === 'open' && itemWhen(i) && itemWhen(i)! < today).sort((a, b) => itemWhen(a)!.toMillis() - itemWhen(b)!.toMillis());
  const undated = items.filter((i) => !itemWhen(i));
  const keys = [...byDay.keys()].filter((k) => k >= dayKey(today)).sort();
  const empty = !overdue.length && !undated.length && !keys.length;
  const label = (k: string) => {
    const d = DateTime.fromISO(k);
    const diff = Math.round(d.diff(today, 'days').days);
    return { lead: diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toFormat('cccc'), rest: d.toFormat('d LLLL') };
  };
  return (
    <div className="agenda">
      {empty && (
        <div className="empty">
          <b>Nothing coming up</b>
          <span>New items appear here as your email and courses are checked. Add one yourself with the + button.</span>
        </div>
      )}
      {overdue.length > 0 && (
        <section>
          <h2 className="is-overdue">Overdue</h2>
          <div className="group">{overdue.map((it) => <Row key={it.id} item={it} onOpen={onOpen} onToggleDone={onToggleDone} />)}</div>
        </section>
      )}
      {keys.map((k) => {
        const l = label(k);
        return (
          <section key={k}>
            <h2>{l.lead} <span>{l.rest}</span></h2>
            <div className="group">{byDay.get(k)!.map((it) => <Row key={it.id} item={it} onOpen={onOpen} onToggleDone={onToggleDone} />)}</div>
          </section>
        );
      })}
      {undated.length > 0 && (
        <section>
          <h2>No date</h2>
          <div className="group">{undated.map((it) => <Row key={it.id} item={it} onOpen={onOpen} onToggleDone={onToggleDone} />)}</div>
        </section>
      )}
    </div>
  );
}
