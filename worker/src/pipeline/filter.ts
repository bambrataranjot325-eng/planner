import type { FilterResult, ParsedMessage, SenderRule } from '../types.js';

const ACTION = new RegExp(
  [
    'due\\b', 'deadline', 'rsvp', 'action required', 'respond by', 'reply by', 'register by', 'sign up by',
    'expires?\\b', 'expiring', 'last day', 'no later than', 'overdue', 'past due', 'payment (is )?due',
    'please (confirm|review|submit|sign|complete|reply|respond|send|let me know)',
    'can you\\b', 'could you\\b', 'are you (free|available)', 'let me know',
    '\\bby (mon|tue|wed|thu|fri|sat|sun|tomorrow|tonight|eod|end of)',
  ].join('|'),
  'i',
);
const DEADLINE = /\b(due\b|deadline|overdue|past due|pay by|return by|expires?\b|last day|no later than)/i;
const AUTOMATED_SECURITY =
  /(verification code|one[- ]time (pass)?code|\botp\b|2fa|two[- ]factor|sign[- ]in (attempt|alert)|new sign[- ]in|new device|security alert|was this you|reset your password|password reset|verify your email|confirm your email|activate your account)/i;
const RECEIPT =
  /(receipt|order (confirmation|confirmed|#)|your order|has shipped|out for delivery|delivered|payment (received|confirmation)|invoice|statement is (ready|available)|thanks for your (order|purchase|payment))/i;

// An "order" email that announces a change is not just a receipt.
const ORDER_CHANGE = /(important|update|change|cancel|reschedul|postpon|action|refund)/i;

function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

/** "@shop.com" matches a domain, "news@shop.com" an address, and anything without an @ matches the sender's name. */
function matchesRule(addr: string, pattern: string, from: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (!p.includes('@')) return from.toLowerCase().includes(p);
  return p.startsWith('@') ? addr.endsWith(p) : addr === p;
}

/**
 * Mass mail: newsletters, digests, announcements to a list. It is still read, because a housing or
 * registration deadline can arrive this way, but by the cheaper model and under a stricter rule
 * (obligations only, no optional events).
 */
export function isBulk(msg: ParsedMessage, account: string): boolean {
  const h = msg.headers;
  if (h['list-unsubscribe'] || h['list-id']) return true;
  if (/bulk|list|junk/i.test(h['precedence'] ?? '')) return true;
  if (/\b(no-?reply|do-?not-?reply|newsletter|digest|notifications?|mailer|announce)/i.test(senderAddress(msg.from))) return true;
  const to = `${h['to'] ?? ''} ${h['cc'] ?? ''}`.toLowerCase();
  if (account && to.trim() && !to.includes(account.toLowerCase())) return true; // sent to a list address, not to me
  return false;
}

/** Cheap rules that run before any LLM call. Order matters. */
export function filterMessage(msg: ParsedMessage, rules: SenderRule[] = []): FilterResult {
  const labels = new Set(msg.labels);
  if (labels.has('SPAM') || labels.has('TRASH') || labels.has('DRAFT')) return { decision: 'skip', reason: 'spam_trash_draft' };
  if (!labels.has('INBOX')) return { decision: 'skip', reason: 'not_inbox' };

  const addr = senderAddress(msg.from);
  if (rules.some((r) => r.action === 'allow' && matchesRule(addr, r.pattern, msg.from))) return { decision: 'pass', reason: 'sender_allowlist' };
  if (rules.some((r) => r.action === 'block' && matchesRule(addr, r.pattern, msg.from))) return { decision: 'skip', reason: 'sender_blocklist' };

  if (labels.has('CATEGORY_PROMOTIONS')) return { decision: 'skip', reason: 'gmail_promotions' };
  if (labels.has('CATEGORY_SOCIAL')) return { decision: 'skip', reason: 'gmail_social' };

  const text = `${msg.subject}\n${msg.bodyText}`;
  if (AUTOMATED_SECURITY.test(msg.subject)) return { decision: 'skip', reason: 'automated_security' };
  if (RECEIPT.test(msg.subject) && !ORDER_CHANGE.test(msg.subject) && !DEADLINE.test(text)) return { decision: 'skip', reason: 'receipt_no_deadline' };
  if (msg.headers['list-unsubscribe'] && !ACTION.test(text)) return { decision: 'skip', reason: 'newsletter_no_action' };

  return { decision: 'pass', reason: 'ok' };
}
