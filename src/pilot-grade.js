// Grades a whole pilot ledger against PILOT.md: which calls count, Tests 1 to 4, and the safety stops.
// Pure functions, so scripts/pilot-check.js only does the file and network work around them.
import { gradeCall, checkSafety, checkWrites, medianGap, countedGaps, latestCallsByScript, isCallBy, groupByCall } from './check.js';
import { detectBrowser } from './call.js';
import { textHasPin } from './numbers.js';
import { scriptByNumber } from './pilot-scripts.js';

// Wed Nov 4, 2026, 9:00 pm PT, the bar's deadline. PT is eight hours behind UTC after Nov 1.
export const DEADLINE = '2026-11-05T05:00:00.000Z';
export const GAP_BAR_MS = 4000;
const SCRIPT_COUNT = 10;
const SCORED_BROWSERS = new Set(['chrome', 'safari']);
// A call is finished when its own last line ended it: goodbye, or the lock in Script 8.
const FINISH_REASONS = new Set(['goodbye', 'locked']);
const CALLER_TEXT_TYPES = new Set(['heard', 'yes', 'no']);
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

function gradeEntry(number, entry) {
  return {
    ...entry,
    number,
    grade: gradeCall(entry.list, scriptByNumber(number)),
    voice: isCallBy(entry.list, 'voice'),
    typed: isCallBy(entry.list, 'typed'),
    browser: creditedBrowser(entry.start),
    finished: entry.list.some((e) => e.type === 'call_end' && FINISH_REASONS.has(e.reason)),
    mock: isMockCall(entry),
  };
}

/**
 * The graded calls. Scripts 1 to 10 come from the latest Chrome or Safari call of each, the Firefox clause from
 * the latest Firefox calls, and Edge and other browsers are recorded apart, never scored.
 */
export function selectCalls(events, { since = null, dryRun = false } = {}) {
  const pick = (wanted) => {
    const filter = (start, list) => wanted(creditedBrowser(start)) && ranPastPin(list);
    return new Map([...latestCallsByScript(events, { since, dryRun, filter })].map(([n, entry]) => [n, gradeEntry(n, entry)]));
  };
  return {
    main: pick((browser) => SCORED_BROWSERS.has(browser)),
    fox: pick((browser) => browser === 'firefox'),
    others: pick((browser) => !SCORED_BROWSERS.has(browser) && browser !== 'firefox'),
  };
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

/** Writes, safety and the PIN over every call in the window, scored or not, so a clean retry never hides an earlier failure. */
export function sweep(calls, { pin = null } = {}) {
  const events = [...calls.values()].flat();
  return { writes: checkWrites(events), safety: checkSafety(events), pin: pinLeaks(calls, pin) };
}

/** Any safety problem or PIN leak in the window is a stop (PILOT.md, safety checks). */
export const stops = (swept) => [...swept.safety, ...swept.pin];

/** The first and last event times of the graded calls, and what came after the deadline (the bar says any miss counts). */
export function timing(entries, webhookEvent, deadline = DEADLINE) {
  const limit = Date.parse(deadline);
  const times = entries.flatMap((c) => c.list.map((e) => Date.parse(e.ts))).filter(Number.isFinite).sort((a, b) => a - b);
  const late = entries.filter((c) => c.list.some((e) => !(Date.parse(e.ts) <= limit)))
    .map((c) => `Script ${c.number}, ${c.browser}, call ${c.callId}, has events after the deadline`);
  if (webhookEvent && !(Date.parse(webhookEvent.ts) <= limit)) late.push(`the paid webhook ${webhookEvent.eventId} reached Render after the deadline`);
  const iso = (ms) => (ms === undefined ? null : new Date(ms).toISOString());
  return { first: iso(times[0]), last: iso(times.at(-1)), late };
}

/** Script 3 restarts the same gift Script 2 paused, and after it (PILOT.md Test 1, "Activate returns it to ACTIVE"). */
export function sameGiftRestarted(two, three) {
  const suspend = two?.list.find((e) => e.type === 'write' && e.kind === 'suspend' && e.ok);
  const activate = three?.list.find((e) => e.type === 'write' && e.kind === 'activate' && e.ok);
  return Boolean(suspend && activate && activate.targetId === suspend.targetId && activate.seq > suspend.seq);
}

/** Tests 1 to 4 as PILOT.md defines them, from the selected calls, the sweep, the webhook evidence and the timing. */
export function pilotTests({ main, fox, swept, webhook, late = [] }) {
  const get = (n) => main.get(n);
  const passedVoice = (n) => Boolean(get(n)?.grade.passed && get(n).voice);
  const all = Array.from({ length: SCRIPT_COUNT }, (_, i) => get(i + 1));
  const gap = medianGap(countedGaps(all.filter(Boolean).flatMap((c) => c.list)), { sources: ['voice'] });
  // Finished by voice means the call ran its whole script, passed its checks and ended with its own last line.
  const finishedBy = (browser) => [...main.values()].some((c) => c.browser === browser && c.voice && c.finished && c.grade.passed);
  const foxOk = [2, 3].every((n) => fox.get(n)?.grade.passed && fox.get(n).typed && fox.get(n).finished);
  const onTime = late.length === 0;
  return {
    gap,
    tests: [
      { name: 'Test 1, gift care end to end', pass: onTime && passedVoice(2) && passedVoice(3) && sameGiftRestarted(get(2), get(3)) },
      { name: 'Test 2, one-time gift with the trust step', pass: onTime && Boolean(get(5)?.grade.passed && webhook.found && get(6)?.grade.passed) },
      { name: 'Test 3, read-back truth in 10 of 10 calls', pass: onTime && all.every((c) => c?.grade.passed) && swept.writes.length === 0 },
      { name: 'Test 4, voice a judge can use', pass: onTime && finishedBy('chrome') && finishedBy('safari') && foxOk && gap !== null && gap < GAP_BAR_MS },
    ],
  };
}
