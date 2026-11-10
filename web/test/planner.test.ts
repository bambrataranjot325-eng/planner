import { DateTime, Settings } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { busyFromItems, DEFAULT_PROFILE, findIssues, learnedPace, manualMilestones, plan, remainingMilestones, suggestDeadline, type Busy, type PlanInput, type Profile } from '../src/lib/planner';
import type { Item } from '../src/lib/types';

beforeAll(() => { Settings.defaultZone = 'Australia/Sydney'; });
const Z = 'Australia/Sydney';
const at = (s: string) => DateTime.fromISO(s, { zone: Z });
const NOW = at('2026-11-10T16:00'); // a Tuesday afternoon
const ms = (s: string) => at(s).toMillis();
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  projectName: 'Essay 2', now: NOW, deadline: at('2026-11-20T17:00'), profile: DEFAULT_PROFILE, busy: [], granularity: 'daily',
  milestones: [{ title: 'Outline', minutes: 60 }, { title: 'Draft', minutes: 180 }, { title: 'Revise', minutes: 120 }], ...over,
});
const span = (s: { start_at: string | null; end_at: string | null }) => [Date.parse(s.start_at!), Date.parse(s.end_at!)] as const;
const overlaps = (a: readonly [number, number], b: Busy) => a[0] < b.end && a[1] > b.start;
let n = 0;
const item = (p: Partial<Item>): Item => ({ id: `i${++n}`, user_id: 'u', title: 'T', summary: null, description: null, kind: 'event', start_at: null, end_at: null, due_at: null, all_day: false, due_precision: null, timezone: null, location: null, course: null, priority: 'medium', priority_reason: null, category: 'study', action_required: false, confidence: 1, status: 'open', review_state: 'accepted', origin: 'email', link: null, overridden_fields: [], ai_values: {}, deleted_at: null, created_at: '', updated_at: '', ...p });

describe('placing work sessions', () => {
  it('schedules all the work, in order, inside working hours', () => {
    const r = plan(base());
    expect(r.shortfallMinutes).toBe(0);
    expect(r.sessions).toHaveLength(6); // 360 minutes in 60-minute sessions
    expect(r.sessions.reduce((s, x) => s + x.planned_minutes, 0)).toBe(360);
    expect(r.sessions.map((s) => s.title.split(': ')[1])).toEqual(['Outline', 'Draft', 'Draft', 'Draft', 'Revise', 'Revise']);
    for (const s of r.sessions) {
      const start = DateTime.fromISO(s.start_at!).setZone(Z), end = DateTime.fromISO(s.end_at!).setZone(Z);
      const wh = DEFAULT_PROFILE.working_hours[String(start.weekday)]!;
      expect(start.toFormat('HH:mm') >= wh.start && end.toFormat('HH:mm') <= wh.end).toBe(true);
      expect(start > NOW).toBe(true);
    }
    const starts = r.sessions.map((s) => Date.parse(s.start_at!));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('never double-books: no session touches a calendar event, a class, or another session', () => {
    const busy: Busy[] = [];
    for (let d = 11; d <= 20; d++) { // a meeting every morning and a long block most afternoons
      busy.push({ start: ms(`2026-11-${d}T09:00`), end: ms(`2026-11-${d}T11:30`) });
      if (d % 2) busy.push({ start: ms(`2026-11-${d}T13:00`), end: ms(`2026-11-${d}T17:45`) });
    }
    const profile: Profile = { ...DEFAULT_PROFILE, blocks: [{ label: 'Lecture', days: [1, 3, 5], start: '12:00', end: '13:00' }] };
    const r = plan(base({ busy, profile, milestones: [{ title: 'Work', minutes: 900 }] }));
    expect(r.sessions.length).toBeGreaterThan(8);
    const spans = r.sessions.map(span);
    for (const s of spans) {
      for (const b of busy) expect(overlaps(s, b)).toBe(false);
      const d = DateTime.fromMillis(s[0], { zone: Z });
      if ([1, 3, 5].includes(d.weekday)) expect(overlaps(s, { start: d.set({ hour: 12, minute: 0 }).toMillis(), end: d.set({ hour: 13, minute: 0 }).toMillis() })).toBe(false);
    }
    for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) expect(overlaps(spans[i]!, { start: spans[j]![0], end: spans[j]![1] })).toBe(false);
  });

  it('respects the buffer: nothing is scheduled in the last 20% of the time before the deadline', () => {
    const r = plan(base({ milestones: [{ title: 'Work', minutes: 1200 }] }));
    const input = base();
    const cutoff = input.deadline.toMillis() - (input.deadline.toMillis() - NOW.toMillis()) * 0.2;
    for (const s of r.sessions) expect(Date.parse(s.end_at!)).toBeLessThanOrEqual(cutoff);
    expect(r.explanation.join(' ')).toContain('kept free in case things run over');
  });

  it('respects the daily limit, counting other projects already on that day', () => {
    const r = plan(base({ milestones: [{ title: 'Work', minutes: 1500 }], otherMinutesByDay: { '2026-11-12': 120 } }));
    const perDay: Record<string, number> = {};
    for (const s of r.sessions) { const k = DateTime.fromISO(s.start_at!).setZone(Z).toISODate()!; perDay[k] = (perDay[k] ?? 0) + 60; }
    for (const [day, minutes] of Object.entries(perDay)) expect(minutes).toBeLessThanOrEqual(day === '2026-11-12' ? 60 : 180);
  });

  it('spreads work out instead of cramming it at either end', () => {
    const r = plan(base({ deadline: at('2026-11-30T17:00'), milestones: [{ title: 'Work', minutes: 240 }] }));
    const days = r.sessions.map((s) => DateTime.fromISO(s.start_at!).setZone(Z).ordinal);
    expect(new Set(days).size).toBe(4); // four sessions on four different days
    expect(days[days.length - 1]! - days[0]!).toBeGreaterThanOrEqual(8); // across the window, not bunched
  });

  it('says so plainly when the work does not fit, and still places what it can', () => {
    const r = plan(base({ deadline: at('2026-11-12T17:00'), milestones: [{ title: 'Work', minutes: 3000 }] }));
    expect(r.shortfallMinutes).toBeGreaterThan(0);
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.explanation.join(' ')).toMatch(/does not all fit: .* could not be placed/);
  });

  it('a past deadline produces no sessions and a clear reason', () => {
    const r = plan(base({ deadline: at('2026-11-09T17:00') }));
    expect(r.sessions).toHaveLength(0);
    expect(r.explanation[0]).toContain('already passed');
  });

  it('skips days off and explains why', () => {
    const profile: Profile = { ...DEFAULT_PROFILE, working_hours: { ...DEFAULT_PROFILE.working_hours, '6': null, '7': null }, max_hours_per_day: 1 };
    const r = plan(base({ profile, deadline: at('2026-11-24T17:00'), milestones: [{ title: 'Work', minutes: 480 }] }));
    for (const s of r.sessions) expect(DateTime.fromISO(s.start_at!).setZone(Z).weekday).toBeLessThan(6);
    expect(r.explanation.join(' ')).toContain('not one of your working days');
  });

  it('honours a morning, afternoon or evening preference', () => {
    const first = (energy: Profile['energy']) => {
      const s = plan(base({ profile: { ...DEFAULT_PROFILE, energy }, milestones: [{ title: 'W', minutes: 60 }] })).sessions[0]!;
      const start = DateTime.fromISO(s.start_at!).setZone(Z), end = DateTime.fromISO(s.end_at!).setZone(Z);
      return { start: start.toFormat('HH:mm'), end: end.toFormat('HH:mm'), hours: DEFAULT_PROFILE.working_hours[String(start.weekday)]! };
    };
    const m = first('morning'), e = first('evening'), a = first('afternoon');
    expect(m.start).toBe(m.hours.start); // the first slot of that day's working hours
    expect(e.end).toBe(e.hours.end); // the last
    expect(a.start).toBe('14:00');
  });

  it('works across a daylight-saving change', () => {
    const r = plan(base({ now: at('2026-09-30T10:00'), deadline: at('2026-10-10T17:00'), milestones: [{ title: 'W', minutes: 600 }] })); // clocks go forward 4 Oct
    expect(r.shortfallMinutes).toBe(0);
    for (const s of r.sessions) expect(Date.parse(s.end_at!) - Date.parse(s.start_at!)).toBe(3_600_000);
  });
});

describe('weekly targets', () => {
  it('gives one task per week that adds up to the whole job', () => {
    const r = plan(base({ granularity: 'weekly', deadline: at('2026-12-08T17:00'), milestones: [{ title: 'Research', minutes: 300 }, { title: 'Write', minutes: 420 }] }));
    expect(r.sessions.every((s) => s.kind === 'task' && s.due_at && !s.start_at)).toBe(true);
    expect(r.sessions.reduce((s, x) => s + x.planned_minutes, 0)).toBe(720);
    expect(r.sessions.length).toBeGreaterThanOrEqual(3);
    expect(r.sessions[0]!.title).toMatch(/^Essay 2: .* this week$/);
    expect(r.milestones.every((m) => m.due)).toBe(true);
  });
});

describe('suggesting a deadline', () => {
  it('proposes the earliest date the work fits at a comfortable pace, and the plan for it fits', () => {
    const { deadline: _d, ...rest } = base({ milestones: [{ title: 'W', minutes: 600 }] });
    const d = suggestDeadline(rest);
    expect(d > NOW.plus({ days: 5 })).toBe(true); // 10 hours at about 1.5 hours a day, plus buffer
    expect(d < NOW.plus({ days: 21 })).toBe(true);
    expect(plan({ ...rest, deadline: d }).shortfallMinutes).toBe(0);
  });
  it('a busier calendar pushes the suggestion later', () => {
    const { deadline: _d, ...rest } = base({ milestones: [{ title: 'W', minutes: 600 }] });
    const busy: Busy[] = Array.from({ length: 14 }, (_, i) => ({ start: NOW.plus({ days: i }).set({ hour: 9, minute: 0 }).toMillis(), end: NOW.plus({ days: i }).set({ hour: 20, minute: 30 }).toMillis() }));
    expect(suggestDeadline({ ...rest, busy }) > suggestDeadline(rest)).toBe(true);
  });
});

describe('what blocks time', () => {
  it('timed commitments block; tasks, all-day events, possibles, dismissed and trashed items do not', () => {
    const s = '2026-11-12T03:00:00Z', e = '2026-11-12T04:00:00Z';
    const { busy } = busyFromItems([
      item({ start_at: s, end_at: e }),
      item({ kind: 'task', due_at: s }),
      item({ start_at: s, end_at: e, all_day: true }),
      item({ start_at: s, end_at: e, optional: true }),
      item({ start_at: s, end_at: e, status: 'dismissed' }),
      item({ start_at: s, end_at: e, deleted_at: s }),
      item({ start_at: s, end_at: e, review_state: 'needs_review' }),
    ], null, NOW);
    expect(busy).toHaveLength(1);
  });
  it('this project\'s own upcoming sessions are ignored (they are being replaced); other projects\' count', () => {
    const s = '2026-11-12T03:00:00Z', e = '2026-11-12T04:00:00Z';
    const out = busyFromItems([item({ origin: 'plan', project_id: 'p1', start_at: s, end_at: e }), item({ origin: 'plan', project_id: 'p2', start_at: s, end_at: e })], 'p1', NOW);
    expect(out.busy).toHaveLength(1);
    expect(out.otherMinutesByDay).toEqual({ '2026-11-12': 60 });
  });
});

describe('replanning', () => {
  const sess = (p: Partial<Item>) => item({ origin: 'plan', project_id: 'p1', planned_minutes: 60, ...p });
  it('offers a replan when the deadline moved, a session was missed, or something now clashes', () => {
    const missed = sess({ start_at: '2026-11-09T03:00:00Z', end_at: '2026-11-09T04:00:00Z' });
    const clash = sess({ start_at: '2026-11-13T03:00:00Z', end_at: '2026-11-13T04:00:00Z' });
    const fine = sess({ start_at: '2026-11-14T03:00:00Z', end_at: '2026-11-14T04:00:00Z' });
    const meeting = item({ start_at: '2026-11-13T03:30:00Z', end_at: '2026-11-13T05:00:00Z' });
    const issues = findIssues('2026-11-25T06:00:00Z', '2026-11-20T06:00:00Z', [missed, clash, fine], [missed, clash, fine, meeting], NOW);
    expect(issues.deadlineMoved).toBe(true);
    expect(issues.missed.map((i) => i.id)).toEqual([missed.id]);
    expect(issues.clashes.map((i) => i.id)).toEqual([clash.id]);
  });
  it('finds nothing to fix when the plan is on track, and done sessions are never "missed"', () => {
    const done = sess({ start_at: '2026-11-09T03:00:00Z', end_at: '2026-11-09T04:00:00Z', status: 'done' });
    const next = sess({ start_at: '2026-11-14T03:00:00Z', end_at: '2026-11-14T04:00:00Z' });
    expect(findIssues('2026-11-20T06:00:00Z', '2026-11-20T06:00:00Z', [done, next], [done, next], NOW)).toEqual({ deadlineMoved: false, missed: [], clashes: [] });
  });
  it('after a moved deadline, the new plan covers only the work left and fits the new window', () => {
    const milestones = [{ title: 'Outline', minutes: 60 }, { title: 'Draft', minutes: 180 }, { title: 'Revise', minutes: 120 }];
    const done = [sess({ status: 'done', planned_minutes: 60 }), sess({ status: 'done', planned_minutes: 60 })];
    const left = remainingMilestones(milestones, done);
    expect(left).toEqual([{ title: 'Draft', minutes: 120 }, { title: 'Revise', minutes: 120 }]);
    const r = plan(base({ milestones: left, deadline: at('2026-11-17T17:00') }));
    expect(r.shortfallMinutes).toBe(0);
    expect(r.sessions).toHaveLength(4);
    for (const s of r.sessions) expect(Date.parse(s.end_at!)).toBeLessThan(ms('2026-11-17T17:00'));
  });
  it('learns my pace from finished sessions, once there are at least three', () => {
    const s = (actual: number) => sess({ status: 'done', planned_minutes: 60, actual_minutes: actual });
    expect(learnedPace([s(75), s(70)])).toBeNull();
    expect(learnedPace([s(75), s(70), s(71)])).toBe(1.2);
    expect(learnedPace([s(200), s(200), s(200)])).toBe(1.6); // capped, so one bad week can't double every estimate
  });
  it('a manual split adds up to the hours given', () => {
    expect(manualMilestones(10).reduce((s, m) => s + m.minutes, 0)).toBe(600);
  });
});
