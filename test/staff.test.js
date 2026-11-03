import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { buildReceipts, receiptOptions } from '../src/receipt.js';
import { projectStaffEvent, staffKeyMatches, HIDDEN_PIN, HIDDEN_EMAIL } from '../src/staff.js';
import { tempLedgerPath } from './helpers.js';

// A known PIN, six digits so no uuid or debug id in the ledger contains it by chance.
const PIN = '482613';
const STAFF_KEY = 'staff-key-for-the-tests-0042';
const FILE_EMAIL = 'sb-maria@personal.example.com';
const NEW_EMAIL = 'bob.new@gmail.com';
const silent = { info: () => {}, error: () => {} };
const servers = [];

async function serve(env) {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', PILOT_PIN: PIN, ...env });
  const deps = buildDeps(config, { ledgerPath: tempLedgerPath(), log: silent, sleep: async () => {} });
  const server = createServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { deps, base: `http://127.0.0.1:${server.address().port}` };
}

/** One call in-process, the way the page sends turns, with a pause and its yes, a new email and a callback. */
async function nightCall(calls) {
  const { callId } = calls.start({ script: null, userAgent: 'Mozilla/5.0 staff-test-agent' });
  let answering = 0;
  const say = async (text, source = 'typed') => {
    const result = await calls.turn(callId, { text, source, answering });
    answering = result.turn;
    return result;
  };
  await say(PIN, 'keypad');
  await say('How much is my monthly gift?');
  await say('Please pause my monthly gift.');
  await say('Yes.');
  await say(`Send a one-time gift to ${NEW_EMAIL} please`);
  await say(`My PIN is ${PIN.split('').join(' ')}`);
  await say('Can a person call me back?');
  await say('Goodbye.');
  return callId;
}

let off;
let on;
let callId;

before(async () => {
  off = await serve({});
  on = await serve({ STAFF_KEY });
  callId = await nightCall(on.deps.calls);
  await nightCall(off.deps.calls);
});

after(() => { for (const server of servers) server.close(); });

const staffGet = (base, path, key = STAFF_KEY) => fetch(`${base}${path}`, { headers: key === null ? {} : { 'x-staff-key': key } });

test('every staff route and file is a 404 when STAFF_KEY is unset', async () => {
  const paths = ['/staff', '/api/staff/calls', `/api/staff/calls/${callId}`, '/api/staff', '/staff.html', '/staff.js', '/staff.css',
    '/vendor/ag-grid.css', '/vendor/ag-grid-community.min.js', '/%73taff.js', '/vendor%2fag-grid.css', '/Staff.js', '/Staff.html', '/%53taff.js', '/VENDOR/ag-grid.css', '/Vendor/ag-grid-community.min.js'];
  for (const path of paths) {
    const res = await staffGet(off.base, path);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(await res.text(), /AG Grid|agGrid|Staff key/, path);
  }
  // The donor page is untouched.
  assert.equal((await fetch(`${off.base}/`)).status, 200);
});

test('a wrong, short, long or missing key gets 401', async () => {
  for (const key of [null, '', 'nope', `${STAFF_KEY}x`, STAFF_KEY.slice(0, -1), STAFF_KEY.toUpperCase()]) {
    for (const path of ['/api/staff/calls', `/api/staff/calls/${callId}`]) {
      const res = await staffGet(on.base, path, key);
      assert.equal(res.status, 401, `${path} with ${JSON.stringify(key)}`);
      const body = await res.text();
      assert.doesNotMatch(body, new RegExp(callId), 'a 401 says nothing about calls');
    }
  }
  assert.equal(staffKeyMatches(STAFF_KEY, STAFF_KEY), true);
  assert.equal(staffKeyMatches('', STAFF_KEY), false);
  assert.equal(staffKeyMatches(STAFF_KEY, null), false);
});

test('the right key gets the list, one summary per call', async () => {
  const page = await fetch(`${on.base}/staff`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('content-security-policy'), "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'");
  const html = await page.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=/i, 'no inline script or style');
  assert.doesNotMatch(html, new RegExp(callId), 'the page holds no data');
  for (const file of ['/staff.js', '/staff.css', '/vendor/ag-grid-community.min.js', '/vendor/ag-grid.css', '/vendor/ag-theme-quartz.css', '/vendor/ag-grid-quartz-icons.woff2']) {
    assert.equal((await fetch(`${on.base}${file}`)).status, 200, file);
  }
  assert.equal((await fetch(`${on.base}/vendor/ag-grid-quartz-icons.woff2`)).headers.get('content-type'), 'font/woff2');

  const res = await staffGet(on.base, '/api/staff/calls');
  assert.equal(res.status, 200);
  const { calls } = await res.json();
  assert.equal(calls.length, 1);
  const [row] = calls;
  assert.equal(row.callId, callId);
  assert.equal(row.kind, 'free');
  assert.equal(row.mock, true);
  assert.equal(row.dryRun, false);
  assert.equal(row.callback, true);
  assert.equal(row.verified, true);
  assert.ok(row.started && row.ended, 'started and ended times');
  for (const intent of ['gift_status', 'pause_gift', 'staff_callback']) assert.ok(row.intents.includes(intent), intent);
  assert.ok(row.refusals.includes('other_email'));
  assert.ok(row.writes.some((w) => w.kind === 'suspend' && w.ok === true && typeof w.debugId === 'string'));
  assert.equal(row.paypalNow.subscription.status, 'SUSPENDED');
  assert.ok(row.counts.proven > 0 && row.counts.plain > 0, JSON.stringify(row.counts));
  assert.equal(row.counts.blocked, 0);
  assert.equal(row.receipts, undefined, 'the list carries counts, not receipts');
});

test('the detail adds receipts built from the same events pilot-check grades, and the projected events', async () => {
  const res = await staffGet(on.base, `/api/staff/calls/${callId}`);
  assert.equal(res.status, 200);
  const { call } = await res.json();
  const expected = buildReceipts(on.deps.ledger.byCall(callId), receiptOptions(on.deps.config));
  assert.deepEqual(call.receipts, JSON.parse(JSON.stringify(expected)));
  assert.equal(call.receipts.length, on.deps.ledger.byCall(callId).filter((e) => e.type === 'said').length);
  const sentences = call.receipts.flatMap((r) => r.sentences);
  const counts = { proven: 0, plain: 0, blocked: 0 };
  for (const s of sentences) counts[s.verdict] += 1;
  assert.deepEqual(counts, call.counts);
  const proven = sentences.find((s) => s.verdict === 'proven' && s.facts.some((f) => f.proof));
  assert.ok(proven, 'a proven sentence with a PayPal read behind a fact');
  const fact = proven.facts.find((f) => f.proof);
  assert.ok(fact.proof.debugId && fact.proof.ts && fact.proof.what);
  assert.ok(sentences.some((s) => s.claims.some((c) => c.proven && typeof c.meaning === 'string')), 'a proven claim with its meaning');
  const heard = call.events.filter((e) => e.type === 'heard');
  assert.equal(heard[0].text, `(${HIDDEN_PIN})`, 'the PIN turn is hidden');
  assert.ok(heard.some((e) => e.text === `(${HIDDEN_EMAIL})`), 'the new email turn is hidden');
  assert.ok(heard.some((e) => e.text === 'How much is my monthly gift?'), 'plain words stay');

  assert.equal((await staffGet(on.base, '/api/staff/calls/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await fetch(`${on.base}/api/staff/calls`, { method: 'POST', headers: { 'x-staff-key': STAFF_KEY } })).status, 405);
});

test('no PIN, full email, token id, user agent or snapshot in either response', async () => {
  const ledger = on.deps.ledger.byCall(callId);
  const tokenIds = ledger.map((e) => e.tokenId).filter(Boolean);
  assert.ok(tokenIds.length >= 1, 'the call made a write, so the ledger holds a token id');
  assert.ok(ledger.some((e) => e.snapshot?.subscriber_email === FILE_EMAIL), 'the ledger holds the email on file');
  const bodies = [await (await staffGet(on.base, '/api/staff/calls')).text(), await (await staffGet(on.base, `/api/staff/calls/${callId}`)).text()];
  for (const body of bodies) {
    assert.ok(!body.includes(PIN), 'no PIN');
    assert.ok(!/4\D{0,3}8\D{0,3}2\D{0,3}6\D{0,3}1\D{0,3}3/.test(body), 'no PIN digits, spaced or not');
    assert.ok(!body.includes(FILE_EMAIL) && !body.includes(NEW_EMAIL), 'no full email');
    assert.ok(!body.includes('@'), 'no @ at all');
    for (const id of tokenIds) assert.ok(!body.includes(id), 'no token id');
    assert.ok(!body.includes('staff-test-agent'), 'no user agent');
    for (const field of ['"tokenId"', '"snapshot"', '"userAgent"', '"client"', '"subscriber_email"', '"recipient_email"', '"clientKey"']) {
      assert.ok(!body.includes(field), `no ${field}`);
    }
  }
});

test('staff events are rebuilt from an allowlist, so a new ledger field never leaks', () => {
  const shown = projectStaffEvent({ type: 'read', seq: 3, ts: 't', turn: 1, what: 'subscription', status: 'ACTIVE', debugId: 'd', snapshot: { subscriber_email: FILE_EMAIL }, secret: 'x' });
  assert.deepEqual(Object.keys(shown).sort(), ['debugId', 'seq', 'status', 'ts', 'turn', 'type', 'what']);
  assert.deepEqual(Object.keys(projectStaffEvent({ type: 'something_new', seq: 1, ts: 't', extra: PIN })).sort(), ['seq', 'ts', 'type']);
  assert.equal(projectStaffEvent({ type: 'heard', seq: 9, text: `it is ${PIN}`, source: 'typed' }, { pin: PIN }).text.includes(PIN), false);
  assert.equal(projectStaffEvent({ type: 'heard', seq: 9, text: 'bob at gmail dot com', source: 'voice' }, { pin: PIN }).text, `(${HIDDEN_EMAIL})`);
  for (const text of ['bob at gmail com', 'bob at gmail', 'bob dot smith at yahoo', 'robert underscore jones at hotmail', 'bob (at) gmail', 'bob [at] gmail', 'bob at gmail.c']) {
    assert.equal(projectStaffEvent({ type: 'heard', seq: 9, text, source: 'voice' }, { pin: PIN }).text, `(${HIDDEN_EMAIL})`, text);
  }
  assert.equal(projectStaffEvent({ type: 'heard', seq: 9, text: 'Please pause my gift.', source: 'voice' }, { pin: PIN }).text, 'Please pause my gift.');
});

test('the staff API is rate limited, wrong keys included', async () => {
  const limited = await serve({ STAFF_KEY });
  const limit = limited.deps.config.limits.staffPerMinute;
  const statuses = [];
  for (let i = 0; i <= limit; i += 1) statuses.push((await staffGet(limited.base, '/api/staff/calls', i % 2 ? STAFF_KEY : 'wrong-key-wrong-key')).status);
  assert.equal(statuses.at(-1), 429);
  assert.ok(statuses.slice(0, limit).every((s) => s === 200 || s === 401));
});

test('the vendored AG Grid files match the sha256 in web/vendor/README.md, and the page never sets innerHTML', () => {
  const dir = new URL('../web/vendor/', import.meta.url);
  const readme = fs.readFileSync(new URL('README.md', dir), 'utf8');
  const rows = [...readme.matchAll(/^\| `([^`]+)` \|[^|]+\| `([0-9a-f]{64})` \|$/gm)];
  assert.equal(rows.length, 4);
  for (const [, file, sha] of rows) {
    assert.equal(createHash('sha256').update(fs.readFileSync(new URL(file, dir))).digest('hex'), sha, file);
  }
  assert.match(readme, /32\.3\.3/);
  const page = fs.readFileSync(new URL('../web/staff.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('STAFF_KEY must be at least 16 plain characters when set', () => {
  const base = { PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' };
  assert.equal(loadConfig(base).staffKey, null);
  assert.throws(() => loadConfig({ ...base, STAFF_KEY: 'short-key' }), /STAFF_KEY must be at least 16 characters/);
  assert.throws(() => loadConfig({ ...base, STAFF_KEY: 'has a space in the key' }), /STAFF_KEY must use plain letters/);
  assert.equal(loadConfig({ ...base, STAFF_KEY }).staffKey, STAFF_KEY);
});
