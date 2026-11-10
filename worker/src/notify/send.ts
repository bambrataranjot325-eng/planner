import webpush from 'web-push';
import { log } from '../config.js';
import type { Db } from '../db.js';
import { dailyNote, reminderNotes, type Note, type NotifyItem, type NotifySettings } from './plan.js';

interface Sub { id: string; endpoint: string; p256dh: string; auth: string }

/** The push key pair is created once and kept: private half in the Vault, public half where the app can read it. */
async function ensureKeys(db: Db): Promise<{ publicKey: string; privateKey: string }> {
  const privateKey = (await db.sb.rpc('get_app_secret', { p_name: 'push:private' })).data as string | null;
  const row = (await db.sb.from('user_settings').select('push_public_key').eq('user_id', db.userId).maybeSingle()).data;
  if (privateKey && row?.push_public_key) return { publicKey: row.push_public_key as string, privateKey };
  const keys = webpush.generateVAPIDKeys();
  const saved = await db.sb.rpc('set_app_secret', { p_name: 'push:private', p_secret: keys.privateKey });
  if (saved.error) throw new Error(`could not store the push key: ${saved.error.message}`);
  await db.sb.from('user_settings').update({ push_public_key: keys.publicKey }).eq('user_id', db.userId);
  log('push_keys_created');
  return keys;
}

async function deliver(db: Db, subs: Sub[], note: Note): Promise<number> {
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(note), { TTL: 3600, urgency: 'high' });
      ok++;
      await db.sb.from('push_subscriptions').update({ last_ok_at: new Date().toISOString() }).eq('id', s.id);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await db.sb.from('push_subscriptions').delete().eq('id', s.id); // the device unsubscribed
      else log('push_failed', { status: status ?? 0, error: (e as Error).message.slice(0, 120) });
    }
  }
  return ok;
}

/** One pass: work out what is due, skip anything already sent, send the rest. Runs every minute. */
export async function notifyOnce(db: Db, defaultZone: string, contact: string): Promise<void> {
  const subs = ((await db.sb.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', db.userId)).data ?? []) as Sub[];
  const keys = await ensureKeys(db); // done even with no devices, so the app can offer "turn on notifications"
  if (!subs.length) return;
  webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);

  const st = (await db.sb.from('user_settings').select('timezone, remind_minutes, daily_summary_time, push_test_at').eq('user_id', db.userId).maybeSingle()).data;
  const settings: NotifySettings = { timezone: (st?.timezone as string) || defaultZone, remind_minutes: Number(st?.remind_minutes ?? 30), daily_summary_time: (st?.daily_summary_time as string | null) ?? null };
  const now = new Date();
  const notes: Note[] = [];

  if (st?.push_test_at && Date.now() - Date.parse(st.push_test_at as string) < 10 * 60_000) {
    notes.push({ key: `test:${st.push_test_at}`, title: 'Notifications are working', body: 'This is the test you asked for. Reminders and the morning summary will arrive like this.', url: '/', tag: 'test' });
  }

  const cols = 'id, title, kind, start_at, end_at, due_at, all_day, due_precision, location, status, optional, timezone';
  const base = () => db.sb.from('items').select(cols).eq('user_id', db.userId).is('deleted_at', null).eq('review_state', 'accepted').eq('status', 'open');
  const soon = new Date(now.getTime() + (settings.remind_minutes + 2) * 60_000).toISOString();
  const upcoming = ((await base().or(`and(start_at.gt.${now.toISOString()},start_at.lte.${soon}),and(due_at.gt.${now.toISOString()},due_at.lte.${soon})`).limit(50)).data ?? []) as NotifyItem[];
  notes.push(...reminderNotes(upcoming, settings, now));

  // The summary needs the whole day, so only fetch it when it could actually be due.
  const probe = dailyNote([{ id: 'x', title: 'x', kind: 'event', start_at: now.toISOString(), end_at: null, due_at: null, all_day: false, due_precision: null, location: null, status: 'open', optional: false, timezone: null }], settings, now);
  if (probe) {
    const lo = new Date(now.getTime() - 60 * 86_400_000).toISOString(), hi = new Date(now.getTime() + 2 * 86_400_000).toISOString();
    const day = ((await base().or(`and(start_at.gte.${new Date(now.getTime() - 86_400_000).toISOString()},start_at.lte.${hi}),and(due_at.gte.${lo},due_at.lte.${hi})`).limit(300)).data ?? []) as NotifyItem[];
    const d = dailyNote(day, settings, now);
    if (d) notes.push(d);
  }

  const alerts = (await db.sb.from('alerts').select('id, kind, message').eq('user_id', db.userId).is('acknowledged_at', null).gte('created_at', new Date(now.getTime() - 86_400_000).toISOString()).limit(10)).data ?? [];
  for (const a of alerts) notes.push({ key: `alert:${a.id}`, title: a.kind === 'spend_cap' ? 'AI budget reached' : a.kind === 'needs_reauth' ? 'A source needs attention' : 'Planner', body: String(a.message).slice(0, 180), url: '/', tag: `alert-${a.id}` });

  if (!notes.length) return;
  const already = new Set((((await db.sb.from('notifications_sent').select('key').eq('user_id', db.userId).in('key', notes.map((n) => n.key))).data ?? []) as { key: string }[]).map((r) => r.key));
  for (const note of notes.filter((n) => !already.has(n.key))) {
    // Record first: if two passes ever overlap, the second finds the key and stays quiet.
    const claim = await db.sb.from('notifications_sent').insert({ user_id: db.userId, key: note.key });
    if (claim.error) continue;
    const ok = await deliver(db, subs, note);
    log('notified', { kind: note.key.split(':')[0], devices: ok });
  }
}

/** Runs beside the 15-minute sync, on its own one-minute beat, so reminders are on time. */
export function startNotifier(db: Db, defaultZone: string, contact: string, stopped: () => boolean): void {
  let busy = false;
  const tick = async () => {
    if (busy || stopped()) return;
    busy = true;
    try { await notifyOnce(db, defaultZone, contact); } catch (e) { log('notify_error', { error: (e as Error).message.slice(0, 200) }); }
    busy = false;
  };
  void tick();
  const id = setInterval(() => { if (stopped()) clearInterval(id); else void tick(); }, 60_000);
  id.unref();
}
