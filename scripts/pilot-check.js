// Grades the ledger against PILOT.md and writes PILOT-RESULTS.md.
// Usage: npm run pilot:check -- [--since ISO] [--render https://...] [--resend] [--ledger path] [--hours path]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, assertReady, isMockConfig } from '../src/config.js';
import { createLedger } from '../src/ledger.js';
import { createPayPal } from '../src/paypal.js';
import { resourceIdOf } from '../src/server.js';
import { latestCallsByScript } from '../src/check.js';
import { DEADLINE, GAP_BAR_MS, formatPt, selectCalls, windowCalls, startedAfter, sweep, stops, timing, pilotTests, outsideLoggedRows } from '../src/pilot-grade.js';
import { parseHoursLog, effectiveDeadline, loggedHours, rowHours, inWindow, outsideWindow, EXPECTED_ROW, ACCEPTED_FORMS, LOGGED_HOURS } from '../src/hours-log.js';

// A sleeping free Render service takes about a minute to wake.
const RENDER_TIMEOUT_MS = 90000;
const POLL_EVERY_MS = 4000;
const POLL_FOR_MS = 120000;
const PAID = 'INVOICING.INVOICE.PAID';
const RESULTS_FILE = 'PILOT-RESULTS.md';
const PREVIOUS_FILE = 'PILOT-RESULTS.previous.md';
const NOTICE_TITLE = '# Pilot results, no grade';
// The Hours log is read from PILOT.md beside this script unless --hours names another file.
const HOURS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'PILOT.md');
// An ISO time with its offset, so a run in any time zone reads it the same way.
const SINCE_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const SINCE_HINT = 'an ISO time with its offset, such as 2026-11-03T18:00-08:00 for 6:00 pm PT on Tue Nov 3, or the same time in UTC, 2026-11-04T02:00Z';
const USAGE = 'Usage: npm run pilot:check -- [--since ISO] [--render https://...] [--resend] [--ledger path] [--hours path]';
// Each flag is --name value or --name=value, given once. Anything else stops the run before it grades (G5).
const FLAGS = Object.freeze({ since: { type: 'string' }, render: { type: 'string' }, resend: { type: 'boolean' }, ledger: { type: 'string' }, hours: { type: 'string' } });
const EXIT_FAIL = 1;
const EXIT_REFUSED = 2;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A flag pilot-check can't use. The run stops with the usage line and grades nothing (G5). */
class FlagError extends Error {}

function flagProblem(error) {
  const name = (error.message.match(/'([^']+)'/)?.[1] ?? '').replace(/ <value>$/, '');
  if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `pilot-check has no flag ${name}.`;
  if (error.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
    return `pilot-check got "${name}" with no flag before it. npm keeps any flag that comes before the --, so run npm run pilot:check -- and then the flags.`;
  }
  if (/does not take an argument/.test(error.message)) return `${name} takes no value.`;
  return `${name} needs a value right after it.`;
}

/** The flags, read strictly, so a flag npm kept, a stray value or a typo never grades another window or ledger. */
function readFlags(argv, env) {
  const kept = Object.keys(FLAGS).filter((name) => env[`npm_config_${name}`] !== undefined);
  if (kept.length > 0) {
    const list = kept.map((name) => `--${name}`).join(' and ');
    throw new FlagError(`npm kept ${list} for itself, so pilot-check never saw it. Put -- before pilot-check's flags, as in npm run pilot:check -- --since 2026-11-03T18:00-08:00.`);
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: FLAGS, strict: true, allowPositionals: false, tokens: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    throw new FlagError(flagProblem(error));
  }
  const names = parsed.tokens.filter((t) => t.kind === 'option').map((t) => t.name);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice) throw new FlagError(`--${twice} was given twice.`);
  return parsed.values;
}

function readSince(raw) {
  if (raw === undefined) return null;
  if (!raw || !SINCE_FORM.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new FlagError(`--since must be ${SINCE_HINT}. It was ${raw ? `"${raw}"` : 'given no time'}.`);
  }
  // One UTC form for the ledger filter and for PayPal's start_time, whatever offset was typed.
  return new Date(raw).toISOString();
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

/** The file beside the ledger that keeps the paid event Render showed, so a later regrade needs no late resend (G2). */
const evidencePath = (ledgerPath) => `${ledgerPath.replace(/\.jsonl$/, '')}.paid-webhook.json`;

/** The verified paid event an earlier run found on Render for this invoice, or null. */
function savedEvidence(file, invoiceId) {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const ok = saved?.eventType === PAID && saved.resourceId === invoiceId && saved.verified === true && Number.isFinite(Date.parse(saved.ts));
  return ok ? saved : null;
}

/** Keeps what Render showed, the event id, the invoice id and when Render received the event. */
function keepEvidence(file, event, source) {
  const record = { eventId: event.eventId ?? null, eventType: event.eventType, resourceId: event.resourceId, verified: true, ts: event.ts, source, savedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

async function webhookEvidence({ config, invoiceId, renderUrl, resendAsked, since, ledger, ledgerPath, notes, save }) {
  if (!invoiceId) return { found: false, source: 'none' };
  const file = evidencePath(ledgerPath);
  const saved = savedEvidence(file, invoiceId);
  if (saved) {
    notes.push(`An earlier run found the paid event for ${invoiceId} on Render and saved it in \`${file}\`, so this run used it and asked Render and PayPal nothing.`);
    return { found: true, source: `${saved.source}, saved ${formatPt(saved.savedAt)}`, event: saved };
  }
  const match = (list) => list.find((w) => w.eventType === PAID && w.resourceId === invoiceId && w.verified === true) ?? null;
  if (!renderUrl) {
    const local = match(ledger.byType('webhook'));
    notes.push('No --render URL was given, so only the local ledger was searched. Test 2 needs the Render URL.');
    return { found: false, source: 'local ledger', event: local };
  }
  const live = resendAsked ? await resendEvidence({ config, invoiceId, renderUrl, since, notes, match }) : await readRender(renderUrl, match, false, notes);
  if (live.found && save) keepEvidence(file, live.event, live.source);
  return live;
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

function gapLine(gap, problems = []) {
  const flagged = problems.length ? ` Test 4 fails anyway, because ${problems.length} logged gaps can't be right. See every problem below.` : '';
  if (gap === null) return `Median gap across voice turns, no unmuted voice turns.${flagged}`;
  if (!Number.isFinite(gap)) return `Median gap across voice turns, over the bar, because most voice replies never started playing. The bar is under ${GAP_BAR_MS} ms.${flagged}`;
  return `Median gap across voice turns, ${gap} ms. The bar is under ${GAP_BAR_MS} ms.${flagged}`;
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

function problemLines(selected, swept, gapProblems = []) {
  const { main, fox } = selected;
  const byId = new Map([...main.values(), ...fox.values()].map((c) => [c.callId, c]));
  const scored = [...main.values(), ...fox.values()].flatMap((c) => [...c.grade.facts, ...c.grade.writes, ...c.grade.safety, ...c.grade.behavior]
    .map((v) => `- Script ${c.number}, ${c.browser}, ${v.check}, turn ${v.turn ?? 'none'}, ${v.message}`));
  const gaps = gapProblems.map((v) => `- Script ${byId.get(v.callId)?.number ?? 'none'}, ${byId.get(v.callId)?.browser ?? 'other'}, gap, turn ${v.turn ?? 'none'}, ${v.message}`);
  // The sweep covers every call in the window. Graded calls already show above, except for the PIN search.
  const elsewhere = [...swept.writes, ...swept.safety].filter((v) => !byId.has(v.callId)).concat(swept.pin)
    .map((v) => `- Call ${v.callId}, ${v.check}, turn ${v.turn ?? 'none'}, ${v.message}`);
  return [...scored, ...gaps, ...elsewhere];
}

/** Each test with every clause under it, met or missed, and the call it used, so a FAIL always says why (G6). */
function testLines(tests, verdict) {
  return tests.flatMap((t) => [`- **${t.name}.** ${verdict(t.pass)}`, ...t.clauses.map((c) => `  - ${c.pass ? 'Met' : 'Missed'}. ${c.text}.`)]);
}

const hoursText = (hours) => Number(hours.toFixed(2));

/** The Hours log as pilot-check read it, the effective deadline, and the warnings that never fail a test (R3-11). */
function hoursLines(hours, deadline, warnings) {
  if (!hours) return [];
  const sixth = deadline.sixthHourEnd ? `The 6th logged hour ended ${formatPt(deadline.sixthHourEnd)}.` : `Fewer than ${LOGGED_HOURS} hours are logged, so no 6th logged hour has ended yet.`;
  const by = deadline.bySixthHour ? `when the 6th logged hour ended, since that comes before ${formatPt(DEADLINE)}` : "the bar's own deadline, since no 6th logged hour ended before it";
  return [
    '## Hours log',
    '',
    `Read from \`${hours.file}\`. Start and End decide the hours, in PT. Only rows on Tue Nov 3 and Wed Nov 4 count.`,
    '',
    ...hours.rows.map((r) => `- Line ${r.line}, ${formatPt(new Date(r.startMs).toISOString())} to ${formatPt(new Date(r.endMs).toISOString())}, ${hoursText(rowHours(r))} hours.`),
    '',
    `Total logged, ${hoursText(loggedHours(hours.rows))} hours, with overlaps counted once. ${sixth} The effective deadline is ${formatPt(deadline.iso)}, ${by}.`,
    ...(warnings.length ? ['', `**Warnings, not fails.** ${warnings.join('. ')}.`] : []),
    '',
  ];
}

/** Scripted calls that started after the deadline. They are listed, never scored (G2). */
function afterLines(after) {
  if (after.length === 0) return [];
  return ['## Recorded after the deadline, not scored', '', ...after.map((c) => `- Script ${c.number}, ${c.browser}, call ${c.callId}, started ${formatPt(c.ts)}.`), ''];
}

const LATE_SHOWN = 3;
function lateLine(late) {
  const more = late.length > LATE_SHOWN ? ` And ${late.length - LATE_SHOWN} more.` : '';
  return `**Past the deadline, so every test fails.** ${late.slice(0, LATE_SHOWN).join('. ')}.${more}`;
}

function report({ refusal, selected, after, results, webhook, swept, times, notes, ledgerPath, since, hours = null, deadline = { iso: DEADLINE }, warnings = [] }) {
  const { main, fox, others } = selected;
  const verdict = (pass) => (refusal ? `${refusal}, not a pass` : pass ? 'PASS' : 'FAIL');
  const stopCount = stops(swept).length;
  const problems = problemLines(selected, swept, results.gapProblems);
  const noProblems = results.tests.every((t) => t.pass) ? 'None.' : 'No call check problems. Each failing test above says which clause it missed.';
  const out = [
    '# Pilot results',
    '',
    refusal ? `**${refusal} RUN, does not count.** Graded from \`${ledgerPath}\`, but these calls used the fake PayPal, the offline rules router or the dry run.` : `Graded from \`${ledgerPath}\`${since ? ` since ${since}` : ''}, at ${formatPt(new Date().toISOString())}.`,
    '',
    'Scripts 1 to 10 use the latest call per script made in Chrome or Safari that went past the PIN step and started by the deadline. The Firefox clause of Test 4 uses the latest such Firefox calls for Scripts 2 and 3. Edge and other browsers, and calls that started after the deadline, are recorded, not scored. See the known gaps note in README.md.',
    '',
    `First graded event ${formatPt(times.first)}, last graded event ${formatPt(times.last)}. The ${hours ? 'effective ' : ''}deadline is ${formatPt(deadline.iso)}.`,
    ...(times.late.length ? ['', lateLine(times.late)] : []),
    '',
    ...testLines(results.tests, verdict),
    '',
    `Safety checks, over every call in the window. ${stopCount === 0 ? 'No problems found.' : `${stopCount} problems. This is a stop.`}`,
    `Writes checks, over every call in the window. ${swept.writes.length === 0 ? 'No problems found.' : `${swept.writes.length} problems, so Test 3 fails.`}`,
    '',
    '## PayPal ids',
    '',
    ...idLines(main),
    `- Webhook event, ${webhook.event?.eventId ?? 'not found'}, from ${webhook.source}${webhook.event?.ts ? `, received ${formatPt(webhook.event.ts)}` : ''}.`,
    '',
    gapLine(results.gap, results.gapProblems),
    `Firefox typed runs, Script 2 ${fox.get(2)?.grade.passed ? 'passed' : 'missing or failed'}, Script 3 ${fox.get(3)?.grade.passed ? 'passed' : 'missing or failed'}.`,
    '',
    '## Calls',
    '',
    ...callRows(main, { all: true }),
    '',
    ...(fox.size ? ['Firefox, for the typed clause of Test 4.', '', ...callRows(fox), ''] : []),
    ...(others.size ? ['Recorded, not scored. Edge and other browsers.', '', ...callRows(others), ''] : []),
    ...afterLines(after),
    ...hoursLines(hours, deadline, warnings),
    '## Every problem',
    '',
    ...(problems.length ? problems : [noProblems]),
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

/** Moves a real grade beside the results file, so neither a notice nor a newer grade ever loses it. */
function keepRealGrade() {
  if (!fs.existsSync(RESULTS_FILE) || fs.readFileSync(RESULTS_FILE, 'utf8').startsWith(NOTICE_TITLE)) return;
  fs.renameSync(RESULTS_FILE, PREVIOUS_FILE);
}

/** A refused, empty or stopped run still replaces PILOT-RESULTS.md, so an older grade never reads as this run's. */
function writeNotice(reason) {
  keepRealGrade();
  const keptLine = fs.existsSync(PREVIOUS_FILE)
    ? `The last graded results are in \`${PREVIOUS_FILE}\`. They are not from this run.` : 'No graded results from an earlier run were in this folder.';
  fs.writeFileSync(RESULTS_FILE, [NOTICE_TITLE, '', `At ${formatPt(new Date().toISOString())}, pilot-check ${reason}`, '', keptLine, ''].join('\n'));
}

/** A fresh grade replaces the notice. An earlier real grade, if one is still there, moves aside first (G2). */
function writeGrade(text) {
  keepRealGrade();
  fs.writeFileSync(RESULTS_FILE, text);
}

/** Every exit without a fresh grade leaves the notice, so an older grade never reads as this run's (R3-9). */
function noGrade(reason, message, code) {
  writeNotice(reason);
  process.stdout.write(`${message}\n`);
  process.exitCode = code;
}

/** The Hours log rows, or why a real grade can't use them. Either way it never fails a test (R3-11). */
function readHours(hoursFlag) {
  if (hoursFlag === '') return { refusal: 'was given --hours with no file, so it did not grade.' };
  const file = hoursFlag ?? HOURS_FILE;
  const form = `Each row needs a date and the PT start and end times, like \`${EXPECTED_ROW}\`. ${ACCEPTED_FORMS}.`;
  let markdown;
  try {
    markdown = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { refusal: `could not read the Hours log in \`${file}\`, ${error.code ?? error.message}, so it did not grade.` };
  }
  const { rows, problems } = parseHoursLog(markdown, path.basename(file));
  if (problems.length > 0) return { refusal: `could not read the Hours log in \`${file}\`, so it did not grade. ${problems.join('. ')}. ${form}` };
  if (rows.length === 0) return { refusal: `found no rows in the Hours log in \`${file}\`, so it did not grade. Log your hours there first. ${form}` };
  // The window is the first 6 hours logged on Tue Nov 3 and Wed Nov 4, and hours before the clock are not logged (G4).
  if (inWindow(rows).length === 0) {
    return { refusal: `found no rows on Tue Nov 3 or Wed Nov 4 in the Hours log in \`${file}\`, so it did not grade. Rows on other days never count toward the 6 hours, and the hours before the clock starts are not logged. ${form}` };
  }
  return { file, rows };
}

/** Why a real grade can't start yet, checked before any PayPal or Render call: the pilot's subscription id and the Hours log. */
function realGradeBlock(config, hoursFlag) {
  if (!config.demoSubscriptionId) {
    return { reason: "refused to grade, because DEMO_SUBSCRIPTION_ID is not configured. Every call must work on the pilot's own subscription, so set it in .env, or run npm run seed so .pilot/state.json has it, then grade again." };
  }
  const hours = readHours(hoursFlag);
  return hours.refusal ? { reason: hours.refusal } : { hours };
}

const hoursWarnings = (graded, rows) => [
  ...outsideWindow(rows).map((r) => `The row on line ${r.line} is on ${r.day}, outside Tue Nov 3 and Wed Nov 4, so its hours don't count`),
  ...outsideLoggedRows(graded, rows),
];

const gradedOf = (selected) => [...selected.main.values(), ...selected.fox.values()];

/**
 * The graded calls and the calls recorded after the deadline. Calls are first picked by the bar's own deadline, to
 * see what kind of run this is, and picked again by the effective deadline once the Hours log gives one (G2).
 */
function pickCalls(events, base, until) {
  const selected = selectCalls(events, { ...base, until });
  return { selected, graded: gradedOf(selected), after: startedAfter(events, { since: base.since, dryRun: base.dryRun, until }) };
}

async function main() {
  // First of all, before the flags, the config or any network step, so a run that stops for any reason, a Ctrl-C or a
  // tool timeout included, never leaves an older grade as this run's. The fresh grade replaces this at the end (R3-9).
  writeNotice('started grading and has not finished. A run that is still going replaces this notice when it ends. If none is, it stopped before it could grade, so run it again.');
  const flags = readFlags(process.argv.slice(2), process.env);
  const config = loadConfig(process.env, { partial: true });
  const ledgerPath = flags.ledger ?? config.ledgerPath;
  const since = readSince(flags.since);
  const ledger = createLedger({ path: ledgerPath });
  const events = ledger.all();
  const realCount = latestCallsByScript(events, { since }).size;
  // With no real calls, grade the dry-run calls so the run is visible, but never as a pass.
  const dryRun = realCount === 0 && latestCallsByScript(events, { since, dryRun: true }).size > 0;
  const base = { since, dryRun, orgName: config.orgName, subscriptionId: config.demoSubscriptionId };
  let picked = pickCalls(events, base, DEADLINE);
  if (picked.graded.length === 0 && picked.after.length === 0) {
    const where = `${ledgerPath}${since ? ` since ${since}` : ''}`;
    noGrade(`found no scripted calls to grade in \`${where}\`.`, `No scripted calls found in ${where}. Nothing to grade, so ${RESULTS_FILE} now says so.`, EXIT_FAIL);
    return;
  }
  const mock = isMockConfig(config) || picked.graded.some((c) => c.mock) || picked.after.some((c) => c.mock);
  const refusal = mock ? 'MOCK' : dryRun ? 'DRY' : null;
  const block = refusal ? {} : realGradeBlock(config, flags.hours);
  if (block.reason) {
    noGrade(block.reason, `pilot-check ${block.reason} ${RESULTS_FILE} now says so.`, EXIT_REFUSED);
    return;
  }
  const deadline = block.hours ? effectiveDeadline(block.hours.rows, DEADLINE) : { iso: DEADLINE, bySixthHour: false, sixthHourEnd: null };
  if (deadline.iso !== DEADLINE) picked = pickCalls(events, base, deadline.iso);
  const { selected, graded, after } = picked;
  const notes = dryRun ? ['This ledger holds only dry-run calls. A dry run never counts toward the bar.'] : [];
  if (!config.pin) notes.push('PILOT_PIN is not set, so the ledger was not searched for the PIN.');
  if (after.length > 0) notes.push(`${after.length} scripted ${after.length === 1 ? 'call' : 'calls'} started after the deadline, so ${after.length === 1 ? 'it is' : 'they are'} recorded, not scored. The writes and safety checks still cover them.`);
  const invoiceId = idOf(selected.main.get(5), 'send_invoice')?.targetId ?? null;
  const webhook = await webhookEvidence({ config, invoiceId, renderUrl: flags.render ?? null, resendAsked: Boolean(flags.resend), since, ledger, ledgerPath, notes, save: !refusal });
  const swept = sweep(windowCalls(events, { since, dryRun }), { pin: config.pin, subscriptionId: config.demoSubscriptionId });
  const times = timing(graded, webhook.found ? webhook.event : null, deadline.iso);
  const results = pilotTests({ main: selected.main, fox: selected.fox, swept, webhook, late: times.late });
  const warnings = block.hours ? hoursWarnings(graded, block.hours.rows) : [];
  const text = report({ refusal, selected, after, results, webhook, swept, times, notes, ledgerPath, since, hours: block.hours ?? null, deadline, warnings });
  if (refusal) {
    const label = `${refusal} RUN, does not count`;
    writeNotice(`graded \`${ledgerPath}\` and refused it, ${label}.`);
    process.stdout.write(`${label}\n\n${text}\n${label}. ${RESULTS_FILE} now says this run does not count.\n`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  writeGrade(text);
  process.stdout.write(`${text}\nWrote ${RESULTS_FILE}.\n`);
  process.exitCode = results.tests.every((t) => t.pass) && stops(swept).length === 0 ? 0 : EXIT_FAIL;
}

main().catch((error) => {
  // A run that stops on an error, such as a bad flag or a config problem, still leaves no older grade in place.
  const usage = error instanceof FlagError ? ` ${USAGE}` : '';
  try {
    writeNotice(`stopped on an error before it could grade. ${error.message}${usage}`);
  } catch (noticeError) {
    process.stderr.write(`Could not write the ${RESULTS_FILE} notice, ${noticeError.message}\n`);
  }
  process.stderr.write(`${error.message}${usage ? `\n${USAGE}` : ''}\n`);
  process.exitCode = EXIT_FAIL;
});
