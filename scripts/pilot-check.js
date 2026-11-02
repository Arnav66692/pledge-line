// Grades the ledger against PILOT.md and writes PILOT-RESULTS.md.
// Usage: npm run pilot:check -- [--since ISO] [--render https://...] [--resend] [--ledger path]
import fs from 'node:fs';
import { loadConfig, assertReady, isMockConfig } from '../src/config.js';
import { createLedger } from '../src/ledger.js';
import { createPayPal } from '../src/paypal.js';
import { resourceIdOf } from '../src/server.js';
import { scriptByNumber } from '../src/pilot-scripts.js';
import { gradeCall, checkSafety, medianGap, latestCallsByScript, isCallBy } from '../src/check.js';

const GAP_BAR_MS = 4000;
// A sleeping free Render service takes about a minute to wake.
const RENDER_TIMEOUT_MS = 90000;
const POLL_EVERY_MS = 4000;
const POLL_FOR_MS = 120000;
const PAID = 'INVOICING.INVOICE.PAID';
const RESULTS_FILE = 'PILOT-RESULTS.md';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function gradeSet(calls) {
  const graded = new Map();
  for (const [number, entry] of calls) {
    const grade = gradeCall(entry.list, scriptByNumber(number));
    graded.set(number, {
      ...entry,
      number,
      grade,
      voice: isCallBy(entry.list, 'voice'),
      typed: isCallBy(entry.list, 'typed'),
      browser: entry.start.browser,
      finished: entry.list.some((e) => e.type === 'call_end'),
      // The mode label, plus what the events show, so a mock call can never pass as sandbox.
      mock: entry.start.mode?.paypal === 'mock' || entry.start.mode?.router === 'rules'
        || entry.list.some((e) => (typeof e.debugId === 'string' && e.debugId.startsWith('mock-')) || (e.type === 'route' && e.model === 'rules')),
    });
  }
  return graded;
}

async function fetchRenderWebhooks(renderUrl) {
  const url = new URL('/api/webhooks', renderUrl);
  const res = await fetch(url, { signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Render answered ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.webhooks) ? body.webhooks : [];
}

async function wakeRender(renderUrl) {
  const res = await fetch(new URL('/healthz', renderUrl), { signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Render answered ${res.status}`);
}

/** Asks PayPal to send the paid event again. Returns whether a resend was accepted, and a note. */
async function resend(config, invoiceId, since) {
  assertReady(config, { need: ['paypal', 'webhook'] });
  const paypal = createPayPal({ baseUrl: config.paypal.baseUrl, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret });
  const startTime = since ?? new Date(Date.now() - 7 * 24 * 3600000).toISOString();
  const { events } = await paypal.listWebhookEvents({ eventType: PAID, startTime, pageSize: 50 });
  const event = events.find((e) => resourceIdOf(e) === invoiceId);
  if (!event) return { sent: false, note: `PayPal lists no ${PAID} event for ${invoiceId} yet` };
  const res = await paypal.resendWebhookEvent(event.id, [config.paypal.webhookId]);
  return { sent: true, note: `asked PayPal to resend ${event.id}, PayPal answered ${res.status}` };
}

/** Reads Render's webhook list until the verified event shows up or about two minutes pass. */
async function pollRender(renderUrl, match) {
  const deadline = Date.now() + POLL_FOR_MS;
  for (;;) {
    const event = match(await fetchRenderWebhooks(renderUrl));
    if (event || Date.now() >= deadline) return event;
    await sleep(POLL_EVERY_MS);
  }
}

async function readRender(renderUrl, match, poll, notes) {
  try {
    const event = poll ? await pollRender(renderUrl, match) : match(await fetchRenderWebhooks(renderUrl));
    return { found: Boolean(event), source: renderUrl, event };
  } catch (error) {
    notes.push(`Could not read ${renderUrl}/api/webhooks, ${error.message}.`);
    return { found: false, source: renderUrl };
  }
}

// Render is woken first, because a resend that lands during the cold start can miss PayPal's time limit.
async function resendEvidence({ config, invoiceId, renderUrl, since, notes, match }) {
  try {
    await wakeRender(renderUrl);
  } catch (error) {
    notes.push(`Could not wake ${renderUrl}, ${error.message}.`);
    return { found: false, source: renderUrl };
  }
  let sent = false;
  try {
    const result = await resend(config, invoiceId, since);
    sent = result.sent;
    notes.push(`Resend, ${result.note}.`);
  } catch (error) {
    notes.push(`Resend failed, ${error.name} ${error.status ?? ''}`.trim() + '.');
  }
  return readRender(renderUrl, match, sent, notes);
}

async function webhookEvidence({ config, invoiceId, renderUrl, since, ledger, notes }) {
  if (!invoiceId) return { found: false, source: 'none' };
  const match = (list) => list.find((w) => w.eventType === PAID && w.resourceId === invoiceId && w.verified === true) ?? null;
  if (!renderUrl) {
    const local = match(ledger.byType('webhook'));
    notes.push('No --render URL was given, so only the local ledger was searched. Test 2 needs the Render URL.');
    return { found: false, source: 'local ledger', event: local };
  }
  if (args.includes('--resend')) return resendEvidence({ config, invoiceId, renderUrl, since, notes, match });
  return readRender(renderUrl, match, false, notes);
}

const idOf = (call, kind) => call?.list.find((e) => e.type === 'write' && e.kind === kind) ?? null;

function testResults(main, fox, webhook) {
  const get = (n) => main.get(n);
  const passedVoice = (n) => get(n)?.grade.passed && get(n).voice && ['chrome', 'safari'].includes(get(n).browser);
  const scriptsPresent = Array.from({ length: 10 }, (_, i) => i + 1).every((n) => main.has(n));
  const factsAndWrites = scriptsPresent && [...main.values()].every((c) => c.grade.facts.length === 0 && c.grade.writes.length === 0);
  const voiceEvents = [...main.values()].flatMap((c) => c.list);
  const gap = medianGap(voiceEvents, { sources: ['voice'] });
  const finishedBy = (browser) => [...main.values()].some((c) => c.browser === browser && c.voice && c.finished);
  const foxOk = [2, 3].every((n) => fox.get(n)?.grade.passed && fox.get(n).typed && fox.get(n).finished);
  return {
    gap,
    tests: [
      { name: 'Test 1, gift care end to end', pass: Boolean(passedVoice(2) && passedVoice(3)) },
      { name: 'Test 2, one-time gift with the trust step', pass: Boolean(get(5)?.grade.passed && webhook.found && get(6)?.grade.passed) },
      { name: 'Test 3, read-back truth in 10 of 10 calls', pass: Boolean(factsAndWrites) },
      { name: 'Test 4, voice a judge can use', pass: Boolean(finishedBy('chrome') && finishedBy('safari') && foxOk && gap !== null && gap < GAP_BAR_MS) },
    ],
  };
}

function callRows(main) {
  const rows = ['| Script | Browser | Voice | Facts | Writes | Safety | Behavior |', '|---|---|---|---|---|---|---|'];
  for (let n = 1; n <= 10; n += 1) {
    const c = main.get(n);
    if (!c) { rows.push(`| ${n} | missing | | | | | |`); continue; }
    const mark = (list) => (list.length === 0 ? 'ok' : `${list.length} problems`);
    rows.push(`| ${n} | ${c.browser} | ${c.voice ? 'yes' : 'no'} | ${mark(c.grade.facts)} | ${mark(c.grade.writes)} | ${mark(c.grade.safety)} | ${mark(c.grade.behavior)} |`);
  }
  return rows;
}

function report({ refusal, main, fox, results, webhook, safety, notes, ledgerPath, since }) {
  const verdict = (pass) => (refusal ? `${refusal}, not a pass` : pass ? 'PASS' : 'FAIL');
  const sub = idOf(main.get(2), 'suspend');
  const act = idOf(main.get(3), 'activate');
  const send = idOf(main.get(5), 'send_invoice');
  const drafts = [5, 6, 7].map((n) => main.get(n)?.list.find((e) => e.type === 'staging_write' && e.kind === 'create_draft')?.id ?? 'none');
  const out = [
    '# Pilot results',
    '',
    refusal ? `**${refusal} RUN, does not count.** Graded from \`${ledgerPath}\`, but these calls used the fake PayPal, the offline rules router or the dry run.` : `Graded from \`${ledgerPath}\`${since ? ` since ${since}` : ''}.`,
    '',
    'Scripts 1 to 10 use the latest call per script outside Firefox. The Firefox clause of Test 4 uses the latest Firefox calls for Scripts 2 and 3. See the known gaps note in README.md.',
    '',
    ...results.tests.map((t) => `- **${t.name}.** ${verdict(t.pass)}`),
    '',
    `Safety checks. ${safety.length === 0 ? 'No problems found.' : `${safety.length} problems. This is a stop.`}`,
    '',
    '## PayPal ids',
    '',
    `- Subscription, ${sub?.targetId ?? 'none'}`,
    `- Suspend debug id, ${sub?.debugId ?? 'none'}. Activate debug id, ${act?.debugId ?? 'none'}.`,
    `- Script 5 invoice, ${send?.targetId ?? drafts[0]}. Send debug id, ${send?.debugId ?? 'none'}.`,
    `- Script 6 and 7 drafts, ${drafts[1]} and ${drafts[2]}.`,
    `- Webhook event, ${webhook.event?.eventId ?? 'not found'}, from ${webhook.source}.`,
    '',
    `Median gap across voice turns, ${results.gap === null ? 'no voice turns' : `${results.gap} ms`}. The bar is under ${GAP_BAR_MS} ms.`,
    `Firefox typed runs, Script 2 ${fox.get(2)?.grade.passed ? 'passed' : 'missing or failed'}, Script 3 ${fox.get(3)?.grade.passed ? 'passed' : 'missing or failed'}.`,
    '',
    '## Calls',
    '',
    ...callRows(main),
    '',
    '## Every problem',
    '',
  ];
  const problems = [...main.values(), ...fox.values()].flatMap((c) => [...c.grade.facts, ...c.grade.writes, ...c.grade.safety, ...c.grade.behavior].map((v) => `- Script ${c.number}, ${c.browser}, ${v.check}, turn ${v.turn ?? 'none'}, ${v.message}`));
  out.push(...(problems.length ? problems : ['None.']), '', '## Notes', '', ...(notes.length ? notes.map((n) => `- ${n}`) : ['None.']), '');
  out.push('Recorded, not scored. Whether Render Workflows runs on the $50 credit without a card, Edge speech, and whether a webhook arrives while the free service sleeps.', '');
  return out.join('\n');
}

async function main() {
  const config = loadConfig(process.env, { partial: true });
  const ledgerPath = flagValue('--ledger') ?? config.ledgerPath;
  const rawSince = flagValue('--since');
  if (rawSince && Number.isNaN(Date.parse(rawSince))) throw new Error('--since must be an ISO time');
  // One UTC form for the ledger filter and for PayPal's start_time, whatever offset was typed.
  const since = rawSince ? new Date(rawSince).toISOString() : null;
  const ledger = createLedger({ path: ledgerPath });
  const events = ledger.all();
  const pick = (dryRun, filter) => gradeSet(latestCallsByScript(events, { since, filter, dryRun }));
  const realCount = latestCallsByScript(events, { since }).size;
  // With no real calls, grade the dry-run calls so the run is visible, but never as a pass.
  const dryRun = realCount === 0 && latestCallsByScript(events, { since, dryRun: true }).size > 0;
  const main10 = pick(dryRun, (start) => start.browser !== 'firefox');
  const fox = pick(dryRun, (start) => start.browser === 'firefox');
  const mock = isMockConfig(config) || [...main10.values(), ...fox.values()].some((c) => c.mock);
  if (main10.size === 0 && fox.size === 0) {
    process.stdout.write(`No scripted calls found in ${ledgerPath}${since ? ` since ${since}` : ''}. Nothing to grade, so ${RESULTS_FILE} was not written.\n`);
    process.exitCode = 1;
    return;
  }
  const notes = dryRun ? ['This ledger holds only dry-run calls. A dry run never counts toward the bar.'] : [];
  const invoiceId = idOf(main10.get(5), 'send_invoice')?.targetId ?? null;
  const webhook = await webhookEvidence({ config, invoiceId, renderUrl: flagValue('--render'), since, ledger, notes });
  const safety = checkSafety([...main10.values(), ...fox.values()].flatMap((c) => c.list));
  const results = testResults(main10, fox, webhook);
  const refusal = mock ? 'MOCK' : dryRun ? 'DRY' : null;
  const text = report({ refusal, main: main10, fox, results, webhook, safety, notes, ledgerPath, since });
  if (refusal) {
    const label = `${refusal} RUN, does not count`;
    process.stdout.write(`${label}\n\n${text}\n${label}. ${RESULTS_FILE} was not written.\n`);
    process.exitCode = 2;
    return;
  }
  fs.writeFileSync(RESULTS_FILE, text);
  process.stdout.write(`${text}\nWrote ${RESULTS_FILE}.\n`);
  process.exitCode = results.tests.every((t) => t.pass) && safety.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
