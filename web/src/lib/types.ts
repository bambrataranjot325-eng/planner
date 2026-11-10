export type Kind = 'event' | 'task';
export type Priority = 'high' | 'medium' | 'low';
export type Category = 'work' | 'study' | 'personal' | 'finance' | 'health' | 'admin' | 'other';
export type Status = 'open' | 'done' | 'snoozed' | 'dismissed' | 'cancelled';
export type Origin = 'email' | 'brightspace' | 'claude_chat' | 'manual';
export type ViewName = 'today' | 'week' | 'month' | 'agenda';

export interface Item {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  description: string | null;
  kind: Kind;
  start_at: string | null;
  end_at: string | null;
  due_at: string | null;
  all_day: boolean;
  due_precision: 'exact' | 'date_only' | 'approximate' | null;
  timezone: string | null;
  location: string | null;
  course: string | null;
  priority: Priority;
  priority_reason: string | null;
  category: Category;
  action_required: boolean;
  confidence: number | null;
  status: Status;
  review_state: 'needs_review' | 'accepted';
  origin: Origin;
  link: string | null;
  overridden_fields: string[];
  ai_values: Record<string, unknown>;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The fields a person can set in the editor. */
export type ItemDraft = Pick<
  Item,
  'title' | 'summary' | 'kind' | 'start_at' | 'end_at' | 'due_at' | 'all_day' | 'due_precision' | 'location' | 'course' | 'priority' | 'category' | 'link'
>;

export interface AuditEntry {
  id: number;
  action: 'insert' | 'update' | 'delete';
  actor: 'user' | 'worker';
  changes: Record<string, { old: unknown; new: unknown }>;
  at: string;
}

export interface SourceInfo {
  source_type: Origin;
  link: string | null;
  subject: string | null;
  sender: string | null;
  received_at: string | null;
}

/** Everything is shown unless it is unticked in the sidebar, as in Apple Calendar. */
export interface Filters {
  hiddenOrigins: Origin[];
  hiddenCategories: Category[];
  hiddenPriorities: Priority[];
  hiddenCourses: string[];
  showDone: boolean;
}
export const NO_FILTERS: Filters = { hiddenOrigins: [], hiddenCategories: [], hiddenPriorities: [], hiddenCourses: [], showDone: false };

export const CATEGORIES: Category[] = ['study', 'work', 'personal', 'finance', 'health', 'admin', 'other'];
export const PRIORITIES: Priority[] = ['high', 'medium', 'low'];
export const ORIGIN_LABEL: Record<Origin, string> = { email: 'Email', brightspace: 'Brightspace', claude_chat: 'Claude chats', manual: 'Added by me' };
export const CATEGORY_LABEL: Record<Category, string> = { study: 'Study', work: 'Work', personal: 'Personal', finance: 'Finance', health: 'Health', admin: 'Admin', other: 'Other' };
