import { DateTime } from 'luxon';
import type { Action } from './store.js';
import type { ItemRow } from './write.js';

export interface ReportEntry {
  receivedAt: Date;
  from: string;
  subject: string;
  filter: string; // "pass" or the skip reason
  escalated: boolean;
  failed?: string;
  items: (ItemRow & { action: Action })[];
}

function cell(s: string): string {
  return s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}
function senderName(from: string): string {
  return cell(from.replace(/<[^>]+>/, '').replace(/"/g, '') || from).slice(0, 40);
}
function when(row: ItemRow, zone: string): string {
  const iso = row.start_at ?? row.due_at;
  if (!iso) return 'no date';
  // Shown in the event's own timezone when it has one (a concert in Sydney, a flight leaving JFK).
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(row.timezone ?? zone);
  const label = row.kind === 'event' ? 'starts' : 'due';
  const place = row.timezone && row.timezone !== zone ? ` ${row.timezone.split('/').pop()!.replace(/_/g, ' ')} time` : '';
  const day = dt.year === DateTime.now().year ? 'ccc d LLL' : 'ccc d LLL yyyy';
  return `${label} ${dt.toFormat(row.all_day || row.due_precision === 'date_only' ? day : `${day}, h:mm a`)}${place}${row.due_precision === 'approximate' ? ' (approx.)' : ''}`;
}

/** The dry-run report: what would be created, without creating it. No email bodies. */
export function renderDryRun(entries: ReportEntry[], zone: string, account: string, costUsd: number, note: string): string {
  const passed = entries.filter((e) => e.filter === 'pass');
  const skipped = entries.filter((e) => e.filter !== 'pass');
  const all = passed.flatMap((e) => e.items.map((i) => ({ e, i })));
  const count = (a: Action) => all.filter((x) => x.i.action === a).length;
  const created = all.filter((x) => x.i.action === 'created');
  const out: string[] = [];
  out.push(`# Dry run: ${account}`, '');
  out.push(`Generated ${DateTime.now().setZone(zone).toFormat('ccc d LLL yyyy, h:mm a')} (${zone}). Nothing was written to the calendar.`, '');
  if (note) out.push(note, '');
  out.push('## Totals', '');
  out.push(`- Emails looked at: ${entries.length}`);
  out.push(`- Filtered out before the AI: ${skipped.length}`);
  out.push(`- Sent to the AI: ${passed.length} (${passed.filter((e) => e.escalated).length} needed a second model call, ${passed.filter((e) => e.failed).length} failed)`);
  out.push(`- Items that would be created: ${created.filter((x) => x.i.review_state === 'accepted').length} on the calendar, ${created.filter((x) => x.i.review_state === 'needs_review').length} in Needs review`);
  out.push(`- Repeat emails merged into an existing item: ${count('merged')}`);
  out.push(`- Items updated: ${count('updated')}, marked done: ${count('completed')}, cancelled: ${count('cancelled')}`);
  out.push(`- Not created because the date had already passed: ${count('skipped_past')}`);
  out.push(`- Estimated AI cost of this run: US$${costUsd.toFixed(4)}`, '');

  out.push('## Would be created', '');
  out.push('| Email | From | Item | Kind | When | Priority | Confidence | Goes to |', '|---|---|---|---|---|---|---|---|');
  for (const { e, i } of created) {
    out.push(`| ${cell(e.subject).slice(0, 50)} | ${senderName(e.from)} | ${cell(i.title)} | ${i.kind} | ${when(i, zone)} | ${i.priority} | ${i.confidence.toFixed(2)} | ${i.review_state === 'accepted' ? 'Calendar' : 'Needs review'} |`);
  }
  if (!created.length) out.push('| (nothing) | | | | | | | |');

  const section = (title: string, actions: Action[]) => {
    const rows = all.filter((x) => actions.includes(x.i.action));
    if (!rows.length) return;
    out.push('', `## ${title}`, '');
    for (const { e, i } of rows) out.push(`- ${cell(i.title)} (${when(i, zone)}), from "${cell(e.subject).slice(0, 60)}"`);
  };
  section('Merged into an item listed earlier (same thing, another email)', ['merged']);
  section('Updated an existing item', ['updated']);
  section('Marked an existing item done', ['completed']);
  section('Cancelled an existing item (waits in Needs review)', ['cancelled']);
  section('Not created: already in the past', ['skipped_past']);

  out.push('', '## Sent to the AI, no item', '');
  const none = passed.filter((e) => !e.items.length || e.items.every((i) => i.action === 'ignored'));
  for (const e of none) out.push(`- ${cell(e.subject).slice(0, 70)} (${senderName(e.from)})${e.failed ? ` FAILED: ${cell(e.failed).slice(0, 80)}` : ''}`);
  if (!none.length) out.push('(none)');

  out.push('', '## Filtered out before the AI', '');
  const byReason = new Map<string, ReportEntry[]>();
  for (const e of skipped) byReason.set(e.filter, [...(byReason.get(e.filter) ?? []), e]);
  for (const [reason, list] of byReason) {
    out.push(`**${reason}** (${list.length})`, '');
    for (const e of list.slice(0, 25)) out.push(`- ${cell(e.subject).slice(0, 70)} (${senderName(e.from)})`);
    if (list.length > 25) out.push(`- and ${list.length - 25} more`);
    out.push('');
  }
  if (!skipped.length) out.push('(none)');
  return out.join('\n') + '\n';
}
