import { isValidZone, localToUtc } from './dates.js';
import type { ExtractedItem } from './schema.js';

export interface ItemRow {
  title: string;
  summary: string;
  kind: 'event' | 'task';
  start_at: string | null;
  end_at: string | null;
  due_at: string | null;
  all_day: boolean;
  optional: boolean; // shown as "possible": something I could do, not something I must
  timezone: string | null; // the event's own timezone when the email made it clear; null = mine
  due_precision: 'exact' | 'date_only' | 'approximate' | null;
  course: string | null;
  priority: 'high' | 'medium' | 'low';
  priority_reason: string;
  category: string;
  action_required: boolean;
  confidence: number;
  review_state: 'needs_review' | 'accepted';
}

/** Turn a validated model item into database columns. Pure, so it is unit-tested. */
export function toItemRow(item: ExtractedItem, zone: string, reviewBelow: number): ItemRow {
  // Times in an email are in the timezone of the place where the thing happens, which may not be mine.
  const ownZone = item.timezone && isValidZone(item.timezone) ? item.timezone : null;
  const startZone = ownZone ?? zone;
  const endZone = item.end_timezone && isValidZone(item.end_timezone) ? item.end_timezone : startZone;
  const start = localToUtc(item.start_local, startZone, 'start');
  const end = localToUtc(item.end_local, endZone, 'end');
  const due = localToUtc(item.due_local, startZone, 'end');
  const isEvent = item.kind === 'event';
  return {
    title: item.title,
    summary: item.summary,
    kind: item.kind,
    start_at: isEvent ? (start?.iso ?? null) : null,
    end_at: isEvent ? (end?.iso ?? null) : null,
    // A "task" that the model gave only a start time for still needs a deadline.
    due_at: isEvent ? null : (due?.iso ?? localToUtc(item.start_local, startZone, 'end')?.iso ?? null),
    all_day: isEvent && !!start?.dateOnly,
    optional: !!item.optional,
    timezone: ownZone,
    due_precision: item.due_precision,
    course: item.course || null,
    priority: item.optional ? 'low' : item.priority,
    priority_reason: item.priority_reason,
    category: item.category,
    action_required: item.optional ? false : item.action_required,
    confidence: Math.round(item.confidence * 100) / 100,
    // Low confidence, or a cancellation I should confirm, goes to the review queue.
    review_state: item.confidence < reviewBelow || item.cancelled ? 'needs_review' : 'accepted',
  };
}

export function gmailThreadLink(account: string, threadId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${threadId}`;
}
