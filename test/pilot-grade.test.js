import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptByNumber, scriptTurns } from '../src/pilot-scripts.js';
import { DEADLINE, formatPt, selectCalls, windowCalls, sweep, stops, timing, pilotTests, pinLeaks } from '../src/pilot-grade.js';
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

function grade(events, { webhook = WEBHOOK, pin = '2468' } = {}) {
  const selected = selectCalls(events);
  const swept = sweep(windowCalls(events), { pin });
  const times = timing([...selected.main.values(), ...selected.fox.values()], webhook.event);
  const results = pilotTests({ main: selected.main, fox: selected.fox, swept, webhook, late: times.late });
  return { selected, swept, times, gap: results.gap, pass: results.tests.map((t) => t.pass), stops: stops(swept) };
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
  assert.equal(result.gap, 5000);
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
