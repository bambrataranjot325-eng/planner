export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  dtstart: string;
  dtend: string;
  allDay: boolean;
  fields: string[];
}

export function unescapeIcs(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** Minimal ICS reader: unfolds lines, reads VEVENTs. Enough for the Brightspace feed. */
export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: IcsEvent[] = [];
  let cur: Record<string, string> | null = null;
  let allDay = false;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      allDay = false;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) {
        events.push({
          uid: cur.UID ?? '',
          summary: unescapeIcs(cur.SUMMARY ?? ''),
          description: unescapeIcs(cur.DESCRIPTION ?? ''),
          location: unescapeIcs(cur.LOCATION ?? ''),
          dtstart: cur.DTSTART ?? '',
          dtend: cur.DTEND ?? '',
          allDay,
          fields: Object.keys(cur),
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const rawKey = line.slice(0, idx);
    const key = rawKey.split(';')[0]!;
    cur[key] = line.slice(idx + 1);
    if (key === 'DTSTART' && rawKey.includes('VALUE=DATE') && !rawKey.includes('DATE-TIME')) allDay = true;
  }
  return events;
}

function tally(values: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function classify(e: IcsEvent): string {
  if (/folder_submit_files|Assignments:/i.test(e.description)) return 'assignment';
  if (/quizzing\.d2l|Quizzes:/i.test(e.description)) return 'quiz';
  if (/discussions/i.test(e.description)) return 'discussion';
  if (/\bexam\b|\bmidterm\b|\bfinal\b/i.test(e.summary)) return 'exam';
  return 'other';
}

/** What is in the feed, with tokens and ids stripped so the report is safe to paste into a chat. */
export function summarizeFeed(events: IcsEvent[]): string {
  const scrub = (s: string) =>
    s
      .replace(/([?&](?:token|ou|db|qi|grpid|isprv)=)[^&\s]+/gi, '$1…')
      .replace(/\/\d{4,}\b/g, '/…');
  const suffix = (s: string) => {
    const m = s.match(/\s-\s([^-]{1,30})$/);
    return m ? `"… - ${m[1]!.trim()}"` : '(no " - " suffix)';
  };
  const out: string[] = [];
  out.push('# Brightspace feed report', '', `Events in feed: ${events.length}`);
  out.push(`All-day events: ${events.filter((e) => e.allDay).length}`);
  out.push(`Events with an end time different from the start: ${events.filter((e) => e.dtend && e.dtend !== e.dtstart).length}`);
  const dates = events.map((e) => e.dtstart.slice(0, 8)).filter(Boolean).sort();
  if (dates.length) out.push(`Date range: ${dates[0]} to ${dates[dates.length - 1]}`);
  out.push('', '## Title endings (how Brightspace labels each kind of event)', '');
  for (const [k, n] of tally(events.map((e) => suffix(e.summary)))) out.push(`- ${k}: ${n}`);
  out.push('', '## Detected type', '');
  for (const [k, n] of tally(events.map(classify))) out.push(`- ${k}: ${n}`);
  out.push('', '## Courses (from the LOCATION field)', '');
  for (const [k, n] of tally(events.map((e) => e.location || '(empty)'))) out.push(`- ${k}: ${n}`);
  out.push('', '## Fields present', '');
  for (const [k, n] of tally(events.flatMap((e) => e.fields))) out.push(`- ${k}: ${n} of ${events.length}`);
  out.push('', '## One sample of each type (links scrubbed)', '');
  const seen = new Set<string>();
  for (const e of events) {
    const type = classify(e);
    if (seen.has(type)) continue;
    seen.add(type);
    out.push(`### ${type}`, '', '```', `SUMMARY: ${e.summary}`, `LOCATION: ${e.location}`, `DTSTART: ${e.dtstart}${e.allDay ? ' (all day)' : ''}`, `DTEND: ${e.dtend}`, `DESCRIPTION: ${scrub(e.description).slice(0, 400)}`, '```', '');
  }
  return out.join('\n') + '\n';
}
