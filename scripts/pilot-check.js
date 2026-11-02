// Grades the ledger against PILOT.md and writes PILOT-RESULTS.md.
// Usage: npm run pilot:check -- [--since ISO] [--render https://...] [--resend] [--ledger path]
import fs from 'node:fs';
import { loadConfig, assertReady, isMockConfig } from '../src/config.js';
import { createLedger } from '../src/ledger.js';
import { createPayPal } from '../src/paypal.js';
import { resourceIdOf } from '../src/server.js';
import { latestCallsByScript } from '../src/check.js';
import { DEADLINE, GAP_BAR_MS, formatPt, selectCalls, windowCalls, sweep, stops, timing, pilotTests } from '../src/pilot-grade.js';

// A sleeping free Render service takes about a minute to wake.
const RENDER_TIMEOUT_MS = 90000;
const POLL_EVERY_MS = 4000;
const POLL_FOR_MS = 120000;
const PAID = 'INVOICING.INVOICE.PAID';
const RESULTS_FILE = 'PILOT-RESULTS.md';
const PREVIOUS_FILE = 'PILOT-RESULTS.previous.md';
const NOTICE_TITLE = '# Pilot results, no grade';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
const mark = (list) => (list.length === 0 ? 'ok' : `${list.length} problems`);

function callRows(calls, { all = false } = {}) {
  const rows = ['| Script | Browser | Voice | Facts | Writes | Safety | Behavior | Call |', '|---|---|---|---|---|---|---|---|'];
  for (let n = 1; n <= 10; n += 1) {
    const c = calls.get(n);
    if (!c) {
      if (all) rows.push(`| ${n} | missing | | | | | | |`);
      continue;
    }
    rows.push(`| ${n} | ${c.browser} | ${c.voice ? 'yes' : 'no'} | ${mark(c.grade.facts)} | ${mark(c.grade.writes)} | ${mark(c.grade.safety)} | ${mark(c.grade.behavior)} | ${c.callId} |`);
  }
  return rows;
}

function gapLine(gap) {
  if (gap === null) return 'Median gap across voice turns, no voice turns.';
  if (!Number.isFinite(gap)) return `Median gap across voice turns, over the bar, because most voice replies never started playing. The bar is under ${GAP_BAR_MS} ms.`;
  return `Median gap across voice turns, ${gap} ms. The bar is under ${GAP_BAR_MS} ms.`;
}

function idLines(main) {
  const sub = idOf(main.get(2), 'suspend');
  const act = idOf(main.get(3), 'activate');
  const send = idOf(main.get(5), 'send_invoice');
  const drafts = [5, 6, 7].map((n) => main.get(n)?.list.find((e) => e.type === 'staging_write' && e.kind === 'create_draft')?.id ?? 'none');
  return [
    `- Subscription, ${sub?.targetId ?? 'none'}`,
    `- Suspend debug id, ${sub?.debugId ?? 'none'}. Activate debug id, ${act?.debugId ?? 'none'}.`,
    `- Script 5 invoice, ${send?.targetId ?? drafts[0]}. Send debug id, ${send?.debugId ?? 'none'}.`,
    `- Script 6 and 7 drafts, ${drafts[1]} and ${drafts[2]}.`,
  ];
}

function problemLines(selected, swept) {
  const { main, fox } = selected;
  const graded = new Set([...main.values(), ...fox.values()].map((c) => c.callId));
  const scored = [...main.values(), ...fox.values()].flatMap((c) => [...c.grade.facts, ...c.grade.writes, ...c.grade.safety, ...c.grade.behavior]
    .map((v) => `- Script ${c.number}, ${c.browser}, ${v.check}, turn ${v.turn ?? 'none'}, ${v.message}`));
  // The sweep covers every call in the window. Graded calls already show above, except for the PIN search.
  const elsewhere = [...swept.writes, ...swept.safety].filter((v) => !graded.has(v.callId)).concat(swept.pin)
    .map((v) => `- Call ${v.callId}, ${v.check}, turn ${v.turn ?? 'none'}, ${v.message}`);
  return [...scored, ...elsewhere];
}

const LATE_SHOWN = 3;
function lateLine(late) {
  const more = late.length > LATE_SHOWN ? ` And ${late.length - LATE_SHOWN} more.` : '';
  return `**Past the deadline, so every test fails.** ${late.slice(0, LATE_SHOWN).join('. ')}.${more}`;
}

function report({ refusal, selected, results, webhook, swept, times, notes, ledgerPath, since }) {
  const { main, fox, others } = selected;
  const verdict = (pass) => (refusal ? `${refusal}, not a pass` : pass ? 'PASS' : 'FAIL');
  const stopCount = stops(swept).length;
  const problems = problemLines(selected, swept);
  const out = [
    '# Pilot results',
    '',
    refusal ? `**${refusal} RUN, does not count.** Graded from \`${ledgerPath}\`, but these calls used the fake PayPal, the offline rules router or the dry run.` : `Graded from \`${ledgerPath}\`${since ? ` since ${since}` : ''}, at ${formatPt(new Date().toISOString())}.`,
    '',
    'Scripts 1 to 10 use the latest call per script made in Chrome or Safari that went past the PIN step. The Firefox clause of Test 4 uses the latest Firefox calls for Scripts 2 and 3. Edge and other browsers are recorded, not scored. See the known gaps note in README.md.',
    '',
    `First graded event ${formatPt(times.first)}, last graded event ${formatPt(times.last)}. The deadline is ${formatPt(DEADLINE)}.`,
    ...(times.late.length ? ['', lateLine(times.late)] : []),
    '',
    ...results.tests.map((t) => `- **${t.name}.** ${verdict(t.pass)}`),
    '',
    `Safety checks, over every call in the window. ${stopCount === 0 ? 'No problems found.' : `${stopCount} problems. This is a stop.`}`,
    `Writes checks, over every call in the window. ${swept.writes.length === 0 ? 'No problems found.' : `${swept.writes.length} problems, so Test 3 fails.`}`,
    '',
    '## PayPal ids',
    '',
    ...idLines(main),
    `- Webhook event, ${webhook.event?.eventId ?? 'not found'}, from ${webhook.source}${webhook.event?.ts ? `, received ${formatPt(webhook.event.ts)}` : ''}.`,
    '',
    gapLine(results.gap),
    `Firefox typed runs, Script 2 ${fox.get(2)?.grade.passed ? 'passed' : 'missing or failed'}, Script 3 ${fox.get(3)?.grade.passed ? 'passed' : 'missing or failed'}.`,
    '',
    '## Calls',
    '',
    ...callRows(main, { all: true }),
    '',
    ...(fox.size ? ['Firefox, for the typed clause of Test 4.', '', ...callRows(fox), ''] : []),
    ...(others.size ? ['Recorded, not scored. Edge and other browsers.', '', ...callRows(others), ''] : []),
    '## Every problem',
    '',
    ...(problems.length ? problems : ['None.']),
    '',
    '## Notes',
    '',
    ...(notes.length ? notes.map((n) => `- ${n}`) : ['None.']),
    '',
    'Recorded, not scored. Whether Render Workflows runs on the $50 credit without a card, Edge speech, and whether a webhook arrives while the free service sleeps.',
    '',
  ];
  return out.join('\n');
}

/**
 * A refused or empty grade still replaces PILOT-RESULTS.md, so an older PASS never reads as this run's.
 * The last real grade is moved beside it rather than lost.
 */
function writeNotice(reason) {
  const kept = fs.existsSync(RESULTS_FILE) && !fs.readFileSync(RESULTS_FILE, 'utf8').startsWith(NOTICE_TITLE);
  if (kept) fs.renameSync(RESULTS_FILE, PREVIOUS_FILE);
  const keptLine = kept ? `The last graded results were moved to \`${PREVIOUS_FILE}\`. They are not from this run.` : 'No graded results from an earlier run were in this folder.';
  fs.writeFileSync(RESULTS_FILE, [NOTICE_TITLE, '', `At ${formatPt(new Date().toISOString())}, pilot-check ${reason}`, '', keptLine, ''].join('\n'));
}

function readSince() {
  const rawSince = flagValue('--since');
  if (rawSince && Number.isNaN(Date.parse(rawSince))) throw new Error('--since must be an ISO time');
  // One UTC form for the ledger filter and for PayPal's start_time, whatever offset was typed.
  return rawSince ? new Date(rawSince).toISOString() : null;
}

async function main() {
  const config = loadConfig(process.env, { partial: true });
  const ledgerPath = flagValue('--ledger') ?? config.ledgerPath;
  const since = readSince();
  const ledger = createLedger({ path: ledgerPath });
  const events = ledger.all();
  const realCount = latestCallsByScript(events, { since }).size;
  // With no real calls, grade the dry-run calls so the run is visible, but never as a pass.
  const dryRun = realCount === 0 && latestCallsByScript(events, { since, dryRun: true }).size > 0;
  const selected = selectCalls(events, { since, dryRun });
  const graded = [...selected.main.values(), ...selected.fox.values()];
  if (graded.length === 0) {
    const where = `${ledgerPath}${since ? ` since ${since}` : ''}`;
    writeNotice(`found no scripted calls to grade in \`${where}\`.`);
    process.stdout.write(`No scripted calls found in ${where}. Nothing to grade, so ${RESULTS_FILE} now says so.\n`);
    process.exitCode = 1;
    return;
  }
  const notes = dryRun ? ['This ledger holds only dry-run calls. A dry run never counts toward the bar.'] : [];
  if (!config.pin) notes.push('PILOT_PIN is not set, so the ledger was not searched for the PIN.');
  const invoiceId = idOf(selected.main.get(5), 'send_invoice')?.targetId ?? null;
  const webhook = await webhookEvidence({ config, invoiceId, renderUrl: flagValue('--render'), since, ledger, notes });
  const swept = sweep(windowCalls(events, { since, dryRun }), { pin: config.pin });
  const times = timing(graded, webhook.found ? webhook.event : null);
  const results = pilotTests({ main: selected.main, fox: selected.fox, swept, webhook, late: times.late });
  const mock = isMockConfig(config) || graded.some((c) => c.mock);
  const refusal = mock ? 'MOCK' : dryRun ? 'DRY' : null;
  const text = report({ refusal, selected, results, webhook, swept, times, notes, ledgerPath, since });
  if (refusal) {
    const label = `${refusal} RUN, does not count`;
    writeNotice(`graded \`${ledgerPath}\` and refused it, ${label}.`);
    process.stdout.write(`${label}\n\n${text}\n${label}. ${RESULTS_FILE} now says this run does not count.\n`);
    process.exitCode = 2;
    return;
  }
  fs.writeFileSync(RESULTS_FILE, text);
  process.stdout.write(`${text}\nWrote ${RESULTS_FILE}.\n`);
  process.exitCode = results.tests.every((t) => t.pass) && stops(swept).length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
