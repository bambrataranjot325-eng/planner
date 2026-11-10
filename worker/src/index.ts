import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, log, reportsDir } from './config.js';
import { parseIcs, summarizeFeed } from './brightspace/ics.js';
import { mapFeed } from './brightspace/map.js';
import { Db } from './db.js';
import { utcToLocal } from './pipeline/dates.js';
import { authCommand } from './cli/auth.js';
import { evalFixtures, previewFixtures } from './cli/fixtures.js';
import { requestStop, runOnce } from './run.js';
import { startNotifier } from './notify/send.js';

const HEARTBEAT = '/tmp/planner-heartbeat';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'loop';

  if (cmd === 'preview-fixtures') {
    previewFixtures(process.env.DEFAULT_TIMEZONE ?? 'America/New_York'); // needs no .env at all
    return;
  }
  if (cmd === 'eval') {
    await evalFixtures(process.env.DEFAULT_TIMEZONE ?? 'America/New_York', { groq: process.env.GROQ_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY });
    return;
  }

  const env = loadEnv();
  if (cmd === 'auth') return authCommand(env);
  if (cmd === 'once') {
    // Without these, Ctrl+C is ignored inside a container and a forced stop would lose the report.
    process.on('SIGINT', requestStop);
    process.on('SIGTERM', requestStop);
    return runOnce(env);
  }
  if (cmd === 'brightspace-report') {
    if (!env.BRIGHTSPACE_FEED_URL) throw new Error('Set BRIGHTSPACE_FEED_URL in .env first');
    const res = await fetch(env.BRIGHTSPACE_FEED_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`); // the URL itself is never printed
    const report = summarizeFeed(parseIcs(await res.text()));
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, 'brightspace-feed.md'), report);
    console.log(report);
    return;
  }
  if (cmd === 'connect-brightspace') {
    if (!env.BRIGHTSPACE_FEED_URL) throw new Error('Set BRIGHTSPACE_FEED_URL in .env first');
    const res = await fetch(env.BRIGHTSPACE_FEED_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok || !(await res.text()).includes('BEGIN:VCALENDAR')) throw new Error(`That address did not return a calendar (HTTP ${res.status}). Nothing was saved.`);
    const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, env.USER_ID);
    const id = await db.upsertSource('brightspace', new URL(env.BRIGHTSPACE_FEED_URL).host, 'Brightspace');
    await db.setSecret(id, env.BRIGHTSPACE_FEED_URL); // kept encrypted in Supabase Vault from here on
    await db.updateSource(id, { cursor: {}, last_success_at: null });
    log('brightspace_connected', { host: new URL(env.BRIGHTSPACE_FEED_URL).host });
    console.log('Connected. You can now remove BRIGHTSPACE_FEED_URL from .env; the worker reads it from the Vault.');
    return;
  }
  if (cmd === 'brightspace-preview') {
    if (!env.BRIGHTSPACE_FEED_URL) throw new Error('Set BRIGHTSPACE_FEED_URL in .env first');
    const res = await fetch(env.BRIGHTSPACE_FEED_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
    const zone = env.DEFAULT_TIMEZONE;
    const events = parseIcs(await res.text());
    const { items, skipped } = mapFeed(events, zone, new Date());
    console.log(`# Brightspace preview\n\n${events.length} events in the feed. ${items.length} would go on the calendar. Nothing was saved.\n`);
    console.log('| Kind | When (' + zone + ') | Title | Course | Priority |\n|---|---|---|---|---|');
    for (const { row } of items.sort((a, b) => (a.row.start_at ?? a.row.due_at)!.localeCompare((b.row.start_at ?? b.row.due_at)!))) {
      console.log(`| ${row.kind} | ${utcToLocal(row.start_at ?? row.due_at, zone)!.replace('T', ' ')}${row.all_day || row.due_precision === 'date_only' ? ' (all day)' : ''} | ${row.title} | ${row.course ?? ''} | ${row.priority} |`);
    }
    console.log('\nLeft out:');
    for (const [why, n] of Object.entries(skipped)) console.log(`- ${why}: ${n}`);
    if (!Object.keys(skipped).length) console.log('- nothing');
    return;
  }
  if (cmd === 'loop') {
    log('worker_started', { mode: env.MODE, poll_minutes: env.POLL_MINUTES });
    let stopping = false;
    process.on('SIGTERM', () => { stopping = true; requestStop(); });
    process.on('SIGINT', () => { stopping = true; requestStop(); });
    if (env.MODE === 'live') startNotifier(new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, env.USER_ID), env.DEFAULT_TIMEZONE, env.PUSH_CONTACT, () => stopping);
    while (!stopping) {
      try {
        await runOnce(env);
      } catch (e) {
        log('loop_error', { error: (e as Error).message.slice(0, 300) });
      }
      writeFileSync(HEARTBEAT, new Date().toISOString());
      // Dry-run and preview produce one report and stop, so a trial can't spend money in a loop.
      if (env.MODE !== 'live') {
        log('trial_mode_finished', { hint: 'read the file in reports/, then set MODE=live and run "make deploy"' });
        while (!stopping) { writeFileSync(HEARTBEAT, new Date().toISOString()); await new Promise((r) => setTimeout(r, 60_000)); }
        break;
      }
      for (let waited = 0; waited < env.POLL_MINUTES * 60 && !stopping; waited += 5) await new Promise((r) => setTimeout(r, 5000));
    }
    log('worker_stopped');
    return;
  }
  throw new Error(`Unknown command "${cmd}". Use: loop | once | auth | brightspace-report | brightspace-preview | connect-brightspace | preview-fixtures | eval`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
