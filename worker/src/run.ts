import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadModels, loadPrompt, log, reportsDir, type Env } from './config.js';
import { Db, DbItemStore, type SourceRow } from './db.js';
import { ReauthError, refreshAccessToken } from './gmail/auth.js';
import { makeGmailApi } from './gmail/client.js';
import { parseGmailMessage } from './gmail/parse.js';
import { planSync } from './gmail/sync.js';
import { cleanBody } from './pipeline/clean.js';
import { formatAnchor } from './pipeline/dates.js';
import { buildUserPrompt, extract, type ExtractInput } from './pipeline/extract.js';
import { filterMessage } from './pipeline/filter.js';
import { makeLlm } from './pipeline/llm.js';
import { redact } from './pipeline/redact.js';
import { renderDryRun, type ReportEntry } from './pipeline/report.js';
import { applyItem, MemoryStore, type ItemStore } from './pipeline/store.js';
import { gmailThreadLink, toItemRow } from './pipeline/write.js';

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').slice(0, 15); // to the second, so reports never overwrite each other
}

async function runSource(env: Env, db: Db, source: SourceRow): Promise<void> {
  const mode = env.MODE;
  const models = loadModels();
  const system = loadPrompt(models.prompt_version);
  const llm = {
    firstPass: makeLlm(models.first_pass, { groq: env.GROQ_API_KEY, anthropic: env.ANTHROPIC_API_KEY }),
    escalation: makeLlm(models.escalation, { groq: env.GROQ_API_KEY, anthropic: env.ANTHROPIC_API_KEY }),
  };
  const { timezone, capUsd } = await db.settings(env.DEFAULT_TIMEZONE);
  const stats = { kind: '', listed: 0, already_done: 0, scanned: 0, skipped: 0, sent_to_llm: 0, escalated: 0, failed: 0, items_created: 0, items_updated: 0, items_merged: 0, items_completed: 0, items_cancelled: 0, skipped_past: 0, needs_review: 0, cost_usd: 0, capped: false };
  const runId = mode === 'preview' ? null : await db.startRun(source.id, mode);
  let runError: string | null = null;
  const report: ReportEntry[] = [];
  const previews: string[] = [];
  let trialNote = '';
  // A dry-run keeps its would-be items in memory, so merging and completing behave as they will live.
  const store: ItemStore = mode === 'live' ? new DbItemStore(db) : new MemoryStore();

  try {
    const refreshToken = await db.getSecret(source.id);
    if (!refreshToken) throw new ReauthError('no saved sign-in for this inbox');
    const api = makeGmailApi(await refreshAccessToken(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, refreshToken));

    // Preview and dry-run never move the cursor or mark anything processed, so a later live run starts clean.
    const state = mode === 'live' ? { cursor: source.cursor, backfillDone: source.backfill_done } : { cursor: {}, backfillDone: false };
    const plan = await planSync(api, state, env.BACKFILL_DAYS);
    stats.kind = plan.kind;
    stats.listed = plan.ids.length;

    let ids = plan.ids;
    if (mode === 'live') {
      const done = await db.finishedMessageIds(source.id, ids);
      stats.already_done = done.size;
      ids = ids.filter((id) => !done.has(id));
    } else {
      ids = ids.slice(-env.DRY_RUN_LIMIT); // most recent N, to keep a trial run cheap
      if (plan.ids.length > ids.length) trialNote = `Trial limited to the ${ids.length} most recent of ${plan.ids.length} emails from the last ${env.BACKFILL_DAYS} days (DRY_RUN_LIMIT).`;
    }

    const rules = await db.senderRules();
    let spent = await db.monthSpendUsd();
    let completed = true;

    for (const id of ids) {
      const raw = await api.getMessage(id);
      if (!raw) continue;
      const msg = parseGmailMessage(raw);
      stats.scanned++;
      const verdict = filterMessage(msg, rules);
      const body = redact(cleanBody(msg.bodyText, models.max_body_chars));
      const subject = redact(msg.subject);
      const entry: ReportEntry = { receivedAt: msg.receivedAt, from: msg.from, subject, filter: verdict.decision === 'pass' ? 'pass' : verdict.reason, escalated: false, items: [] };
      report.push(entry);

      let messageRowId: string | null = null;
      if (mode === 'live') {
        messageRowId = await db.upsertMessage({
          source_id: source.id,
          provider: 'gmail',
          provider_message_id: msg.id,
          thread_id: msg.threadId,
          sender: msg.from,
          subject,
          received_at: msg.receivedAt.toISOString(),
          body_clean: verdict.decision === 'pass' ? body : null,
          filter_decision: verdict.decision,
          filter_reason: verdict.reason,
          extraction_status: verdict.decision === 'pass' ? 'pending' : 'skipped',
          processed_at: verdict.decision === 'pass' ? null : new Date().toISOString(),
        });
      }
      if (verdict.decision === 'skip') {
        stats.skipped++;
        continue;
      }

      const threadKey = `${source.id}:${msg.threadId}`;
      const input: ExtractInput = {
        from: msg.from,
        subject,
        receivedAnchor: formatAnchor(msg.receivedAt, timezone),
        body,
        existing: mode === 'preview' ? [] : await store.context(threadKey, timezone, new Date(msg.receivedAt.getTime() - 3 * 86_400_000)),
      };

      if (mode === 'preview') {
        previews.push(`## ${subject}\n\n\`\`\`\n${buildUserPrompt(input)}\n\`\`\`\n`);
        continue;
      }
      if (mode === 'live' && messageRowId && (await db.messageAlreadyHasItems(messageRowId))) {
        // A previous run created the items and died before marking the message done.
        await db.updateMessage(messageRowId, { extraction_status: 'done', processed_at: new Date().toISOString() });
        continue;
      }
      if (spent >= capUsd) {
        stats.capped = true;
        completed = false;
        await db.alert('spend_cap', `AI spend reached the monthly cap of US$${capUsd.toFixed(2)}. Extraction is paused until next month or until you raise the cap.`);
        log('spend_cap_reached', { spent: Number(spent.toFixed(4)), cap: capUsd });
        break; // the cursor is not advanced, so these emails are picked up once the cap allows
      }

      const outcome = await extract(input, system, models, llm);
      stats.sent_to_llm++;
      if (outcome.escalated) stats.escalated++;
      const cost = outcome.usage.reduce((s, u) => s + u.estCostUsd, 0);
      spent += cost;
      stats.cost_usd += cost;
      await db.recordUsage(runId!, models.prompt_version, outcome.usage);
      entry.escalated = outcome.escalated;

      if (outcome.failed) {
        stats.failed++;
        entry.failed = outcome.error ?? 'unknown error';
        log('extraction_failed', { message: msg.id, error: (outcome.error ?? '').slice(0, 200) });
        if (messageRowId) await db.updateMessage(messageRowId, { extraction_status: 'failed', processed_at: new Date().toISOString(), prompt_version: models.prompt_version });
        continue;
      }

      const knownIds = new Set(input.existing.map((e) => e.id));
      const link = gmailThreadLink(source.account, msg.threadId);
      for (const item of outcome.items) {
        const row = toItemRow(item, timezone, models.review_below_confidence);
        const { action } = await applyItem(store, item, row, {
          knownIds,
          threadKey,
          src: { ref: msg.id, link, sourceId: source.id, messageRowId },
          skipPast: plan.kind === 'backfill' && env.BACKFILL_SKIP_PAST === 'true',
          now: new Date(),
        });
        entry.items.push({ ...row, action });
        if (action === 'created') stats.items_created++;
        if (action === 'updated') stats.items_updated++;
        if (action === 'merged') stats.items_merged++;
        if (action === 'completed') stats.items_completed++;
        if (action === 'cancelled') stats.items_cancelled++;
        if (action === 'skipped_past') stats.skipped_past++;
        if (action === 'created' && row.review_state === 'needs_review') stats.needs_review++;
      }
      if (messageRowId) await db.updateMessage(messageRowId, { extraction_status: 'done', processed_at: new Date().toISOString(), prompt_version: models.prompt_version });
    }

    if (mode === 'live' && completed) {
      await db.updateSource(source.id, { cursor: plan.nextCursor, backfill_done: true, last_success_at: new Date().toISOString(), last_error: null, status: 'active' });
    }
  } catch (e) {
    runError = (e as Error).message;
    if (e instanceof ReauthError) {
      await db.updateSource(source.id, { status: 'needs_reauth', last_error: 'Sign-in expired or was revoked', last_error_at: new Date().toISOString() });
      await db.alert('needs_reauth', `${source.account} needs you to sign in again. Run "make auth" on the server.`, source.id);
    } else {
      await db.updateSource(source.id, { last_error: runError.slice(0, 500), last_error_at: new Date().toISOString() });
    }
    log('run_error', { source: source.label, error: runError.slice(0, 300) });
  } finally {
    // Write the trial report even if the run stopped early, so paid-for results are never lost.
    try {
      const stopped = runError ? `**This run stopped early** after ${stats.scanned} emails: ${runError.slice(0, 200)}` : '';
      if (mode === 'preview' && (previews.length || !runError)) {
        mkdirSync(reportsDir, { recursive: true });
        const file = join(reportsDir, `preview-${stamp()}.md`);
        writeFileSync(file, `# Preview: exactly what would be sent to the AI\n\nNothing was sent. ${previews.length} of ${stats.scanned} emails passed the filter.\n\n${stopped}\n\n## System prompt (${models.prompt_version})\n\n\`\`\`\n${system}\n\`\`\`\n\n${previews.join('\n')}`);
        log('preview_written', { file, would_send: previews.length, scanned: stats.scanned });
      } else if (mode === 'dry-run' && (report.length || !runError)) {
        mkdirSync(reportsDir, { recursive: true });
        const file = join(reportsDir, `dry-run-${stamp()}.md`);
        writeFileSync(file, renderDryRun(report, timezone, source.account, stats.cost_usd, [trialNote, stopped].filter(Boolean).join('\n\n')));
        log('dry_run_written', { file });
      }
    } catch (e) {
      log('report_write_failed', { error: (e as Error).message.slice(0, 200) });
    }
    stats.cost_usd = Number(stats.cost_usd.toFixed(6));
    if (runId) await db.finishRun(runId, stats, runError);
    log('run_finished', { source: source.label, mode, ...stats });
  }
}

export async function runOnce(env: Env): Promise<void> {
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, env.USER_ID);
  const sources = await db.gmailSources();
  if (!sources.length) {
    log('no_sources', { hint: 'run "make auth" to connect an inbox' });
    return;
  }
  for (const source of sources) {
    if (source.status !== 'active') {
      log('source_skipped', { source: source.label, status: source.status });
      continue;
    }
    await runSource(env, db, source);
  }
}
