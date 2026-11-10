import { DateTime } from 'luxon';
import type { ItemRow } from '../pipeline/write.js';
import { classify, type IcsEvent } from './ics.js';

export interface FeedItem {
  uid: string;
  row: ItemRow;
  link: string | null;
}

function parseDate(value: string, tzid: string | null, zone: string): DateTime | null {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) return DateTime.fromFormat(value, 'yyyyMMdd', { zone }); // an all-day date is "that day, wherever I am"
  if (value.endsWith('Z')) return DateTime.fromFormat(value, "yyyyMMdd'T'HHmmss'Z'", { zone: 'utc' });
  const dt = DateTime.fromFormat(value, "yyyyMMdd'T'HHmmss", { zone: tzid ?? zone });
  return dt.isValid ? dt : DateTime.fromFormat(value, "yyyyMMdd'T'HHmmss", { zone });
}
const iso = (dt: DateTime) => dt.toUTC().toISO({ suppressMilliseconds: true })!;

const SUFFIX = /^(.*?)\s+-\s+(Due|Available|Availability Starts|Availability Ends|Start|End)\s*$/i;
const PRIORITY: Record<string, { p: 'high' | 'medium' | 'low'; why: string }> = {
  exam: { p: 'high', why: 'Exam' },
  assignment: { p: 'medium', why: 'Assignment' },
  quiz: { p: 'medium', why: 'Quiz' },
  discussion: { p: 'low', why: 'Discussion post' },
  other: { p: 'medium', why: 'Course item' },
};

function courseOf(location: string): string | null {
  const loc = location.trim();
  if (!loc) return null;
  const code = loc.match(/\b[A-Z]{2,5}-[A-Z]{2}\s?\d{3,4}\b/); // e.g. CS-UY 1134
  return (code ? code[0] : loc).slice(0, 60);
}

function summaryOf(e: IcsEvent, type: string): string {
  const body = e.description
    .replace(/View event\s*-?\s*https?:\/\/\S+/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^(Assignments|Quizzes|Discussions|Content)\s*:\s*.*$/gim, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lead = `${PRIORITY[type]!.why}${e.location ? ` in ${e.location.trim()}` : ''}.`;
  return `${lead}${body ? ` ${body}` : ''}`.slice(0, 400);
}

/**
 * Turn Brightspace calendar-feed events into calendar items. No AI involved: the feed is structured,
 * so this is exact, free and repeatable.
 *  "X - Due"                      a task due then
 *  "X - Availability Ends" / End  a task, only when X has no "Due" entry of its own
 *  "X - Available" / Starts       ignored (it only says when X opens)
 *  anything else                  an event (a class meeting, an exam sitting, a course event)
 * Things dated more than a day ago are left out.
 */
export function mapFeed(events: IcsEvent[], zone: string, now: Date): { items: FeedItem[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const parsed = events.map((e) => {
    const m = e.summary.match(SUFFIX);
    return { e, base: (m ? m[1]! : e.summary).trim(), suffix: m ? m[2]!.toLowerCase() : '' };
  });
  const hasDue = new Set(parsed.filter((p) => p.suffix === 'due').map((p) => `${p.e.location}|${p.base}`));
  const cutoff = now.getTime() - 24 * 3_600_000;
  const items: FeedItem[] = [];

  for (const { e, base, suffix } of parsed) {
    if (!e.uid || !base) { skip('no_id_or_title'); continue; }
    if (['available', 'availability starts', 'start'].includes(suffix)) { skip('opens_only'); continue; }
    const closes = suffix === 'availability ends' || suffix === 'end';
    if (closes && hasDue.has(`${e.location}|${base}`)) { skip('closes_but_has_due_date'); continue; }
    const start = parseDate(e.dtstart, e.tzid, zone);
    if (!start || !start.isValid) { skip('no_date'); continue; }

    const type = classify(e);
    const isTask = suffix === 'due' || closes;
    const pr = PRIORITY[type]!;
    const link = e.description.match(/https?:\/\/[^\s\\]+/)?.[0] ?? null;
    let start_at: string | null = null, end_at: string | null = null, due_at: string | null = null;
    if (isTask) {
      due_at = iso(e.allDay ? start.set({ hour: 23, minute: 59 }) : start);
    } else {
      start_at = iso(e.allDay ? start.startOf('day') : start);
      const end = parseDate(e.dtend, e.tzid, zone);
      if (end && end.isValid) {
        if (e.allDay) { if (end.diff(start, 'days').days > 1) end_at = iso(end.minus({ days: 1 }).set({ hour: 23, minute: 59 })); } // DTEND is the day after the last day
        else if (end > start) end_at = iso(end);
      }
    }
    const when = Date.parse((end_at ?? start_at ?? due_at)!);
    if (when < cutoff) { skip('already_past'); continue; }

    items.push({
      uid: e.uid,
      link,
      row: {
        title: base.slice(0, 80),
        summary: summaryOf(e, type),
        kind: isTask ? 'task' : 'event',
        start_at, end_at, due_at,
        all_day: !isTask && e.allDay,
        optional: false,
        timezone: null,
        due_precision: isTask ? (e.allDay ? 'date_only' : 'exact') : null,
        course: courseOf(e.location),
        priority: pr.p,
        priority_reason: closes ? `${pr.why}; closes then` : pr.why,
        category: 'study',
        action_required: isTask,
        confidence: 1,
        review_state: 'accepted',
      },
    });
  }
  return { items, skipped };
}
