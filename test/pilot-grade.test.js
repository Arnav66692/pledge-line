import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scriptByNumber, scriptTurns } from '../src/pilot-scripts.js';
import { DEADLINE, formatPt, selectCalls, windowCalls, startedAfter, sweep, stops, timing, pilotTests, pinLeaks } from '../src/pilot-grade.js';
import { buildStack, tempDir } from './helpers.js';

const CHECK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pilot-check.js');
const AGENTS = {
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
  edge: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
};
const CHROMIUM = { vendor: 'Google Inc.', chrome: true, uaData: true };
const SIGNALS = { chrome: CHROMIUM, edge: CHROMIUM, safari: { vendor: 'Apple Computer, Inc.', chrome: false, uaData: false }, firefox: { vendor: '', chrome: false, uaData: false } };
const WEBHOOK = { found: true, source: 'render', event: { eventId: 'WH-1', ts: '2026-11-03T19:00:00.000Z' } };
const VOICE_GAP_MS = 1800;

/** One call made the way the page makes it. Spoken lines come from `source`, the PIN from the keypad. */
async function runAs(stack, number, browser, { source = browser === 'firefox' ? 'typed' : 'voice', turns = null, end = null } = {}) {
  const lines = turns ?? scriptTurns(scriptByNumber(number), stack.config.pin).map((t) => (t.source === 'typed' ? { ...t, source } : t));
  const started = stack.calls.start({ script: number, userAgent: AGENTS[browser], client: SIGNALS[browser] });
  let answering = started.turn;
  for (const t of lines) {
    const result = await stack.calls.turn(started.callId, { text: t.text, source: t.source, answering });
    answering = result.turn;
    stack.calls.logGap(started.callId, { turn: result.turn, gapMs: VOICE_GAP_MS, source: t.source, muted: false, played: true });
  }
  if (end) await stack.calls.end(started.callId, end);
  return started.callId;
}

// The mock run, labelled the way a sandbox run is, so the mock guard is not what decides these tests.
const asSandbox = (events) => events.map((e) => {
  const copy = structuredClone(e);
  if (copy.type === 'call_start') copy.mode = { paypal: 'sandbox', router: 'haiku' };
  if (typeof copy.debugId === 'string') copy.debugId = copy.debugId.replace(/^mock-/, 'sbx-');
  if (copy.type === 'route') copy.model = 'claude-haiku-5-5';
  return copy;
});

/** Scripts 1 to 10, Script 1 in Safari and the rest in Chrome, then Scripts 2 and 3 typed in Firefox. */
async function honestPilot({ before = async () => {}, after = async () => {}, safariScript1 = true } = {}) {
  const stack = buildStack();
  await before(stack);
  for (let n = 1; n <= 10; n += 1) if (n !== 1 || safariScript1) await runAs(stack, n, n === 1 ? 'safari' : 'chrome');
  for (const n of [2, 3]) await runAs(stack, n, 'firefox');
  await after(stack);
  return { stack, events: asSandbox(stack.ledger.all()) };
}

/** Grades the events as pilot-check does. With until, only calls that started by then are graded, as pilot-check picks them (G2). */
function grade(events, { webhook = WEBHOOK, pin = '2468', until = null } = {}) {
  const selected = selectCalls(events, { until });
  const swept = sweep(windowCalls(events), { pin });
  const times = timing([...selected.main.values(), ...selected.fox.values()], webhook.event);
  const results = pilotTests({ main: selected.main, fox: selected.fox, swept, webhook, late: times.late });
  return { selected, swept, times, gap: results.gap, gapProblems: results.gapProblems, pass: results.tests.map((t) => t.pass), tests: results.tests, stops: stops(swept) };
}

const callOf = (events, number, browser) => events.filter((e) => e.type === 'call_start' && e.script === number && e.browser === browser).at(-1).callId;

test('an honest pilot passes all four tests with no stops', async () => {
  const { events } = await honestPilot();
  const result = grade(events);
  assert.deepEqual(result.pass, [true, true, true, true]);
  assert.deepEqual(result.stops, []);
  assert.equal(result.gap, VOICE_GAP_MS);
  assert.equal(result.selected.main.get(1).browser, 'safari');
});

test('a Safari call counts for Test 4 only when it ran its script, passed and ended with its last line', async () => {
  const noise = [{ text: '2468', source: 'keypad' }, { text: 'hmm mm', source: 'voice' }, { text: 'blah blah', source: 'voice' }];
  const { events } = await honestPilot({ safariScript1: false, before: (stack) => runAs(stack, 1, 'safari', { turns: noise, end: 'client' }) });
  assert.equal(grade(events).pass[3], false, 'a Safari call that never understood a word');
});

test('a call that never went past the PIN never replaces a real run, and Test 3 needs every script to pass its behavior check', async () => {
  const pinOnly = [{ text: '2468', source: 'keypad' }];
  const misclicks = await honestPilot({ after: async (stack) => { for (const n of [4, 7, 10]) await runAs(stack, n, 'chrome', { turns: pinOnly, end: 'client' }); } });
  const kept = grade(misclicks.events);
  assert.deepEqual(kept.pass, [true, true, true, true]);
  assert.equal(kept.selected.main.get(4).list.some((e) => e.type === 'proposed'), true, 'the real Script 4 is still the one graded');
  const stray = await honestPilot({ after: (stack) => runAs(stack, 9, 'chrome', { turns: [...pinOnly, { text: 'hello', source: 'voice' }], end: 'client' }) });
  assert.equal(grade(stray.events).pass[2], false, 'a later call that never ran Script 9 fails Test 3');
});

test('anything after the deadline fails every test, and the first and last event times are reported in PT', async () => {
  const { events } = await honestPilot();
  const shift = Date.parse(DEADLINE) - Date.parse(events[0].ts) + 3600000;
  const late = events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString() }));
  const result = grade(late);
  assert.deepEqual(result.pass, [false, false, false, false]);
  assert.ok(result.times.late.length > 0);
  assert.equal(result.times.first, late[0].ts);
  const lateHook = grade(events, { webhook: { ...WEBHOOK, event: { ...WEBHOOK.event, ts: '2026-11-05T05:00:01.000Z' } } });
  assert.deepEqual(lateHook.pass, [false, false, false, false], 'a paid webhook after the deadline');
  assert.equal(formatPt(DEADLINE), 'Wed Nov 4, 2026, 9:00 pm PT');
});

test('a call counts for a browser only when its logged agent and engine signals give that browser', async () => {
  const { events } = await honestPilot();
  const start = events.find((e) => e.callId === callOf(events, 1, 'safari') && e.type === 'call_start');
  start.userAgent = AGENTS.chrome;
  const result = grade(events);
  assert.equal(result.selected.main.has(1), false, 'a Safari label on a Chrome agent');
  assert.equal(result.pass[3], false);
});

test('writes and safety checks cover every call in the window, not only the graded ones', async () => {
  const { events } = await honestPilot();
  const free = events.filter((e) => e.callId === callOf(events, 7, 'chrome')).map((e) => ({ ...structuredClone(e), callId: 'free-call', ...(e.type === 'call_start' ? { script: null } : {}) }));
  for (const e of free) if (e.type === 'read' && e.what === 'invoice' && e.snapshot) e.snapshot.recipient_email = 'bob@gmail.com';
  const loose = { type: 'write', callId: 'free-call', turn: 9, kind: 'suspend', targetId: 'I-MOCK0000001', tokenId: null, ok: true, debugId: 'sbx-1', ms: 1, ts: free[0].ts };
  const result = grade([...free, loose, ...events].map((e, i) => ({ ...e, seq: i + 1 })));
  assert.ok(result.stops.some((v) => v.callId === 'free-call' && v.message.includes('email other than the one on file')));
  assert.ok(result.swept.writes.some((v) => v.callId === 'free-call' && v.message.includes('without a one-time token')));
  assert.equal(result.pass[2], false, 'a write without a yes anywhere fails Test 3');
});

test('Test 1 needs Script 3 to restart the same gift Script 2 paused, after it', async () => {
  const { events } = await honestPilot();
  const three = callOf(events, 3, 'chrome');
  const other = events.map((e) => (e.callId === three ? JSON.parse(JSON.stringify(e).replaceAll('I-MOCK0000001', 'I-OTHER00001')) : e));
  assert.equal(grade(other).pass[0], false, 'Script 3 restarted another gift');
  const two = callOf(events, 2, 'chrome');
  const moved = [...events.filter((e) => e.callId === three), ...events.filter((e) => e.callId !== three)].map((e, i) => ({ ...e, seq: i + 1 }));
  assert.equal(moved.findIndex((e) => e.callId === three) < moved.findIndex((e) => e.callId === two), true);
  assert.equal(grade(moved).pass[0], false, 'Script 3 ran before Script 2');
});

test('Edge and other browsers never replace a graded call, and are recorded apart', async () => {
  const { events } = await honestPilot({ after: async (stack) => { for (const n of [1, 2, 3]) await runAs(stack, n, 'edge'); } });
  const result = grade(events);
  assert.deepEqual(result.pass, [true, true, true, true]);
  assert.deepEqual([...result.selected.others.keys()].sort(), [1, 2, 3]);
  assert.equal(result.selected.main.get(2).browser, 'chrome');
});

test('Test 4 counts one gap per heard voice turn, so extra gap events cannot pull the median down', async () => {
  const { events } = await honestPilot();
  const slow = events.map((e) => (e.type === 'gap' && e.source === 'voice' ? { ...e, gapMs: 5000 } : e));
  const forged = slow.filter((e) => e.type === 'gap').flatMap((e) => [{ ...e, gapMs: 100 }, { ...e, source: 'voice', gapMs: 100 }, { ...e, turn: e.turn + 50, source: 'voice', gapMs: 100 }]);
  const result = grade([...slow, ...forged].map((e, i) => ({ ...e, seq: i + 1 })));
  // A turn with two gaps counts neither of them and is a problem, so the forged 100 ms gaps never reach the median (R3-8).
  assert.notEqual(result.gap, 100);
  assert.ok(result.gapProblems.some((v) => /gaps were logged for one turn/.test(v.message)));
  assert.equal(result.pass[3], false);
});

test('the PIN is found in any reading of what the caller said, or plainly in what the line said', async () => {
  const { events } = await honestPilot();
  assert.deepEqual(pinLeaks(windowCalls(events), '2468'), []);
  const leaked = events.map((e) => (e.type === 'heard' && e.source === 'keypad' ? { ...e, text: 'two four six eight' } : e));
  assert.ok(pinLeaks(windowCalls(leaked), '2468').length > 0);
  const said = events.map((e) => (e.type === 'said' && e.turn === 1 ? { ...e, text: `${e.text} Your PIN is 2468.` } : e));
  assert.ok(pinLeaks(windowCalls(said), '2468').length > 0);
  // An invoice number PayPal returned can share the PIN's digits by chance, and that is no leak.
  const suffix = [{ type: 'call_start', callId: 'c', seq: 1 }, { type: 'said', callId: 'c', seq: 2, turn: 2, text: 'PayPal shows invoice ending in 0001.', facts: [{ kind: 'number_suffix', value: '0001', source: 'invoice.number_last4' }] }];
  assert.deepEqual(pinLeaks(windowCalls(suffix), '0001'), []);
});

test('a refused or empty run replaces PILOT-RESULTS.md with a notice, and keeps the last graded results beside it', async () => {
  const { stack } = await honestPilot();
  const dir = tempDir();
  const run = (...args) => spawnSync(process.execPath, [CHECK_SCRIPT, '--ledger', stack.ledger.path, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  fs.writeFileSync(path.join(dir, 'PILOT-RESULTS.md'), '# Pilot results\n\n- **Test 1, gift care end to end.** PASS\n');
  const refused = run();
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'PILOT-RESULTS.md'), 'utf8'), /no grade[\s\S]*MOCK RUN, does not count/);
  const empty = run('--since', '2030-01-01T00:00:00Z');
  assert.equal(empty.status, 1, empty.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'PILOT-RESULTS.md'), 'utf8'), /found no scripted calls/);
  assert.match(fs.readFileSync(path.join(dir, 'PILOT-RESULTS.previous.md'), 'utf8'), /Test 1, gift care end to end\.\*\* PASS/, 'a notice never replaces the kept results');
});

const LOCK = [{ text: '1111', source: 'keypad' }, { text: '2222', source: 'keypad' }, { text: '3333', source: 'keypad' }];

/** Scripts 1 to 10, each run as plan(n) says, then Scripts 2 and 3 typed in Firefox. */
async function pilotWith(plan) {
  const stack = buildStack();
  for (let n = 1; n <= 10; n += 1) {
    const { browser, ...options } = plan(n);
    await runAs(stack, n, browser, options);
  }
  for (const n of [2, 3]) await runAs(stack, n, 'firefox');
  return asSandbox(stack.ledger.all());
}

test('Script 8 never earns browser credit, so a run whose speech never worked in Safari or Chrome fails Test 4', async () => {
  // The only Safari call is Script 8, and its one voice turn after the lock is noise.
  const safari = await pilotWith((n) => (n === 8 ? { browser: 'safari', turns: [...LOCK, { text: 'blah blah', source: 'voice' }] } : { browser: 'chrome' }));
  assert.deepEqual(grade(safari).pass, [true, true, true, false]);
  // Chrome speech never gave a usable line, so every Chrome call but Script 8 was typed, and Scripts 2 and 3 ran by voice in Safari.
  const chrome = await pilotWith((n) => {
    if (n === 2 || n === 3) return { browser: 'safari' };
    return n === 8 ? { browser: 'chrome', turns: [...LOCK, { text: 'uh huh', source: 'voice' }] } : { browser: 'chrome', source: 'typed' };
  });
  assert.deepEqual(grade(chrome).pass, [true, true, true, false]);
});

test('pilot-check holds every call to the configured org name', async () => {
  const { events } = await honestPilot();
  assert.ok([...selectCalls(events, { orgName: 'Sunny Hollow Pantry' }).main.values()].every((c) => c.grade.passed));
  const other = selectCalls(events, { orgName: 'Maple Street Pantry' });
  assert.ok([...other.main.values()].every((c) => !c.grade.passed));
  assert.ok(other.main.get(1).grade.facts.some((v) => v.message.includes('logged the org name "Sunny Hollow Pantry", but ORG_NAME is "Maple Street Pantry"')));
});

test('a gap shorter than the line took to make its reply, or two gaps for one turn, fails Test 4 with a clear reason', async () => {
  const { events } = await honestPilot();
  // The line logged 2,500 ms to make Script 2's offer, but the page says it began playing 1,800 ms after the button.
  const two = callOf(events, 2, 'chrome');
  const offerTurn = events.find((e) => e.callId === two && e.type === 'proposed').turn;
  const slowServer = grade(events.map((e) => (e.callId === two && e.type === 'said' && e.turn === offerTurn ? { ...e, ms: 2500 } : e)));
  assert.equal(slowServer.pass[3], false);
  assert.ok(slowServer.gapProblems.some((v) => v.message.includes('shorter than the 2500 ms the line took')));
  // Every real voice gap is 5,000 ms, and a forged 250 ms gap was posted just before each one.
  const forged = [];
  for (const e of events) {
    if (e.type === 'gap' && e.source === 'voice') forged.push({ ...e, gapMs: 250 }, { ...e, gapMs: 5000 });
    else forged.push(e);
  }
  const doubled = grade(forged.map((e, i) => ({ ...e, seq: i + 1 })));
  assert.equal(doubled.pass[3], false);
  assert.notEqual(doubled.gap, 250);
  assert.ok(doubled.gapProblems.some((v) => v.message.includes('2 gaps were logged for one turn')));
});

test('the line\'s own housekeeping after the last heard turn never makes a run late, and a late caller turn still does', async () => {
  for (const close of ['idle', 'client']) {
    // Script 10's goodbye is misheard, so its call stays open until the idle sweep or the page's end beacon closes it.
    const { events } = await honestPilot({
      after: async (stack) => {
        const turns = scriptTurns(scriptByNumber(10), stack.config.pin).map((t) => (t.source === 'typed' ? { ...t, source: 'voice' } : t));
        const callId = await runAs(stack, 10, 'chrome', { turns: [...turns.slice(0, -1), { text: 'Good buy.', source: 'voice' }] });
        stack.clock.advance(stack.config.limits.callIdleMs + 1);
        if (close === 'idle') await stack.calls.sweep();
        else await stack.calls.end(callId, 'client');
      },
    });
    // Everything the caller and PayPal did is 5 minutes before the deadline, and the call closes 5 minutes after it.
    const shift = Date.parse(DEADLINE) - Date.parse(events[0].ts) - 300000;
    const shifted = events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString() }));
    const ten = callOf(shifted, 10, 'chrome');
    assert.ok(shifted.some((e) => e.callId === ten && e.type === 'call_end' && e.reason === close && Date.parse(e.ts) > Date.parse(DEADLINE)), close);
    const onTime = grade(shifted);
    assert.deepEqual(onTime.times.late, [], close);
    assert.deepEqual(onTime.pass, [true, true, true, true], close);
    const lastHeard = shifted.filter((e) => e.callId === ten && e.type === 'heard').at(-1);
    const lateTurn = shifted.map((e) => (e === lastHeard ? { ...e, ts: new Date(Date.parse(DEADLINE) + 1000).toISOString() } : e));
    assert.deepEqual(grade(lateTurn).pass, [false, false, false, false], `${close}, a caller turn after the deadline`);
  }
});

/** The real pilot-check CLI over a sandbox-labelled copy of the events, in a scratch folder, with a scratch Hours log. */
function cliRun(events, { hours = '| Tue Nov 3 | 9:00 am | 11:00 am | 2 | scripted calls |', env = { DEMO_SUBSCRIPTION_ID: 'I-MOCK0000001' }, args = [] } = {}) {
  const dir = tempDir();
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledgerPath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const hoursPath = path.join(dir, 'hours.md');
  fs.writeFileSync(hoursPath, ['## Hours log', '', '| Date | Start | End | Hours | What |', '|---|---|---|---|---|', hours, '| | | | | |', ''].join('\n'));
  const result = spawnSync(process.execPath, [CHECK_SCRIPT, '--ledger', ledgerPath, '--hours', hoursPath, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { ...result, results: fs.readFileSync(path.join(dir, 'PILOT-RESULTS.md'), 'utf8') };
}

test('pilot-check refuses a real grade without DEMO_SUBSCRIPTION_ID, and holds every call in the window to it', async () => {
  const { events } = await honestPilot();
  const refused = cliRun(events, { env: {} });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.results, /no grade[\s\S]*DEMO_SUBSCRIPTION_ID is not configured/);
  const graded = cliRun(events);
  assert.match(graded.results, /Test 3, read-back truth in 10 of 10 calls\.\*\* PASS/);
  const other = cliRun(events, { env: { DEMO_SUBSCRIPTION_ID: 'I-OTHER00001' } });
  assert.match(other.results, /Test 3, read-back truth in 10 of 10 calls\.\*\* FAIL/);
  assert.match(other.results, /a read of I-MOCK0000001, not of the pilot's subscription, I-OTHER00001/);
});

test('pilot-check reads the Hours log, refuses an empty or unreadable one, and fails anything after the 6th logged hour', async () => {
  const { events } = await honestPilot();
  const empty = cliRun(events, { hours: '| | | | | |' });
  assert.equal(empty.status, 2, empty.stderr);
  assert.match(empty.results, /no grade[\s\S]*found no rows in the Hours log[\s\S]*\| Tue Nov 3 \| 6:00 pm \| 8:30 pm \| 2\.5 \| sandbox setup \|/);
  const unreadable = cliRun(events, { hours: '| Wed Nov 3 | 9 am | 11 am | 2 | typo |' });
  assert.equal(unreadable.status, 2, unreadable.stderr);
  assert.match(unreadable.results, /Line 5 of hours\.md, `\| Wed Nov 3 \| 9 am \| 11 am \| 2 \| typo \|`, has a Date pilot-check cannot read/);
  // Six hours logged on Tue Nov 3 end before any call, so every test fails, and the calls are recorded after the deadline (G2).
  const spent = cliRun(events, { hours: '| Tue Nov 3 | 3:00 am | 9:00 am | 6 | early |' });
  assert.equal(spent.status, 1, spent.stderr);
  assert.equal((spent.results.match(/\*\* FAIL/g) ?? []).length, 4);
  assert.match(spent.results, /The 6th logged hour ended Tue Nov 3, 2026, 9:00 am PT\. The effective deadline is Tue Nov 3, 2026, 9:00 am PT/);
  assert.match(spent.results, /## Recorded after the deadline, not scored[\s\S]*- Script 1, safari, call /);
  // Hours logged on Mon Nov 2 come before the clock and never count toward the 6 hours (G4). Alone they are refused.
  const monday = cliRun(events, { hours: '| 11/2 | 9:00 am | 3:00 pm | 6 | early |' });
  assert.equal(monday.status, 2, monday.stderr);
  assert.match(monday.results, /no grade[\s\S]*found no rows on Tue Nov 3 or Wed Nov 4/);
  const withTuesday = cliRun(events, { hours: '| 11/2 | 9:00 am | 3:00 pm | 6 | early |\n| Tue Nov 3 | 9:00 am | 11:00 am | 2 | scripted calls |' });
  assert.match(withTuesday.results, /Test 1, gift care end to end\.\*\* PASS/);
  assert.match(withTuesday.results, /Total logged, 2 hours[\s\S]*the bar's own deadline/);
  assert.match(withTuesday.results, /Warnings, not fails\.\*\* The row on line 5 is on 2026-11-02, outside Tue Nov 3 and Wed Nov 4, so its hours don't count/);
  // A log that covers the calls grades them, prints the rows and the deadline, and warns about calls outside every row.
  const covered = cliRun(events);
  assert.match(covered.results, /Test 1, gift care end to end\.\*\* PASS/);
  assert.match(covered.results, /- Line 5, Tue Nov 3, 2026, 9:00 am PT to Tue Nov 3, 2026, 11:00 am PT, 2 hours\./);
  assert.match(covered.results, /Total logged, 2 hours[\s\S]*The effective deadline is Wed Nov 4, 2026, 9:00 pm PT, the bar's own deadline/);
  assert.match(cliRun(events, { hours: '| Tue Nov 3 | 11:00 am | 1:00 pm | 2 | later |' }).results, /Warnings, not fails\.\*\* Script 1, safari, call [0-9a-f-]+, has events outside every logged row/);
});

test('every run that stops without a fresh grade leaves the notice, keeps the last real grade beside it, and --since takes an offset', async () => {
  const { stack } = await honestPilot();
  const dir = tempDir();
  const run = (args, env = {}) => spawnSync(process.execPath, [CHECK_SCRIPT, '--ledger', stack.ledger.path, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const results = path.join(dir, 'PILOT-RESULTS.md');
  const previous = path.join(dir, 'PILOT-RESULTS.previous.md');
  const realGrade = '# Pilot results\n\n- **Test 1, gift care end to end.** PASS\n';
  const stops = [[['--since', '2026-11-03T00:00PT'], {}, /--since must be an ISO time with its offset, such as 2026-11-03T18:00-08:00/], [[], { ORG_NAME: 'Pantry 2' }, /Config problems/]];
  for (const [args, env, why] of stops) {
    fs.writeFileSync(results, realGrade);
    fs.rmSync(previous, { force: true });
    const stopped = run(args, env);
    assert.equal(stopped.status, 1, stopped.stderr);
    assert.match(fs.readFileSync(results, 'utf8'), /^# Pilot results, no grade[\s\S]*stopped on an error before it could grade/);
    assert.match(fs.readFileSync(results, 'utf8'), why);
    assert.equal(fs.readFileSync(previous, 'utf8'), realGrade);
  }
  // A -08:00 or -07:00 offset is read as a time, so this mock ledger is graded and refused as a mock run.
  for (const since of ['2026-11-03T09:00-08:00', '2026-11-03T09:00:00-07:00']) assert.equal(run(['--since', since]).status, 2, since);
});

const execFileAsync = promisify(execFile);
const REAL_ENV = { DEMO_SUBSCRIPTION_ID: 'I-MOCK0000001', PILOT_PIN: '2468' };

/** A ledger and an Hours log in a scratch folder, for runs of the real pilot-check CLI. */
function scratchRun(events, hours = '| Tue Nov 3 | 9:00 am | 11:00 am | 2 | scripted calls |') {
  const dir = tempDir();
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const hoursPath = path.join(dir, 'hours.md');
  const writeEvents = (list) => fs.writeFileSync(ledgerPath, `${list.map((e) => JSON.stringify(e)).join('\n')}\n`);
  writeEvents(events);
  fs.writeFileSync(hoursPath, ['## Hours log', '', '| Date | Start | End | Hours | What |', '|---|---|---|---|---|', hours, ''].join('\n'));
  const file = (name) => path.join(dir, name);
  return { dir, ledgerPath, hoursPath, writeEvents, file, read: (name) => fs.readFileSync(file(name), 'utf8') };
}

/** The real CLI, run without blocking, so a fake Render in this process can answer it. */
async function cliAsync(run, args, env = REAL_ENV) {
  try {
    const out = await execFileAsync(process.execPath, [CHECK_SCRIPT, ...args], { cwd: run.dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    return { status: 0, ...out };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** A fake Render whose webhook list the test can change, or that never answers, like a free service still waking. */
async function fakeRender({ webhooks = [], hang = false } = {}) {
  const state = { webhooks };
  const server = http.createServer((req, res) => {
    if (hang) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/api/webhooks' ? JSON.stringify({ webhooks: state.webhooks }) : '{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => { server.close(resolve); });
  };
  return { url: `http://127.0.0.1:${server.address().port}`, state, server, close };
}

test('a call that started after the deadline is recorded, not scored, so a later demo never fails a pilot that met the bar (G2)', async () => {
  const { stack, events } = await honestPilot();
  assert.deepEqual(grade(events, { until: DEADLINE }).pass, [true, true, true, true]);
  // A Safari demo of Script 1 at 9:15 pm on Wed Nov 4, picked from the menu after the deadline.
  stack.clock.t = Date.parse(DEADLINE) + 15 * 60000;
  await runAs(stack, 1, 'safari');
  const withDemo = asSandbox(stack.ledger.all());
  const result = grade(withDemo, { until: DEADLINE });
  assert.deepEqual(result.pass, [true, true, true, true]);
  assert.notEqual(result.selected.main.get(1).callId, callOf(withDemo, 1, 'safari'), 'the demo never replaces the graded Script 1');
  assert.deepEqual(startedAfter(withDemo, { until: DEADLINE }).map((c) => [c.number, c.browser]), [[1, 'safari']]);
  // A graded call that started by the deadline and ran past it still fails every test.
  const ten = callOf(events, 10, 'chrome');
  const lastHeard = events.filter((e) => e.callId === ten && e.type === 'heard').at(-1);
  const ranPast = events.map((e) => (e === lastHeard ? { ...e, ts: new Date(Date.parse(DEADLINE) + 1000).toISOString() } : e));
  assert.deepEqual(grade(ranPast, { until: DEADLINE }).pass, [false, false, false, false]);
});

test('a regrade after a late demo and a Render restart still passes, moves the last grade aside, and reuses the paid event (G2)', async () => {
  const { stack, events } = await honestPilot();
  const invoice = events.find((e) => e.type === 'write' && e.kind === 'send_invoice').targetId;
  const paid = { eventId: 'WH-1', eventType: 'INVOICING.INVOICE.PAID', resourceId: invoice, verified: true, verifyStatus: 'SUCCESS', ts: '2026-11-03T19:00:00.000Z' };
  const render = await fakeRender({ webhooks: [paid] });
  try {
    const run = scratchRun(events);
    const args = ['--ledger', run.ledgerPath, '--hours', run.hoursPath, '--render', render.url];
    const first = await cliAsync(run, args);
    assert.equal(first.status, 0, first.stdout);
    const evidence = JSON.parse(run.read('ledger.paid-webhook.json'));
    assert.deepEqual([evidence.eventId, evidence.resourceId, evidence.ts], ['WH-1', invoice, paid.ts]);
    // A Safari demo of Script 1 after the deadline, then Render restarts and loses its list.
    stack.clock.t = Date.parse(DEADLINE) + 15 * 60000;
    await runAs(stack, 1, 'safari');
    run.writeEvents(asSandbox(stack.ledger.all()));
    render.state.webhooks = [];
    const second = await cliAsync(run, args);
    assert.equal(second.status, 0, second.stdout);
    const results = run.read('PILOT-RESULTS.md');
    assert.equal((results.match(/\*\* PASS/g) ?? []).length, 4);
    assert.match(results, /## Recorded after the deadline, not scored\n\n- Script 1, safari, call [0-9a-f-]+, started Wed Nov 4, 2026, 9:15 pm PT\./);
    assert.match(results, /Webhook event, WH-1, from http:\/\/127\.0\.0\.1:\d+, saved [^,]+, 2026, [^,]+ PT, received Tue Nov 3, 2026, 11:00 am PT\./);
    const previous = run.read('PILOT-RESULTS.previous.md');
    assert.match(previous, /^# Pilot results\n/);
    assert.equal((previous.match(/\*\* PASS/g) ?? []).length, 4, 'the first grade is moved aside, not lost');
  } finally {
    await render.close();
  }
});

test('a run stopped while Render hangs leaves the notice, never the last grade, and keeps that grade beside it (R3-9)', async () => {
  const { events } = await honestPilot();
  const run = scratchRun(events);
  const realGrade = '# Pilot results\n\n- **Test 1, gift care end to end.** PASS\n';
  fs.writeFileSync(run.file('PILOT-RESULTS.md'), realGrade);
  const render = await fakeRender({ hang: true });
  try {
    const reached = once(render.server, 'request').then(() => 'reached Render');
    const child = spawn(process.execPath, [CHECK_SCRIPT, '--ledger', run.ledgerPath, '--hours', run.hoursPath, '--render', render.url],
      { cwd: run.dir, env: { PATH: process.env.PATH, ...REAL_ENV }, stdio: 'ignore' });
    const exited = once(child, 'exit');
    assert.equal(await Promise.race([reached, exited.then(() => 'exited first')]), 'reached Render');
    const during = run.read('PILOT-RESULTS.md');
    child.kill('SIGINT');
    await exited;
    assert.match(during, /^# Pilot results, no grade[\s\S]*started grading and has not finished/);
    assert.equal(run.read('PILOT-RESULTS.md'), during, 'a Ctrl-C leaves the notice');
    assert.equal(run.read('PILOT-RESULTS.previous.md'), realGrade);
  } finally {
    await render.close();
  }
});

test('pilot-check reads its flags strictly, in both forms, and refuses a flag npm kept, a stray value, a repeat or an unknown flag (G5)', async () => {
  const { events } = await honestPilot();
  const run = scratchRun(events);
  const cli = (args, env = REAL_ENV) => spawnSync(process.execPath, [CHECK_SCRIPT, ...args], { cwd: run.dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const graded = cli([`--ledger=${run.ledgerPath}`, `--hours=${run.hoursPath}`]);
  assert.match(run.read('PILOT-RESULTS.md'), /Test 1, gift care end to end\.\*\* PASS/, graded.stderr);
  assert.ok(run.read('PILOT-RESULTS.md').includes(`Read from \`${run.hoursPath}\``), 'the --hours=path form is the file read');
  // A --since after every call grades nothing, in either form.
  for (const since of [['--since=2030-01-01T00:00Z'], ['--since', '2030-01-01T00:00Z']]) {
    assert.equal(cli(['--ledger', run.ledgerPath, '--hours', run.hoursPath, ...since]).status, 1, since.join(' '));
    assert.match(run.read('PILOT-RESULTS.md'), /no grade[\s\S]*found no scripted calls/, since.join(' '));
  }
  const refusals = [
    [['--frobnicate'], {}, /pilot-check has no flag --frobnicate\./],
    [['2026-11-03T18:00-08:00'], {}, /got "2026-11-03T18:00-08:00" with no flag before it/],
    [['--since', '2026-11-03T18:00-08:00', '--since', '2026-11-04T18:00-08:00'], {}, /--since was given twice\./],
    [['--resend=yes'], {}, /--resend takes no value\./],
    [['2026-11-03T18:00-08:00'], { npm_config_since: 'true' }, /npm kept --since for itself/],
  ];
  for (const [args, env, why] of refusals) {
    const result = cli(['--ledger', run.ledgerPath, '--hours', run.hoursPath, ...args], { ...REAL_ENV, ...env });
    assert.equal(result.status, 1, args.join(' '));
    const notice = run.read('PILOT-RESULTS.md');
    assert.match(notice, /^# Pilot results, no grade[\s\S]*stopped on an error before it could grade/, args.join(' '));
    assert.match(notice, why, args.join(' '));
    assert.match(notice, /Usage: npm run pilot:check -- \[--since ISO\]/, args.join(' '));
  }
  assert.match(run.read('PILOT-RESULTS.previous.md'), /Test 1, gift care end to end\.\*\* PASS/, 'the last real grade is kept beside the notices');
});

test('every test lists its clauses with the call each used, so a FAIL always says which clause missed (G6)', async () => {
  const safari = await pilotWith((n) => (n === 8 ? { browser: 'safari', turns: [...LOCK, { text: 'blah blah', source: 'voice' }] } : { browser: 'chrome' }));
  const four = grade(safari).tests[3];
  assert.equal(four.pass, false);
  assert.deepEqual(four.clauses.filter((c) => !c.pass).map((c) => c.text.replace(/call [0-9a-f]{8}-[0-9a-f-]+/g, 'call X')),
    ['Safari has no call finished by voice. Script 8, safari, call X, the line acted on no voice turn after the PIN']);
  // Script 2 run again by voice at the end, so the graded Script 2 paused the gift after Script 3 restarted it.
  const rerun = await honestPilot({ after: (stack) => runAs(stack, 2, 'chrome') });
  const one = grade(rerun.events).tests[0];
  assert.deepEqual(one.clauses.filter((c) => !c.pass).map((c) => c.text), ['Script 3 did not restart the gift Script 2 paused, after it']);
  const cli = cliRun(rerun.events);
  assert.match(cli.results, /- \*\*Test 1, gift care end to end\.\*\* FAIL\n {2}- Met\. Script 2 passed by voice, Script 2, chrome, call [0-9a-f-]+\.\n {2}- Met\. Script 3 passed by voice[^\n]*\n {2}- Missed\. Script 3 did not restart the gift Script 2 paused, after it\./);
  assert.match(cli.results, /## Every problem\n\nNo call check problems\. Each failing test above says which clause it missed\./);
  // With every voice reply muted, the gap clause says so.
  const muted = grade(rerun.events.map((e) => (e.type === 'gap' ? { ...e, muted: true } : e))).tests[3];
  assert.ok(muted.clauses.some((c) => !c.pass && /^No unmuted voice turn was timed, and \d+ muted turns don't count$/.test(c.text)), JSON.stringify(muted.clauses));
});
