// The "PayPal said no" fault drill (A12), in mock mode only. No sandbox, PayPal or model call runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, MOCK_SUBSCRIPTION_ID } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { createTokens } from '../src/gate.js';
import { createMockPayPal } from '../src/paypal-mock.js';
import { createPayPal, PayPalError, WriteNotAuthorized } from '../src/paypal.js';
import * as check from '../src/check.js';
import { buildReceipts } from '../src/receipt.js';
import { summarizeCall } from '../src/staff.js';
import { DRILLS, DrillRefused, SANDBOX_DRILL_OPENS, drillFor, drillOf } from '../src/drill.js';
import { PILOT_SCRIPTS } from '../src/pilot-scripts.js';
import { refusalAt, checkErrsub, reportLines } from '../scripts/errsub-check.js';
import { buildStack, runScript, say, copyProject, tempLedgerPath } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The pilot tip this work branched from, live on Render for the graded pilot. Its check.js grades every non-drill call.
const PILOT_TIP = '6c6dd35';
const REFUSED = "PayPal didn't accept that change.";
const UNCLEAR = "PayPal didn't answer clearly, so I checked again.";
const STILL_ACTIVE = 'PayPal now shows your monthly gift of $25.00 as active.';
const silent = { info: () => {}, error: () => {} };

const options = (stack) => ({ orgName: stack.config.orgName, subscriptionId: stack.config.demoSubscriptionId });

/** A drill call made the way the page makes one: no script, the drill by name, the PIN, a pause request and a yes. */
async function drillCall(stack, key) {
  const { callId } = stack.calls.start({ drill: key, userAgent: 'node-test' });
  await say(stack, callId, stack.config.pin, 'keypad');
  const ask = await say(stack, callId, 'Can I pause my gift for a while?');
  const yes = await say(stack, callId, 'Yes.');
  const bye = await say(stack, callId, 'Goodbye.');
  return { callId, ask, yes, bye, list: stack.ledger.byCall(callId) };
}

const sentence = (receipts, turn, text) => receipts.find((r) => r.turn === turn).sentences.find((s) => s.text === text);

for (const [key, lead, claim, httpStatus, name] of [['refused', REFUSED, 'write_failed', 422, 'UNPROCESSABLE_ENTITY'], ['unclear', UNCLEAR, 'write_unclear', 500, 'INTERNAL_SERVER_ERROR']]) {
  test(`a ${httpStatus} drill never claims the pause, reads the real gift again as active, and passes every check`, async () => {
    const stack = buildStack();
    const { callId, ask, yes, list } = await drillCall(stack, key);
    const drill = DRILLS[key];
    // The proposal reads the real gift, and the suspend goes to PayPal's test id.
    assert.match(ask.reply, /^PayPal shows your monthly gift of \$25\.00 as active\. Pausing it holds/);
    const [proposed] = list.filter((e) => e.type === 'proposed');
    assert.equal(proposed.targetId, drill.writeId);
    const [write] = list.filter((e) => e.type === 'write');
    assert.deepEqual([write.kind, write.targetId, write.ok, write.httpStatus, write.error], ['suspend', drill.writeId, false, httpStatus, `${name} ${httpStatus}`]);
    assert.match(write.debugId, /^mock-/);
    // No claim of a change: the existing refusal sentence, then the fresh read of the real gift, still active.
    assert.equal(yes.reply, `${lead} ${STILL_ACTIVE} What else can I help with?`);
    const said = list.find((e) => e.type === 'said' && e.turn === yes.turn);
    assert.deepEqual(said.claims.map((c) => c.claim), [claim]);
    assert.ok(!/Done\.|suspended|paused|I asked PayPal to pause/.test(yes.reply), 'the line never says the gift paused');
    const after = list.filter((e) => e.type === 'read' && e.what === 'subscription' && e.seq > write.seq && e.turn === yes.turn);
    assert.ok(after.length >= 1 && after.every((r) => r.id === MOCK_SUBSCRIPTION_ID && r.status === 'ACTIVE'), 'every read after the write is a fresh GET of the real gift');
    assert.equal(after.length, key === 'unclear' ? 3 : 1, 'a 500 is read again up to three times, a 422 once');
    assert.equal(yes.state.record.subscription.status, 'ACTIVE');
    assert.equal(yes.state.record.subscription.id, MOCK_SUBSCRIPTION_ID);
    assert.deepEqual(yes.state.record.write, { kind: 'suspend', ok: false, unclear: key === 'unclear', httpStatus, debugId: write.debugId, drill: true });
    assert.deepEqual(yes.state.drill, { key, writeId: drill.writeId, title: drill.title });
    // The receipt names the refused write with its HTTP code and debug id.
    const receipt = sentence(yes.state.receipts, yes.turn, lead);
    assert.equal(receipt.verdict, 'proven');
    assert.deepEqual(receipt.claims.map((c) => [c.name, c.proven, c.write?.httpStatus, c.write?.debugId, c.write?.targetId]), [[claim, true, httpStatus, write.debugId, drill.writeId]]);
    assert.equal(sentence(yes.state.receipts, yes.turn, STILL_ACTIVE).verdict, 'proven');
    // checkFacts, checkWrites and checkSafety, as pilot-check runs them, with and without the configured values.
    for (const o of [{}, options(stack)]) {
      assert.deepEqual(check.checkFacts(list, o), []);
      assert.deepEqual(check.checkWrites(list, o), []);
      assert.deepEqual(check.checkSafety(list, o), []);
    }
    // The ledger says it was a drill, so pilot-check and the staff view tell it apart.
    assert.deepEqual(list.find((e) => e.type === 'call_start').drill, { key, writeId: drill.writeId });
    const row = summarizeCall(list, stack.config);
    assert.deepEqual([row.kind, row.drill, row.script], ['drill', { key, writeId: drill.writeId }, null]);
    assert.ok(!stack.ledger.all().some((e) => e.type === 'write' && e.targetId === MOCK_SUBSCRIPTION_ID), 'the real gift was never written');
    assert.ok(callId);
  });
}

test('the mock answers a suspend of each ERRSUB id the way PayPal documents, after the token is used', async () => {
  const tokens = createTokens();
  const paypal = createMockPayPal({ tokens });
  for (const drill of Object.values(DRILLS)) {
    const token = tokens.mint({ callId: 'c', pendingId: 'p', kind: 'suspend', targetId: drill.writeId });
    await assert.rejects(paypal.suspendSubscription(drill.writeId, token, { callId: 'c' }), (error) => error instanceof PayPalError
      && error.status === drill.httpStatus && error.name === drill.name && /^mock-/.test(error.debugId));
    // A missing token is still refused first, so the fault never stands in for the gate.
    await assert.rejects(paypal.suspendSubscription(drill.writeId, null, { callId: 'c' }), WriteNotAuthorized);
  }
  // Only suspend fails on purpose. A GET of a test id finds nothing, and the real gift is untouched.
  assert.equal((await paypal.getSubscription('ERRSUB062')).notFound, true);
  assert.equal((await paypal.getSubscription(MOCK_SUBSCRIPTION_ID)).data.status, 'ACTIVE');
});

test('no graded script can reach a drill, and a drill opens on the sandbox only after the deadline', () => {
  const stack = buildStack();
  for (const script of [1, 2, 10, '2']) assert.throws(() => stack.calls.start({ script, drill: 'refused' }), (e) => e instanceof DrillRefused && e.status === 400);
  assert.throws(() => stack.calls.start({ drill: 'ERRSUB062' }), (e) => e instanceof DrillRefused && e.status === 400);
  assert.throws(() => stack.calls.start({ drill: { key: 'refused' } }), DrillRefused);
  assert.equal(stack.ledger.byType('call_start').length, 0, 'a refused drill starts no call');
  // Every script runs as before, with its suspend on the real gift and no drill logged.
  const before = Date.parse(SANDBOX_DRILL_OPENS) - 1;
  assert.throws(() => drillFor('refused', { paypalMode: 'sandbox', now: new Date(before) }), (e) => e.status === 403);
  assert.equal(drillFor('refused', { paypalMode: 'sandbox', now: new Date(before + 1) }), DRILLS.refused);
  assert.equal(drillFor('unclear', { paypalMode: 'mock', now: new Date(before) }), DRILLS.unclear);
  assert.equal(drillFor(null, { paypalMode: 'sandbox', now: new Date(before) }), null);
  // A scripted call_start can never be read as a drill, and neither can a made-up test id.
  assert.equal(drillOf({ script: 2, drill: { key: 'refused', writeId: 'ERRSUB062' } }), null);
  assert.equal(drillOf({ script: null, drill: { key: 'refused', writeId: 'I-OTHER' } }), null);
  assert.equal(drillOf({ script: null, drill: { key: 'refused', writeId: 'ERRSUB062' } }), DRILLS.refused);
});

test('normal and scripted calls are unchanged: their suspend goes to the real gift and they log no drill', async () => {
  const stack = buildStack();
  const two = await runScript(stack, PILOT_SCRIPTS[1]);
  const list = stack.ledger.byCall(two.callId);
  assert.deepEqual(list.filter((e) => e.type === 'write').map((e) => [e.kind, e.targetId, e.ok]), [['suspend', MOCK_SUBSCRIPTION_ID, true]]);
  assert.equal(Object.hasOwn(list.find((e) => e.type === 'call_start'), 'drill'), false);
  assert.deepEqual(check.gradeCall(list, PILOT_SCRIPTS[1], options(stack)).passed, true);
});

test('a forged drill on a scripted call or on another id gets no allowance, so its writes still fail', async () => {
  const stack = buildStack();
  const { list } = await drillCall(stack, 'refused');
  const forged = (start) => list.map((e) => (e.type === 'call_start' ? { ...e, ...start } : e));
  for (const start of [{ script: 2 }, { drill: { key: 'refused', writeId: 'ERRSUB059' } }, { drill: undefined }]) {
    const messages = check.checkWrites(forged(start), options(stack)).map((v) => v.message).join('\n');
    assert.match(messages, /a suspend write of ERRSUB062, not of I-MOCK0000001/);
  }
});

test('a drill proposal read from the wrong id names the real gift it should have been read from', async () => {
  const stack = buildStack();
  const { list } = await drillCall(stack, 'refused');
  const proposed = list.find((e) => e.type === 'proposed');
  const stray = { ...list.find((e) => e.type === 'read' && e.what === 'subscription' && e.seq < proposed.seq), id: DRILLS.refused.writeId, seq: proposed.seq - 0.5 };
  const misread = list.flatMap((e) => (e === proposed ? [stray, e] : [e]));
  const messages = check.checkWrites(misread, options(stack)).map((v) => v.message).join('\n');
  assert.match(messages, /the suspend proposal was not read back from I-MOCK0000001/);
  assert.doesNotMatch(messages, /not read back from ERRSUB062/);
});

test('the pilot tip\'s grader would fail a drill, and agrees with this grader on every non-drill call', async (t) => {
  const base = spawnSync('git', ['show', `${PILOT_TIP}:src/check.js`], { cwd: ROOT, encoding: 'utf8' });
  if (base.status !== 0) {
    t.skip(`git has no ${PILOT_TIP} here, ${base.stderr.trim()}`);
    return;
  }
  const dir = copyProject();
  fs.writeFileSync(path.join(dir, 'src', 'check.js'), base.stdout);
  const before = await import(pathToFileURL(path.join(dir, 'src', 'check.js')).href);
  const stack = buildStack();
  const calls = [];
  for (const script of PILOT_SCRIPTS) calls.push({ script, events: stack.ledger.byCall((await runScript(stack, script)).callId) });
  for (const { script, events } of calls) {
    for (const o of [{}, options(stack), { lenientTemplates: true }]) {
      for (const name of ['checkFacts', 'checkWrites', 'checkSafety']) assert.deepEqual(check[name](events, o), before[name](events, o), `${name} ${JSON.stringify(o)}`);
      assert.deepEqual(check.gradeCall(events, script, o), before.gradeCall(events, script, o));
    }
  }
  // Why the drill needs its own read target: the old grader holds its suspend to the test id it wrote.
  const drill = await drillCall(buildStack(), 'unclear');
  assert.ok(before.checkWrites(drill.list, options(stack)).length > 0);
  assert.ok(before.checkFacts(drill.list, options(stack)).length > 0, 'the old grader finds no read of ERRSUB059 behind "didn\'t answer clearly"');
  assert.deepEqual(check.checkWrites(drill.list, options(stack)), []);
  assert.deepEqual(check.checkFacts(drill.list, options(stack)), []);
});

test('receipts of a refused write in a normal call name it too, and a passing write carries no write field', async () => {
  const stack = buildStack();
  stack.paypal.suspendSubscription = async () => {
    throw new PayPalError({ status: 422, name: 'UNPROCESSABLE_ENTITY', message: 'no', debugId: 'dbg-422' });
  };
  const { callId } = stack.calls.start({ userAgent: 'node-test' });
  await say(stack, callId, stack.config.pin, 'keypad');
  await say(stack, callId, 'Can I pause my gift for a while?');
  const yes = await say(stack, callId, 'Yes.');
  const receipts = buildReceipts(stack.ledger.byCall(callId), { ...options(stack), timeZone: stack.config.timeZone });
  assert.deepEqual(sentence(receipts, yes.turn, REFUSED).claims[0].write.httpStatus, 422);
  assert.deepEqual(sentence(receipts, yes.turn, REFUSED).claims[0].write.debugId, 'dbg-422');
  const ok = buildStack();
  const two = await runScript(ok, PILOT_SCRIPTS[1]);
  const all = buildReceipts(ok.ledger.byCall(two.callId), options(ok)).flatMap((r) => r.sentences).flatMap((s) => s.claims);
  assert.ok(all.length > 0 && all.every((c) => !Object.hasOwn(c, 'write')));
});

// ---- The server, with no network: a fetch that throws stands in for PayPal ----

async function server(env, now) {
  const config = loadConfig({ ROUTER_MODE: 'rules', PILOT_PIN: '482613', ...env });
  const fetchImpl = async () => { throw new Error('no network in tests'); };
  const deps = buildDeps(config, { ledgerPath: tempLedgerPath(), log: silent, sleep: async () => {}, now: () => new Date(now), fetchImpl });
  const s = createServer(deps);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${s.address().port}`;
  const post = (body) => fetch(`${url}/api/calls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { url, post, close: () => s.close(), deps };
}

const SANDBOX = { PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'test-id', PAYPAL_CLIENT_SECRET: 'test-secret', DEMO_SUBSCRIPTION_ID: 'I-TEST0000001' };

test('the server lists drills only while one may start, and refuses a drill with a script or before the deadline', async () => {
  const opens = Date.parse(SANDBOX_DRILL_OPENS);
  const mock = await server({ PAYPAL_MODE: 'mock' }, opens - 3600000);
  try {
    const { drills } = await (await fetch(`${mock.url}/api/drills`)).json();
    assert.deepEqual(drills.map((d) => d.key), ['refused', 'unclear']);
    assert.match(drills[0].expected, /ERRSUB062, which answers 422 UNPROCESSABLE_ENTITY/);
    assert.equal((await mock.post({ script: 2, drill: 'refused' })).status, 400);
    assert.equal((await mock.post({ drill: 'nope' })).status, 400);
    const started = await mock.post({ drill: 'refused' });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).state.drill.writeId, 'ERRSUB062');
  } finally {
    mock.close();
  }
  const early = await server(SANDBOX, opens - 1000);
  try {
    assert.deepEqual((await (await fetch(`${early.url}/api/drills`)).json()).drills, []);
    const refused = await early.post({ drill: 'refused' });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /after the pilot deadline/);
    assert.equal(early.deps.ledger.byType('call_start').length, 0);
  } finally {
    early.close();
  }
  const late = await server(SANDBOX, opens + 1000);
  try {
    assert.equal((await (await fetch(`${late.url}/api/drills`)).json()).drills.length, 2);
  } finally {
    late.close();
  }
});

// ---- scripts/errsub-check.js, the 15-minute sandbox gate check, run here only against the mock and a fake fetch ----

test('errsub-check refuses before Wed Nov 4, 2026, 9:00 pm PT, and runs after it', () => {
  assert.match(refusalAt(new Date('2026-11-04T20:59:59-08:00')), /refuses to run before Wed Nov 4, 2026, 9:00 pm PT/);
  assert.match(refusalAt(new Date('2026-11-03T12:00:00-08:00')), /Nothing was sent to PayPal/);
  assert.equal(refusalAt(new Date('2026-11-04T21:00:00-08:00')), null);
});

test('errsub-check passes on the documented answers and fails on any other', async () => {
  const tokens = createTokens();
  const good = await checkErrsub({ paypal: createMockPayPal({ tokens }), tokens });
  assert.equal(good.pass, true);
  assert.deepEqual(good.results.map((r) => [r.id, r.got.httpStatus, r.got.name]), [['ERRSUB062', 422, 'UNPROCESSABLE_ENTITY'], ['ERRSUB059', 500, 'INTERNAL_SERVER_ERROR']]);
  assert.match(reportLines(good).at(-1), /^PASS\./);
  const wrong = createMockPayPal({ tokens });
  wrong.suspendSubscription = async () => { throw new PayPalError({ status: 404, name: 'RESOURCE_NOT_FOUND', debugId: 'x' }); };
  const bad = await checkErrsub({ paypal: wrong, tokens });
  assert.equal(bad.pass, false);
  assert.match(reportLines(bad).at(-1), /^FAIL\. Do not build the sandbox drill/);
});

test('errsub-check sends only the token request and the two suspend POSTs, to the sandbox', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(`${init.method} ${url}`);
    const json = (status, body, debugId) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'paypal-debug-id': debugId } });
    if (url.endsWith('/v1/oauth2/token')) return json(200, { access_token: 'A', expires_in: 3600, scope: 's' }, 'dbg-token');
    if (url.includes('ERRSUB062')) return json(422, { name: 'UNPROCESSABLE_ENTITY', message: 'no' }, 'dbg-062');
    return json(500, { name: 'INTERNAL_SERVER_ERROR', message: 'oops' }, 'dbg-059');
  };
  const tokens = createTokens();
  const paypal = createPayPal({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', clientSecret: 'secret', tokens, fetchImpl });
  const outcome = await checkErrsub({ paypal, tokens });
  assert.equal(outcome.pass, true);
  assert.deepEqual(sent, [
    'POST https://api-m.sandbox.paypal.com/v1/oauth2/token',
    'POST https://api-m.sandbox.paypal.com/v1/billing/subscriptions/ERRSUB062/suspend',
    'POST https://api-m.sandbox.paypal.com/v1/billing/subscriptions/ERRSUB059/suspend',
  ]);
  assert.deepEqual(outcome.results.map((r) => r.got.debugId), ['dbg-062', 'dbg-059']);
});
