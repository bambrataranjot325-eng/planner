import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixturesDir, loadModels, loadPrompt } from '../src/config.js';
import { cleanBody, htmlToText } from '../src/pipeline/clean.js';
import { formatAnchor, localToUtc, utcToLocal } from '../src/pipeline/dates.js';
import { buildUserPrompt, extract } from '../src/pipeline/extract.js';
import { filterMessage } from '../src/pipeline/filter.js';
import { estimateCost } from '../src/pipeline/llm.js';
import { redact } from '../src/pipeline/redact.js';
import { parseExtraction } from '../src/pipeline/schema.js';
import { toItemRow } from '../src/pipeline/write.js';
import { fixtureToMessage, loadFixtures } from '../src/cli/fixtures.js';
import { parseGmailMessage } from '../src/gmail/parse.js';
import { planSync } from '../src/gmail/sync.js';
import { GmailError, HistoryExpiredError, makeGmailApi, type GmailApi } from '../src/gmail/client.js';
import { classify, parseIcs, summarizeFeed } from '../src/brightspace/ics.js';
import type { LlmCall } from '../src/types.js';

const NY = 'America/New_York';
const SYD = 'Australia/Sydney';

describe('date resolution', () => {
  it('converts local wall-clock times to UTC in winter and summer', () => {
    expect(localToUtc('2026-11-13T17:00', NY, 'end')!.iso).toBe('2026-11-13T22:00:00Z'); // EST, UTC-5
    expect(localToUtc('2026-07-10T17:00', NY, 'end')!.iso).toBe('2026-07-10T21:00:00Z'); // EDT, UTC-4
    expect(localToUtc('2026-11-13T17:00', SYD, 'end')!.iso).toBe('2026-11-13T06:00:00Z'); // AEDT, UTC+11
    expect(localToUtc('2026-07-10T17:00', SYD, 'end')!.iso).toBe('2026-07-10T07:00:00Z'); // AEST, UTC+10
  });
  it('treats a date-only deadline as 23:59 that day, and a date-only event as all day', () => {
    const due = localToUtc('2026-11-20', NY, 'end')!;
    expect(due).toEqual({ iso: '2026-11-21T04:59:00Z', dateOnly: true });
    expect(localToUtc('2026-11-20', NY, 'start')!.iso).toBe('2026-11-20T05:00:00Z');
  });
  it('keeps an 11:59 PM deadline on the right local day (the off-by-one in the old workflow)', () => {
    const iso = localToUtc('2026-11-16T23:59', NY, 'end')!.iso;
    expect(iso).toBe('2026-11-17T04:59:00Z'); // UTC date is the 17th...
    expect(utcToLocal(iso, NY)).toBe('2026-11-16T23:59'); // ...but it is still the 16th for me
  });
  it('handles the spring-forward gap by moving to the next valid time', () => {
    // New York: 02:30 on 8 Mar 2026 does not exist. Sydney: 02:30 on 4 Oct 2026 does not exist.
    expect(localToUtc('2026-03-08T02:30', NY, 'end')!.iso).toBe('2026-03-08T07:30:00Z'); // 03:30 EDT
    expect(localToUtc('2026-10-04T02:30', SYD, 'end')!.iso).toBe('2026-10-03T16:30:00Z'); // 03:30 AEDT
  });
  it('handles the fall-back repeat by taking the first occurrence', () => {
    expect(localToUtc('2026-11-01T01:30', NY, 'end')!.iso).toBe('2026-11-01T05:30:00Z'); // 01:30 EDT, before clocks go back
    expect(localToUtc('2026-04-05T02:30', SYD, 'end')!.iso).toBe('2026-04-04T15:30:00Z'); // 02:30 AEDT
  });
  it('days either side of a clock change are 23 and 25 hours apart', () => {
    const a = Date.parse(localToUtc('2026-03-08', NY, 'start')!.iso);
    const b = Date.parse(localToUtc('2026-03-09', NY, 'start')!.iso);
    expect((b - a) / 3_600_000).toBe(23);
    const c = Date.parse(localToUtc('2026-04-05', SYD, 'start')!.iso);
    const d = Date.parse(localToUtc('2026-04-06', SYD, 'start')!.iso);
    expect((d - c) / 3_600_000).toBe(25);
  });
  it('gives the model the received date with its weekday in my timezone', () => {
    expect(formatAnchor(new Date('2026-11-10T15:00:00Z'), NY)).toBe('Tuesday 2026-11-10 10:00 (America/New_York)');
    expect(formatAnchor(new Date('2026-11-10T15:00:00Z'), SYD)).toBe('Wednesday 2026-11-11 02:00 (Australia/Sydney)');
  });
  it('rejects garbage', () => {
    expect(localToUtc('next Friday', NY, 'end')).toBeNull();
    expect(localToUtc(null, NY, 'end')).toBeNull();
  });
});

describe('schema validation', () => {
  const good = { title: 'Submit essay draft', summary: 'Draft due on Brightspace.', kind: 'task', start_local: null, end_local: null, due_local: '2026-11-13T17:00', due_precision: 'exact', course: 'EXPOS-UY 1', priority: 'medium', priority_reason: 'homework', category: 'study', action_required: true, confidence: 0.95, updates_item_id: null, cancelled: false };
  it('accepts a valid reply, including one wrapped in code fences', () => {
    expect(parseExtraction(JSON.stringify({ items: [good] })).ok).toBe(true);
    expect(parseExtraction('```json\n' + JSON.stringify({ items: [] }) + '\n```').ok).toBe(true);
  });
  it('rejects bad JSON, long titles, timezone-suffixed dates and unknown enums', () => {
    expect(parseExtraction('Sure! Here you go').ok).toBe(false);
    expect(parseExtraction(JSON.stringify({ items: [{ ...good, title: 'x'.repeat(81) }] })).ok).toBe(false);
    expect(parseExtraction(JSON.stringify({ items: [{ ...good, due_local: '2026-11-13T17:00:00Z' }] })).ok).toBe(false);
    expect(parseExtraction(JSON.stringify({ items: [{ ...good, priority: 'urgent' }] })).ok).toBe(false);
    expect(parseExtraction(JSON.stringify({ items: [{ ...good, confidence: 1.4 }] })).ok).toBe(false);
  });
});

describe('extraction flow (fake models)', () => {
  const models = { ...loadModels(), escalate_below_confidence: 0.75 }; // tests fix the threshold; the live value is in models.json
  const input = { from: 'a@b.c', subject: 's', receivedAnchor: 'Tuesday 2026-11-10 10:00 (America/New_York)', body: 'b', existing: [] };
  const item = (confidence: number) => ({ title: 'Do the thing', summary: 's', kind: 'task', start_local: null, end_local: null, due_local: '2026-11-13', due_precision: 'date_only', course: null, priority: 'medium', priority_reason: 'r', category: 'study', action_required: true, confidence });
  const reply = (obj: unknown): LlmCall => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj), inputTokens: 1000, outputTokens: 100 });
  const scripted = (replies: LlmCall[]) => { let n = 0; const fn = async () => replies[n++]!; return Object.assign(fn, { calls: () => n }); };

  it('uses only the cheap model when it is confident', async () => {
    const first = scripted([reply({ items: [item(0.95)] })]);
    const second = scripted([]);
    const out = await extract(input, 'sys', models, { firstPass: first, escalation: second });
    expect(out).toMatchObject({ escalated: false, failed: false });
    expect(out.items).toHaveLength(1);
    expect(second.calls()).toBe(0);
  });
  it('retries a malformed reply once, then succeeds', async () => {
    const first = scripted([reply('not json'), reply({ items: [] })]);
    const out = await extract(input, 'sys', models, { firstPass: first, escalation: scripted([]) });
    expect(first.calls()).toBe(2);
    expect(out.failed).toBe(false);
    expect(out.usage.map((u) => u.purpose)).toEqual(['extract', 'extract_retry']);
  });
  it('escalates to the stronger model when the cheap one is unsure', async () => {
    const out = await extract(input, 'sys', models, { firstPass: scripted([reply({ items: [item(0.5)] })]), escalation: scripted([reply({ items: [item(0.9)] })]) });
    expect(out.escalated).toBe(true);
    expect(out.items[0]!.confidence).toBe(0.9);
  });
  it('gives up after both models fail twice, without throwing', async () => {
    const bad = () => scripted([reply('x'), reply('y')]);
    const out = await extract(input, 'sys', models, { firstPass: bad(), escalation: bad() });
    expect(out).toMatchObject({ failed: true, items: [] });
    expect(out.usage).toHaveLength(4);
  });
  it('survives a model that throws (network error, rate limit)', async () => {
    const boom = async () => { throw new Error('LLM HTTP 429'); };
    const out = await extract(input, 'sys', models, { firstPass: boom, escalation: scripted([reply({ items: [] })]) });
    expect(out).toMatchObject({ failed: false, escalated: true });
  });
  it('estimates cost from token counts', () => {
    expect(estimateCost({ provider: 'groq', model: 'm', usd_per_mtok_in: 1, usd_per_mtok_out: 2 }, 1_000_000, 500_000)).toBe(2);
  });
  it('the versioned prompt file loads and mentions the review queue rule', () => {
    expect(loadPrompt(models.prompt_version)).toContain('review queue');
  });
});

describe('item mapping', () => {
  const base = { title: 'T', summary: 's', kind: 'task' as const, start_local: null, end_local: null, due_local: '2026-11-13T17:00', due_precision: 'exact' as const, course: null, priority: 'medium' as const, priority_reason: 'r', category: 'study' as const, action_required: true, confidence: 0.9 };
  it('tasks get due_at, events get start/end, and all-day is detected', () => {
    expect(toItemRow(base, NY, 0.6)).toMatchObject({ due_at: '2026-11-13T22:00:00Z', start_at: null, all_day: false, review_state: 'accepted' });
    const ev = toItemRow({ ...base, kind: 'event', due_local: null, start_local: '2026-11-12T15:00', end_local: '2026-11-12T16:00' }, NY, 0.6);
    expect(ev).toMatchObject({ start_at: '2026-11-12T20:00:00Z', end_at: '2026-11-12T21:00:00Z', due_at: null, all_day: false });
    expect(toItemRow({ ...base, kind: 'event', due_local: null, start_local: '2026-11-19' }, NY, 0.6).all_day).toBe(true);
  });
  it('low confidence and cancellations go to Needs review', () => {
    expect(toItemRow({ ...base, confidence: 0.59 }, NY, 0.6).review_state).toBe('needs_review');
    expect(toItemRow({ ...base, cancelled: true }, NY, 0.6).review_state).toBe('needs_review');
  });
});

describe('cleaning and redaction', () => {
  const e10 = loadFixtures().find((f) => f.id === 'e10')!;
  it('removes quoted replies and signatures', () => {
    const out = cleanBody(e10.body, 6000);
    expect(out).toContain('review my section');
    expect(out).not.toContain('earlier message');
    expect(out).not.toContain('Sent from my iPhone');
    expect(out).not.toMatch(/wrote:/);
  });
  it('only the newest message of a long chain reaches the model', () => {
    const out = cleanBody(loadFixtures().find((f) => f.id === 'e17')!.body, 6000);
    expect(out).toContain('Friday noon');
    expect(out).not.toContain('October');
  });
  it('truncates very long bodies', () => {
    expect(cleanBody('word '.repeat(5000), 6000).length).toBeLessThan(6100);
  });
  it('masks cards, passwords, account numbers and codes, and leaves ordinary numbers alone', () => {
    expect(redact('card 4111 1111 1111 1111 thanks')).toBe('card [CARD] thanks');
    expect(redact('My login password is hunter2 ok')).toBe('My login password is [REDACTED] ok');
    expect(redact('Account number: 4481 2290 115.')).toBe('Account number: [ACCOUNT].');
    expect(redact('Your verification code is 481920')).toBe('Your verification code is [CODE]');
    expect(redact('Due November 24, 2026 at 11:59 PM, room 204, $84.12')).toBe('Due November 24, 2026 at 11:59 PM, room 204, $84.12');
    expect(redact('order 1234567890123456')).toBe('order 1234567890123456'); // 16 digits but fails the card checksum
  });
  it('the payload for e10 contains no password and no quoted thread', () => {
    const msg = fixtureToMessage(e10);
    const payload = buildUserPrompt({ from: msg.from, subject: msg.subject, receivedAnchor: formatAnchor(msg.receivedAt, NY), body: redact(cleanBody(msg.bodyText, 6000)), existing: [] });
    expect(payload).not.toContain('hunter2');
    expect(payload).toContain('Received: Tuesday 2026-11-10 10:00 (America/New_York)');
  });
  it('turns HTML into text', () => {
    expect(htmlToText('<style>p{}</style><p>Due&nbsp;<b>Friday</b></p>').replace(/\s+/g, ' ').trim()).toBe('Due Friday');
  });
});

describe('pre-LLM filter', () => {
  const fixtures = loadFixtures();
  it('has at least 30 fixtures covering every required type', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    const types = new Set(fixtures.map((f) => f.type));
    for (const t of ['deadline', 'invite', 'reschedule', 'cancellation', 'newsletter', 'receipt', 'multi', 'relative', 'long_chain', 'non_english']) expect(types.has(t)).toBe(true);
  });
  for (const f of loadFixtures()) {
    it(`${f.id} ${f.type}: ${f.expect.filter}`, () => {
      expect(filterMessage(fixtureToMessage(f)).decision).toBe(f.expect.filter);
    });
  }
  it('never filters out an email that contains a real action item', () => {
    for (const f of fixtures.filter((x) => x.expect.items > 0)) expect(filterMessage(fixtureToMessage(f)).decision).toBe('pass');
  });
  it('applies my sender rules, with allow beating everything else', () => {
    const promo = fixtureToMessage(fixtures.find((f) => f.id === 'e27')!);
    expect(filterMessage(promo, [{ pattern: '@shoebarn.example', action: 'allow' }]).decision).toBe('pass');
    const real = fixtureToMessage(fixtures.find((f) => f.id === 'e01')!);
    expect(filterMessage(real, [{ pattern: 'dw@university.example', action: 'block' }])).toEqual({ decision: 'skip', reason: 'sender_blocklist' });
  });
  it('skips mail that is not in the inbox', () => {
    expect(filterMessage({ ...fixtureToMessage(fixtures[0]!), labels: ['SENT'] }).reason).toBe('not_inbox');
  });
});

describe('gmail message parsing', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  it('prefers the plain-text part and ignores attachments', () => {
    const msg = parseGmailMessage({
      id: 'm1', threadId: 't1', labelIds: ['INBOX'], internalDate: '1794322800000',
      payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'A <a@b.c>' }, { name: 'Subject', value: 'Hello' }, { name: 'List-Unsubscribe', value: '<x>' }],
        parts: [
          { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('plain body é') } }, { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } }] },
          { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('attachment text') } },
        ] },
    });
    expect(msg).toMatchObject({ id: 'm1', threadId: 't1', from: 'A <a@b.c>', subject: 'Hello', bodyText: 'plain body é' });
    expect(msg.headers['list-unsubscribe']).toBe('<x>');
    expect(msg.receivedAt.toISOString()).toBe('2026-11-10T15:00:00.000Z');
  });
  it('falls back to HTML when there is no plain part', () => {
    const msg = parseGmailMessage({ id: 'm2', payload: { mimeType: 'text/html', headers: [], body: { data: b64('<div>Only <b>html</b></div>') } } });
    expect(msg.bodyText.replace(/\s+/g, ' ').trim()).toBe('Only html');
  });
});

describe('delta sync cursor', () => {
  const api = (over: Partial<GmailApi>): GmailApi => ({
    getProfile: async () => ({ emailAddress: 'me@example.com', historyId: '900' }),
    listMessageIds: async () => ['new3', 'new2', 'old1'],
    listAddedSince: async () => ({ ids: ['d1', 'd2'], historyId: '905' }),
    getMessage: async () => null,
    ...over,
  });
  it('first run backfills the last N days, oldest first, and saves the cursor read before listing', async () => {
    let query = '';
    const plan = await planSync(api({ listMessageIds: async (q) => { query = q; return ['new3', 'new2', 'old1']; } }), { cursor: {}, backfillDone: false }, 30);
    expect(query).toBe('in:inbox newer_than:30d');
    expect(plan).toEqual({ ids: ['old1', 'new2', 'new3'], nextCursor: { historyId: '900' }, kind: 'backfill' });
  });
  it('later runs ask only for what changed since the cursor and never list the mailbox', async () => {
    let listed = false;
    let since = '';
    const plan = await planSync(api({ listMessageIds: async () => { listed = true; return []; }, listAddedSince: async (h) => { since = h; return { ids: ['d1', 'd2'], historyId: '905' }; } }), { cursor: { historyId: '850' }, backfillDone: true }, 30);
    expect(since).toBe('850');
    expect(listed).toBe(false);
    expect(plan).toEqual({ ids: ['d1', 'd2'], nextCursor: { historyId: '905' }, kind: 'delta' });
  });
  it('with nothing new, the cursor still moves forward', async () => {
    const plan = await planSync(api({ listAddedSince: async () => ({ ids: [], historyId: null }) }), { cursor: { historyId: '850' }, backfillDone: true }, 30);
    expect(plan).toEqual({ ids: [], nextCursor: { historyId: '900' }, kind: 'delta' });
  });
  it('recovers from an expired cursor with a 7-day window instead of a full re-read', async () => {
    let query = '';
    const plan = await planSync(api({ listAddedSince: async () => { throw new HistoryExpiredError(); }, listMessageIds: async (q) => { query = q; return ['b', 'a']; } }), { cursor: { historyId: '1' }, backfillDone: true }, 30);
    expect(query).toBe('in:inbox newer_than:7d');
    expect(plan).toEqual({ ids: ['a', 'b'], nextCursor: { historyId: '900' }, kind: 'recovery' });
  });
});

describe('brightspace feed', () => {
  const events = parseIcs(readFileSync(join(fixturesDir, 'brightspace.ics'), 'utf8'));
  it('reads all five fixture events, unfolding wrapped lines and unescaping commas', () => {
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ summary: 'Homework 8 - Due', location: 'Data Structures and Algorithms, Section A', allDay: false });
    expect(events[0]!.description).toContain('db=551234&grpid=0'); // the folded line was joined
  });
  it('detects all-day events and event types', () => {
    expect(events[3]!.allDay).toBe(true);
    expect(events.map(classify)).toEqual(['assignment', 'quiz', 'quiz', 'exam', 'other']);
  });
  it('the report keeps course names but scrubs ids and tokens from links', () => {
    const report = summarizeFeed(events);
    expect(report).toContain('Events in feed: 5');
    expect(report).toContain('"… - Due": 2');
    expect(report).toContain('"… - Available": 1');
    expect(report).not.toMatch(/551234|412345|77123/);
  });
});

describe('gmail rate limits', () => {
  afterEach(() => vi.unstubAllGlobals());
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const quota = { error: { message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'" } };

  it('waits and retries when Gmail says the per-minute quota is exceeded (the error from the first big dry-run)', async () => {
    const replies = [res(403, quota), res(429, { error: { message: 'Too many requests' } }), res(200, { emailAddress: 'me@example.com', historyId: 7 })];
    const fetchMock = vi.fn(async () => replies.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    const profile = await makeGmailApi('token', { baseDelayMs: 1, paceMs: 0 }).getProfile();
    expect(profile).toEqual({ emailAddress: 'me@example.com', historyId: '7' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('gives up after six attempts with the real error', async () => {
    const fetchMock = vi.fn(async () => res(403, quota));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeGmailApi('token', { baseDelayMs: 1, paceMs: 0 }).getProfile()).rejects.toThrow(/Quota exceeded/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it('does not retry a real permission error', async () => {
    const fetchMock = vi.fn(async () => res(403, { error: { message: 'Request had insufficient authentication scopes.' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeGmailApi('token', { baseDelayMs: 1, paceMs: 0 }).getProfile()).rejects.toBeInstanceOf(GmailError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { applyItem, findDuplicate, MemoryStore, titleSimilarity, type ApplyContext } from '../src/pipeline/store.js';
import { renderDryRun } from '../src/pipeline/report.js';
import type { ExtractedItem } from '../src/pipeline/schema.js';

describe('per-event timezones', () => {
  const base: ExtractedItem = { title: 'Attend Joji concert', summary: 's', kind: 'event', start_local: '2026-11-14T19:00', end_local: null, due_local: null, due_precision: 'exact', course: null, priority: 'medium', priority_reason: 'r', category: 'personal', action_required: false, confidence: 0.95 };
  it('a Sydney concert is 7 PM in Sydney even when my timezone is New York', () => {
    const row = toItemRow({ ...base, timezone: 'Australia/Sydney' }, NY, 0.6);
    expect(row.start_at).toBe('2026-11-14T08:00:00Z'); // 19:00 AEDT
    expect(row.timezone).toBe('Australia/Sydney');
  });
  it('without a stated place, the time is read in my timezone', () => {
    const row = toItemRow(base, NY, 0.6);
    expect(row.start_at).toBe('2026-11-15T00:00:00Z'); // 19:00 EST
    expect(row.timezone).toBeNull();
  });
  it('a flight departs in one timezone and lands in another', () => {
    const row = toItemRow({ ...base, title: 'Fly SYD to JFK', start_local: '2026-11-29T21:40', end_local: '2026-11-29T22:55', timezone: 'Australia/Sydney', end_timezone: 'America/New_York' }, SYD, 0.6);
    expect(row.start_at).toBe('2026-11-29T10:40:00Z');
    expect(row.end_at).toBe('2026-11-30T03:55:00Z');
    expect(Date.parse(row.end_at!)).toBeGreaterThan(Date.parse(row.start_at!)); // lands "an hour later" on the clock, 17 hours later in reality
  });
  it('ignores a made-up timezone name', () => {
    expect(toItemRow({ ...base, timezone: 'Sydney time' }, NY, 0.6).timezone).toBeNull();
    expect(toItemRow({ ...base, timezone: 'Mars/Olympus' }, NY, 0.6).timezone).toBeNull();
  });
});

describe('duplicate detection (titles taken from the real dry-run)', () => {
  const ev = (title: string, start_at: string) => ({ id: title, title, kind: 'event' as const, start_at, due_at: null });
  const task = (title: string, due_at: string | null) => ({ id: title, title, kind: 'task' as const, start_at: null, due_at });
  it('merges the two Joji emails and the two Screamfest emails', () => {
    expect(findDuplicate(ev('Attend Joji concert at Afterpay Arena', '2026-11-14T08:00:00Z'), [ev('Attend Joji concert at Afterpay Arena, Sydney', '2026-11-14T08:00:00Z')])).not.toBeNull();
    expect(findDuplicate(ev('Attend Screamfest Halloween Festival at Manning Bar, Sydney', '2026-10-31T06:00:00Z'), [ev('Attend SCREAMFEST SYDNEY - Halloween Festival', '2026-10-31T06:00:00Z')])).not.toBeNull();
  });
  it('merges repeated password reminders', () => {
    expect(findDuplicate(task('Change NYU NetID password before it expires', '2026-11-07T04:59:00Z'), [task('Change NYU NetID password before it expires', '2026-11-07T04:59:00Z')])).not.toBeNull();
  });
  it('keeps different things apart', () => {
    const wed = '2026-11-12T04:59:00Z';
    expect(findDuplicate(task('Submit Homework 9', wed), [task('Submit Homework 8', wed)])).toBeNull(); // different number
    expect(findDuplicate(task('Submit Lab 9 report', wed), [task('Submit Lab 9 pre-work', wed)])).toBeNull(); // different words
    expect(findDuplicate(task('Change NYU NetID password before it expires', '2027-11-07T04:59:00Z'), [task('Change NYU NetID password before it expires', '2026-11-07T04:59:00Z')])).toBeNull(); // a year apart
    expect(findDuplicate(ev('Attend Joji concert', '2026-11-14T08:00:00Z'), [task('Attend Joji concert', '2026-11-14T08:00:00Z')])).toBeNull(); // event vs task
    expect(findDuplicate(task('Reply to Anna about lunch', null), [task('Reply to Sam about the deck', null)])).toBeNull();
  });
  it('similarity ignores case, punctuation and filler words', () => {
    expect(titleSimilarity('Pay the Chase card bill', 'pay chase card bill!')).toBe(1);
  });
});

describe('what an extracted item does to the calendar', () => {
  const NOW = new Date('2026-11-10T04:00:00Z');
  const item = (over: Partial<ExtractedItem>): ExtractedItem => ({ title: 'Change NYU NetID password before it expires', summary: 's', kind: 'task', start_local: null, end_local: null, due_local: '2026-11-20', due_precision: 'date_only', course: null, priority: 'high', priority_reason: 'r', category: 'admin', action_required: true, confidence: 0.95, ...over });
  const ctx = (store: MemoryStore, ref: string, over: Partial<ApplyContext> = {}): ApplyContext => ({ knownIds: new Set(store.items.map((i) => i.id)), threadKey: `src:${ref}`, src: { ref, link: 'l', sourceId: null, messageRowId: null }, skipPast: false, now: NOW, ...over });
  const run = (store: MemoryStore, it: ExtractedItem, ref: string, over: Partial<ApplyContext> = {}) => applyItem(store, it, toItemRow(it, NY, 0.6), ctx(store, ref, over));

  it('nine reminder emails in nine threads become one item with nine sources', async () => {
    const store = new MemoryStore();
    const actions: string[] = [];
    for (let n = 1; n <= 9; n++) actions.push((await run(store, item({}), `m${n}`)).action);
    expect(actions).toEqual(['created', ...Array(8).fill('merged')]);
    expect(store.items).toHaveLength(1);
    expect(store.items[0]!.sources).toHaveLength(9);
  });
  it('"your password has been changed" marks the open task done', async () => {
    const store = new MemoryStore();
    const { itemId } = await run(store, item({}), 'm1');
    const done = await run(store, item({ updates_item_id: itemId, resolved: true }), 'm2');
    expect(done.action).toBe('completed');
    expect(store.items[0]!.status).toBe('done');
    expect((await store.context('other', NY, NOW)).length).toBe(0); // done items are no longer offered to the model
  });
  it('a "done" email with nothing to close creates nothing', async () => {
    const store = new MemoryStore();
    expect((await run(store, item({ resolved: true }), 'm1')).action).toBe('ignored');
    expect(store.items).toHaveLength(0);
  });
  it('a reschedule updates the item instead of adding a second one', async () => {
    const store = new MemoryStore();
    const { itemId } = await run(store, item({ title: 'Submit Essay 2 draft', due_local: '2026-11-13T17:00', due_precision: 'exact' }), 'm1');
    const out = await run(store, item({ title: 'Submit Essay 2 draft', due_local: '2026-11-16T23:59', due_precision: 'exact', updates_item_id: itemId }), 'm2');
    expect(out.action).toBe('updated');
    expect(store.items).toHaveLength(1);
    expect(store.items[0]!.row.due_at).toBe('2026-11-17T04:59:00Z');
  });
  it('a cancellation keeps the item, marked cancelled and waiting for my confirmation', async () => {
    const store = new MemoryStore();
    const { itemId } = await run(store, item({}), 'm1');
    expect((await run(store, item({ updates_item_id: itemId, cancelled: true }), 'm2')).action).toBe('cancelled');
    expect(store.items[0]).toMatchObject({ status: 'cancelled', row: { review_state: 'needs_review' } });
  });
  it('the model cannot update an item it was not shown', async () => {
    const store = new MemoryStore();
    const out = await run(store, item({ updates_item_id: '11111111-1111-4111-8111-111111111111' }), 'm1');
    expect(out.action).toBe('created');
  });
  it('during the first 30-day read, things already in the past are skipped; afterwards they are not', async () => {
    const store = new MemoryStore();
    const past = item({ title: 'Attend Screamfest', kind: 'event', due_local: null, start_local: '2026-10-31T17:00', timezone: 'Australia/Sydney' });
    expect((await run(store, past, 'm1', { skipPast: true })).action).toBe('skipped_past');
    expect((await run(store, item({}), 'm2', { skipPast: true })).action).toBe('created'); // future deadline still created
    expect((await run(store, past, 'm3', { skipPast: false })).action).toBe('created');
  });
});

describe('dry-run report', () => {
  it('shows created items in their own timezone and lists merges and skips separately', () => {
    const mk = (title: string, action: any, over = {}) => ({ ...toItemRow({ title, summary: 's', kind: 'event', start_local: '2026-11-14T19:00', end_local: null, due_local: null, due_precision: 'exact', course: null, priority: 'medium', priority_reason: 'r', category: 'personal', action_required: false, confidence: 0.95, timezone: 'Australia/Sydney', ...over }, NY, 0.6), action });
    const entry = (subject: string, items: any[]) => ({ receivedAt: new Date(), from: 'StubHub <a@b.c>', subject, filter: 'pass', escalated: false, items });
    const md = renderDryRun([entry('Tickets on the way', [mk('Attend Joji concert', 'created')]), entry('Tickets ready', [mk('Attend Joji concert at Afterpay Arena', 'merged')]), entry('Old', [mk('Attend Screamfest', 'skipped_past')]), { ...entry('Promo', []), filter: 'gmail_promotions' }], NY, 'me@example.com', 0.01, '');
    expect(md).toContain('| Attend Joji concert | event | starts Sat 14 Nov, 7:00 PM Sydney time |');
    expect(md).toContain('Items that would be created: 1 commitments and 0 possibles on the calendar');
    expect(md).toContain('Repeat emails merged into an existing item: 1');
    expect(md).toContain('Not created because the date had already passed: 1');
    expect(md).toContain('## Merged into an item listed earlier');
  });
});

describe('filter: order emails that announce a change', () => {
  const msg = (subject: string) => ({ id: 'x', threadId: 'x', labels: ['INBOX'], headers: {}, from: 'StubHub <a@b.c>', subject, receivedAt: new Date(), bodyText: 'Details inside.' });
  it('passes "Important update regarding your Order" to the AI but still skips a plain receipt', () => {
    expect(filterMessage(msg('Important update regarding your Order# 650518710')).decision).toBe('pass');
    expect(filterMessage(msg('Thanks for your order - Order #658817540')).decision).toBe('skip');
  });
});

import { mapFeed } from '../src/brightspace/map.js';
import { syncBrightspace } from '../src/brightspace/sync.js';

describe('brightspace feed to calendar items', () => {
  const text = readFileSync(join(fixturesDir, 'brightspace.ics'), 'utf8');
  const NOW = new Date('2026-11-10T04:00:00Z');
  const ev = (over: Record<string, unknown>) => ({ uid: 'u1', summary: 'Lab 3 - Due', description: '', location: 'Physics', dtstart: '20261120T045900Z', dtend: '', allDay: false, tzid: null, fields: [], ...over }) as any;

  it('maps the fixture feed: due dates become tasks, sittings become events, "Available" is ignored', () => {
    const { items, skipped } = mapFeed(parseIcs(text), NY, NOW);
    expect(skipped).toEqual({ opens_only: 1 });
    expect(items.map((i) => [i.row.kind, i.row.title, i.row.priority])).toEqual([
      ['task', 'Homework 8', 'medium'],
      ['task', 'Quiz 7', 'medium'],
      ['event', 'Midterm Exam 2', 'high'],
      ['event', 'Guest lecture: embedded security', 'medium'],
    ]);
    const hw = items[0]!;
    expect(hw.row).toMatchObject({ due_at: '2026-11-14T04:59:00Z', due_precision: 'exact', category: 'study', action_required: true, course: 'Data Structures and Algorithms, Section A' });
    expect(hw.link).toContain('folder_submit_files');
    expect(hw.row.summary).not.toContain('http');
    expect(items[2]!.row).toMatchObject({ all_day: true, start_at: '2026-11-19T05:00:00Z', end_at: null }); // all day on the 19th, New York
    expect(items[3]!.row).toMatchObject({ start_at: '2026-11-12T19:00:00Z', end_at: '2026-11-12T20:15:00Z' });
  });
  it('an 11:59 PM New York deadline stays on the right day (the old workflow stored it a day late)', () => {
    const { items } = mapFeed(parseIcs(text), NY, NOW);
    expect(utcToLocal(items[0]!.row.due_at, NY)).toBe('2026-11-13T23:59');
  });
  it('"Availability Ends" is a deadline only when there is no Due entry for the same thing', () => {
    const alone = mapFeed([ev({ summary: 'Reading quiz - Availability Ends' })], NY, NOW);
    expect(alone.items[0]!.row).toMatchObject({ kind: 'task', title: 'Reading quiz', priority_reason: 'Course item; closes then' });
    const both = mapFeed([ev({ summary: 'Reading quiz - Due' }), ev({ uid: 'u2', summary: 'Reading quiz - Availability Ends', dtstart: '20261121T045900Z' })], NY, NOW);
    expect(both.items).toHaveLength(1);
    expect(both.skipped).toEqual({ closes_but_has_due_date: 1 });
  });
  it('leaves out things already more than a day past, reads TZID times, and pulls a course code when there is one', () => {
    expect(mapFeed([ev({ dtstart: '20261101T045900Z' })], NY, NOW).skipped).toEqual({ already_past: 1 });
    const local = mapFeed([ev({ summary: 'Recitation', dtstart: '20261112T140000', tzid: 'America/New_York', location: 'CS-UY 1134 Data Structures' })], SYD, NOW).items[0]!;
    expect(local.row).toMatchObject({ kind: 'event', start_at: '2026-11-12T19:00:00Z', course: 'CS-UY 1134' });
  });
  it('an all-day due date means the end of that day where I am', () => {
    const it2 = mapFeed([ev({ dtstart: '20261120', allDay: true })], SYD, NOW).items[0]!;
    expect(it2.row).toMatchObject({ due_at: '2026-11-20T12:59:00Z', due_precision: 'date_only' });
  });
});

describe('brightspace sync', () => {
  const feed = readFileSync(join(fixturesDir, 'brightspace.ics'), 'utf8');
  function setup() {
    const store = new MemoryStore();
    const source: any = { id: 's1', label: 'Brightspace', account: 'brightspace.example', status: 'active', cursor: {}, backfill_done: false, last_success_at: null };
    const alerts: string[] = [];
    const db: any = {
      startRun: async () => 'run', finishRun: async () => {}, getSecret: async () => 'https://feed.example/secret-token',
      updateSource: async (_id: string, patch: any) => Object.assign(source, patch),
      alert: async (kind: string) => { alerts.push(kind); },
      itemIdBySourceRef: async (_t: string, ref: string) => store.items.find((i) => i.sources.includes(ref))?.id ?? null,
    };
    const serve = (body: string, status = 200) => async () => ({ ok: status < 400, status, text: async () => body });
    return { store, source, db, alerts, serve };
  }
  // The fixture's dates are in November 2026; these tests run "now", so use a copy moved far into the future.
  const future = feed.replace(/2026(\d{4})/g, '2099$1');

  it('first sync creates the items; an identical feed afterwards does no work', async () => {
    const t = setup();
    const first = await syncBrightspace(t.db, t.store, t.source, NY, t.serve(future));
    expect(first).toMatchObject({ events: 5, created: 4, linked_to_existing: 0 });
    expect(t.source).toMatchObject({ status: 'active', backfill_done: true });
    const again = await syncBrightspace(t.db, t.store, t.source, NY, t.serve(future));
    expect(again.unchanged).toBe(true);
    expect(t.store.items).toHaveLength(4);
  });
  it('a moved deadline updates the same item instead of adding another', async () => {
    const t = setup();
    await syncBrightspace(t.db, t.store, t.source, NY, t.serve(future));
    const moved = future.replace('DTSTART:20991114T045900Z', 'DTSTART:20991117T045900Z');
    const out = await syncBrightspace(t.db, t.store, t.source, NY, t.serve(moved));
    expect(out).toMatchObject({ created: 0, checked: 4 });
    expect(t.store.items).toHaveLength(4);
    expect(t.store.items.find((i) => i.row.title === 'Homework 8')!.row.due_at).toBe('2099-11-17T04:59:00Z');
  });
  it('a deadline an email already produced is linked, not duplicated, and the feed then keeps its date', async () => {
    const t = setup();
    const emailRow = toItemRow({ title: 'Submit Homework 8 on Brightspace', summary: 's', kind: 'task', start_local: null, end_local: null, due_local: '2099-11-13T23:59', due_precision: 'exact', course: null, priority: 'medium', priority_reason: 'r', category: 'study', action_required: true, confidence: 0.9 }, NY, 0.6);
    await t.store.insert(emailRow, 'gmail:thread1');
    const out = await syncBrightspace(t.db, t.store, t.source, NY, t.serve(future));
    expect(out).toMatchObject({ created: 3, linked_to_existing: 1 });
    expect(t.store.items).toHaveLength(4);
    const moved = future.replace('DTSTART:20991114T045900Z', 'DTSTART:20991117T045900Z');
    await syncBrightspace(t.db, t.store, t.source, NY, t.serve(moved));
    expect(t.store.items[0]!.row.due_at).toBe('2099-11-17T04:59:00Z');
    expect(t.store.items).toHaveLength(4);
  });
  it('a dead feed address marks Brightspace as needing attention and raises one alert', async () => {
    const t = setup();
    await syncBrightspace(t.db, t.store, t.source, NY, t.serve('gone', 404));
    expect(t.source.status).toBe('needs_reauth');
    expect(t.alerts).toEqual(['needs_reauth']);
    expect(t.source.last_error).not.toContain('secret-token'); // the address never ends up in an error
  });
  it('a page that is not a calendar is an error, not an empty calendar', async () => {
    const t = setup();
    await syncBrightspace(t.db, t.store, t.source, NY, t.serve('<html>Sign in</html>'));
    expect(t.source.status).toBe('active');
    expect(t.source.last_error).toContain('did not return a calendar');
    expect(t.store.items).toHaveLength(0);
  });
});

import { isBulk } from '../src/pipeline/filter.js';

describe('bulk mail', () => {
  const me = 'tsb5911@nyu.edu';
  const msg = (from: string, headers: Record<string, string> = {}) => ({ id: 'x', threadId: 'x', labels: ['INBOX'], headers, from, subject: 's', receivedAt: new Date(), bodyText: 'b' });
  it('recognises newsletters, list mail, no-reply senders and mail not addressed to me', () => {
    expect(isBulk(msg('Tandon GLASS <glass@nyu.edu>', { 'list-unsubscribe': '<x>' }), me)).toBe(true);
    expect(isBulk(msg('Club <club@nyu.edu>', { 'list-id': '<club.nyu.edu>' }), me)).toBe(true);
    expect(isBulk(msg('Brightspace <noreply@mail.brightspace.nyu.edu>', { to: me }), me)).toBe(true);
    expect(isBulk(msg('NYU Sydney <sydney@nyu.edu>', { to: 'sydney-students@nyu.edu' }), me)).toBe(true);
    expect(isBulk(msg('Dean <dean@nyu.edu>', { precedence: 'bulk', to: me }), me)).toBe(true);
  });
  it('treats mail from a person to me as personal', () => {
    expect(isBulk(msg('Jessica Pascual <jp@nyu.edu>', { to: `Taranjot <${me}>` }), me)).toBe(false);
    expect(isBulk(msg('Alisa <alisa@nyu.edu>', { to: 'someone@nyu.edu', cc: me.toUpperCase() }), me)).toBe(false);
    expect(isBulk(msg('Mom <mom@family.example>'), me)).toBe(false); // no To header to judge by
  });
  it('sends bulk mail to the cheaper model and tells the model it is bulk', async () => {
    const models = { ...loadModels(), escalate_below_confidence: 0 };
    const used: string[] = [];
    const fn = (name: string) => async (_s: string, user: string) => { used.push(`${name}:${/Bulk mail: (yes|no)/.exec(user)![1]}`); return { text: '{"items":[]}', inputTokens: 100, outputTokens: 10 }; };
    const llm = { firstPass: fn('sonnet'), escalation: fn('sonnet'), bulk: fn('haiku') };
    const base = { from: 'a', subject: 's', receivedAnchor: 'r', body: 'b', existing: [] };
    const bulk = await extract({ ...base, bulk: true }, 'sys', models, llm);
    await extract({ ...base, bulk: false }, 'sys', models, llm);
    expect(used).toEqual(['haiku:yes', 'sonnet:no']);
    expect(bulk.usage[0]).toMatchObject({ purpose: 'extract_bulk', model: models.bulk!.model });
  });
  it('a block rule without an @ matches the sender name', () => {
    const wsj = { ...msg('"Emma Tucker, WSJ" <access@interactive.wsj.com>'), labels: ['INBOX'] };
    expect(filterMessage(wsj, [{ pattern: 'WSJ', action: 'block' }])).toEqual({ decision: 'skip', reason: 'sender_blocklist' });
    expect(filterMessage(wsj, [{ pattern: 'Handshake', action: 'block' }]).decision).toBe('pass');
  });
  it('cached instructions cost a tenth to re-read', () => {
    const spec = { provider: 'anthropic' as const, model: 'm', usd_per_mtok_in: 3, usd_per_mtok_out: 15 };
    expect(estimateCost(spec, 1000, 0, 2000, 0)).toBeCloseTo((1000 + 200) * 3 / 1e6, 10);
    expect(estimateCost(spec, 1000, 0, 0, 2000)).toBeCloseTo((1000 + 2500) * 3 / 1e6, 10);
  });
  it('the current prompt keeps sales and job listings out entirely', () => {
    const p = loadPrompt(loadModels().prompt_version);
    expect(p).toContain('Leave these out entirely');
    expect(p).toContain('sales and promotions, job listings');
  });
});

describe('possible items', () => {
  const NOW = new Date('2026-11-10T04:00:00Z');
  const base: ExtractedItem = { title: 'Attend CSE Lock-Picking Workshop', summary: 's', kind: 'event', start_local: '2026-11-19T14:00', end_local: null, due_local: null, due_precision: 'exact', course: null, priority: 'high', priority_reason: 'r', category: 'study', action_required: true, confidence: 0.8, timezone: 'America/New_York' };
  it('a possible is stored as optional, low priority, with no action required', () => {
    expect(toItemRow({ ...base, optional: true }, SYD, 0.6)).toMatchObject({ optional: true, priority: 'low', action_required: false });
    expect(toItemRow(base, SYD, 0.6)).toMatchObject({ optional: false, priority: 'high', action_required: true });
  });
  it('a later ticket email for the same event turns the possible into a plan, without duplicating it', async () => {
    const store = new MemoryStore();
    const ctx = (ref: string) => ({ knownIds: new Set<string>(), threadKey: ref, src: { type: 'email' as const, ref, link: 'l', sourceId: null, messageRowId: null }, skipPast: false, now: NOW });
    const possible = toItemRow({ ...base, optional: true }, SYD, 0.6);
    expect((await applyItem(store, { ...base, optional: true }, possible, ctx('digest'))).action).toBe('created');
    expect(store.items[0]!.row.optional).toBe(true);
    const ticket = toItemRow({ ...base, title: 'Attend Lock-Picking Workshop (CSE)' }, SYD, 0.6);
    expect((await applyItem(store, { ...base }, ticket, ctx('ticket'))).action).toBe('merged');
    expect(store.items).toHaveLength(1);
    expect(store.items[0]!.row.optional).toBe(false);
  });
  it('the same advert in two digests is one possible, and stays a possible', async () => {
    const store = new MemoryStore();
    const ctx = (ref: string) => ({ knownIds: new Set<string>(), threadKey: ref, src: { type: 'email' as const, ref, link: 'l', sourceId: null, messageRowId: null }, skipPast: false, now: NOW });
    const row = toItemRow({ ...base, optional: true }, SYD, 0.6);
    await applyItem(store, { ...base, optional: true }, row, ctx('week12'));
    expect((await applyItem(store, { ...base, optional: true }, row, ctx('week13'))).action).toBe('merged');
    expect(store.items[0]!.row.optional).toBe(true);
  });
  it('the current prompt explains commitments and possibles', () => {
    const p = loadPrompt(loadModels().prompt_version);
    expect(p).toContain('"optional": true | false');
    expect(p).toContain('at most the 6 possibles');
  });
});

import { pullBackYear } from '../src/pipeline/dates.js';
describe('a just-passed date is not pushed into next year', () => {
  const received = new Date('2026-11-10T04:00:00Z');
  it('pulls "9 Nov next year" back when the email arrived on 10 Nov (seen in the NYU dry-run)', () => {
    expect(pullBackYear('2027-11-09', received, SYD)).toBe('2026-11-09');
    expect(pullBackYear('2027-10-13T17:00', received, SYD)).toBe('2026-10-13T17:00');
  });
  it('leaves genuine next-year dates, this-year dates and empty values alone', () => {
    expect(pullBackYear('2027-01-17', received, SYD)).toBe('2027-01-17'); // January check-in really is next year
    expect(pullBackYear('2027-05-04', received, SYD)).toBe('2027-05-04');
    expect(pullBackYear('2027-11-20', received, SYD)).toBe('2027-11-20'); // 20 Nov has not happened yet this year, so the model meant it
    expect(pullBackYear('2026-11-13', received, SYD)).toBe('2026-11-13');
    expect(pullBackYear(null, received, SYD)).toBeNull();
  });
});

describe('brightspace: shapes seen in the real NYU feed', () => {
  const NOW = new Date('2026-11-10T04:00:00Z');
  const ev = (over: Record<string, unknown>) => ({ uid: 'u1', summary: 'X', description: '', location: 'L', dtstart: '20261120T045959Z', dtend: '20261120T045959Z', allDay: false, tzid: null, fields: [], ...over }) as any;
  it('a discussion deadline with no "- Due" label is a task, not a zero-length event', () => {
    const { items } = mapFeed([ev({ summary: 'Introduce yourself to the cohort', description: 'Post 2-3 sentences.\n\nDiscussions:\nIntroduce yourself - https://b.example/d2l/le/1/discussions/topics/2/View', location: 'Global Leaders and Scholars in STEM (GLASS) Sophomore Seminar' })], SYD, NOW);
    expect(items[0]!.row).toMatchObject({ kind: 'task', due_at: '2026-11-20T04:59:59Z', priority: 'low', course: 'Global Leaders and Scholars in STEM (GLASS) Sophomore Seminar' });
  });
  it('an all-day entry or one with a real duration is still an event', () => {
    expect(mapFeed([ev({ summary: 'Spring 2027 Classes Begin', dtstart: '20270125', dtend: '20270126', allDay: true })], SYD, NOW).items[0]!.row.kind).toBe('event');
    expect(mapFeed([ev({ summary: 'Review session', dtend: '20261120T060000Z' })], SYD, NOW).items[0]!.row.kind).toBe('event');
  });
  it('"Final Exam Period - May 11th - May 17th" keeps its whole title and spans the days', () => {
    const it2 = mapFeed([ev({ summary: 'Final Exam Period - May 11th - May 17th', dtstart: '20270511', dtend: '20270517', allDay: true })], NY, NOW).items[0]!;
    expect(it2.row).toMatchObject({ title: 'Final Exam Period - May 11th - May 17th', kind: 'event', all_day: true, priority: 'high', end_at: '2027-05-17T03:59:00Z' });
  });
  it('course codes: the short code when there is one', () => {
    const course = (location: string) => mapFeed([ev({ summary: 'HW - Due', location })], NY, NOW).items[0]!.row.course;
    expect(course('CS-UY 1134 - Spring 2026')).toBe('CS-UY 1134');
    expect(course('CS-UY 1122 - S26 - Introduction to Computer Science')).toBe('CS-UY 1122');
    expect(course('EXPOS-UY 1 2025 Fall 125 143-144')).toBe('EXPOS-UY 1');
    expect(course('Info Technology in Business & Society Fall 2026')).toBe('Info Technology in Business & Society Fall 2026');
  });
});

import { dailyNote, reminderNotes, type NotifyItem } from '../src/notify/plan.js';
describe('notifications', () => {
  const S = { timezone: SYD, remind_minutes: 30, daily_summary_time: '08:00' };
  const it0 = (p: Partial<NotifyItem>): NotifyItem => ({ id: 'i1', title: 'Design review', kind: 'event', start_at: null, end_at: null, due_at: null, all_day: false, due_precision: null, location: null, status: 'open', optional: false, timezone: null, ...p });
  const at = (s: string) => new Date(s);

  it('reminds 30 minutes before a timed event, and not earlier or after it has started', () => {
    const ev = it0({ start_at: '2026-11-12T04:00:00Z', location: 'Room 204' }); // 3:00 PM Sydney
    expect(reminderNotes([ev], S, at('2026-11-12T03:29:00Z'))).toEqual([]);
    const [n] = reminderNotes([ev], S, at('2026-11-12T03:30:00Z'));
    expect(n).toEqual({ key: 'rem:i1:2026-11-12T04:00:00Z', title: 'Design review', body: 'Starts in 30 minutes, at 3:00 PM. Room 204', url: '/?item=i1', tag: 'item-i1' });
    expect(reminderNotes([ev], S, at('2026-11-12T03:55:00Z'))[0]!.body).toContain('in 5 minutes');
    expect(reminderNotes([ev], S, at('2026-11-12T04:00:00Z'))).toEqual([]);
  });
  it('a rescheduled event gets a new key, so it is reminded again at its new time', () => {
    const a = reminderNotes([it0({ start_at: '2026-11-12T04:00:00Z' })], S, at('2026-11-12T03:40:00Z'))[0]!.key;
    const b = reminderNotes([it0({ start_at: '2026-11-13T04:00:00Z' })], S, at('2026-11-13T03:40:00Z'))[0]!.key;
    expect(a).not.toBe(b);
  });
  it('tasks with an exact time remind; date-only tasks, all-day events, possibles and done items do not', () => {
    const t = at('2026-11-12T03:40:00Z'), when = '2026-11-12T04:00:00Z';
    expect(reminderNotes([it0({ kind: 'task', due_at: when, due_precision: 'exact', title: 'Submit lab 3' })], S, t)[0]!.body).toBe('Due in 20 minutes, at 3:00 PM');
    expect(reminderNotes([it0({ kind: 'task', due_at: when, due_precision: 'date_only' })], S, t)).toEqual([]);
    expect(reminderNotes([it0({ start_at: when, all_day: true })], S, t)).toEqual([]);
    expect(reminderNotes([it0({ start_at: when, optional: true })], S, t)).toEqual([]);
    expect(reminderNotes([it0({ start_at: when, status: 'done' })], S, t)).toEqual([]);
    expect(reminderNotes([it0({ start_at: when })], { ...S, remind_minutes: 0 }, t)).toEqual([]);
  });
  it('the morning summary is sent at the chosen local time, once per local day, and not hours late', () => {
    const items = [
      it0({ id: 'a', title: 'Data Structures lecture', start_at: '2026-11-11T22:30:00Z' }), // 9:30 AM Thu 12 Nov, Sydney
      it0({ id: 'b', title: 'Joji concert', start_at: '2026-11-12T08:00:00Z' }),
      it0({ id: 'c', kind: 'task', title: 'Submit blog post', due_at: '2026-11-12T12:59:00Z', due_precision: 'date_only' }),
      it0({ id: 'd', kind: 'task', title: 'Old thing', due_at: '2026-11-10T12:59:00Z', due_precision: 'date_only' }),
      it0({ id: 'e', title: 'A possible', start_at: '2026-11-12T01:00:00Z', optional: true }),
    ];
    expect(dailyNote(items, S, at('2026-11-11T20:59:00Z'))).toBeNull(); // 7:59 AM
    const n = dailyNote(items, S, at('2026-11-11T21:00:00Z'))!; // 8:00 AM
    expect(n).toMatchObject({ key: 'daily:2026-11-12', title: 'Thursday 12 November', body: '2 events and 1 task due today. First: Data Structures lecture at 9:30 AM. 1 task overdue.' });
    expect(dailyNote(items, S, at('2026-11-12T00:30:00Z'))).toBeNull(); // 11:30 AM is too late to say good morning
    expect(dailyNote(items, { ...S, daily_summary_time: null }, at('2026-11-11T21:00:00Z'))).toBeNull();
  });
  it('an empty day sends nothing, and the day is judged in my timezone, not UTC', () => {
    expect(dailyNote([], S, at('2026-11-11T21:00:00Z'))).toBeNull();
    const ny = { ...S, timezone: NY };
    const lateEvening = it0({ start_at: '2026-11-12T03:00:00Z' }); // 10 PM Wed 11 Nov in New York, already the 12th in UTC
    expect(dailyNote([lateEvening], ny, at('2026-11-11T13:00:00Z'))!.key).toBe('daily:2026-11-11');
  });
});
