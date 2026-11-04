import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig, FAULT_DRILLS } from '../src/config.js';
import { buildDeps } from '../src/server.js';
import { buildRecovery } from '../src/recovery.js';
import { checkFacts, gradeCall } from '../src/check.js';
import { PayPalError } from '../src/paypal.js';
import { formatMoney } from '../src/say.js';
import { PILOT_SCRIPTS } from '../src/pilot-scripts.js';
import { buildStack, runScript, say, verifiedCall, eventsOf, tempLedgerPath } from './helpers.js';

const PARTS = ['wanted', 'wrong', 'did', 'now'];
const STATUS_TEXT = Object.freeze({ active: 'ACTIVE', paused: 'SUSPENDED', cancelled: 'CANCELLED', 'a draft': 'DRAFT', refunded: 'REFUNDED', completed: 'COMPLETED', open: 'CREATED' });

/** The real wiring with a fault drill staged, as `FAULT_DRILL=... npm run dev` runs it. */
function drillStack(drill) {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', LEDGER_PATH: tempLedgerPath(), FAULT_DRILL: drill });
  return { ...buildDeps(config, { log: { info() {}, error() {}, warn() {} }, sleep: async () => {} }), answered: new Map() };
}

/** Every row's time and reference is an event's own, and every amount, status and quote on it is in the ledger. */
function assertFromLedger(events, recovery) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const reads = events.filter((e) => e.type === 'read' && e.snapshot);
  const moneyHeld = new Set(reads.flatMap((e) => [formatMoney(e.snapshot.amount_value, e.snapshot.amount_currency ?? undefined), formatMoney(e.snapshot.price_value, e.snapshot.price_currency ?? undefined)]).filter(Boolean));
  const statusesShown = new Set(reads.map((e) => e.snapshot.status));
  for (const incident of recovery.incidents) {
    assert.deepEqual(incident.steps.map((s) => s.part), PARTS);
    for (const row of incident.steps) {
      const at = bySeq.get(row.seq);
      assert.ok(at, `"${row.text}" points at a ledger event`);
      assert.equal(row.ts, at.ts, row.text);
      if (row.reference === null) assert.equal(row.refSeq, null, row.text);
      else assert.equal(bySeq.get(row.refSeq).debugId, row.reference, row.text);
      for (const money of row.text.match(/\$\d[\d,]*\.\d\d/g) ?? []) assert.ok(moneyHeld.has(money), `${money} is in a read, "${row.text}"`);
      for (const quoted of row.text.match(/You said "(.*)"$/)?.slice(1) ?? []) assert.ok(events.some((e) => e.type === 'heard' && e.text === quoted), quoted);
      if (row.part === 'now') {
        for (const [word, status] of Object.entries(STATUS_TEXT)) {
          if (new RegExp(`\\bis ${word}\\.`).test(row.text)) assert.ok(statusesShown.has(status), `"${row.text}" needs a read that showed ${status}`);
        }
      }
    }
  }
}

const incidentsOf = (stack, callId) => buildRecovery(stack.ledger.byCall(callId)).incidents;
const row = (incident, part) => incident.steps.find((s) => s.part === part);

test('nothing is shown when nothing went wrong, on every script, a charge check and a covered month', async () => {
  const stack = buildStack();
  for (const script of PILOT_SCRIPTS) {
    const { callId } = await runScript(stack, script);
    assert.deepEqual(incidentsOf(stack, callId), [], `Script ${script.number}`);
  }
  const charge = buildStack();
  const chargeCall = await verifiedCall(charge);
  await say(charge, chargeCall, "I see a PayPal charge I don't recognize.");
  await say(charge, chargeCall, 'Yes.');
  assert.deepEqual(incidentsOf(charge, chargeCall), []);
  const cover = buildStack();
  const coverCall = await verifiedCall(cover);
  await say(cover, coverCall, "I lost my job, I can't do it this month.");
  const { state } = await say(cover, coverCall, 'Yes.');
  assert.equal(state.record.cover.outcome, 'covered');
  assert.deepEqual(state.recovery.incidents, []);
});

test('a timeout PayPal made the change behind is followed by a fresh read, and says what that read shows', async () => {
  const stack = drillStack('suspend-timeout');
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my gift.');
  const { state, reply } = await say(stack, callId, 'Yes.');
  assert.match(reply, /PayPal didn't answer clearly, so I checked again/);
  const [incident] = state.recovery.incidents;
  assert.equal(state.recovery.incidents.length, 1);
  assert.equal(incident.kind, 'lost_answer');
  assert.equal(row(incident, 'wanted').text, 'To pause your monthly gift.');
  assert.match(row(incident, 'wrong').text, /didn't answer in time/);
  assert.equal(row(incident, 'wrong').reference, null, 'a timeout has no PayPal reference, and none is made up');
  assert.match(row(incident, 'did').text, /read PayPal again, once/);
  assert.equal(row(incident, 'now').text, 'Your monthly gift is paused.');
  assert.ok(row(incident, 'now').reference.startsWith('mock-'));
  const events = stack.ledger.byCall(callId);
  assertFromLedger(events, state.recovery);
  assert.deepEqual(checkFacts(events, { subscriptionId: stack.config.demoSubscriptionId }), []);
});

test('a 5xx that changed nothing reads PayPal again until it is sure, and says the gift is still active', async () => {
  const stack = drillStack('suspend-503');
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my gift.');
  const { state } = await say(stack, callId, 'Yes.');
  const [incident] = state.recovery.incidents;
  assert.equal(incident.kind, 'lost_answer');
  assert.match(row(incident, 'wrong').text, /error, code 503/);
  assert.equal(row(incident, 'wrong').reference, 'mock-drill-503');
  assert.match(row(incident, 'did').text, /read PayPal again, 3 times/);
  assert.equal(row(incident, 'now').text, 'Your monthly gift is active.');
  assertFromLedger(stack.ledger.byCall(callId), state.recovery);
});

test('a refusal says PayPal turned it down and what PayPal shows now', async () => {
  const stack = drillStack('suspend-refused');
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my gift.');
  const { state, reply } = await say(stack, callId, 'Yes.');
  assert.match(reply, /PayPal didn't accept that change/);
  const [incident] = state.recovery.incidents;
  assert.equal(incident.kind, 'refused');
  assert.match(row(incident, 'wrong').text, /turned it down, code 422/);
  assert.match(row(incident, 'did').text, /told you PayPal said no, and read PayPal again/);
  assert.equal(row(incident, 'now').text, 'Your monthly gift is active.');
  assertFromLedger(stack.ledger.byCall(callId), state.recovery);
});

test('a record changed by someone else sets a waiting change aside, and a refused write is told once, not twice', async () => {
  const stack = drillStack('gift-changed');
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my gift.');
  const { state } = await say(stack, callId, 'Are you sure?');
  assert.equal(state.pending, null);
  const [incident] = state.recovery.incidents;
  assert.equal(incident.kind, 'changed');
  assert.equal(row(incident, 'wanted').text, 'To pause your monthly gift.');
  assert.match(row(incident, 'wrong').text, /It showed active, and now shows cancelled\./);
  assert.match(row(incident, 'did').text, /set the waiting change aside/);
  assert.equal(row(incident, 'now').text, 'Your monthly gift is cancelled.');
  assertFromLedger(stack.ledger.byCall(callId), state.recovery);

  const refused = buildStack();
  const call = await verifiedCall(refused);
  await say(refused, call, 'Pause my gift.');
  refused.paypal.mockSetSubscriptionStatus(refused.config.demoSubscriptionId, 'CANCELLED');
  const after = await say(refused, call, 'Yes.');
  assert.deepEqual(after.state.recovery.incidents.map((i) => i.kind), ['refused']);
  assert.equal(row(after.state.recovery.incidents[0], 'now').text, 'Your monthly gift is cancelled.');

  const asked = buildStack();
  const free = await verifiedCall(asked);
  await say(asked, free, 'How much is my gift?');
  asked.paypal.mockSetSubscriptionStatus(asked.config.demoSubscriptionId, 'SUSPENDED');
  const again = await say(asked, free, 'How much is my gift?');
  assert.deepEqual(again.state.recovery.incidents.map((i) => i.kind), ['changed']);
  assert.match(row(again.state.recovery.incidents[0], 'did').text, /told you what PayPal shows now, and changed nothing/);
  assert.equal(row(again.state.recovery.incidents[0], 'wanted').text, 'You said "How much is my gift?"');
});

test('an unclear amount shows what she said, why it was unclear, and that no draft was made, then the draft her answer made', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  const first = await say(stack, callId, 'fifty dollars, I mean double that');
  const [incident] = first.state.recovery.incidents;
  assert.equal(incident.kind, 'unclear_amount');
  assert.equal(row(incident, 'wanted').text, 'You said "fifty dollars, I mean double that"');
  assert.match(row(incident, 'wrong').text, /depended on another number/);
  assert.equal(row(incident, 'did').text, "It asked how much you'd like to give, and made no draft.");
  assert.equal(row(incident, 'now').text, 'No draft was made, so PayPal has nothing new from this.');
  assert.equal(row(incident, 'now').reference, null);
  assertFromLedger(stack.ledger.byCall(callId), first.state.recovery);
  const second = await say(stack, callId, 'Sixty dollars.');
  assert.equal(row(second.state.recovery.incidents[0], 'now').text, 'The invoice, $60.00, is a draft.');
  assertFromLedger(stack.ledger.byCall(callId), second.state.recovery);
});

test('a question naming another amount shows, and one naming the gift\'s own amount shows nothing', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  const { state } = await say(stack, callId, 'Is my gift still seventy five dollars a month?');
  const [incident] = state.recovery.incidents;
  assert.equal(row(incident, 'did').text, 'It read your gift from PayPal, and made no draft.');
  assert.equal(row(incident, 'now').text, 'Your monthly gift, $25.00, is active.');
  assertFromLedger(stack.ledger.byCall(callId), state.recovery);
  const right = buildStack();
  const call = await verifiedCall(right);
  assert.deepEqual((await say(right, call, 'Is my gift still twenty five dollars a month?')).state.recovery.incidents, []);
});

test('a PayPal step that fails is told plainly, and the row after it claims nothing PayPal did not return', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  stack.paypal.getSubscription = async () => { throw new PayPalError({ status: 503, name: 'SERVICE_UNAVAILABLE', message: 'try later', debugId: 'mock-read-503' }); };
  const { state } = await say(stack, callId, 'How much is my gift?');
  const [incident] = state.recovery.incidents;
  assert.equal(incident.kind, 'read_failed');
  assert.match(row(incident, 'wrong').text, /didn't answer when the line checked your monthly gift/);
  assert.equal(row(incident, 'wrong').reference, 'mock-read-503');
  assert.match(row(incident, 'did').text, /couldn't get a clear answer. It changed nothing/);
  assert.match(row(incident, 'now').text, /says nothing here about what PayPal shows/);
  assertFromLedger(stack.ledger.byCall(callId), state.recovery);
});

test('a lost write with no read after it never names a status', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my gift.');
  stack.paypal.suspendSubscription = async () => { throw new PayPalError({ status: 0, name: 'TIMEOUT', message: 'late', debugId: null }); };
  stack.paypal.getSubscription = async () => { throw new PayPalError({ status: 503, name: 'SERVICE_UNAVAILABLE', message: 'try later', debugId: null }); };
  const { state } = await say(stack, callId, 'Yes.');
  const [incident] = state.recovery.incidents;
  assert.match(row(incident, 'did').text, /tried to read PayPal again, couldn't/);
  assert.equal(row(incident, 'now').text, 'Your monthly gift is active.', 'the last read PayPal gave, said by that read');
  const events = stack.ledger.byCall(callId);
  assert.ok(row(incident, 'now').seq < events.find((e) => e.type === 'write').seq, 'and it points at that older read');
});

test('the timeline never shows a fact missing from the ledger', async () => {
  const stack = drillStack('suspend-timeout');
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my gift.');
  await say(stack, callId, 'Yes.');
  const events = stack.ledger.byCall(callId);
  const full = buildRecovery(events);
  assert.equal(row(full.incidents[0], 'now').text, 'Your monthly gift is paused.');
  // Take every read out of the ledger, and the status and its reference go too.
  const noReads = buildRecovery(events.filter((e) => e.type !== 'read'));
  const now = row(noReads.incidents[0], 'now');
  assert.match(now.text, /says nothing here about what PayPal shows/);
  assert.equal(now.reference, null);
  assert.match(row(noReads.incidents[0], 'did').text, /couldn't/);
  assert.doesNotMatch(JSON.stringify(noReads), /paused|mock-0/, 'no status, no reference');
  // Take the write and its reads out, and there is nothing to tell.
  assert.deepEqual(buildRecovery(events.filter((e) => e.type !== 'write' && e.type !== 'read')).incidents, []);
  // The status comes from the read's own snapshot, whatever it says.
  const edited = events.map((e) => (e.type === 'read' && e.what === 'subscription' ? { ...e, snapshot: { ...e.snapshot, status: 'CANCELLED' } } : e));
  assert.equal(row(buildRecovery(edited).incidents[0], 'now').text, 'Your monthly gift is cancelled.');
});

test('no row carries a token, a PayPal id or the sponsor\'s hold, even when a money move fails', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, "I lost my job, I can't do it this month.");
  stack.paypal.captureSponsorHold = async () => { throw new PayPalError({ status: 422, name: 'UNPROCESSABLE_ENTITY', message: 'no', debugId: 'mock-cap-422' }); };
  const { state } = await say(stack, callId, 'Yes.');
  assert.equal(state.record.cover.outcome, 'no_money_moved');
  const [incident] = state.recovery.incidents;
  assert.equal(row(incident, 'wanted').text, 'To give this month back.');
  assert.match(row(incident, 'wrong').text, /turned it down, code 422/);
  assert.match(row(incident, 'now').text, /^The sponsor's hold/);
  const text = JSON.stringify(state.recovery);
  for (const secret of [stack.config.cover.holdId, stack.config.demoSubscriptionId, 'MOCKTX', ...eventsOf(stack, callId, 'yes').flatMap((e) => e.tokenIds ?? [])]) assert.ok(!text.includes(secret), secret);
  assertFromLedger(stack.ledger.byCall(callId), state.recovery);
});

test('mock and drill calls are labeled as such, and a real sandbox call carries no such label', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  assert.equal(stack.calls.get(callId).recovery.run.kind, 'mock');
  assert.match(stack.calls.get(callId).recovery.run.text, /^Mock run\./);
  const drill = drillStack('suspend-refused');
  const drillCall = await verifiedCall(drill);
  assert.equal(eventsOf(drill, drillCall, 'call_start')[0].faultDrill, 'suspend-refused');
  assert.match(drill.calls.get(drillCall).recovery.run.text, /^Fault drill\./);
  const start = (mode, extra = {}) => [{ type: 'call_start', seq: 1, ts: 't', callId: 'c', mode, ...extra }];
  assert.equal(buildRecovery(start({ paypal: 'sandbox', router: 'gemini' })).run, null);
  assert.match(buildRecovery(start({ paypal: 'sandbox', router: 'rules' })).run.text, /^Mock run\./);
  assert.match(buildRecovery(start({ paypal: 'sandbox', router: 'gemini' }, { dryRun: true })).run.text, /^Dry run\./);
});

test('a fault drill runs only on the mock, once, and keeps the gate and the grader honest', async () => {
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'sandbox', ROUTER_MODE: 'gemini', FAULT_DRILL: 'suspend-503' }, { partial: true }), /FAULT_DRILL needs PAYPAL_MODE=mock/);
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', FAULT_DRILL: 'nope' }), /FAULT_DRILL must be one of/);
  assert.equal(loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' }).faultDrill, null);
  assert.deepEqual([...FAULT_DRILLS], ['suspend-timeout', 'suspend-503', 'suspend-refused', 'gift-changed']);
  const stack = drillStack('suspend-refused');
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my gift.');
  await say(stack, callId, 'Yes.');
  await say(stack, callId, 'Pause my gift.');
  const { state } = await say(stack, callId, 'Yes.');
  assert.equal(state.record.subscription.status, 'SUSPENDED', 'the second try is not staged');
  const grade = gradeCall(stack.ledger.byCall(callId), null);
  assert.deepEqual(grade.writes, [], 'each write still has its own yes');
});

test('the state from start, turn, get and end all carry the timeline, and the page draws it with text only', async () => {
  const stack = drillStack('suspend-refused');
  const started = stack.calls.start({ userAgent: 'node-test' });
  assert.deepEqual(started.state.recovery.incidents, []);
  const callId = started.callId;
  await stack.calls.turn(callId, { text: stack.config.pin, source: 'keypad', answering: 0 });
  await stack.calls.turn(callId, { text: 'Pause my gift.', source: 'typed', answering: 1 });
  const turned = await stack.calls.turn(callId, { text: 'Yes.', source: 'typed', answering: 2 });
  assert.equal(turned.state.recovery.incidents.length, 1);
  assert.deepEqual(stack.calls.get(callId).recovery, turned.state.recovery);
  assert.equal((await stack.calls.end(callId)).state.recovery.incidents.length, 1);
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/);
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<section id="recovery" class="recovery" aria-labelledby="recovery-title" hidden>/);
});
