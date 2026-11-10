import { DateTime } from 'luxon';
import type { Item } from './types';

/* The scheduler. Pure functions: given the work, the deadline, my profile and what is already on the
   calendar, decide when the work sessions go. Claude estimates the work; this code places it, so
   "never double-book" is a guarantee of the code, not a hope about a model. */

export interface Profile {
  working_hours: Record<string, { start: string; end: string } | null>; // "1" = Monday ... "7" = Sunday
  blocks: { label: string; days: number[]; start: string; end: string }[];
  max_hours_per_day: number;
  session_minutes: number;
  buffer_pct: number;
  energy: 'any' | 'morning' | 'afternoon' | 'evening';
  goals?: string | null;
  notes?: string | null;
  learned?: { pace?: number };
}

export const DEFAULT_PROFILE: Profile = {
  working_hours: { '1': { start: '09:00', end: '21:00' }, '2': { start: '09:00', end: '21:00' }, '3': { start: '09:00', end: '21:00' }, '4': { start: '09:00', end: '21:00' }, '5': { start: '09:00', end: '21:00' }, '6': { start: '10:00', end: '18:00' }, '7': { start: '10:00', end: '18:00' } },
  blocks: [], max_hours_per_day: 3, session_minutes: 60, buffer_pct: 20, energy: 'any', learned: {},
};

export interface Busy { start: number; end: number } // epoch ms
export interface Milestone { title: string; minutes: number; due?: string }
export interface PlannedSession {
  title: string; summary: string | null; kind: 'event' | 'task';
  start_at: string | null; end_at: string | null; due_at: string | null; planned_minutes: number;
}
export interface PlanInput {
  projectName: string;
  milestones: Milestone[];
  deadline: DateTime;
  now: DateTime;
  profile: Profile;
  busy: Busy[];
  granularity: 'daily' | 'weekly';
  /** Minutes of other projects' sessions already on each day ("yyyy-MM-dd"), counted against the daily limit. */
  otherMinutesByDay?: Record<string, number>;
}
export interface PlanResult {
  sessions: PlannedSession[];
  milestones: Milestone[];
  totalMinutes: number;
  shortfallMinutes: number;
  explanation: string[];
}

const iso = (d: DateTime) => d.toUTC().toISO({ suppressMilliseconds: true })!;
const hm = (d: DateTime, t: string) => { const [h, m] = t.split(':').map(Number); return d.set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 }); };
const key = (d: DateTime) => d.toFormat('yyyy-LL-dd');
const hours = (min: number) => { const h = Math.round((min / 60) * 10) / 10; return `${h} hour${h === 1 ? '' : 's'}`; };

/** Timed, accepted, real commitments block time. Tasks, all-day things and "possibles" do not. */
export function busyFromItems(items: Item[], replacingProjectId: string | null, now: DateTime): { busy: Busy[]; otherMinutesByDay: Record<string, number> } {
  const busy: Busy[] = [];
  const otherMinutesByDay: Record<string, number> = {};
  for (const it of items) {
    if (it.deleted_at || it.kind !== 'event' || it.all_day || !it.start_at || it.optional) continue;
    if (it.review_state !== 'accepted' || ['dismissed', 'cancelled'].includes(it.status)) continue;
    const start = Date.parse(it.start_at);
    const end = it.end_at ? Date.parse(it.end_at) : start + 3_600_000;
    const ownFuture = it.origin === 'plan' && it.project_id === replacingProjectId && it.status === 'open' && start > now.toMillis();
    if (ownFuture) continue; // these are about to be replaced by the new plan
    busy.push({ start, end });
    if (it.origin === 'plan' && it.project_id !== replacingProjectId) {
      const k = key(DateTime.fromMillis(start, { zone: now.zone }));
      otherMinutesByDay[k] = (otherMinutesByDay[k] ?? 0) + (end - start) / 60_000;
    }
  }
  return { busy, otherMinutesByDay };
}

interface Day { date: DateTime; free: [number, number][]; capMinutes: number; reason: 'ok' | 'off' | 'full' }

function subtract(free: [number, number][], s: number, e: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of free) {
    if (e <= a || s >= b) { out.push([a, b]); continue; }
    if (s > a) out.push([a, s]);
    if (e < b) out.push([e, b]);
  }
  return out;
}

/** Each day's free time inside working hours, after classes, fixed blocks and calendar events are removed. */
function freeDays(input: PlanInput, from: DateTime, until: DateTime): Day[] {
  const { profile, busy } = input;
  const days: Day[] = [];
  for (let d = from.startOf('day'); d <= until; d = d.plus({ days: 1 })) {
    const wh = profile.working_hours[String(d.weekday)];
    if (!wh) { days.push({ date: d, free: [], capMinutes: 0, reason: 'off' }); continue; }
    const start = Math.max(hm(d, wh.start).toMillis(), from.toMillis());
    const end = Math.min(hm(d, wh.end).toMillis(), until.toMillis());
    let free: [number, number][] = end > start ? [[start, end]] : [];
    for (const b of profile.blocks) if (b.days.includes(d.weekday)) free = subtract(free, hm(d, b.start).toMillis(), hm(d, b.end).toMillis());
    for (const b of busy) if (b.end > start && b.start < end) free = subtract(free, b.start, b.end);
    const freeMin = free.reduce((s, [a, b]) => s + (b - a) / 60_000, 0);
    const limit = Math.max(0, profile.max_hours_per_day * 60 - (input.otherMinutesByDay?.[key(d)] ?? 0));
    const cap = Math.min(freeMin, limit);
    days.push({ date: d, free, capMinutes: cap, reason: cap >= Math.min(profile.session_minutes, 30) ? 'ok' : end > start ? 'full' : 'off' });
  }
  return days;
}

/** Up to `count` non-overlapping session slots in one day, 15 minutes apart, in the part of the day I prefer. */
function pickSlots(day: Day, len: number, count: number, energy: Profile['energy']): number[] {
  const L = len * 60_000, gap = 15 * 60_000, step = 30 * 60_000;
  const candidates: number[] = [];
  for (const [a, b] of day.free) for (let t = Math.ceil(a / step) * step; t + L <= b; t += step) candidates.push(t);
  const noon2 = day.date.set({ hour: 14, minute: 0 }).toMillis();
  const order = [...candidates].sort((x, y) => (energy === 'evening' ? y - x : energy === 'afternoon' ? Math.abs(x - noon2) - Math.abs(y - noon2) || x - y : x - y));
  const chosen: number[] = [];
  for (const t of order) {
    if (chosen.length >= count) break;
    if (chosen.every((c) => t + L + gap <= c || c + L + gap <= t)) chosen.push(t);
  }
  return chosen.sort((x, y) => x - y);
}

/** Share `n` sessions over the days as evenly as their capacity allows, rather than cramming at either end. */
function spread(capacity: number[], n: number): number[] {
  const counts = capacity.map(() => 0);
  let left = n;
  while (left > 0) {
    const open = capacity.map((c, i) => (counts[i]! < c ? i : -1)).filter((i) => i >= 0);
    if (!open.length) break;
    if (left >= open.length) { for (const i of open) counts[i]!++; left -= open.length; continue; }
    for (let k = 0; k < left; k++) counts[open[Math.min(open.length - 1, Math.floor(((k + 0.5) * open.length) / left))]!]!++;
    left = 0;
  }
  return counts;
}

export function plan(input: PlanInput): PlanResult {
  const { profile, now, deadline, projectName } = input;
  const milestones = input.milestones.filter((m) => m.minutes > 0);
  const total = milestones.reduce((s, m) => s + m.minutes, 0);
  const explanation: string[] = [];
  const len = profile.session_minutes;
  if (!total || deadline <= now) {
    return { sessions: [], milestones, totalMinutes: total, shortfallMinutes: total, explanation: [deadline <= now ? 'The deadline has already passed. Choose a later one.' : 'There is no work to schedule.'] };
  }

  // Leave the last part of the window empty for overruns.
  const start = now.plus({ minutes: 60 }).set({ second: 0, millisecond: 0 });
  const windowMs = deadline.toMillis() - now.toMillis();
  const workEnd = DateTime.fromMillis(deadline.toMillis() - (windowMs * profile.buffer_pct) / 100, { zone: now.zone });
  const days = freeDays(input, start, workEnd);
  const sessions: PlannedSession[] = [];
  let placedMinutes = 0;

  // Which milestone a given minute of work belongs to.
  const bounds: number[] = [];
  milestones.reduce((acc, m) => { bounds.push(acc + m.minutes); return acc + m.minutes; }, 0);
  const milestoneAt = (minute: number) => Math.max(0, bounds.findIndex((b) => minute < b));
  const due: (string | undefined)[] = milestones.map(() => undefined);

  if (input.granularity === 'daily') {
    const n = Math.max(1, Math.ceil(total / len));
    const slotsByDay = days.map((d) => pickSlots(d, len, Math.floor(d.capMinutes / len), profile.energy));
    const counts = spread(slotsByDay.map((s) => s.length), n);
    const times = days.flatMap((d, i) => pickSlots(d, len, counts[i]!, profile.energy));
    times.forEach((t, k) => {
      const minutes = Math.min(len, total - k * len);
      const m = milestoneAt(k * len + minutes / 2);
      const s = DateTime.fromMillis(t, { zone: now.zone });
      const e = s.plus({ minutes: len });
      sessions.push({ title: `${projectName}: ${milestones[m]!.title}`.slice(0, 80), summary: null, kind: 'event', start_at: iso(s), end_at: iso(e), due_at: null, planned_minutes: Math.max(15, Math.round(minutes)) });
      due[m] = iso(e);
      placedMinutes += minutes;
    });
    if (sessions.length) {
      const first = DateTime.fromISO(sessions[0]!.start_at!).setZone(now.zone), last = DateTime.fromISO(sessions[sessions.length - 1]!.start_at!).setZone(now.zone);
      explanation.push(`${sessions.length} session${sessions.length === 1 ? '' : 's'} of ${len} minutes, from ${first.toFormat('ccc d LLL')} to ${last.toFormat('ccc d LLL')}, spread out rather than left to the end.`);
      const used = new Set(sessions.map((s) => key(DateTime.fromISO(s.start_at!).setZone(now.zone))));
      const skipped = days.filter((d) => d.date >= first.startOf('day') && d.date <= last && !used.has(key(d.date)) && d.reason !== 'ok').slice(0, 3);
      for (const d of skipped) explanation.push(`Nothing on ${d.date.toFormat('ccc d LLL')}: ${d.reason === 'off' ? 'it is not one of your working days' : 'your day is already full'}.`);
      if (counts.some((c, i) => c > 0 && c === Math.floor(days[i]!.capMinutes / len) && days[i]!.capMinutes >= profile.max_hours_per_day * 60 - len)) explanation.push(`No day has more than ${hours(profile.max_hours_per_day * 60)} of project work, your daily limit.`);
    }
  } else {
    // Weekly: one target per week, sized to what that week can hold.
    const weeks = new Map<string, { end: DateTime; cap: number }>();
    for (const d of days) {
      const wk = d.date.startOf('week');
      const cur = weeks.get(key(wk)) ?? { end: DateTime.min(wk.endOf('week'), workEnd), cap: 0 };
      cur.cap += d.capMinutes;
      weeks.set(key(wk), cur);
    }
    const list = [...weeks.values()].filter((w) => w.cap >= 30);
    const share = list.map(() => 0);
    let left = total;
    for (let guard = 0; guard < 20 && left > 0.5; guard++) {
      const open = list.map((w, i) => (share[i]! < w.cap ? i : -1)).filter((i) => i >= 0);
      if (!open.length) break;
      const each = left / open.length;
      for (const i of open) { const add = Math.min(each, list[i]!.cap - share[i]!); share[i]! += add; left -= add; }
    }
    let done = 0;
    list.forEach((w, i) => {
      const minutes = Math.round(share[i]! / 15) * 15;
      if (minutes < 15) return;
      const a = milestoneAt(done + 1), b = milestoneAt(Math.min(total - 1, done + minutes - 1));
      const names = milestones.slice(a, b + 1).map((m) => m.title);
      sessions.push({ title: `${projectName}: ${hours(minutes)} this week`.slice(0, 80), summary: `This week: ${names.join(', ')}.`, kind: 'task', start_at: null, end_at: null, due_at: iso(w.end), planned_minutes: minutes });
      for (let m = a; m <= b; m++) due[m] = iso(w.end);
      done += minutes;
      placedMinutes += share[i]!;
    });
    if (sessions.length) explanation.push(`${sessions.length} weekly target${sessions.length === 1 ? '' : 's'}, sized to how much free time each week has.`);
  }

  const bufferDays = (deadline.toMillis() - workEnd.toMillis()) / 86_400_000;
  if (profile.buffer_pct > 0 && sessions.length) explanation.push(bufferDays >= 1 ? `The last ${Math.round(bufferDays)} day${Math.round(bufferDays) === 1 ? '' : 's'} before the deadline are kept free in case things run over.` : `The last ${Math.round(bufferDays * 24)} hours before the deadline are kept free in case things run over.`);
  const shortfall = Math.max(0, Math.round(total - placedMinutes));
  if (shortfall >= 15) explanation.push(`This does not all fit: ${hours(shortfall)} could not be placed. Move the deadline, raise your daily limit, or trim the work.`);

  // A milestone with no session of its own is finished when the one before it is.
  let prev: string | undefined;
  const outMilestones = milestones.map((m, i) => { prev = due[i] ?? prev; return { ...m, due: prev }; });
  return { sessions, milestones: outMilestones, totalMinutes: total, shortfallMinutes: shortfall >= 15 ? shortfall : 0, explanation };
}

/** With no deadline given: the earliest date the work fits at a comfortable pace (half my daily limit), buffer included. */
export function suggestDeadline(input: Omit<PlanInput, 'deadline'>): DateTime {
  const easy: Profile = { ...input.profile, max_hours_per_day: Math.max(input.profile.session_minutes / 60, input.profile.max_hours_per_day / 2) };
  for (let d = 2; d <= 240; d++) {
    const deadline = input.now.plus({ days: d }).set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
    if (plan({ ...input, profile: easy, deadline }).shortfallMinutes === 0) return deadline;
  }
  return input.now.plus({ days: 240 });
}

/** How long my sessions really take compared with the plan, once there are a few to go on (1.2 = 20% longer). */
export function learnedPace(items: Item[]): number | null {
  const done = items.filter((i) => i.origin === 'plan' && i.status === 'done' && i.actual_minutes && i.planned_minutes);
  if (done.length < 3) return null;
  const ratio = done.reduce((s, i) => s + i.actual_minutes!, 0) / done.reduce((s, i) => s + i.planned_minutes!, 0);
  return Math.min(1.6, Math.max(0.7, Math.round(ratio * 20) / 20));
}

export interface PlanIssues { deadlineMoved: boolean; missed: Item[]; clashes: Item[] }

/** Reasons to offer a replan. Nothing is ever replanned without being asked. */
export function findIssues(projectDeadline: string | null, planDeadline: string | null, sessions: Item[], all: Item[], now: DateTime): PlanIssues {
  const live = sessions.filter((s) => !s.deleted_at && s.status === 'open');
  const when = (s: Item) => Date.parse((s.end_at ?? s.due_at ?? s.start_at)!);
  const missed = live.filter((s) => when(s) < now.toMillis());
  const others = busyFromItems(all.filter((i) => i.origin !== 'plan' || !sessions.some((s) => s.id === i.id)), null, now).busy;
  const clashes = live.filter((s) => s.kind === 'event' && s.start_at && Date.parse(s.start_at) > now.toMillis() && others.some((b) => b.start < Date.parse(s.end_at ?? s.start_at!) && b.end > Date.parse(s.start_at!)));
  const deadlineMoved = !!projectDeadline && !!planDeadline && Math.abs(Date.parse(projectDeadline) - Date.parse(planDeadline)) > 60_000;
  return { deadlineMoved, missed, clashes };
}

/** What is left to do: the plan's milestones with finished minutes taken off the front. */
export function remainingMilestones(milestones: Milestone[], sessions: Item[]): Milestone[] {
  let done = sessions.filter((s) => s.status === 'done' && !s.deleted_at).reduce((sum, s) => sum + (s.planned_minutes ?? 0), 0);
  return milestones.map((m) => { const cut = Math.min(done, m.minutes); done -= cut; return { title: m.title, minutes: m.minutes - cut }; }).filter((m) => m.minutes > 0);
}

/** A plain split for when the AI is unavailable or I'd rather give the hours myself. */
export function manualMilestones(totalHours: number): Milestone[] {
  const total = Math.round(totalHours * 60);
  const parts: [string, number][] = [['Plan and outline', 0.15], ['First pass', 0.5], ['Revise', 0.25], ['Final check', 0.1]];
  return parts.map(([title, share]) => ({ title, minutes: Math.max(15, Math.round((total * share) / 15) * 15) }));
}
