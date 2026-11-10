import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixturesDir, loadModels, loadPrompt } from '../config.js';
import { cleanBody } from '../pipeline/clean.js';
import { formatAnchor } from '../pipeline/dates.js';
import { buildUserPrompt, extract } from '../pipeline/extract.js';
import { filterMessage } from '../pipeline/filter.js';
import { makeLlm } from '../pipeline/llm.js';
import { redact } from '../pipeline/redact.js';
import type { ParsedMessage } from '../types.js';

export interface Fixture {
  id: string;
  type: string;
  from: string;
  subject: string;
  received: string; // ISO instant
  labels: string[];
  headers?: Record<string, string>;
  body: string;
  expect: { filter: 'pass' | 'skip'; items: number; date?: string };
}

export function loadFixtures(): Fixture[] {
  return JSON.parse(readFileSync(join(fixturesDir, 'emails.json'), 'utf8')) as Fixture[];
}

export function fixtureToMessage(f: Fixture): ParsedMessage {
  return { id: f.id, threadId: f.id, labels: f.labels, headers: f.headers ?? {}, from: f.from, subject: f.subject, receivedAt: new Date(f.received), bodyText: f.body };
}

/** Offline demo: filter, clean, redact and build payloads for the fixture emails. No network. */
export function previewFixtures(zone: string): void {
  const models = loadModels();
  let wouldSend = 0;
  console.log('id   filter verdict             subject');
  for (const f of loadFixtures()) {
    const msg = fixtureToMessage(f);
    const v = filterMessage(msg);
    const verdict = v.decision === 'pass' ? 'SEND TO AI' : `skip: ${v.reason}`;
    console.log(`${f.id.padEnd(4)} ${verdict.padEnd(26)} ${f.subject}`);
    if (v.decision === 'pass') wouldSend++;
  }
  console.log(`\n${wouldSend} of ${loadFixtures().length} fixture emails would be sent to the AI.\n`);
  const sample = loadFixtures().find((f) => f.id === 'e10')!;
  const msg = fixtureToMessage(sample);
  console.log('Example of the exact user message for one email (after cleaning and redaction):\n');
  console.log(
    buildUserPrompt({
      from: msg.from,
      subject: redact(msg.subject),
      receivedAnchor: formatAnchor(msg.receivedAt, zone),
      body: redact(cleanBody(msg.bodyText, models.max_body_chars)),
      existing: [],
    }),
  );
}

/** Extraction eval on the fixtures. Calls the real models, so it costs a little. */
export async function evalFixtures(zone: string, keys: { groq?: string; anthropic?: string }): Promise<void> {
  const models = loadModels();
  const system = loadPrompt(models.prompt_version);
  const llm = { firstPass: makeLlm(models.first_pass, keys), escalation: makeLlm(models.escalation, keys) };
  let tp = 0, fp = 0, fn = 0, dateOk = 0, dateTotal = 0, cost = 0, falseOnNoise = 0, noise = 0;
  for (const f of loadFixtures()) {
    const msg = fixtureToMessage(f);
    const v = filterMessage(msg);
    let got = 0;
    let dates: string[] = [];
    if (v.decision === 'pass') {
      const out = await extract(
        { from: msg.from, subject: redact(msg.subject), receivedAnchor: formatAnchor(msg.receivedAt, zone), body: redact(cleanBody(msg.bodyText, models.max_body_chars)), existing: [] },
        system, models, llm,
      );
      cost += out.usage.reduce((s, u) => s + u.estCostUsd, 0);
      got = out.items.length;
      dates = out.items.map((i) => (i.due_local ?? i.start_local ?? '').slice(0, 10));
    }
    const want = f.expect.items;
    tp += Math.min(got, want);
    fp += Math.max(0, got - want);
    fn += Math.max(0, want - got);
    if (want === 0) { noise++; if (got > 0) falseOnNoise++; }
    if (f.expect.date) { dateTotal++; if (dates.includes(f.expect.date)) dateOk++; }
    const mark = got === want ? 'ok  ' : 'DIFF';
    console.log(`${mark} ${f.id.padEnd(4)} want ${want} got ${got}${f.expect.date ? `  date ${dates.includes(f.expect.date) ? 'ok' : `want ${f.expect.date} got ${dates.join(',') || 'none'}`}` : ''}  ${f.subject}`);
  }
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
  console.log(`\nRecall (real action items captured): ${pct(tp, tp + fn)}   target 90%`);
  console.log(`Precision (items that were real):     ${pct(tp, tp + fp)}`);
  console.log(`False items on no-action emails:       ${falseOnNoise} of ${noise}   target at most 1 in 10`);
  console.log(`Dates resolved correctly:              ${dateOk} of ${dateTotal}`);
  console.log(`Estimated cost of this eval:           US$${cost.toFixed(4)}`);
}
