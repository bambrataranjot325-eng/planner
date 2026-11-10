import { DateTime } from 'luxon';
import type { Item } from './types';

/** Sample data for the demo (no account, nothing saved). Dates are relative to today. */
export function demoItems(): Item[] {
  const today = DateTime.local().startOf('day');
  const at = (days: number, h: number, m = 0) => today.plus({ days, hours: h, minutes: m }).toUTC().toISO({ suppressMilliseconds: true })!;
  let n = 0;
  const mk = (p: Partial<Item> & Pick<Item, 'title' | 'kind'>): Item => ({
    id: `demo-${++n}`, user_id: 'demo', summary: null, description: null, start_at: null, end_at: null, due_at: null, all_day: false,
    due_precision: null, timezone: null, location: null, course: null, priority: 'medium', priority_reason: null, category: 'other',
    action_required: false, confidence: 0.95, status: 'open', review_state: 'accepted', origin: 'email', link: null,
    overridden_fields: [], ai_values: {}, deleted_at: null, created_at: at(-2, 9), updated_at: at(-1, 9), ...p,
  });
  return [
    mk({ title: 'Data Structures lecture', kind: 'event', start_at: at(0, 9, 30), end_at: at(0, 10, 50), category: 'study', course: 'CS-UY 1134', origin: 'brightspace', location: 'JAB 474' }),
    mk({ title: 'Design review with Jordan', kind: 'event', start_at: at(0, 13), end_at: at(0, 14), category: 'work', summary: 'Bring the updated CAD for the intake.', location: 'Room 204' }),
    mk({ title: 'Reply to Alex about the lab report', kind: 'task', due_at: at(0, 17), due_precision: 'exact', category: 'study', action_required: true, priority: 'high', priority_reason: 'Due today', summary: 'Alex asked for a review of his section by end of day.' }),
    mk({ title: 'Submit Homework 8', kind: 'task', due_at: at(1, 23, 59), due_precision: 'exact', category: 'study', course: 'CS-UY 1134', origin: 'brightspace', priority: 'medium' }),
    mk({ title: 'Fencing practice', kind: 'event', start_at: at(1, 18), end_at: at(1, 19, 30), category: 'health', origin: 'manual' }),
    mk({ title: 'Accept Joji tickets from the vendor', kind: 'task', due_at: at(3, 23, 59), due_precision: 'date_only', category: 'personal', priority: 'high', priority_reason: 'Needed to get in', action_required: true }),
    mk({ title: 'Attend Joji concert at Afterpay Arena', kind: 'event', start_at: at(3, 19), end_at: at(3, 22), category: 'personal', location: 'Afterpay Arena, Sydney', summary: 'Tickets are in your StubHub account.' }),
    mk({ title: 'Save or delete GitHub Codespace', kind: 'task', due_at: at(4, 23, 59), due_precision: 'date_only', category: 'admin', priority: 'low' }),
    mk({ title: 'Essay 2 draft', kind: 'task', due_at: at(5, 17), due_precision: 'exact', category: 'study', course: 'EXPOS-UY 1', priority: 'medium', overridden_fields: ['title'], ai_values: { title: 'Submit Essay 2 draft on Brightspace' }, summary: 'Draft due on Brightspace. Extended once already.' }),
    mk({ title: 'Midterm 2', kind: 'event', start_at: at(8, 18), end_at: at(8, 19, 30), category: 'study', course: 'CS-UY 1134', priority: 'high', priority_reason: 'Exam', origin: 'brightspace', location: 'JAB 474' }),
    mk({ title: 'Pay Chase card bill', kind: 'task', due_at: at(12, 23, 59), due_precision: 'date_only', category: 'finance', priority: 'high', priority_reason: 'Payment due' }),
    mk({ title: 'Thanksgiving dinner at Grandma\u2019s', kind: 'event', start_at: at(15, 16), end_at: at(15, 20), category: 'personal' }),
    mk({ title: 'Fly SYD to HNL (Alaska 852)', kind: 'event', start_at: at(18, 21, 40), end_at: at(19, 7, 30), category: 'personal' }),
    mk({ title: 'Review inactive OAuth clients', kind: 'task', due_at: at(22, 23, 59), due_precision: 'approximate', category: 'admin', priority: 'low', confidence: 0.75 }),
    mk({ title: 'Morning run', kind: 'event', start_at: at(-1, 7), end_at: at(-1, 7, 45), category: 'health', origin: 'manual', status: 'done' }),
    mk({ title: 'Sign and return the lease renewal', kind: 'task', due_at: at(6, 23, 59), due_precision: 'approximate', category: 'admin', review_state: 'needs_review', confidence: 0.55, summary: 'The landlord asked for the form "within the next week". The date is a guess.' }),
    mk({ title: 'RSVP to Maya\u2019s dinner', kind: 'task', due_at: at(2, 23, 59), due_precision: 'date_only', category: 'personal', review_state: 'needs_review', confidence: 0.58, summary: 'Maya asked you to say by Thursday whether you\u2019re coming on Saturday.' }),
  ];
}
