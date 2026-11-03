// Grades a whole pilot ledger against PILOT.md: which calls count, Tests 1 to 4, and the safety stops.
// Pure functions, so scripts/pilot-check.js only does the file and network work around them.
import { gradeCall, checkSafety, checkWrites, medianGap, countedGaps, gapProblems, latestCallsByScript, isCallBy, groupByCall, templateTrouble } from './check.js';
import { detectBrowser } from './call.js';
import { textHasPin } from './numbers.js';
import { scriptByNumber } from './pilot-scripts.js';
import { inLoggedRow } from './hours-log.js';
import { drillOf } from './drill.js';

// Wed Nov 4, 2026, 9:00 pm PT, the bar's deadline. PT is eight hours behind UTC after Nov 1.
export const DEADLINE = '2026-11-05T05:00:00.000Z';
export const GAP_BAR_MS = 4000;
const SCRIPT_COUNT = 10;
const SCORED_BROWSERS = new Set(['chrome', 'safari']);
// A call is finished when its own last line ended it: goodbye, or the lock in Script 8.
const FINISH_REASONS = new Set(['goodbye', 'locked']);
const CALLER_TEXT_TYPES = new Set(['heard', 'yes', 'no']);
// What the line does when it acts on a turn it understood: read PayPal, propose, take a yes or a no, write.
const ACTED_TYPES = new Set(['read', 'proposed', 'yes', 'no', 'write']);
// The line's own housekeeping, logged by the idle sweep or the page's end beacon after the caller is done.
const HOUSEKEEPING_TYPES = new Set(['withdrawn', 'expired', 'gap']);
const HOUSEKEEPING_ENDS = new Set(['idle', 'client']);
const DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Wed Nov 4, 2026, 9:00 pm PT". */
export function formatPt(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const p = Object.fromEntries(PT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod.toLowerCase()} PT`;
}

/** The browser a call counts for: the one it logged, only when its logged user agent and engine signals give the same one. */
export function creditedBrowser(start) {
  const derived = detectBrowser(start.userAgent, start.client);
  return derived === start.browser ? derived : 'other';
}

/** A call that heard nothing after the PIN step was a mis-click or a stray call, so it never replaces a real run. */
export function ranPastPin(list) {
  const step = list.find((e) => e.type === 'pin_ok' || e.type === 'pin_locked');
  return Boolean(step) && list.some((e) => e.type === 'heard' && e.turn > step.turn);
}

// The mode label, plus what the events show, so a mock call can never pass as sandbox.
const isMockCall = ({ start, list }) => start.mode?.paypal === 'mock' || start.mode?.router === 'rules'
  || list.some((e) => (typeof e.debugId === 'string' && e.debugId.startsWith('mock-')) || (e.type === 'route' && e.model === 'rules'));

/** A voice turn after the PIN passed that the line acted on, so a call whose speech never worked earns no browser credit (R3-4). */
export function actedOnVoice(list) {
  const pinOk = list.find((e) => e.type === 'pin_ok');
  if (!pinOk) return false;
  const acted = new Set(list.filter((e) => ACTED_TYPES.has(e.type) || (e.type === 'staging_write' && e.kind === 'create_draft')).map((e) => e.turn));
  return list.some((e) => e.type === 'heard' && e.source === 'voice' && e.turn > pinOk.turn && acted.has(e.turn));
}

/** The facts check sets the org name aside, so the one each call logged must be the configured ORG_NAME. */
function orgProblems(start, orgName) {
  if (!orgName || start.orgName === orgName) return [];
  return [{ callId: start.callId ?? null, turn: null, check: 'facts', message: `the call logged the org name ${JSON.stringify(start.orgName ?? null)}, but ORG_NAME is ${JSON.stringify(orgName)}` }];
}

function gradeEntry(number, entry, options) {
  const graded = gradeCall(entry.list, scriptByNumber(number), options);
  const org = orgProblems(entry.start, options.orgName);
  return {
    ...entry,
    number,
    grade: { ...graded, facts: [...graded.facts, ...org], passed: graded.passed && org.length === 0 },
    voice: isCallBy(entry.list, 'voice'),
    typed: isCallBy(entry.list, 'typed'),
    actedOn: actedOnVoice(entry.list),
    browser: creditedBrowser(entry.start),
    finished: entry.list.some((e) => e.type === 'call_end' && FINISH_REASONS.has(e.reason)),
    mock: isMockCall(entry),
  };
}

/**
 * The graded calls. Scripts 1 to 10 come from the latest Chrome or Safari call of each, the Firefox clause from
 * the latest Firefox calls, and Edge and other browsers are recorded apart, never scored. With until, the deadline,
 * only calls that started by then are graded (G2). orgName and subscriptionId are the configured ones, which the
 * facts and writes checks hold every call to. lenientTemplates sets aside what templateTrouble finds, which pilot-check
 * uses only to tell a refusal from a fail (G1).
 */
export function selectCalls(events, { since = null, until = null, dryRun = false, orgName = null, subscriptionId = null, lenientTemplates = false } = {}) {
  const options = { orgName, subscriptionId, lenientTemplates };
  const pick = (wanted) => {
    const filter = (start, list) => wanted(creditedBrowser(start)) && ranPastPin(list);
    return new Map([...latestCallsByScript(events, { since, until, dryRun, filter })].map(([n, entry]) => [n, gradeEntry(n, entry, options)]));
  };
  return {
    main: pick((browser) => SCORED_BROWSERS.has(browser)),
    fox: pick((browser) => browser === 'firefox'),
    others: pick((browser) => !SCORED_BROWSERS.has(browser) && browser !== 'firefox'),
  };
}

/**
 * The template lists that can't vouch for their calls' replies, one per hash, as templateTrouble finds them: a list
 * the history lacks, or one with a sentence the review never passed. scored holds those of Chrome, Safari and Firefox
 * calls, which fail and can make pilot-check refuse the grade, and others those of Edge and other browsers, which are
 * never scored and only noted (R4-1, R4-2, G1).
 */
export function templateTroubles(selected) {
  const troubles = (calls) => {
    const byHash = new Map();
    for (const c of calls) {
      const trouble = templateTrouble(c.start);
      if (trouble && !byHash.has(trouble.hash)) byHash.set(trouble.hash, { ...trouble, calls: [] });
      if (trouble) byHash.get(trouble.hash).calls.push(c);
    }
    return [...byHash.values()];
  };
  return { scored: troubles([...selected.main.values(), ...selected.fox.values()]), others: troubles([...selected.others.values()]) };
}

const loggedValue = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The ORG_NAME and DEMO_SUBSCRIPTION_ID every graded call logged on call_start, when all of them logged the same two,
 * else null. A regrade whose config names others can then be told apart from a pilot that failed (R4-3).
 */
export function loggedConfig(entries) {
  const pairs = entries.map((c) => ({ orgName: loggedValue(c.start.orgName), subscriptionId: loggedValue(c.start.subscriptionId) }));
  if (pairs.length === 0 || pairs.some((p) => !p.orgName || !p.subscriptionId)) return null;
  const [first] = pairs;
  return pairs.every((p) => p.orgName === first.orgName && p.subscriptionId === first.subscriptionId) ? first : null;
}

/** Every call in the --since window, real or dry run as asked, whatever its script or browser. */
export function windowCalls(events, { since = null, dryRun = false } = {}) {
  const sinceMs = since ? Date.parse(since) : null;
  const calls = new Map();
  for (const [callId, list] of groupByCall(events)) {
    const start = list.find((e) => e.type === 'call_start');
    if (!start || Boolean(start.dryRun) !== dryRun) continue;
    if (sinceMs !== null && !(Date.parse(start.ts) >= sinceMs)) continue;
    calls.set(callId, list);
  }
  return calls;
}

/**
 * Scripted calls in the window that started after the deadline. They are recorded, not scored, so a demo after the
 * deadline never replaces the call that met the bar (G2). The writes and safety sweeps still cover them.
 */
export function startedAfter(events, { since = null, dryRun = false, until }) {
  const untilMs = Date.parse(until);
  return [...windowCalls(events, { since, dryRun })].flatMap(([callId, list]) => {
    const start = list.find((e) => e.type === 'call_start');
    if (!start.script || !(Date.parse(start.ts) > untilMs)) return [];
    return [{ callId, number: start.script, browser: creditedBrowser(start), ts: start.ts, mock: isMockCall({ start, list }) }];
  });
}

/**
 * The fault drills in the window (A12). A drill has no script, so it is never graded, and the writes and safety sweeps
 * cover it like any other call, its suspend to PayPal's test id held to the gift it read.
 */
export function drillCalls(calls) {
  return [...calls].flatMap(([callId, list]) => {
    const start = list.find((e) => e.type === 'call_start');
    const drill = drillOf(start);
    return drill ? [{ callId, key: drill.key, writeId: drill.writeId, ts: start.ts, mock: isMockCall({ start, list }) }] : [];
  });
}

const leak = (event) => ({ callId: event.callId ?? null, turn: event.turn ?? null, check: 'safety', message: `the PIN shows in a ${event.type} event` });

/** The line's own words, minus facts proven against PayPal such as an invoice number, hold the PIN as digits or spelled out. */
function saidHasPin(said, pin) {
  const facts = Array.isArray(said.facts) ? said.facts.map((f) => String(f.value)) : [];
  const text = facts.filter(Boolean).reduce((acc, value) => acc.split(value).join(' '), String(said.text ?? ''));
  const spelled = [...pin].map((d) => DIGIT_NAMES[Number(d)]).join(' ');
  return new RegExp(`(?<![0-9])${pin}(?![0-9])`).test(text) || text.toLowerCase().includes(spelled);
}

/** I4, as a second line of defense: the PIN in any reading of what the caller said, or plainly in what the line said. */
export function pinLeaks(calls, pin) {
  if (typeof pin !== 'string' || !/^\d+$/.test(pin)) return [];
  const problems = [];
  for (const list of calls.values()) {
    for (const e of list) {
      if (CALLER_TEXT_TYPES.has(e.type) && textHasPin(e.text, pin)) problems.push(leak(e));
      else if (e.type === 'said' && saidHasPin(e, pin)) problems.push(leak(e));
    }
  }
  return problems;
}

/**
 * Writes, safety and the PIN over every call in the window, scored or not, so a clean retry never hides an earlier
 * failure. Every subscription step in a call must target the DEMO_SUBSCRIPTION_ID it logged on call_start, or
 * subscriptionId when it logged none, so a later call on a new seed is held to its own subscription and its own email
 * on file (R3-7, R4-3). The graded calls are also held to subscriptionId in their own grade.
 */
export function sweep(calls, { pin = null, subscriptionId = null } = {}) {
  const writes = [];
  const safety = [];
  for (const list of calls.values()) {
    const own = loggedValue(list.find((e) => e.type === 'call_start')?.subscriptionId) ?? subscriptionId;
    writes.push(...checkWrites(list, { subscriptionId: own }));
    safety.push(...checkSafety(list, { subscriptionId: own }));
  }
  return { writes, safety, pin: pinLeaks(calls, pin) };
}

/** Any safety problem or PIN leak in the window is a stop (PILOT.md, safety checks). */
export const stops = (swept) => [...swept.safety, ...swept.pin];

const isHousekeeping = (e) => HOUSEKEEPING_TYPES.has(e.type) || (e.type === 'call_end' && HOUSEKEEPING_ENDS.has(e.reason))
  || (e.type === 'staging_write' && e.kind === 'delete_draft');

/**
 * What the caller and PayPal did in a graded call: every event up to and including the reply to its last heard turn,
 * and after it anything but the line's own housekeeping, such as an idle call_end or the end beacon's draft delete (R3-10).
 */
export function timedEvents(list) {
  const heard = list.filter((e) => e.type === 'heard').at(-1);
  const reply = heard ? list.filter((e) => e.type === 'said' && e.turn === heard.turn).at(-1) : null;
  const cutoff = (reply ?? heard)?.seq ?? Infinity;
  return list.filter((e) => e.seq <= cutoff || !isHousekeeping(e));
}

/** The first and last times of what the graded calls did, and what came after the deadline (the bar says any miss counts). */
export function timing(entries, webhookEvent, deadline = DEADLINE) {
  const limit = Date.parse(deadline);
  const timed = entries.map((c) => ({ c, events: timedEvents(c.list) }));
  const times = timed.flatMap(({ events }) => events.map((e) => Date.parse(e.ts))).filter(Number.isFinite).sort((a, b) => a - b);
  const late = timed.filter(({ events }) => events.some((e) => !(Date.parse(e.ts) <= limit)))
    .map(({ c }) => `Script ${c.number}, ${c.browser}, call ${c.callId}, has events after the deadline`);
  if (webhookEvent && !(Date.parse(webhookEvent.ts) <= limit)) late.push(`the paid webhook ${webhookEvent.eventId} reached Render after the deadline`);
  const iso = (ms) => (ms === undefined ? null : new Date(ms).toISOString());
  return { first: iso(times[0]), last: iso(times.at(-1)), late };
}

/** Graded calls that did something outside every row of the Hours log. A warning, not a fail (R3-11). */
export function outsideLoggedRows(entries, rows) {
  return entries.filter((c) => timedEvents(c.list).some((e) => !inLoggedRow(Date.parse(e.ts), rows)))
    .map((c) => `Script ${c.number}, ${c.browser}, call ${c.callId}, has events outside every logged row`);
}

/** Script 3 restarts the same gift Script 2 paused, and after it (PILOT.md Test 1, "Activate returns it to ACTIVE"). */
export function sameGiftRestarted(two, three) {
  const suspend = two?.list.find((e) => e.type === 'write' && e.kind === 'suspend' && e.ok);
  const activate = three?.list.find((e) => e.type === 'write' && e.kind === 'activate' && e.ok);
  return Boolean(suspend && activate && activate.targetId === suspend.targetId && activate.seq > suspend.seq);
}

// ---- Each test's clauses, with the call each one used, so a FAIL always says which clause missed (G6) ----

const SHOWN_CALLS = 3;
const clause = (pass, text) => ({ pass: Boolean(pass), text });
const named = (c) => `Script ${c.number}, ${c.browser}, call ${c.callId}`;
const joined = (reasons) => reasons.join(', and ');

/** Why a Chrome or Safari call earns no voice credit for Test 4. Finished by voice needs none of these. */
export function voiceCreditMisses(c) {
  return [
    !c.voice && 'not every turn after the PIN came from the talk button',
    !c.finished && 'it did not end with its own last line',
    !c.grade.passed && 'it failed its call checks',
    !c.actedOn && 'the line acted on no voice turn after the PIN',
  ].filter(Boolean);
}

function passedClause(c, n, { byVoice = false } = {}) {
  if (!c) return clause(false, `Script ${n} has no graded ${byVoice ? 'Chrome or Safari ' : ''}call`);
  const how = byVoice ? ' by voice' : '';
  const misses = [byVoice && !c.voice && 'not every turn after the PIN came from the talk button', !c.grade.passed && 'it failed its call checks'].filter(Boolean);
  return misses.length === 0 ? clause(true, `Script ${n} passed${how}, ${named(c)}`) : clause(false, `Script ${n} did not pass${how}, ${named(c)}, ${joined(misses)}`);
}

function browserClause(main, browser, label) {
  const calls = [...main.values()].filter((c) => c.browser === browser);
  const credited = calls.find((c) => voiceCreditMisses(c).length === 0);
  if (credited) return clause(true, `${label} has a call finished by voice, ${named(credited)}`);
  if (calls.length === 0) return clause(false, `${label} has no graded call`);
  const why = calls.slice(0, SHOWN_CALLS).map((c) => `${named(c)}, ${joined(voiceCreditMisses(c))}`);
  const more = calls.length > SHOWN_CALLS ? [`And ${calls.length - SHOWN_CALLS} more`] : [];
  return clause(false, [`${label} has no call finished by voice`, ...why, ...more].join('. '));
}

function foxClause(fox) {
  const misses = (c) => [!c.typed && 'not every turn after the PIN came from the typed box', !c.finished && 'it did not end with its own last line',
    !c.grade.passed && 'it failed its call checks'].filter(Boolean);
  const parts = [2, 3].map((n) => {
    const c = fox.get(n);
    if (!c) return { pass: false, text: `Script ${n} has no graded Firefox call` };
    const why = misses(c);
    return { pass: why.length === 0, text: why.length === 0 ? `Script ${n} passed typed, ${named(c)}` : `Script ${n} did not count, ${named(c)}, ${joined(why)}` };
  });
  return clause(parts.every((p) => p.pass), `Firefox typed runs. ${parts.map((p) => p.text).join('. ')}`);
}

function gapClause(gap, counted) {
  const voice = counted.filter((g) => g.source === 'voice' && Number.isFinite(g.gapMs));
  const muted = voice.filter((g) => g.muted).length;
  const mutedNote = muted ? `, and ${muted} muted ${muted === 1 ? 'turn doesn\'t' : 'turns don\'t'} count` : '';
  const timed = voice.length - muted;
  if (gap === null) return clause(false, `No unmuted voice turn was timed${mutedNote}`);
  if (!Number.isFinite(gap)) return clause(false, `The median gap is over the bar, because most of the ${timed} unmuted voice replies never started playing${mutedNote}`);
  return clause(gap < GAP_BAR_MS, `The median gap is ${gap} ms across ${timed} unmuted voice turns, and the bar is under ${GAP_BAR_MS} ms${mutedNote}`);
}

function allScriptsClause(all) {
  const missing = all.flatMap((c, i) => (c ? [] : [i + 1]));
  const failed = all.flatMap((c, i) => (c && !c.grade.passed ? [i + 1] : []));
  if (missing.length === 0 && failed.length === 0) return clause(true, 'All 10 scripts passed every call check');
  const parts = [failed.length && `Scripts ${failed.join(', ')} failed a call check`, missing.length && `Scripts ${missing.join(', ')} have no graded call`].filter(Boolean);
  return clause(false, `Not all 10 scripts passed. ${parts.join('. ')}`);
}

const onTimeClause = (onTime) => clause(onTime, onTime ? 'Every graded event came by the deadline' : 'Some graded events came after the deadline, as listed above');
const test = (name, clauses) => ({ name, pass: clauses.every((c) => c.pass), clauses });

/** Tests 1 to 4 as PILOT.md defines them, from the selected calls, the sweep, the webhook evidence and the timing. */
export function pilotTests({ main, fox, swept, webhook, late = [] }) {
  const get = (n) => main.get(n);
  const all = Array.from({ length: SCRIPT_COUNT }, (_, i) => get(i + 1));
  const lists = all.filter(Boolean).flatMap((c) => c.list);
  const counted = countedGaps(lists);
  const gap = medianGap(counted, { sources: ['voice'] });
  // A gap no honest page could post fails Test 4, whatever the median shows (R3-8).
  const gapIssues = gapProblems(lists);
  const onTime = onTimeClause(late.length === 0);
  const restarted = sameGiftRestarted(get(2), get(3));
  const paid = webhook.found ? "Render shows the verified INVOICING.INVOICE.PAID event for Script 5's invoice"
    : "Render's list shows no verified INVOICING.INVOICE.PAID event for Script 5's invoice";
  return {
    gap,
    gapProblems: gapIssues,
    tests: [
      test('Test 1, gift care end to end', [passedClause(get(2), 2, { byVoice: true }), passedClause(get(3), 3, { byVoice: true }),
        clause(restarted, restarted ? 'Script 3 restarted the gift Script 2 paused, after it' : 'Script 3 did not restart the gift Script 2 paused, after it'), onTime]),
      test('Test 2, one-time gift with the trust step', [passedClause(get(5), 5), clause(webhook.found, paid), passedClause(get(6), 6), onTime]),
      test('Test 3, read-back truth in 10 of 10 calls', [allScriptsClause(all),
        clause(swept.writes.length === 0, swept.writes.length === 0 ? 'No write without a yes in any call in the window' : `${swept.writes.length} writes problems in the window`), onTime]),
      // Finished by voice means the call passed its checks, ended with its own last line, and acted on a voice turn after the PIN.
      test('Test 4, voice a judge can use', [browserClause(main, 'chrome', 'Chrome'), browserClause(main, 'safari', 'Safari'), foxClause(fox), gapClause(gap, counted),
        clause(gapIssues.length === 0, gapIssues.length === 0 ? 'No gap problems' : `${gapIssues.length} logged gaps can't be right, as listed under every problem`), onTime]),
    ],
  };
}
