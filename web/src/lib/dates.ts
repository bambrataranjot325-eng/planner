import { DateTime } from 'luxon';
import type { Filters, Item } from './types';

export const zone = () => DateTime.local().zoneName;
export const now = () => DateTime.local();
export const fromIso = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).toLocal();

/** The instant an item sits at on the calendar: an event's start or a task's deadline. */
export function itemWhen(item: Pick<Item, 'start_at' | 'due_at'>): DateTime | null {
  const iso = item.start_at ?? item.due_at;
  return iso ? fromIso(iso) : null;
}

/** Shown in the all-day strip instead of on the hour grid. */
export function isAllDay(item: Pick<Item, 'kind' | 'all_day' | 'due_precision'>): boolean {
  if (item.kind === 'event') return item.all_day;
  return item.due_precision === 'date_only' || item.due_precision === 'approximate';
}

export function startOfWeek(d: DateTime): DateTime {
  return d.startOf('day').minus({ days: d.weekday % 7 }); // weeks start on Sunday, as in Apple Calendar's default
}

export function weekDays(d: DateTime): DateTime[] {
  const s = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => s.plus({ days: i }));
}

/** Six rows of seven days covering the month that contains `d`. */
export function monthGrid(d: DateTime): DateTime[] {
  const first = startOfWeek(d.startOf('month'));
  return Array.from({ length: 42 }, (_, i) => first.plus({ days: i }));
}

export const dayKey = (d: DateTime) => d.toFormat('yyyy-LL-dd');

export function matchesFilters(item: Item, f: Filters): boolean {
  if (item.deleted_at) return false;
  if (item.review_state === 'needs_review') return false; // lives in the review queue until accepted
  if (item.status === 'dismissed') return false;
  if (!f.showDone && item.status === 'done') return false;
  if (!f.showPossible && item.optional) return false;
  if (f.hiddenOrigins.includes(item.origin)) return false;
  if (f.hiddenCategories.includes(item.category)) return false;
  if (f.hiddenPriorities.includes(item.priority)) return false;
  if (item.course && f.hiddenCourses.includes(item.course)) return false;
  return true;
}

/** Items grouped by local day, each day sorted: all-day first, then by time. */
export function groupByDay(items: Item[]): Map<string, Item[]> {
  const map = new Map<string, Item[]>();
  for (const it of items) {
    const w = itemWhen(it);
    if (!w) continue;
    const k = dayKey(w);
    map.set(k, [...(map.get(k) ?? []), it]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => Number(isAllDay(b)) - Number(isAllDay(a)) || itemWhen(a)!.toMillis() - itemWhen(b)!.toMillis());
  }
  return map;
}

export interface Placed {
  item: Item;
  top: number; // minutes from midnight
  height: number; // minutes
  col: number;
  cols: number;
}

/** Lay out one day's timed items side by side when they overlap, like a calendar's day column. */
export function layoutDay(items: Item[]): Placed[] {
  const blocks = items
    .filter((i) => !isAllDay(i) && itemWhen(i))
    .map((item) => {
      const start = itemWhen(item)!;
      const top = start.hour * 60 + start.minute;
      let minutes = 30; // a task is a half-hour marker ending at its deadline
      if (item.kind === 'event' && item.end_at) minutes = Math.max(20, fromIso(item.end_at).diff(start, 'minutes').minutes);
      else if (item.kind === 'event') minutes = 60;
      const t = item.kind === 'task' ? Math.max(0, top - 30) : top;
      return { item, top: t, height: Math.min(minutes, 24 * 60 - t), col: 0, cols: 1 };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);

  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(0, ...cluster.map((b) => b.col)) + 1;
    for (const b of cluster) b.cols = cols;
    cluster = [];
  };
  for (const b of blocks) {
    if (cluster.length && b.top >= clusterEnd) flush();
    const taken = new Set(cluster.filter((o) => o.top + o.height > b.top).map((o) => o.col));
    let col = 0;
    while (taken.has(col)) col++;
    b.col = col;
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.top + b.height);
  }
  if (cluster.length) flush();
  return blocks;
}

export function timeLabel(item: Item): string {
  const w = itemWhen(item);
  if (!w) return 'No date';
  if (isAllDay(item)) return item.kind === 'event' ? 'All day' : item.due_precision === 'approximate' ? 'Due around this day' : 'Due this day';
  const t = w.toFormat('h:mm a');
  if (item.kind === 'task') return `Due ${t}`;
  return item.end_at ? `${t} to ${fromIso(item.end_at).toFormat('h:mm a')}` : t;
}

/** "Sat 14 Nov, 7:00 PM", plus the event's own local time when it happens in another timezone. */
export function fullWhen(item: Item): string {
  const w = itemWhen(item);
  if (!w) return 'No date set';
  const day = w.toFormat('cccc d LLLL yyyy');
  if (isAllDay(item)) return `${item.kind === 'task' ? 'Due ' : ''}${day}${item.due_precision === 'approximate' ? ' (approximate)' : ''}`;
  let out = `${item.kind === 'task' ? 'Due ' : ''}${day} at ${w.toFormat('h:mm a')}`;
  if (item.kind === 'event' && item.end_at) out += ` to ${fromIso(item.end_at).toFormat('h:mm a')}`;
  if (item.timezone && item.timezone !== zone()) {
    const there = DateTime.fromISO(item.start_at ?? item.due_at!, { zone: 'utc' }).setZone(item.timezone);
    out += ` (${there.toFormat('h:mm a')} ${item.timezone.split('/').pop()!.replace(/_/g, ' ')} time)`;
  }
  return out;
}

/** For <input type="datetime-local"> and <input type="date">. */
export const toInput = (iso: string | null, dateOnly: boolean) => (iso ? fromIso(iso).toFormat(dateOnly ? 'yyyy-LL-dd' : "yyyy-LL-dd'T'HH:mm") : '');
export function fromInput(value: string, dateOnlyAs?: 'start' | 'end'): string | null {
  if (!value) return null;
  let dt = DateTime.fromISO(value, { zone: zone() });
  if (!dt.isValid) return null;
  if (dateOnlyAs === 'end') dt = dt.set({ hour: 23, minute: 59 });
  return dt.toUTC().toISO({ suppressMilliseconds: true });
}

/** One audit-log change as a sentence, e.g. "Due date moved from Fri 14 Nov to Mon 17 Nov". */
export function describeChange(field: string, oldV: unknown, newV: unknown): string | null {
  const date = (v: unknown) => (typeof v === 'string' ? fromIso(v).toFormat('ccc d LLL, h:mm a') : 'none');
  const names: Record<string, string> = { start_at: 'Start', end_at: 'End', due_at: 'Due date' };
  if (field in names) return `${names[field]} moved from ${date(oldV)} to ${date(newV)}`;
  if (field === 'status') return `Marked ${String(newV)}`;
  if (field === 'review_state') return newV === 'accepted' ? 'Accepted from review' : 'Sent to review';
  if (field === 'deleted_at') return newV ? 'Moved to Trash' : 'Restored from Trash';
  if (field === 'title') return `Renamed from "${String(oldV)}"`;
  if (['overridden_fields', 'confidence', 'priority_reason', 'ai_values'].includes(field)) return null;
  return `${field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())} changed`;
}
