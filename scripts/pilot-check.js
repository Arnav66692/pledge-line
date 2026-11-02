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
import { DEADLINE, GAP_BAR_MS, formatPt, selectCalls, windowCalls, startedAfter, sweep, stops, timing, pilotTests, outsideLoggedRows,
  templateTroubles, loggedConfig } from '../src/pilot-grade.js';
import { parseHoursLog, effectiveDeadline, loggedHours, rowHours, inWindow, outsideWindow, EXPECTED_ROW, ACCEPTED_FORMS, LOGGED_HOURS } from '../src/hours-log.js';

// A sleeping free Render service takes about a minute to wake.
const RENDER_TIMEOUT_MS = 90000;
const POLL_EVERY_MS = 4000;
const POLL_FOR_MS = 120000;
const PAID = 'INVOICING.INVOICE.PAID';
const RESULTS_FILE = 'PILOT-RESULTS.md';
const PREVIOUS_FILE = 'PILOT-RESULTS.previous.md';
// Every real grade is kept here under its own PT time, and none is ever replaced, moved or deleted (R4-3).
const GRADES_DIR = 'pilot-results';
const NOTICE_TITLE = '# Pilot results, no grade';
const STAMP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
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

/** "2026-11-04-21-15-03-PT", a grade's PT time as a file name that sorts by time. */
function ptStamp(date) {
  const p = Object.fromEntries(STAMP.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}-PT`;
}

/** Keeps a real grade in pilot-results/ under its own PT time, never over a grade already kept there (R4-3). */
function keepGrade(text, at = new Date()) {
  fs.mkdirSync(GRADES_DIR, { recursive: true });
  const stem = path.join(GRADES_DIR, ptStamp(at));
  for (let n = 1; ; n += 1) {
    const file = n === 1 ? `${stem}.md` : `${stem}-${n}.md`;
    try {
      fs.writeFileSync(file, text, { flag: 'wx' });
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

// A kept grade's name is its PT time, then -2, -3 and on for a second grade in the same second.
const KEPT_NAME = /^(.*-PT)(?:-(\d+))?\.md$/;
const keptOrder = (name) => {
  const [, stem = name, n = '1'] = name.match(KEPT_NAME) ?? [];
  return [stem, Number(n)];
};

/** The kept grades, oldest first, so a second grade in the same second comes after the first. */
function keptGrades() {
  if (!fs.existsSync(GRADES_DIR)) return [];
  return fs.readdirSync(GRADES_DIR).filter((name) => name.endsWith('.md')).sort((a, b) => {
    const [stemA, nA] = keptOrder(a);
    const [stemB, nB] = keptOrder(b);
    return stemA === stemB ? nA - nB : stemA < stemB ? -1 : 1;
  });
}

/**
 * A real grade in PILOT-RESULTS.md or PILOT-RESULTS.previous.md that pilot-results/ does not hold yet, as one an older
 * pilot-check wrote or moved aside, is kept there first, under the time its file was last written (R4-3, G2).
 */
function keepUnkeptGrade(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text.startsWith(NOTICE_TITLE)) return;
  if (keptGrades().some((name) => fs.readFileSync(path.join(GRADES_DIR, name), 'utf8') === text)) return;
  keepGrade(text, fs.statSync(file).mtime);
}

/** Moves a real grade beside the results file, so neither a notice nor a newer grade ever loses it, and keeps both first. */
function keepRealGrade() {
  keepUnkeptGrade(PREVIOUS_FILE);
  if (!fs.existsSync(RESULTS_FILE)) return;
  const text = fs.readFileSync(RESULTS_FILE, 'utf8');
  if (text.startsWith(NOTICE_TITLE)) return;
  keepUnkeptGrade(RESULTS_FILE);
  fs.renameSync(RESULTS_FILE, PREVIOUS_FILE);
}

/** A refused, empty or stopped run still replaces PILOT-RESULTS.md, so an older grade never reads as this run's. */
function writeNotice(reason) {
  keepRealGrade();
  const keptLine = fs.existsSync(PREVIOUS_FILE)
    ? `The last graded results are in \`${PREVIOUS_FILE}\`. They are not from this run.` : 'No graded results from an earlier run were in this folder.';
  const kept = keptGrades();
  const allLine = kept.length ? [`Every real grade is kept in \`${GRADES_DIR}/\`, the latest in \`${GRADES_DIR}/${kept.at(-1)}\`.`, ''] : [];
  fs.writeFileSync(RESULTS_FILE, [NOTICE_TITLE, '', `At ${formatPt(new Date().toISOString())}, pilot-check ${reason}`, '', keptLine, '', ...allLine].join('\n'));
}

/** A fresh grade replaces the notice and is kept in pilot-results/. An earlier real grade, if one is still there, moves aside first (G2). */
function writeGrade(text) {
  keepRealGrade();
  const kept = keepGrade(text);
  fs.writeFileSync(RESULTS_FILE, text);
  return kept;
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

/**
 * The four tests, the sweep and the timing, with the calls graded against one ORG_NAME and DEMO_SUBSCRIPTION_ID.
 * lenientTemplates sets aside what is wrong with the calls' template lists, to see whether that is all that fails (G1).
 */
function gradeWith(run, values, { lenientTemplates = false } = {}) {
  const { events, base, deadline, webhook, config, block } = run;
  const picked = pickCalls(events, { ...base, ...values, lenientTemplates }, deadline.iso);
  const swept = sweep(windowCalls(events, { since: base.since, dryRun: base.dryRun }), { pin: config.pin, subscriptionId: values.subscriptionId });
  const times = timing(picked.graded, webhook.found ? webhook.event : null, deadline.iso);
  const results = pilotTests({ main: picked.selected.main, fox: picked.selected.fox, swept, webhook, late: times.late });
  const warnings = block.hours ? hoursWarnings(picked.graded, block.hours.rows) : [];
  return { ...picked, swept, times, results, warnings, passed: results.tests.every((t) => t.pass) && stops(swept).length === 0 };
}

const valuesText = ({ orgName, subscriptionId }) => `ORG_NAME ${JSON.stringify(orgName)} and DEMO_SUBSCRIPTION_ID ${subscriptionId}`;

/** What is wrong with each template list, a list src/template-history.js lacks or one with sentences no one reviewed. */
const troubleText = (t) => (t.unknown ? `the template list ${t.hash}, which src/template-history.js does not have`
  : `the template list ${t.hash}, whose sentences ${t.unreviewed.map((sentence) => JSON.stringify(sentence)).join(', ')} the review in src/vocabulary.js never passed with their claims`);
const troublesText = (troubles) => troubles.map(troubleText).join(', and ');

/** How to clear each kind of template trouble, so the calls can be graded (R4-1, R4-2). */
function troubleFixes(troubles) {
  return [
    troubles.some((t) => t.unknown) && 'Grade with the code those calls were made with, after npm run vocabulary there, so its src/template-history.js has the list.',
    troubles.some((t) => !t.unknown) && 'Read each of those sentences. If it claims nothing, add it to CLAIM_FREE in src/vocabulary.js, and if its claims cover what it says, add it to CLAIMED there. Else fix it in src/say.js and make those calls again. Then run npm run vocabulary and npm test.',
  ].filter(Boolean);
}

/**
 * The notice for a grade that passes only with the config the calls logged (R4-3), or only with their template lists
 * set aside (G1). Neither is a fail, and neither is a pass.
 */
function refusalReason({ logged, configured, mismatch, troubles }) {
  const why = [mismatch && `every graded call logged ${valuesText(logged)}, but the config now names ${valuesText(configured)}`,
    troubles.length > 0 && `graded calls logged ${troublesText(troubles)}, so their replies can't be checked`].filter(Boolean);
  const how = [mismatch && 'graded with the values the calls logged', troubles.length > 0 && 'with those calls\' template lists set aside'].filter(Boolean).join(' and ');
  const fixes = [mismatch && 'Set ORG_NAME and DEMO_SUBSCRIPTION_ID in .env to the values the calls logged.', ...troubleFixes(troubles)].filter(Boolean);
  return `refused to grade, because ${why.join(', and ')}. ${how.charAt(0).toUpperCase()}${how.slice(1)}, every test passes, so this is not a fail, and it is not a pass either. ${fixes.join(' ')} Then grade again.`;
}

const configNote = (logged, configured) => `Every graded call logged ${valuesText(logged)}, but the config names ${valuesText(configured)}. So the calls were graded with the values they logged, and they fail even so.`;

const troublesNote = (troubles) => `Graded calls logged ${troublesText(troubles)}, so those calls fail the facts check. With their lists set aside the grade still fails, so it is written as a FAIL. ${troubleFixes(troubles).join(' ')}`;

const othersNote = (troubles) => `Edge or other calls, recorded and never scored, logged ${troublesText(troubles)}.`;

/** Reads the flags, the config and the ledger, and picks the calls. Returns a reason to stop when there is nothing to grade. */
function prepare() {
  const flags = readFlags(process.argv.slice(2), process.env);
  const config = loadConfig(process.env, { partial: true });
  const ledgerPath = flags.ledger ?? config.ledgerPath;
  const since = readSince(flags.since);
  const ledger = createLedger({ path: ledgerPath });
  const events = ledger.all();
  // With no real calls, grade the dry-run calls so the run is visible, but never as a pass.
  const dryRun = latestCallsByScript(events, { since }).size === 0 && latestCallsByScript(events, { since, dryRun: true }).size > 0;
  const configured = { orgName: config.orgName, subscriptionId: config.demoSubscriptionId };
  const base = { since, dryRun, ...configured };
  const first = pickCalls(events, base, DEADLINE);
  const run = { flags, config, ledgerPath, since, ledger, events, dryRun, configured, base };
  if (first.graded.length === 0 && first.after.length === 0) {
    const where = `${ledgerPath}${since ? ` since ${since}` : ''}`;
    return { ...run, stop: [`found no scripted calls to grade in \`${where}\`.`, `No scripted calls found in ${where}. Nothing to grade, so ${RESULTS_FILE} now says so.`, EXIT_FAIL] };
  }
  const mock = isMockConfig(config) || first.graded.some((c) => c.mock) || first.after.some((c) => c.mock);
  const refusal = mock ? 'MOCK' : dryRun ? 'DRY' : null;
  const block = refusal ? {} : realGradeBlock(config, flags.hours);
  if (block.reason) return { ...run, stop: [block.reason, `pilot-check ${block.reason} ${RESULTS_FILE} now says so.`, EXIT_REFUSED] };
  const deadline = block.hours ? effectiveDeadline(block.hours.rows, DEADLINE) : { iso: DEADLINE, bySixthHour: false, sixthHourEnd: null };
  const picked = deadline.iso === DEADLINE ? first : pickCalls(events, base, deadline.iso);
  return { ...run, refusal, block, deadline, picked };
}

function runNotes({ dryRun, config, picked }) {
  const { after } = picked;
  const notes = dryRun ? ['This ledger holds only dry-run calls. A dry run never counts toward the bar.'] : [];
  if (!config.pin) notes.push('PILOT_PIN is not set, so the ledger was not searched for the PIN.');
  if (after.length > 0) notes.push(`${after.length} scripted ${after.length === 1 ? 'call' : 'calls'} started after the deadline, so ${after.length === 1 ? 'it is' : 'they are'} recorded, not scored. The writes and safety checks still cover them.`);
  return notes;
}

async function main() {
  // First of all, before the flags, the config or any network step, so a run that stops for any reason, a Ctrl-C or a
  // tool timeout included, never leaves an older grade as this run's. The fresh grade replaces this at the end (R3-9).
  writeNotice('started grading and has not finished. A run that is still going replaces this notice when it ends. If none is, it stopped before it could grade, so run it again.');
  const run = prepare();
  if (run.stop) {
    noGrade(...run.stop);
    return;
  }
  const { flags, config, ledgerPath, since, ledger, refusal, block, deadline, picked, configured } = run;
  const notes = runNotes(run);
  const invoiceId = idOf(picked.selected.main.get(5), 'send_invoice')?.targetId ?? null;
  const webhook = await webhookEvidence({ config, invoiceId, renderUrl: flags.render ?? null, resendAsked: Boolean(flags.resend), since, ledger, ledgerPath, notes, save: !refusal });
  // When every graded call logged one ORG_NAME and DEMO_SUBSCRIPTION_ID and the config names others, the calls are
  // graded with what they logged. A pass then is refused, since the config is wrong, and a fail is still a fail (R4-3).
  const logged = refusal ? null : loggedConfig(picked.graded);
  const mismatch = Boolean(logged) && (logged.orgName !== configured.orgName || logged.subscriptionId !== configured.subscriptionId);
  const values = mismatch ? logged : configured;
  const graded = gradeWith({ ...run, webhook }, values);
  // A graded call whose template list can't vouch for its replies fails the facts check. When that is all that keeps
  // the run from a PASS, the grade is refused, and any other fail or stop is still written as one, with a note (G1).
  const troubles = refusal ? { scored: [], others: [] } : templateTroubles(graded.selected);
  const lenient = troubles.scored.length > 0 ? gradeWith({ ...run, webhook }, values, { lenientTemplates: true }) : graded;
  if ((mismatch || troubles.scored.length > 0) && lenient.passed) {
    const reason = refusalReason({ logged, configured, mismatch, troubles: troubles.scored });
    noGrade(reason, `pilot-check ${reason} ${RESULTS_FILE} now says so.`, EXIT_REFUSED);
    return;
  }
  if (mismatch) notes.push(configNote(logged, configured));
  if (troubles.scored.length > 0) notes.push(troublesNote(troubles.scored));
  if (troubles.others.length > 0) notes.push(othersNote(troubles.others));
  const text = report({ refusal, selected: graded.selected, after: graded.after, results: graded.results, webhook, swept: graded.swept, times: graded.times, notes, ledgerPath, since, hours: block.hours ?? null, deadline, warnings: graded.warnings });
  if (refusal) {
    const label = `${refusal} RUN, does not count`;
    writeNotice(`graded \`${ledgerPath}\` and refused it, ${label}.`);
    process.stdout.write(`${label}\n\n${text}\n${label}. ${RESULTS_FILE} now says this run does not count.\n`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  const kept = writeGrade(text);
  process.stdout.write(`${text}\nWrote ${RESULTS_FILE}, and kept this grade as ${kept}.\n`);
  process.exitCode = graded.passed ? 0 : EXIT_FAIL;
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
