import { Settings, DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { describeChange, fromInput, groupByDay, isAllDay, layoutDay, matchesFilters, monthGrid, startOfWeek, timeLabel, toInput, weekDays } from '../src/lib/dates';
import { NO_FILTERS, type Item } from '../src/lib/types';

beforeAll(() => { Settings.defaultZone = 'Australia/Sydney'; });

let n = 0;
const item = (p: Partial<Item>): Item => ({
  id: `i${++n}`, user_id: 'u', title: 'T', summary: null, description: null, kind: 'event', start_at: null, end_at: null, due_at: null, all_day: false,
  due_precision: null, timezone: null, location: null, course: null, priority: 'medium', priority_reason: null, category: 'study', action_required: false,
  confidence: 0.9, status: 'open', review_state: 'accepted', origin: 'email', link: null, overridden_fields: [], ai_values: {}, deleted_at: null, created_at: '', updated_at: '', ...p,
});

describe('calendar grids', () => {
  it('a week runs Sunday to Saturday and contains the day asked for', () => {
    const days = weekDays(DateTime.fromISO('2026-11-10'));
    expect(days.map((d) => d.toFormat('ccc d'))).toEqual(['Sun 8', 'Mon 9', 'Tue 10', 'Wed 11', 'Thu 12', 'Fri 13', 'Sat 14']);
    expect(startOfWeek(DateTime.fromISO('2026-11-08')).toISODate()).toBe('2026-11-08');
  });
  it('a month grid is six full weeks around the month', () => {
    const g = monthGrid(DateTime.fromISO('2026-11-10'));
    expect(g).toHaveLength(42);
    expect(g[0]!.toISODate()).toBe('2026-11-01');
    expect(g[41]!.toISODate()).toBe('2026-12-12');
    expect(monthGrid(DateTime.fromISO('2026-10-15'))[0]!.toISODate()).toBe('2026-09-27');
  });
  it('a week across the daylight-saving change still has seven distinct days', () => {
    const days = weekDays(DateTime.fromISO('2026-10-04')); // clocks go forward in Sydney this day
    expect(new Set(days.map((d) => d.toISODate())).size).toBe(7);
  });
});

describe('placing items', () => {
  it('puts an item on its local day, not its UTC day', () => {
    // 7 PM Saturday in Sydney is 8 AM Saturday UTC; 9 AM Monday in Sydney is still Sunday in UTC
    const map = groupByDay([item({ start_at: '2026-11-14T08:00:00Z' }), item({ start_at: '2026-11-15T22:00:00Z' })]);
    expect([...map.keys()].sort()).toEqual(['2026-11-14', '2026-11-16']);
  });
  it('lists all-day things first, then by time', () => {
    const a = item({ title: 'late', start_at: '2026-11-14T08:00:00Z' });
    const b = item({ title: 'early', start_at: '2026-11-13T22:00:00Z' });
    const c = item({ title: 'allday', kind: 'task', due_at: '2026-11-14T12:59:00Z', due_precision: 'date_only' });
    expect(groupByDay([a, b, c]).get('2026-11-14')!.map((i) => i.title)).toEqual(['allday', 'early', 'late']);
  });
  it('date-only tasks and all-day events go in the all-day strip', () => {
    expect(isAllDay(item({ kind: 'task', due_precision: 'date_only' }))).toBe(true);
    expect(isAllDay(item({ kind: 'task', due_precision: 'exact' }))).toBe(false);
    expect(isAllDay(item({ kind: 'event', all_day: true }))).toBe(true);
  });
  it('overlapping events sit side by side; ones that do not overlap take the full width', () => {
    const at = (h: number, m = 0) => DateTime.fromObject({ year: 2026, month: 11, day: 10, hour: h, minute: m }).toUTC().toISO()!;
    const placed = layoutDay([
      item({ title: 'A', start_at: at(9), end_at: at(11) }),
      item({ title: 'B', start_at: at(10), end_at: at(12) }),
      item({ title: 'C', start_at: at(10, 30), end_at: at(11, 30) }),
      item({ title: 'D', start_at: at(14), end_at: at(15) }),
    ]);
    const by = Object.fromEntries(placed.map((p) => [p.item.title, p]));
    expect([by.A!.col, by.B!.col, by.C!.col]).toEqual([0, 1, 2]);
    expect([by.A!.cols, by.B!.cols, by.C!.cols]).toEqual([3, 3, 3]);
    expect(by.D).toMatchObject({ col: 0, cols: 1, top: 14 * 60, height: 60 });
  });
  it('a timed task is drawn as the half hour leading up to its deadline', () => {
    const due = DateTime.fromObject({ year: 2026, month: 11, day: 10, hour: 17 }).toUTC().toISO()!;
    expect(layoutDay([item({ kind: 'task', due_at: due, due_precision: 'exact' })])[0]).toMatchObject({ top: 16 * 60 + 30, height: 30 });
  });
});

describe('filters', () => {
  it('hides review, dismissed, trashed and (by default) done items', () => {
    expect(matchesFilters(item({}), NO_FILTERS)).toBe(true);
    expect(matchesFilters(item({ review_state: 'needs_review' }), NO_FILTERS)).toBe(false);
    expect(matchesFilters(item({ status: 'dismissed' }), NO_FILTERS)).toBe(false);
    expect(matchesFilters(item({ deleted_at: '2026-11-10T00:00:00Z' }), NO_FILTERS)).toBe(false);
    expect(matchesFilters(item({ status: 'done' }), NO_FILTERS)).toBe(false);
    expect(matchesFilters(item({ status: 'done' }), { ...NO_FILTERS, showDone: true })).toBe(true);
  });
  it('unticking a category, course, source or priority hides only those', () => {
    expect(matchesFilters(item({ category: 'finance' }), { ...NO_FILTERS, hiddenCategories: ['finance'] })).toBe(false);
    expect(matchesFilters(item({ course: 'CS-UY 1134' }), { ...NO_FILTERS, hiddenCourses: ['CS-UY 1134'] })).toBe(false);
    expect(matchesFilters(item({ course: null }), { ...NO_FILTERS, hiddenCourses: ['CS-UY 1134'] })).toBe(true);
    expect(matchesFilters(item({ origin: 'manual' }), { ...NO_FILTERS, hiddenOrigins: ['email'] })).toBe(true);
    expect(matchesFilters(item({ priority: 'low' }), { ...NO_FILTERS, hiddenPriorities: ['low'] })).toBe(false);
  });
});

describe('editing', () => {
  it('date inputs round-trip through the device timezone without changing the instant', () => {
    const iso = '2026-11-14T08:00:00Z';
    expect(toInput(iso, false)).toBe('2026-11-14T19:00');
    expect(fromInput(toInput(iso, false))).toBe(iso);
    expect(fromInput('2026-11-20', 'end')).toBe('2026-11-20T12:59:00Z'); // 23:59 in Sydney
    expect(fromInput('')).toBeNull();
  });
  it('labels', () => {
    expect(timeLabel(item({ start_at: '2026-11-14T08:00:00Z', end_at: '2026-11-14T11:00:00Z' }))).toBe('7:00 PM to 10:00 PM');
    expect(timeLabel(item({ kind: 'task', due_at: '2026-11-14T06:00:00Z', due_precision: 'exact' }))).toBe('Due 5:00 PM');
    expect(timeLabel(item({ kind: 'task', due_at: '2026-11-14T12:59:00Z', due_precision: 'date_only' }))).toBe('Due this day');
  });
  it('history lines read as sentences', () => {
    expect(describeChange('due_at', '2026-11-13T06:00:00Z', '2026-11-16T12:59:00Z')).toBe('Due date moved from Fri 13 Nov, 5:00 PM to Mon 16 Nov, 11:59 PM');
    expect(describeChange('status', 'open', 'done')).toBe('Marked done');
    expect(describeChange('confidence', 0.8, 0.9)).toBeNull();
  });
});
