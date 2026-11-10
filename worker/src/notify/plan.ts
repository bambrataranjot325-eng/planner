import { DateTime } from 'luxon';

/* Which notifications are due right now. Pure, so the timing rules are tested. */

export interface NotifyItem {
  id: string; title: string; kind: 'event' | 'task';
  start_at: string | null; end_at: string | null; due_at: string | null;
  all_day: boolean; due_precision: string | null; location: string | null;
  status: string; optional: boolean; timezone: string | null;
}
export interface NotifySettings { timezone: string; remind_minutes: number; daily_summary_time: string | null }
export interface Note { key: string; title: string; body: string; url: string; tag: string }

const fmtTime = (iso: string, zone: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone).toFormat('h:mm a');

/**
 * A reminder for each timed commitment that starts (or falls due) within the reminder window.
 * The key includes the time, so if something is rescheduled it is reminded again at its new time.
 * "Possible" items are not commitments and never remind.
 */
export function reminderNotes(items: NotifyItem[], s: NotifySettings, now: Date): Note[] {
  if (s.remind_minutes <= 0) return [];
  const t = now.getTime(), windowMs = s.remind_minutes * 60_000;
  const out: Note[] = [];
  for (const it of items) {
    if (it.status !== 'open' || it.optional) continue;
    const timedEvent = it.kind === 'event' && !it.all_day && it.start_at;
    const timedTask = it.kind === 'task' && it.due_precision === 'exact' && it.due_at;
    const when = timedEvent ? it.start_at! : timedTask ? it.due_at! : null;
    if (!when) continue;
    const at = Date.parse(when);
    if (!(t >= at - windowMs && t < at)) continue;
    const mins = Math.max(1, Math.round((at - t) / 60_000));
    const lead = mins >= 60 ? `in ${Math.round(mins / 6) / 10} hours` : `in ${mins} minute${mins === 1 ? '' : 's'}`;
    const body = timedEvent
      ? `Starts ${lead}, at ${fmtTime(when, s.timezone)}${it.location ? `. ${it.location}` : ''}`
      : `Due ${lead}, at ${fmtTime(when, s.timezone)}`;
    out.push({ key: `rem:${it.id}:${when}`, title: it.title, body, url: `/?item=${it.id}`, tag: `item-${it.id}` });
  }
  return out;
}

/**
 * The morning summary: sent once per local day, at or after the chosen time (within three hours,
 * so a worker that was down overnight does not send "good morning" at 4 PM).
 */
export function dailyNote(items: NotifyItem[], s: NotifySettings, now: Date): Note | null {
  if (!s.daily_summary_time || !/^\d{2}:\d{2}$/.test(s.daily_summary_time)) return null;
  const local = DateTime.fromJSDate(now, { zone: s.timezone });
  if (!local.isValid) return null;
  const [h, m] = s.daily_summary_time.split(':').map(Number);
  const at = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (local < at || local > at.plus({ hours: 3 })) return null;
  const dayStart = local.startOf('day').toMillis(), dayEnd = local.endOf('day').toMillis();
  const open = items.filter((i) => i.status === 'open' && !i.optional);
  const inToday = (iso: string | null) => !!iso && Date.parse(iso) >= dayStart && Date.parse(iso) <= dayEnd;
  const events = open.filter((i) => i.kind === 'event' && inToday(i.start_at)).sort((a, b) => a.start_at!.localeCompare(b.start_at!));
  const due = open.filter((i) => i.kind === 'task' && inToday(i.due_at));
  const overdue = open.filter((i) => i.kind === 'task' && i.due_at && Date.parse(i.due_at) < dayStart);
  if (!events.length && !due.length && !overdue.length) return null; // an empty day needs no notification
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const parts: string[] = [];
  const head = [events.length && n(events.length, 'event'), due.length && `${n(due.length, 'task')} due`].filter(Boolean).join(' and ');
  parts.push(head ? `${head} today.` : 'Nothing scheduled today.');
  const first = events.find((e) => !e.all_day);
  if (first) parts.push(`First: ${first.title} at ${fmtTime(first.start_at!, s.timezone)}.`);
  else if (due[0]) parts.push(`Due: ${due[0].title}.`);
  if (overdue.length) parts.push(`${n(overdue.length, 'task')} overdue.`);
  return { key: `daily:${local.toISODate()}`, title: local.toFormat('cccc d LLLL'), body: parts.join(' '), url: '/', tag: 'daily' };
}
