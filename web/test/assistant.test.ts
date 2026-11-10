import { Settings } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { describeAdd, describeUpdate, expandAdd, updatePatch, type ProposedAdd } from '../src/lib/assistant';
import type { Item } from '../src/lib/types';

beforeAll(() => { Settings.defaultZone = 'Australia/Sydney'; });
const Z = 'Australia/Sydney';
const item = (p: Partial<Item>): Item => ({ id: 'i', user_id: 'u', title: 'T', summary: null, description: null, kind: 'event', start_at: null, end_at: null, due_at: null, all_day: false, due_precision: null, timezone: null, location: null, course: null, priority: 'medium', priority_reason: null, category: 'study', action_required: false, confidence: 1, status: 'open', review_state: 'accepted', origin: 'manual', link: null, overridden_fields: [], ai_values: {}, deleted_at: null, created_at: '', updated_at: '', ...p });

describe('turning a proposal into calendar rows', () => {
  it('a one-off event: "dentist Thursday 3pm"', () => {
    const rows = expandAdd({ title: 'Dentist', kind: 'event', start_local: '2026-11-12T15:00', category: 'health' }, Z);
    expect(rows).toEqual([expect.objectContaining({ title: 'Dentist', kind: 'event', start_at: '2026-11-12T04:00:00Z', end_at: '2026-11-12T05:00:00Z', all_day: false, category: 'health', priority: 'medium' })]);
    expect(describeAdd({ title: 'Dentist', kind: 'event', start_local: '2026-11-12T15:00' }, Z)).toBe('Thu 12 Nov, 3:00 PM to 4:00 PM');
  });
  it('a weekly class becomes one event per occurrence, on the right days, up to and including the last date', () => {
    const cls: ProposedAdd = { title: 'Data Structures lecture', kind: 'event', start_local: '2027-01-25T09:30', end_local: '2027-01-25T10:50', course: 'CS-UY 1134', category: 'study', repeat: { weekdays: [1, 3], until: '2027-02-10' } };
    const rows = expandAdd(cls, 'America/New_York');
    expect(rows.map((r) => r.start_at)).toEqual(['2027-01-25T14:30:00Z', '2027-01-27T14:30:00Z', '2027-02-01T14:30:00Z', '2027-02-03T14:30:00Z', '2027-02-08T14:30:00Z', '2027-02-10T14:30:00Z']);
    expect(rows.every((r) => Date.parse(r.end_at!) - Date.parse(r.start_at!) === 80 * 60_000)).toBe(true);
    expect(describeAdd(cls, 'America/New_York')).toBe('Mon and Wed, 9:30 AM to 10:50 AM, weekly from 25 Jan to 10 Feb (6 times)');
  });
  it('a weekly class stays at the same clock time across a daylight-saving change', () => {
    const rows = expandAdd({ title: 'Lab', kind: 'event', start_local: '2027-03-09T10:00', end_local: '2027-03-09T12:00', repeat: { weekdays: [2], until: '2027-03-16' } }, 'America/New_York');
    expect(rows.map((r) => r.start_at)).toEqual(['2027-03-09T15:00:00Z', '2027-03-16T14:00:00Z']); // clocks go forward on 14 March
  });
  it('a runaway repeat is capped', () => {
    expect(expandAdd({ title: 'Daily', kind: 'event', start_local: '2027-01-01T09:00', repeat: { weekdays: [1, 2, 3, 4, 5, 6, 7], until: '2029-01-01' } }, Z)).toHaveLength(60);
  });
  it('tasks: a date-only deadline means the end of that day; no date is allowed', () => {
    expect(expandAdd({ title: 'Submit lab 3', kind: 'task', due_local: '2026-11-20' }, Z)[0]).toMatchObject({ due_at: '2026-11-20T12:59:00Z', due_precision: 'date_only', start_at: null });
    expect(expandAdd({ title: 'Submit lab 3', kind: 'task', due_local: '2026-11-20T17:00' }, Z)[0]).toMatchObject({ due_at: '2026-11-20T06:00:00Z', due_precision: 'exact' });
    expect(expandAdd({ title: 'Call the bank', kind: 'task' }, Z)[0]).toMatchObject({ due_at: null, due_precision: null });
  });
  it('an all-day event, an event somewhere else, and things that cannot be placed', () => {
    expect(expandAdd({ title: 'Classes begin', kind: 'event', start_local: '2027-01-25' }, Z)[0]).toMatchObject({ all_day: true, start_at: '2027-01-24T13:00:00Z', end_at: null });
    const away = { title: 'Orientation', kind: 'event' as const, start_local: '2027-01-20T10:00', timezone: 'America/New_York' };
    expect(expandAdd(away, Z)[0]).toMatchObject({ start_at: '2027-01-20T15:00:00Z', timezone: 'America/New_York' });
    expect(describeAdd(away, Z)).toBe('Wed 20 Jan, 10:00 AM to 11:00 AM (New York time)');
    expect(expandAdd({ title: 'Mystery', kind: 'event' }, Z)).toEqual([]);
    expect(expandAdd({ title: '   ', kind: 'task' }, Z)).toEqual([]);
    expect(expandAdd({ title: 'Bad zone', kind: 'event', start_local: '2027-01-20T10:00', timezone: 'Mars/Base' }, Z)[0]!.timezone).toBeNull();
  });
});

describe('changing an existing item', () => {
  const meeting = item({ title: 'Registration meeting', start_at: '2026-11-12T04:00:00Z', end_at: '2026-11-12T04:30:00Z' });
  it('moving an event keeps its length', () => {
    expect(updatePatch({ id: 'i', start_local: '2026-11-13T10:00' }, meeting, Z)).toEqual({ start_at: '2026-11-12T23:00:00Z', end_at: '2026-11-12T23:30:00Z', all_day: false });
    expect(describeUpdate({ id: 'i', start_local: '2026-11-13T10:00' }, meeting, Z)).toBe('Move to Fri 13 Nov, 10:00 AM');
  });
  it('a task gets a new deadline; marking done and renaming read plainly', () => {
    const task = item({ kind: 'task', due_at: '2026-11-13T12:59:00Z', due_precision: 'date_only' });
    expect(updatePatch({ id: 'i', due_local: '2026-11-16' }, task, Z)).toEqual({ due_at: '2026-11-16T12:59:00Z', due_precision: 'date_only' });
    expect(describeUpdate({ id: 'i', status: 'done' }, task, Z)).toBe('Mark done');
    expect(describeUpdate({ id: 'i', title: 'Blog post 7' }, task, Z)).toBe('Rename to "Blog post 7"');
  });
  it('an update with nothing usable changes nothing', () => {
    expect(updatePatch({ id: 'i', start_local: 'next week sometime' }, meeting, Z)).toEqual({});
  });
});
