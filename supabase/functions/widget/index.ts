// Supabase Edge Function: widget
// Read-only feed for the home-screen widget: today's and tomorrow's items, already formatted.
// The widget proves who it is with a long random token (header "x-widget-token") created in the app.
// IMPORTANT: turn OFF "Verify JWT" for this function, because the widget has no sign-in session.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Milliseconds that `zone` is ahead of UTC at instant `d`. */
function offsetMs(d: Date, zone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
}
/** The UTC instant of local midnight, `addDays` days from today, in `zone`. */
function localMidnight(now: Date, zone: string, addDays: number): Date {
  const local = new Date(now.getTime() + offsetMs(now, zone));
  const guess = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays));
  return new Date(guess.getTime() - offsetMs(new Date(guess.getTime() - offsetMs(now, zone)), zone));
}

Deno.serve(async (req) => {
  try {
    const token = req.headers.get('x-widget-token') ?? '';
    if (token.length < 32) return json({ error: 'missing token' }, 401);
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
    if (!serviceKey) return json({ error: 'the function has no service key' }, 500);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });
    const { data: owner } = await admin.from('user_settings').select('user_id, timezone').eq('widget_token', token).maybeSingle();
    if (!owner) return json({ error: 'unknown token' }, 401);
    let zone = owner.timezone || 'UTC';
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { zone = 'UTC'; }

    const now = new Date();
    const d0 = localMidnight(now, zone, 0), d1 = localMidnight(now, zone, 1), d2 = localMidnight(now, zone, 2);
    const { data: rows } = await admin.from('items')
      .select('id, title, kind, start_at, end_at, due_at, all_day, due_precision, category, status, optional, origin')
      .eq('user_id', owner.user_id).is('deleted_at', null).eq('review_state', 'accepted').in('status', ['open', 'done'])
      .or(`and(start_at.gte.${d0.toISOString()},start_at.lt.${d2.toISOString()}),and(due_at.gte.${d0.toISOString()},due_at.lt.${d2.toISOString()})`).limit(120);
    const { count: overdue } = await admin.from('items').select('id', { count: 'exact', head: true })
      .eq('user_id', owner.user_id).is('deleted_at', null).eq('review_state', 'accepted').eq('status', 'open').eq('kind', 'task').lt('due_at', d0.toISOString());

    const time = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    const shape = (i: Record<string, unknown>) => {
      const when = (i.start_at ?? i.due_at) as string;
      const untimed = i.kind === 'event' ? !!i.all_day : i.due_precision !== 'exact';
      return {
        id: i.id, title: i.title, kind: i.origin === 'plan' ? 'session' : i.kind, category: i.category, done: i.status === 'done', possible: !!i.optional,
        sort: untimed ? `0${when}` : `1${when}`,
        time: i.kind === 'event' ? (i.all_day ? 'All day' : time(when)) : (i.due_precision === 'exact' ? `Due ${time(when)}` : 'Due'),
        at: when,
      };
    };
    const inDay = (i: Record<string, unknown>, a: Date, b: Date) => { const t = Date.parse((i.start_at ?? i.due_at) as string); return t >= a.getTime() && t < b.getTime(); };
    const list = (a: Date, b: Date) => (rows ?? []).filter((i) => inDay(i, a, b)).map(shape).sort((x, y) => x.sort.localeCompare(y.sort)).map(({ sort: _s, ...rest }) => rest);
    const label = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(d.getTime() + 12 * 3_600_000));

    return json({ generated_at: now.toISOString(), zone, overdue: overdue ?? 0, today: { label: label(d0), items: list(d0, d1) }, tomorrow: { label: label(d1), items: list(d1, d2) } });
  } catch (e) {
    return json({ error: (e as Error).message.slice(0, 200) }, 500);
  }
});
