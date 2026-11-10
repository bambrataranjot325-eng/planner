import { DateTime } from 'luxon';
import type { Category, Item, Kind, Priority } from './types';

/* What the assistant may propose, and how a proposal becomes calendar rows. Pure functions, so the
   conversion from "Mon and Wed 9:30 until 11 Dec" to real events is tested, not left to the model. */

export interface ProposedAdd {
  title: string; kind: Kind;
  start_local?: string | null; end_local?: string | null; due_local?: string | null;
  location?: string | null; course?: string | null; category?: Category; priority?: Priority; notes?: string | null; timezone?: string | null;
  repeat?: { weekdays: number[]; until: string } | null;
}
export interface ProposedUpdate { id: string; title?: string; start_local?: string | null; end_local?: string | null; due_local?: string | null; location?: string | null; status?: 'open' | 'done'; notes?: string | null; course?: string | null; category?: Category; priority?: Priority }
export interface ClassBlock { label: string; days: number[]; start: string; end: string }
export interface Proposal { add: ProposedAdd[]; update: ProposedUpdate[]; remove: string[]; class_blocks: ClassBlock[] }
export interface ProposalState { applied_at?: string; batch_id?: string | null; undone_at?: string; added?: number; updated?: number; removed?: number; blocks?: number }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; attachments: string[]; proposal: Proposal | null; proposal_state: ProposalState | null; created_at: string }

export type NewRow = Pick<Item, 'title' | 'summary' | 'kind' | 'start_at' | 'end_at' | 'due_at' | 'all_day' | 'due_precision' | 'location' | 'course' | 'category' | 'priority' | 'timezone'>;

const MAX_REPEATS = 60;
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const iso = (d: DateTime) => d.toUTC().toISO({ suppressMilliseconds: true })!;
const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const validZone = (z: string | null | undefined) => (z && DateTime.local().setZone(z).isValid ? z : null);
function parse(local: string | null | undefined, zone: string): DateTime | null {
  if (!local) return null;
  const d = DateTime.fromISO(local, { zone });
  return d.isValid ? d : null;
}

/** The dates a weekly item falls on: its first day, then every listed weekday up to and including `until`. */
function occurrences(first: DateTime, repeat: ProposedAdd['repeat']): DateTime[] {
  if (!repeat || !repeat.weekdays?.length) return [first];
  const until = DateTime.fromISO(repeat.until, { zone: first.zone }).endOf('day');
  if (!until.isValid || until < first) return [first];
  const out: DateTime[] = [];
  for (let d = first.startOf('day'); d <= until && out.length < MAX_REPEATS; d = d.plus({ days: 1 })) {
    // Keep the wall-clock time on each date, so a 9:30 class stays at 9:30 across a clock change.
    if (repeat.weekdays.includes(d.weekday)) out.push(d.set({ hour: first.hour, minute: first.minute }));
  }
  return out.length ? out : [first];
}

/** One proposed addition as calendar rows: a single row, or one per week for a repeating class. */
export function expandAdd(a: ProposedAdd, deviceZone: string): NewRow[] {
  const zone = validZone(a.timezone) ?? deviceZone;
  const base = { title: a.title.trim().slice(0, 80), summary: a.notes?.trim() || null, kind: a.kind, location: a.location?.trim() || null, course: a.course?.trim() || null, category: a.category ?? 'other', priority: a.priority ?? 'medium', timezone: validZone(a.timezone) } as const;
  if (!base.title) return [];
  if (a.kind === 'event') {
    const startStr = a.start_local ?? a.due_local;
    const start = parse(startStr, zone);
    if (!start || !startStr) return []; // an event with no start cannot be placed
    const allDay = isDateOnly(startStr);
    const end = parse(a.end_local, zone);
    const minutes = end && end > start ? end.diff(start, 'minutes').minutes : null;
    return occurrences(allDay ? start.startOf('day') : start, a.repeat).map((s) => ({
      ...base, all_day: allDay, due_precision: null, due_at: null,
      start_at: iso(s), end_at: allDay ? null : minutes ? iso(s.plus({ minutes })) : iso(s.plus({ hours: 1 })),
    }));
  }
  const dueStr = a.due_local ?? a.start_local;
  const due = parse(dueStr, zone);
  if (!due || !dueStr) return [{ ...base, all_day: false, start_at: null, end_at: null, due_at: null, due_precision: null }];
  const dateOnly = isDateOnly(dueStr);
  return occurrences(dateOnly ? due.set({ hour: 23, minute: 59 }) : due, a.repeat).map((d) => ({ ...base, all_day: false, start_at: null, end_at: null, due_at: iso(d), due_precision: dateOnly ? 'date_only' : 'exact' }));
}

/** How a proposed addition reads on the card. */
export function describeAdd(a: ProposedAdd, deviceZone: string): string {
  const rows = expandAdd(a, deviceZone);
  if (!rows.length) return 'No date given, so it cannot be placed';
  const zone = validZone(a.timezone) ?? deviceZone;
  const first = rows[0]!;
  const whenIso = first.start_at ?? first.due_at;
  if (!whenIso) return 'No date';
  const s = DateTime.fromISO(whenIso, { zone: 'utc' }).setZone(zone);
  const dateOnly = first.all_day || first.due_precision === 'date_only';
  const time = dateOnly ? '' : first.end_at ? `${s.toFormat('h:mm a')} to ${DateTime.fromISO(first.end_at, { zone: 'utc' }).setZone(zone).toFormat('h:mm a')}` : s.toFormat('h:mm a');
  const tz = a.timezone && validZone(a.timezone) && a.timezone !== deviceZone ? ` (${a.timezone.split('/').pop()!.replace(/_/g, ' ')} time)` : '';
  const lead = a.kind === 'task' ? 'Due ' : '';
  if (rows.length > 1 && a.repeat) {
    const days = [...a.repeat.weekdays].sort().map((d) => DAY[d]).join(' and ');
    const last = DateTime.fromISO((rows[rows.length - 1]!.start_at ?? rows[rows.length - 1]!.due_at)!, { zone: 'utc' }).setZone(zone);
    return `${lead}${days}${time ? `, ${time}` : ''}${tz}, weekly from ${s.toFormat('d LLL')} to ${last.toFormat('d LLL')} (${rows.length} times)`;
  }
  return `${lead}${s.toFormat('ccc d LLL')}${time ? `, ${time}` : ''}${tz}`;
}

/** The fields to change on an existing item. Moving an event's start keeps its length unless a new end is given. */
export function updatePatch(u: ProposedUpdate, item: Item, deviceZone: string): Partial<Item> {
  const zone = validZone(item.timezone) ?? deviceZone;
  const patch: Partial<Item> = {};
  if (u.title?.trim()) patch.title = u.title.trim().slice(0, 80);
  if (u.location !== undefined) patch.location = u.location?.trim() || null;
  if (u.notes !== undefined) patch.summary = u.notes?.trim() || null;
  if (u.status) patch.status = u.status;
  if (u.course !== undefined) patch.course = u.course?.trim() || null;
  if (u.category) patch.category = u.category;
  if (u.priority) patch.priority = u.priority;
  const start = parse(u.start_local, zone), end = parse(u.end_local, zone), due = parse(u.due_local, zone);
  if (item.kind === 'event') {
    if (start) {
      patch.start_at = iso(start);
      patch.all_day = isDateOnly(u.start_local!);
      if (!end && item.start_at && item.end_at) patch.end_at = iso(start.plus({ milliseconds: Date.parse(item.end_at) - Date.parse(item.start_at) }));
    }
    if (end) patch.end_at = iso(end);
    // A work session's length is what its project counts, so keep the two in step.
    const newStart = patch.start_at ?? item.start_at, newEnd = patch.end_at ?? item.end_at;
    if (item.origin === 'plan' && newStart && newEnd && (patch.start_at || patch.end_at)) patch.planned_minutes = Math.max(5, Math.round((Date.parse(newEnd) - Date.parse(newStart)) / 60_000));
  } else {
    const d = due ?? start;
    const str = u.due_local ?? u.start_local;
    if (d && str) { patch.due_at = iso(isDateOnly(str) ? d.set({ hour: 23, minute: 59 }) : d); patch.due_precision = isDateOnly(str) ? 'date_only' : 'exact'; }
  }
  return patch;
}

export function describeUpdate(u: ProposedUpdate, item: Item, deviceZone: string): string {
  const p = updatePatch(u, item, deviceZone);
  const zone = validZone(item.timezone) ?? deviceZone;
  const parts: string[] = [];
  const when = p.start_at ?? p.due_at;
  if (when) parts.push(`${item.kind === 'task' ? 'due' : 'move to'} ${DateTime.fromISO(when, { zone: 'utc' }).setZone(zone).toFormat(p.all_day || p.due_precision === 'date_only' ? 'ccc d LLL' : 'ccc d LLL, h:mm a')}`);
  else if (p.end_at) {
    const delta = item.end_at ? Math.round((Date.parse(p.end_at) - Date.parse(item.end_at)) / 60_000) : 0;
    const by = delta ? ` (${Math.abs(delta) % 60 === 0 ? `${Math.abs(delta) / 60} hour${Math.abs(delta) === 60 ? '' : 's'}` : `${Math.abs(delta)} minutes`} ${delta > 0 ? 'longer' : 'shorter'})` : '';
    parts.push(`end at ${DateTime.fromISO(p.end_at, { zone: 'utc' }).setZone(zone).toFormat('h:mm a')}${by}`);
  }
  if (p.title) parts.push(`rename to "${p.title}"`);
  if (p.location !== undefined) parts.push(p.location ? `location: ${p.location}` : 'clear the location');
  if (p.status) parts.push(p.status === 'done' ? 'mark done' : 'reopen');
  if (p.priority) parts.push(`${p.priority} priority`);
  if (p.category) parts.push(`category: ${p.category}`);
  if (p.course !== undefined) parts.push(p.course ? `course: ${p.course}` : 'clear the course');
  if (p.summary !== undefined && !parts.length) parts.push('update the notes');
  const text = parts.join(', ') || 'no change';
  return text[0]!.toUpperCase() + text.slice(1);
}

export const describeBlock = (b: ClassBlock) => `${[...b.days].sort().map((d) => DAY[d]).join(', ')}, ${b.start} to ${b.end}`;
