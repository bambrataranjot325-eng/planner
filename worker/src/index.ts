import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, log, reportsDir } from './config.js';
import { parseIcs, summarizeFeed } from './brightspace/ics.js';
import { authCommand } from './cli/auth.js';
import { evalFixtures, previewFixtures } from './cli/fixtures.js';
import { runOnce } from './run.js';

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
  if (cmd === 'once') return runOnce(env);
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
  if (cmd === 'loop') {
    log('worker_started', { mode: env.MODE, poll_minutes: env.POLL_MINUTES });
    let stopping = false;
    process.on('SIGTERM', () => { stopping = true; });
    process.on('SIGINT', () => { stopping = true; });
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
  throw new Error(`Unknown command "${cmd}". Use: loop | once | auth | brightspace-report | preview-fixtures | eval`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
