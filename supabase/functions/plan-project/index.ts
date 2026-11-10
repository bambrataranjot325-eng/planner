// Supabase Edge Function: plan-project
// Turns a project description into milestones with hour estimates. It only estimates the work;
// the app does the scheduling, so nothing here can double-book the calendar.
//
// Secrets to set (Edge Functions > Secrets): ANTHROPIC_API_KEY. Optional: PLANNER_MODEL.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const MODEL = Deno.env.get('PLANNER_MODEL') ?? 'claude-sonnet-4-6';
const PRICE_IN = 3, PRICE_OUT = 15; // USD per million tokens, for the spend log
const PROMPT = `You size up a piece of work for one student so it can be scheduled. Given a project's name, description, course and deadline, break it into 3 to 7 milestones in the order they should be done, each with a realistic estimate of focused hours for one person.

Return ONLY a JSON object, no prose and no code fences:
{"milestones": [{"title": "short imperative phrase, max 50 characters", "hours": number}], "rationale": "one or two plain sentences on how you sized it"}

Rules:
- Estimate focused working time, not elapsed time. Use quarter-hour steps.
- Size from what the description says (word counts, problem sets, slides, experiments). If it says little, give a modest estimate and say in the rationale what you assumed.
- Include the unglamorous parts: understanding the brief, checking and proofreading, submitting.
- Do not pad. A weekly problem set is a few hours; a term paper is tens of hours.
- Total must be between 0.5 and 200 hours.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!serviceKey) return json({ error: 'the function has no service key' }, 500);
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not set for this function' }, 500);

    // Who is asking? The token from the signed-in app is checked with Supabase Auth.
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(token);
    const user = auth?.user;
    if (!user) return json({ error: 'not signed in' }, 401);

    // Spend cap and a simple rate limit, shared with the email worker's log.
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const { data: usage } = await admin.from('llm_usage').select('est_cost_usd, created_at, purpose').eq('user_id', user.id).gte('created_at', monthStart.toISOString());
    const { data: settings } = await admin.from('user_settings').select('llm_monthly_cap_usd').eq('user_id', user.id).maybeSingle();
    const cap = Number(settings?.llm_monthly_cap_usd ?? 5);
    const spent = (usage ?? []).reduce((s, r) => s + Number(r.est_cost_usd), 0);
    if (spent >= cap) return json({ error: `this month's AI budget of $${cap.toFixed(2)} is used up` }, 429);
    const lastHour = (usage ?? []).filter((r) => r.purpose === 'plan_project' && Date.parse(r.created_at) > Date.now() - 3_600_000).length;
    if (lastHour >= 20) return json({ error: 'too many plans in the last hour; try again later' }, 429);

    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? '').trim().slice(0, 120);
    if (!name) return json({ error: 'a project name is required' }, 400);
    const description = String(body.description ?? '').trim().slice(0, 4000);
    const course = body.course ? String(body.course).slice(0, 80) : null;
    const deadline = body.deadline ? String(body.deadline).slice(0, 40) : null;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1000, system: PROMPT,
        messages: [{ role: 'user', content: `Project: ${name}\nCourse: ${course ?? 'none'}\nDeadline: ${deadline ?? 'none set'}\nDescription: ${description || '(none given)'}` }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return json({ error: `the AI service answered ${res.status}` }, 502);
    const data = await res.json();
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();

    const inTok = data.usage?.input_tokens ?? 0, outTok = data.usage?.output_tokens ?? 0;
    await admin.from('llm_usage').insert({ user_id: user.id, provider: 'anthropic', model: MODEL, prompt_version: 'plan.v1', purpose: 'plan_project', input_tokens: inTok, output_tokens: outTok, est_cost_usd: (inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6 });

    let parsed: { milestones?: { title?: unknown; hours?: unknown }[]; rationale?: unknown };
    try { parsed = JSON.parse(text); } catch { return json({ error: 'the AI reply could not be read' }, 502); }
    const milestones = (parsed.milestones ?? [])
      .map((m) => ({ title: String(m.title ?? '').trim().slice(0, 60), hours: Math.round(Number(m.hours) * 4) / 4 }))
      .filter((m) => m.title && m.hours >= 0.25 && m.hours <= 200)
      .slice(0, 8);
    const total = milestones.reduce((s, m) => s + m.hours, 0);
    if (!milestones.length || total > 400) return json({ error: 'the AI reply was not a usable plan' }, 502);
    return json({ milestones, rationale: String(parsed.rationale ?? '').slice(0, 400) });
  } catch (e) {
    return json({ error: (e as Error).message.slice(0, 200) }, 500);
  }
});
