// Covered Month (PICK.md): a donor who can't afford this month gets her last charge back, and a sponsor's hold pays the
// same amount to the org, on one spoken yes. Mock PayPal only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildStack, verifiedCall, say, eventsOf, makeClock, tempLedgerPath, tempDir } from './helpers.js';
import { rulesRoute, INTENTS, SYSTEM_PROMPT, ROUTE_TOOL, buildRouterContent } from '../src/router.js';
import { PILOT_SCRIPTS } from '../src/pilot-scripts.js';
import { createPayPal, PayPalError, WriteNotAuthorized, toSnapshot } from '../src/paypal.js';
import { mockCharge, MOCK_TRANSACTION_ID, createMockPayPal } from '../src/paypal-mock.js';
import { createTokens, isClearYes } from '../src/gate.js';
import { gradeCall, checkFacts, checkWrites, checkSafety, checkScript } from '../src/check.js';
import { buildReceipts } from '../src/receipt.js';
import { projectStaffEvent, summarizeCall } from '../src/staff.js';
import { TEMPLATE_CLAIMS, TEMPLATE_SENTENCES } from '../src/template-words.js';
import { COVER_DEFAULTS, loadConfig, MOCK_HOLD_ID, MOCK_SUBSCRIPTION_ID, SANDBOX_BASE_URL } from '../src/config.js';
import { coverBlock, holdCovers, moneyBinding, requestIds } from '../src/cover.js';
import { createLedger } from '../src/ledger.js';

const ASK = "I lost my job, I can't do it this month.";
const SUB = MOCK_SUBSCRIPTION_ID;
const HOLD = MOCK_HOLD_ID;
const TX = MOCK_TRANSACTION_ID;
const allClear = (grade) => [...grade.facts, ...grade.writes, ...grade.safety];
const clean = (stack, callId) => assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
const legs = (stack, callId) => eventsOf(stack, callId, 'write').map((e) => [e.kind, e.ok]);
const donorRefunded = (stack) => stack.paypal.mockMoney().refunded[TX] ?? 0;
const sponsorPaid = (stack) => stack.paypal.mockMoney().captures.filter((c) => c.status === 'COMPLETED').length;

async function offered(stack = buildStack()) {
  const callId = await verifiedCall(stack);
  const asked = await say(stack, callId, ASK);
  return { stack, callId, asked };
}

const offerText = 'PayPal shows the latest charge for your monthly gift to Sunny Hollow Pantry was $25.00 on November 1, with the status completed. '
  + "I can give that $25.00 back to you, and a sponsor's hardship fund would pay the same amount to Sunny Hollow Pantry. "
  + "PayPal shows the sponsor's hold is open. This does not change your monthly gift. The next gift is on December 1. "
  + 'Should I give it back? Please say yes or no.';

// ---- Routing ----

test('the rules router sends hardship to hardship_cover, and an explicit stop, pause or fraud fear stays what it was', () => {
  for (const text of [ASK, "I can't afford it this month.", 'I got laid off.', 'Money is tight right now.', "I can’t afford this charge, can I get a refund?", 'I am out of work and cannot afford my gift.']) {
    assert.equal(rulesRoute(text).intent, 'hardship_cover', text);
  }
  assert.equal(rulesRoute('I lost my job, please cancel my gift.').intent, 'stop_gift');
  assert.equal(rulesRoute("I can't afford it, pause it.").intent, 'pause_gift');
  assert.equal(rulesRoute("I can't afford this and I don't recognize this charge.").intent, 'charge_check');
  assert.equal(rulesRoute('I think this is fraud, I lost my job.').intent, 'charge_check');
  assert.equal(rulesRoute("I can't afford it this month, I want to give five dollars instead.").amountDollars, 0, 'hardship never drafts a gift');
});

test('Gemini and Haiku can pick hardship_cover, and the prompt says when', () => {
  assert.ok(INTENTS.includes('hardship_cover'));
  assert.ok(ROUTE_TOOL.input_schema.properties.intent.enum.includes('hardship_cover'));
  assert.match(SYSTEM_PROMPT, /^hardship_cover, says they lost income/m);
  assert.match(buildRouterContent({ text: 'yes', state: { verified: true, pendingKind: 'cover_month' } }), /giving this month back with a sponsor covering it/);
});

test('all 10 pilot scripts route the same as on the pilot branch', () => {
  // From the pilot branch's own router at 6c6dd35, run over these same lines.
  const pilot = { 1: ['gift_status', 'goodbye'], 2: ['stop_gift', 'unclear', 'goodbye'], 3: ['resume_gift', 'unclear', 'goodbye'], 4: ['stop_gift', 'unclear', 'unclear', 'goodbye'],
    5: ['one_time_gift', 'unclear', 'goodbye'], 6: ['one_time_gift', 'unclear', 'goodbye'], 7: ['other_email', 'unclear', 'goodbye'], 8: ['pause_gift'],
    9: ['unclear', 'cancel_now', 'unclear', 'goodbye'], 10: ['pause_gift', 'unclear', 'resume_gift', 'unclear', 'goodbye'] };
  for (const script of PILOT_SCRIPTS) {
    assert.deepEqual(script.lines.filter((line) => typeof line === 'string').map((line) => rulesRoute(line).intent), pilot[script.number], `Script ${script.number}`);
  }
});

// ---- The offer ----

test('the offer reads the charge, the gift and the hold from PayPal, says the next gift still comes, and moves nothing', async () => {
  const { stack, callId, asked } = await offered();
  assert.equal(asked.reply, `I'm sorry to hear that. ${offerText}`);
  assert.deepEqual(eventsOf(stack, callId, 'read').map((e) => e.what).sort(), ['charge', 'hold', 'plan', 'subscription']);
  const [proposal] = eventsOf(stack, callId, 'proposed');
  assert.equal(proposal.kind, 'cover_month');
  assert.equal(proposal.targetId, SUB);
  assert.deepEqual(proposal.legs.map((l) => [l.kind, l.targetId, l.amountValue, l.currency]),
    [['cover_capture', HOLD, '25.00', 'USD'], ['cover_refund', TX, '25.00', 'USD'], ['cover_unwind', HOLD, '25.00', 'USD']]);
  assert.equal(asked.state.pending.label, 'Give this month back, with a sponsor covering it');
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.equal(donorRefunded(stack), 0);
  assert.equal(sponsorPaid(stack), 0);
  clean(stack, callId);
});

test("a suspended gift's offer names no next gift", async () => {
  const stack = buildStack();
  stack.paypal.mockSetSubscriptionStatus(SUB, 'SUSPENDED');
  const { asked } = await offered(stack);
  assert.doesNotMatch(asked.reply, /next gift/);
  assert.match(asked.reply, /This does not change your monthly gift\. Should I give it back\?/);
});

// ---- The staff rule, from config, with safe defaults ----

test('the staff rule defaults are safe, come from the env, and a bad value is a config problem', () => {
  const base = { PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' };
  assert.deepEqual({ ...COVER_DEFAULTS }, { maxDollars: 50, windowDays: 30, perYear: 1 });
  const config = loadConfig(base);
  assert.equal(config.cover.maxDollars, 50);
  assert.equal(config.cover.holdId, HOLD);
  const set = loadConfig({ ...base, COVER_MAX_DOLLARS: '20', COVER_WINDOW_DAYS: '10', COVER_PER_YEAR: '2', SPONSOR_HOLD_ID: 'AUTH-1' });
  assert.deepEqual({ ...set.cover }, { holdId: 'AUTH-1', maxDollars: 20, windowDays: 10, perYear: 2 });
  for (const [name, value] of [['COVER_MAX_DOLLARS', '0'], ['COVER_MAX_DOLLARS', 'lots'], ['COVER_MAX_DOLLARS', '501'], ['COVER_WINDOW_DAYS', '181'], ['COVER_WINDOW_DAYS', '1.5'], ['COVER_PER_YEAR', '-1'], ['SPONSOR_HOLD_ID', 'a/b']]) {
    assert.throws(() => loadConfig({ ...base, [name]: value }), new RegExp(name), `${name}=${value}`);
  }
  // Never let a developer's private seeded state decide a config-default assertion.
  const directory = tempDir();
  const moduleUrl = new URL('../src/config.js', import.meta.url).href;
  const sandbox = { PAYPAL_MODE: 'sandbox', ROUTER_MODE: 'rules', PILOT_PIN: '2468', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' };
  const inspect = () => JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '--eval',
    `import { loadConfig } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(loadConfig(${JSON.stringify(sandbox)}).cover));`],
  { cwd: directory, encoding: 'utf8' }));
  assert.equal(inspect().holdId, null, 'in an unseeded sandbox, the move stays off');
  fs.mkdirSync(path.join(directory, '.pilot'));
  fs.writeFileSync(path.join(directory, '.pilot', 'state.json'), JSON.stringify({ sponsorHoldId: 'AUTH-FIXTURE1' }));
  assert.equal(inspect().holdId, 'AUTH-FIXTURE1', 'a seeded sandbox retains its configured hold');
});

test('coverBlock holds the cap, the window, the yearly count and the status at their edges', () => {
  const nowMs = Date.parse('2026-11-03T18:00:00Z');
  const ok = { status: 'COMPLETED', amount_value: '50.00', amount_currency: 'USD', time: '2026-10-04T18:00:00Z', refunded_count: 0 };
  const ask = (patch, rule = COVER_DEFAULTS) => coverBlock({ ...ok, ...patch }, { rule, nowMs, currency: 'USD' });
  assert.equal(ask({}), null, 'exactly the cap on exactly the last day passes');
  assert.equal(ask({ amount_value: '50.01' }), 'too_big');
  assert.equal(ask({ time: '2026-10-04T17:59:59Z' }), 'too_old');
  assert.equal(ask({ time: 'not a time' }), 'too_old');
  assert.equal(ask({ refunded_count: 1 }), 'used');
  assert.equal(ask({ refunded_count: 1 }, { ...COVER_DEFAULTS, perYear: 2 }), null);
  assert.equal(ask({ status: 'REFUNDED' }), 'used');
  assert.equal(ask({ status: 'PARTIALLY_REFUNDED' }), 'used');
  assert.equal(ask({ status: 'PENDING' }), 'not_ready');
  assert.equal(ask({ status: 'DECLINED' }), 'not_ready');
  assert.equal(ask({ amount_currency: 'EUR' }), 'not_ready');
  assert.equal(ask({ amount_value: '0.00' }), 'too_big');
});

test('holdCovers needs an open hold, the same currency, enough on it, and a time before it expires', () => {
  const nowMs = Date.parse('2026-11-03T18:00:00Z');
  const hold = { status: 'CREATED', amount_value: '25.00', amount_currency: 'USD', expiration_time: '2026-11-20T00:00:00Z' };
  const ask = (patch) => holdCovers({ ...hold, ...patch }, { amountValue: '25.00', currency: 'USD', nowMs });
  assert.equal(ask({}), true);
  assert.equal(ask({ status: 'PARTIALLY_CAPTURED' }), true);
  for (const status of ['CAPTURED', 'VOIDED', 'DENIED', 'PENDING', null]) assert.equal(ask({ status }), false, status);
  assert.equal(ask({ amount_value: '24.99' }), false);
  assert.equal(ask({ amount_currency: 'EUR' }), false);
  assert.equal(ask({ expiration_time: '2026-11-03T17:00:00Z' }), false);
  assert.equal(holdCovers(null, { amountValue: '25.00', currency: 'USD', nowMs }), false);
});

test('future charge times and unverifiable sponsor expiries cannot establish relief eligibility', () => {
  const nowMs = Date.parse('2026-11-03T18:00:00Z');
  const charge = { status: 'COMPLETED', amount_value: '25.00', amount_currency: 'USD', time: '2026-11-03T18:00:00Z' };
  assert.equal(coverBlock(charge, { rule: COVER_DEFAULTS, nowMs, currency: 'USD' }), null);
  assert.equal(coverBlock({ ...charge, time: '2026-11-03T18:00:00.001Z' }, { rule: COVER_DEFAULTS, nowMs, currency: 'USD' }), 'not_ready');
  assert.equal(coverBlock({ ...charge, time: '2027-02-30T18:00:00Z' }, { rule: COVER_DEFAULTS, nowMs, currency: 'USD' }), 'too_old');
  assert.equal(coverBlock(charge, { rule: COVER_DEFAULTS, nowMs: NaN, currency: 'USD' }), 'not_ready');
  const hold = { status: 'CREATED', amount_value: '25.00', amount_currency: 'USD', expiration_time: '2026-11-03T18:00:00.001Z' };
  assert.equal(holdCovers(hold, { amountValue: '25.00', currency: 'USD', nowMs }), true);
  for (const expiration_time of [undefined, null, '', 'not-a-date', '2027-02-30T18:00:00Z', '2026-11-03T18:00:00Z']) {
    assert.equal(holdCovers({ ...hold, expiration_time }, { amountValue: '25.00', currency: 'USD', nowMs }), false);
  }
  for (const amountValue of [null, '', 'not-money', '0.00', '-1.00']) {
    assert.equal(holdCovers(hold, { amountValue, currency: 'USD', nowMs }), false);
  }
  assert.equal(holdCovers(hold, { amountValue: '25.00', currency: 'USD', nowMs: NaN }), false);
});

test('invalid sponsor expiry and a future completed charge cause no proposal or financial attempt', async () => {
  const expired = buildStack();
  expired.paypal.mockSetHold(HOLD, { expiration_time: 'not-a-date' });
  const first = await offered(expired);
  assert.deepEqual(eventsOf(expired, first.callId, 'proposed'), []);
  assert.deepEqual(eventsOf(expired, first.callId, 'write'), []);
  const future = buildStack();
  future.paypal.mockSetCharges(SUB, [mockCharge({ time: '2030-01-01T00:00:00Z' })]);
  const second = await offered(future);
  assert.deepEqual(eventsOf(future, second.callId, 'proposed'), []);
  assert.deepEqual(eventsOf(future, second.callId, 'write'), []);
});

test('a charge outside the staff rule, or no hold, gets no offer and an honest sentence, and every reply grades clean', async () => {
  const cases = [
    [{ value: '75.00', time: '2026-11-01T10:00:00.000Z' }, /more than the hardship fund can cover/],
    [{ time: '2026-09-01T10:00:00.000Z' }, /too old for the hardship fund/],
  ];
  for (const [charge, words] of cases) {
    const stack = buildStack();
    stack.paypal.mockSetCharges(SUB, [mockCharge(charge)]);
    const { callId, asked } = await offered(stack);
    assert.match(asked.reply, words);
    assert.match(asked.reply, /You can ask me to pause your monthly gift instead\./);
    assert.deepEqual(eventsOf(stack, callId, 'proposed'), []);
    clean(stack, callId);
  }
  const off = buildStack({ env: { COVER_PER_YEAR: '0' } });
  const offCall = await offered(off);
  assert.match(offCall.asked.reply, /isn't open in PayPal right now/);
  assert.deepEqual(eventsOf(off, offCall.callId, 'proposed'), []);
  clean(off, offCall.callId);
  for (const patch of [{ status: 'VOIDED' }, { expiration_time: '2026-11-03T17:00:00.000Z' }, { amount: { currency_code: 'USD', value: '10.00' } }]) {
    const stack = buildStack();
    stack.paypal.mockSetHold(HOLD, patch);
    const { callId, asked } = await offered(stack);
    assert.match(asked.reply, /isn't open in PayPal right now/, JSON.stringify(patch));
    assert.deepEqual(eventsOf(stack, callId, 'proposed'), []);
    clean(stack, callId);
  }
});

test('a pending charge is read aloud with no offer, no charge gets no offer, and a missing hold id says the fund is not open', async () => {
  const pending = buildStack();
  pending.paypal.mockSetCharges(SUB, [mockCharge({ status: 'PENDING', time: '2026-11-01T10:00:00.000Z' })]);
  const one = await offered(pending);
  assert.match(one.asked.reply, /with the status pending\. That charge can't be given back right now\./);
  assert.deepEqual(eventsOf(pending, one.callId, 'proposed'), []);
  clean(pending, one.callId);
  const none = buildStack();
  none.paypal.mockSetCharges(SUB, []);
  const two = await offered(none);
  assert.match(two.asked.reply, /PayPal shows no recent charge/);
  clean(none, two.callId);
  const gone = buildStack();
  gone.paypal.mockRemoveHold(HOLD);
  const three = await offered(gone);
  assert.match(three.asked.reply, /isn't open in PayPal right now/);
  clean(gone, three.callId);
});

// ---- The yes: both moves, each with its own token, each read back ----

test('one spoken yes captures from the sponsor first, then refunds the donor, the same amount, and reads both back from PayPal', async () => {
  const { stack, callId } = await offered();
  const { reply, state } = await say(stack, callId, 'Yes.');
  assert.equal(reply, 'Done. PayPal now shows your charge of $25.00 as refunded. '
    + "PayPal shows the sponsor's payment of the same amount to Sunny Hollow Pantry, with the status completed. "
    + 'PayPal now shows your monthly gift as active. The next gift is on December 1. If next month is hard too, you can ask me to pause it. What else can I help with?');
  assert.deepEqual(legs(stack, callId), [['cover_capture', true], ['cover_refund', true]]);
  const writes = eventsOf(stack, callId, 'write');
  assert.ok(writes[0].seq < writes[1].seq, 'the sponsor pays before the donor is refunded');
  assert.ok(writes.every((w) => w.amountValue === '25.00' && w.currency === 'USD' && w.tokenId));
  assert.notEqual(writes[0].tokenId, writes[1].tokenId, 'each move has its own one-time token');
  assert.equal(donorRefunded(stack), 2500);
  assert.deepEqual(stack.paypal.mockMoney().captures.map((c) => [c.hold_id, c.amount.value, c.final_capture]), [[HOLD, '25.00', false]]);
  const after = eventsOf(stack, callId, 'read').filter((e) => e.seq > writes[1].seq).map((e) => e.what);
  for (const what of ['gift_charge', 'capture', 'hold', 'charge', 'subscription']) assert.ok(after.includes(what), `a fresh ${what} read after the moves`);
  const [cover] = eventsOf(stack, callId, 'cover_month');
  assert.equal(cover.outcome, 'covered');
  assert.equal(cover.transactionId, TX);
  assert.equal(state.pending, null);
  assert.deepEqual(state.record.cover, { outcome: 'covered', amount: '$25.00', refundStatus: 'REFUNDED', captureStatus: 'COMPLETED', transactionId: TX, captureFee: '$1.21' });
  assert.equal(state.record.subscription.status, 'ACTIVE', 'a refund leaves the gift active');
  clean(stack, callId);
  const script = { expect: { writes: ['cover_capture', 'cover_refund'], staging: [], refusals: [], proposals: ['cover_month'], finalStatus: 'ACTIVE' } };
  assert.deepEqual(checkScript(stack.ledger.byCall(callId), script), []);
});

test('the yes accepts the words a donor would say, and nothing that adds a detail', () => {
  for (const text of ['Yes.', 'Yes, give it back.', 'Yes, refund me.', 'Yes please, cover it.', 'Okay, go ahead.']) assert.ok(isClearYes(text, 'cover_month'), text);
  for (const text of ['Yes, give me back fifty dollars.', 'Yes, refund it to my other card.', 'Yes, but keep it for next month.', 'Give it back?', 'Okay.', 'Yes, cancel it.']) assert.ok(!isClearYes(text, 'cover_month'), text);
});

// ---- The gate: no yes, a stale yes, a wrong amount ----

test('no yes moves no money: an okay, a question, a yes with an amount in it, and a yes in the asking turn', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, "Yes, yes, I lost my job, give it back, I can't do it this month.");
  assert.deepEqual(eventsOf(stack, callId, 'write'), [], 'a yes in the same turn as the request does not count');
  const okay = await say(stack, callId, 'Okay.');
  assert.match(okay.reply, /^I need a clear yes or no before I change anything\./);
  const amount = await say(stack, callId, 'Yes, give me back fifty dollars.');
  assert.doesNotMatch(amount.reply, /^Done/);
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.equal(donorRefunded(stack), 0);
  clean(stack, callId);
});

test('"I want my money back" and "I can\'t afford it" ask again, without reading PayPal twice or a new proposal', async () => {
  const { stack, callId } = await offered();
  const reads = eventsOf(stack, callId, 'read').length;
  for (const text of ['I want my money back.', "I can't afford it."]) {
    const again = await say(stack, callId, text);
    assert.match(again.reply, /^I need a clear yes or no before I change anything\./);
  }
  assert.equal(eventsOf(stack, callId, 'read').length, reads);
  assert.equal(eventsOf(stack, callId, 'proposed').length, 1);
  await say(stack, callId, 'Yes, refund me.');
  assert.deepEqual(legs(stack, callId), [['cover_capture', true], ['cover_refund', true]]);
  clean(stack, callId);
});

test('a no moves nothing and says so', async () => {
  const { stack, callId } = await offered();
  const { reply } = await say(stack, callId, 'No, thank you.');
  assert.equal(reply, "OK, I won't change anything, so your monthly gift stays as it is. What else can I help with?");
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.deepEqual(eventsOf(stack, callId, 'cover_month'), []);
  clean(stack, callId);
});

test('a stale yes moves nothing', async () => {
  const { stack, callId } = await offered();
  stack.clock.advance(stack.config.limits.pendingTtlMs + 1000);
  await say(stack, callId, 'Yes.');
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.equal(eventsOf(stack, callId, 'expired').length, 1);
  assert.equal(donorRefunded(stack), 0);
  clean(stack, callId);
});

test('a yes that left its client before the offer reached it moves nothing', async () => {
  const { stack, callId, asked } = await offered();
  await stack.calls.turn(callId, { text: 'Yes.', source: 'typed', answering: asked.turn - 1 });
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.equal(donorRefunded(stack), 0);
});

test('a token is bound to its kind, its target and its exact amount, and works once', async () => {
  const clock = makeClock();
  const tokens = createTokens({ now: clock.now });
  const paypal = createMockPayPal({ tokens, now: clock.now });
  const ctx = (patch = {}) => ({ callId: 'c1', amountValue: '25.00', currency: 'USD', requestId: 'r1', ...patch });
  const mint = (kind, targetId, amount = '25.00') => tokens.mint({ callId: 'c1', pendingId: 'p', kind, targetId, binding: moneyBinding(amount, 'USD') });
  await assert.rejects(paypal.captureSponsorHold(HOLD, undefined, ctx()), WriteNotAuthorized);
  await assert.rejects(paypal.captureSponsorHold(HOLD, 'made-up', ctx()), /unknown_or_used/);
  await assert.rejects(paypal.captureSponsorHold(HOLD, mint('cover_refund', HOLD), ctx()), /wrong_kind/);
  await assert.rejects(paypal.captureSponsorHold(HOLD, mint('cover_capture', 'OTHER'), ctx()), /wrong_target/);
  await assert.rejects(paypal.captureSponsorHold(HOLD, mint('cover_capture', HOLD), ctx({ amountValue: '26.00' })), /wrong_amount/);
  await assert.rejects(paypal.captureSponsorHold(HOLD, mint('cover_capture', HOLD), ctx({ callId: 'c2' })), /wrong_call/);
  await assert.rejects(paypal.refundCharge(TX, mint('cover_refund', TX), ctx({ currency: 'EUR' })), /wrong_amount/);
  const stale = mint('cover_refund', TX);
  clock.advance(60000);
  await assert.rejects(paypal.refundCharge(TX, stale, ctx()), /expired/);
  assert.deepEqual(paypal.mockMoney().captures, [], 'no refused token moved money');
  assert.deepEqual(paypal.mockMoney().refunded, {});
  const token = mint('cover_capture', HOLD);
  await paypal.captureSponsorHold(HOLD, token, ctx());
  await assert.rejects(paypal.captureSponsorHold(HOLD, token, ctx()), /unknown_or_used/);
  assert.equal(paypal.mockMoney().captures.length, 1);
});

// ---- PayPal errors: nothing ever says money moved that didn't, and the sponsor never pays for a month not given back ----

const refusal = (name) => new PayPalError({ status: 422, name, message: 'no' });
const lost = () => new PayPalError({ status: 0, name: 'TIMEOUT', message: 'PayPal did not answer in time' });

test('a sponsor capture PayPal refuses runs no refund, and says no money moved', async () => {
  const { stack, callId } = await offered();
  stack.paypal.captureSponsorHold = async () => { throw refusal('MAX_CAPTURE_AMOUNT_EXCEEDED'); };
  const { reply, state } = await say(stack, callId, 'Yes.');
  assert.equal(reply, "PayPal didn't accept the sponsor's payment, so I didn't give the month back and no money moved. Staff can help during open hours. What else can I help with?");
  assert.deepEqual(legs(stack, callId), [['cover_capture', false]]);
  assert.equal(donorRefunded(stack), 0);
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'no_money_moved');
  assert.equal(state.pending, null);
  clean(stack, callId);
});

test('a capture PayPal really refuses, a hold drawn down too far, runs no refund', async () => {
  const stack = buildStack();
  stack.paypal.mockSetHold(HOLD, { amount: { currency_code: 'USD', value: '30.00' } });
  const first = await offered(stack);
  stack.paypal.mockSetCharges(SUB, [mockCharge({ time: '2026-11-01T10:00:00.000Z' })]);
  // A real earlier capture from another gift took 10 of the 30.
  const token = stack.tokens.mint({ callId: 'other', pendingId: 'p', kind: 'cover_capture', targetId: HOLD, binding: moneyBinding('10.00', 'USD') });
  await stack.paypal.captureSponsorHold(HOLD, token, { callId: 'other', amountValue: '10.00', currency: 'USD', requestId: 'other-1' });
  const { reply } = await say(stack, first.callId, 'Yes.');
  assert.match(reply, /PayPal didn't accept the sponsor's payment/);
  assert.equal(donorRefunded(stack), 0);
  clean(stack, first.callId);
});

test('a capture with a lost answer runs no refund, never says it moved, and stays with staff', async () => {
  const { stack, callId } = await offered();
  stack.paypal.captureSponsorHold = async () => { throw lost(); };
  const { reply } = await say(stack, callId, 'Yes.');
  assert.equal(reply, "PayPal didn't answer clearly about the sponsor's payment, so I didn't give the month back. Staff can help during open hours. What else can I help with?");
  assert.equal(donorRefunded(stack), 0);
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open');
  clean(stack, callId);
  // The same charge is staff's now, so a later call moves nothing.
  const later = await verifiedCall(stack);
  const again = await say(stack, later, ASK);
  assert.match(again.reply, /There is an earlier request for this charge/);
  assert.deepEqual(eventsOf(stack, later, 'proposed'), []);
  clean(stack, later);
});

test('a capture that answers with no completed money, as a replay of a refunded one would, runs no refund', async () => {
  const { stack, callId } = await offered();
  stack.paypal.captureSponsorHold = async () => ({ id: 'CAP1', status: 'REFUNDED', amountValue: '25.00', debugId: 'd', ms: 1 });
  const { reply } = await say(stack, callId, 'Yes.');
  assert.match(reply, /didn't answer clearly about the sponsor's payment/);
  assert.equal(donorRefunded(stack), 0);
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open', 'an unusable success response cannot prove no money moved');
  clean(stack, callId);
  const other = await offered();
  other.stack.paypal.captureSponsorHold = async () => ({ id: 'CAP1', status: 'COMPLETED', amountValue: '24.00', debugId: 'd', ms: 1 });
  await say(other.stack, other.callId, 'Yes.');
  assert.equal(donorRefunded(other.stack), 0, 'another amount never runs the refund');
  clean(other.stack, other.callId);
});

test('a refund PayPal refuses after the sponsor paid sends the sponsor\'s money back, says so, and the donor keeps her charge as it was', async () => {
  const { stack, callId } = await offered();
  stack.paypal.refundCharge = async () => { throw refusal('REFUND_FAILED_INSUFFICIENT_FUNDS'); };
  const { reply, state } = await say(stack, callId, 'Yes.');
  assert.equal(reply, "PayPal didn't accept the refund, so I asked PayPal to return the sponsor's payment. PayPal now shows the sponsor's payment as refunded. "
    + 'Your charge stays as it was. Staff can help during open hours. What else can I help with?');
  assert.deepEqual(legs(stack, callId), [['cover_capture', true], ['cover_refund', false], ['cover_unwind', true]]);
  assert.equal(stack.paypal.mockMoney().captures[0].status, 'REFUNDED');
  assert.equal(donorRefunded(stack), 0);
  assert.equal(state.record.cover.outcome, 'unwound');
  clean(stack, callId);
});

test('a refund PayPal refuses that a read shows went through keeps the sponsor\'s money and goes to staff', async () => {
  const { stack, callId } = await offered();
  const realRefund = stack.paypal.refundCharge;
  stack.paypal.refundCharge = async (...args) => { await realRefund(...args); throw refusal('CAPTURE_FULLY_REFUNDED'); };
  const { reply } = await say(stack, callId, 'Yes.');
  assert.equal(reply, "PayPal didn't answer clearly about the refund, so I can't say it went through. Staff can help during open hours. What else can I help with?");
  assert.deepEqual(legs(stack, callId), [['cover_capture', true], ['cover_refund', false]], 'no return of the sponsor\'s payment');
  assert.equal(stack.paypal.mockMoney().captures[0].status, 'COMPLETED');
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open');
  clean(stack, callId);
});

test('a refund refused and a return that fails too says so, and leaves it with staff', async () => {
  const { stack, callId } = await offered();
  stack.paypal.refundCharge = async () => { throw refusal('REFUND_FAILED_INSUFFICIENT_FUNDS'); };
  stack.paypal.unwindSponsorCapture = async () => { throw refusal('UNPROCESSABLE_ENTITY'); };
  const { reply } = await say(stack, callId, 'Yes.');
  assert.equal(reply, "PayPal didn't accept the refund, and I couldn't return the sponsor's payment. Staff can help during open hours. What else can I help with?");
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open');
  clean(stack, callId);
});

test('a refund with a lost answer is read back: went through says what PayPal shows, not shown stays with staff and returns nothing', async () => {
  const through = await offered();
  const realRefund = through.stack.paypal.refundCharge;
  through.stack.paypal.refundCharge = async (...args) => { await realRefund(...args); throw lost(); };
  const yes = await say(through.stack, through.callId, 'Yes.');
  assert.match(yes.reply, /^PayPal didn't answer clearly, so I checked again\. PayPal now shows your charge of \$25\.00 as refunded\./);
  assert.equal(eventsOf(through.stack, through.callId, 'cover_month')[0].outcome, 'covered');
  clean(through.stack, through.callId);

  const notShown = await offered();
  notShown.stack.paypal.refundCharge = async () => { throw lost(); };
  const no = await say(notShown.stack, notShown.callId, 'Yes.');
  assert.equal(no.reply, "PayPal didn't answer clearly about the refund, so I can't say it went through. Staff can help during open hours. What else can I help with?");
  assert.deepEqual(legs(notShown.stack, notShown.callId), [['cover_capture', true], ['cover_refund', false]], 'no return, since the refund may have gone through');
  assert.equal(eventsOf(notShown.stack, notShown.callId, 'cover_month')[0].outcome, 'open');
  clean(notShown.stack, notShown.callId);
});

test('a read that fails after the moves never hides them or claims them', async () => {
  const { stack, callId } = await offered();
  const realCapture = stack.paypal.getCapture;
  stack.paypal.getCapture = async (id) => {
    // The pre-write and sponsor-funding reads must succeed. Fail only once the donor refund has actually run.
    if (donorRefunded(stack) > 0) throw lost();
    return realCapture(id);
  };
  const { reply } = await say(stack, callId, 'Yes.');
  assert.match(reply, /^I asked PayPal to give it back\. It can take a minute to update\. I asked PayPal to take the sponsor's payment\./);
  assert.doesNotMatch(reply, /Done\.|refunded|completed/);
  assert.equal(donorRefunded(stack), 2500);
  clean(stack, callId);
});

test('a generic error after sponsor capture keeps its ID and never claims that no money moved', async () => {
  const { stack, callId } = await offered();
  const getCapture = stack.paypal.getCapture;
  let reads = 0;
  stack.paypal.getCapture = async (...args) => {
    reads += 1;
    if (reads === 2) throw new Error('injected local read failure');
    return getCapture(...args);
  };
  const { reply } = await say(stack, callId, 'Yes.');
  const [cover] = eventsOf(stack, callId, 'cover_month');
  assert.equal(cover.outcome, 'open');
  assert.ok(cover.captureId, 'the response capture ID is retained for reconciliation');
  assert.equal(sponsorPaid(stack), 1);
  assert.equal(donorRefunded(stack), 0);
  assert.doesNotMatch(reply, /nothing (?:was|has been) (?:moved|taken)/i);
});

test('a generic error after a donor refund never triggers sponsor unwind', async () => {
  const { stack, callId } = await offered();
  const refund = stack.paypal.refundCharge;
  stack.paypal.refundCharge = async (...args) => {
    await refund(...args);
    throw new Error('injected lost refund response');
  };
  await say(stack, callId, 'Yes.');
  assert.equal(donorRefunded(stack), 2500);
  assert.equal(sponsorPaid(stack), 1);
  assert.ok(!eventsOf(stack, callId, 'write').some((event) => event.kind === 'cover_unwind'));
});

test('a ledger failure after capture keeps this charge blocked for the life of the process', async () => {
  const { stack, callId } = await offered();
  const append = stack.ledger.append;
  let fail = true;
  stack.ledger.append = (event) => {
    if (fail && event.type === 'write' && event.kind === 'cover_capture') {
      fail = false;
      throw new Error('injected ledger failure');
    }
    return append(event);
  };
  await assert.rejects(() => say(stack, callId, 'Yes.'), /injected ledger failure/);
  assert.equal(sponsorPaid(stack), 1);
  assert.equal(donorRefunded(stack), 0);
  const another = await offered(stack);
  assert.equal(another.asked.state.pending, null);
  assert.equal(eventsOf(stack, another.callId, 'write').length, 0);
  assert.equal(sponsorPaid(stack), 1);
});

test('PayPal errors before the moves say nothing changed and move nothing', async () => {
  const first = buildStack();
  first.paypal.getSponsorHold = async () => { throw lost(); };
  const a = await offered(first);
  assert.match(a.asked.reply, /couldn't get a clear answer from PayPal/);
  assert.deepEqual(eventsOf(first, a.callId, 'proposed'), []);
  clean(first, a.callId);

  const second = await offered();
  second.stack.paypal.getCapture = async () => { throw lost(); };
  const b = await say(second.stack, second.callId, 'Yes.');
  assert.match(b.reply, /couldn't get a clear answer from PayPal/);
  assert.deepEqual(eventsOf(second.stack, second.callId, 'write'), []);
  assert.equal(b.state.pending, null, 'the offer is closed, so a second yes answers nothing');
  clean(second.stack, second.callId);
});

// ---- What changed since the offer ----

test('the yes reads PayPal again, and a charge refunded, replaced or a hold voided since the offer moves nothing', async () => {
  const changes = [
    (s) => s.paypal.mockSetCharges(SUB, [mockCharge({ status: 'REFUNDED', time: '2026-11-01T10:00:00.000Z' })]),
    (s) => s.paypal.mockSetCharges(SUB, [mockCharge({ time: '2026-11-01T10:00:00.000Z' }), mockCharge({ id: 'NEWTX0000000099ZZ', value: '40.00', time: '2026-11-03T17:00:00.000Z' })]),
    (s) => s.paypal.mockSetHold(HOLD, { status: 'VOIDED' }),
  ];
  for (const change of changes) {
    const { stack, callId } = await offered();
    change(stack);
    const { reply, state } = await say(stack, callId, 'Yes.');
    assert.equal(reply, "Something changed since I read that to you, so I didn't move any money. Staff can help during open hours. What else can I help with?");
    assert.deepEqual(eventsOf(stack, callId, 'write'), []);
    assert.equal(state.pending, null);
    assert.equal(sponsorPaid(stack), 0);
    clean(stack, callId);
  }
});

test('"How do you know?" while the cover waits reads the charge and hold again and keeps the offer, unless PayPal changed', async () => {
  const { stack, callId } = await offered();
  const { reply } = await say(stack, callId, 'How do you know?');
  assert.match(reply, /^I just checked PayPal's record again\. PayPal shows the latest charge/);
  const turn = eventsOf(stack, callId, 'said').at(-1).turn;
  assert.deepEqual(eventsOf(stack, callId, 'read').filter((e) => e.turn === turn).map((e) => e.what).sort(), ['charge', 'hold', 'plan', 'subscription']);
  clean(stack, callId);
  await say(stack, callId, 'Yes.');
  assert.deepEqual(legs(stack, callId), [['cover_capture', true], ['cover_refund', true]]);
  clean(stack, callId);

  const other = await offered();
  other.stack.paypal.mockSetHold(HOLD, { status: 'VOIDED' });
  const set = await say(other.stack, other.callId, 'Are you sure?');
  assert.match(set.reply, /^I've set that earlier request aside, so nothing changed\./);
  await say(other.stack, other.callId, 'Yes.');
  assert.deepEqual(eventsOf(other.stack, other.callId, 'write'), []);
  clean(other.stack, other.callId);
});

test('moving past the offer drops it, so a later yes moves nothing', async () => {
  const { stack, callId } = await offered();
  await say(stack, callId, 'Actually, pause it instead.');
  assert.equal(eventsOf(stack, callId, 'withdrawn').length, 1);
  assert.equal(eventsOf(stack, callId, 'proposed').at(-1).kind, 'suspend');
  await say(stack, callId, 'Yes, give it back.');
  assert.deepEqual(eventsOf(stack, callId, 'write').filter((w) => w.kind.startsWith('cover')), []);
  clean(stack, callId);
});

// ---- A locked or unverified call ----

test('before the PIN and on a locked call, a hardship turn reads nothing and moves nothing', async () => {
  const stack = buildStack();
  const { callId } = stack.calls.start({ userAgent: 'node-test' });
  const { reply } = await say(stack, callId, ASK);
  assert.match(reply, /PIN/);
  assert.deepEqual(eventsOf(stack, callId, 'read'), []);

  const locked = buildStack();
  const call = locked.calls.start({ userAgent: 'node-test' });
  for (const pin of ['1111', '2222', '3333']) await locked.calls.turn(call.callId, { text: pin, source: 'keypad' });
  const after = await say(locked, call.callId, ASK);
  assert.equal(after.reply, 'This call has ended. Please start a new call if you need anything else.');
  await say(locked, call.callId, 'Yes.');
  assert.deepEqual(eventsOf(locked, call.callId, 'read'), []);
  assert.deepEqual(eventsOf(locked, call.callId, 'write'), []);
  assert.deepEqual(checkSafety(locked.ledger.byCall(call.callId)), []);
});

test('a call that ends while the cover waits moves nothing on a late yes', async () => {
  const { stack, callId } = await offered();
  await stack.calls.end(callId);
  await say(stack, callId, 'Yes.');
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.equal(donorRefunded(stack), 0);
});

// ---- A double submit ----

test('two copies of one yes sent together move money once', async () => {
  const { stack, callId, asked } = await offered();
  const send = () => stack.calls.turn(callId, { text: 'Yes.', source: 'typed', answering: asked.turn });
  const [first, second] = await Promise.all([send(), send()]);
  assert.match(first.reply, /^Done\./);
  assert.match(second.reply, /nothing waiting for a yes or no/);
  assert.deepEqual(legs(stack, callId), [['cover_capture', true], ['cover_refund', true]]);
  assert.equal(donorRefunded(stack), 2500);
  assert.equal(stack.paypal.mockMoney().captures.length, 1);
  clean(stack, callId);
});

test('two calls about one charge never both move money, whichever way they race', async () => {
  const stack = buildStack({ mockOptions: { latencyMs: 2 } });
  const a = await offered(stack);
  const b = await offered(stack);
  const [one, two] = await Promise.all([say(stack, a.callId, 'Yes.'), say(stack, b.callId, 'Yes.')]);
  const replies = [one.reply, two.reply];
  assert.equal(replies.filter((r) => r.startsWith('Done.')).length, 1, replies.join(' | '));
  assert.equal(replies.filter((r) => r.startsWith('Something changed')).length, 1);
  assert.equal(donorRefunded(stack), 2500);
  assert.equal(stack.paypal.mockMoney().captures.length, 1);
  clean(stack, a.callId);
  clean(stack, b.callId);
});

test('a second try at the same charge is turned down, from PayPal or from the ledger when PayPal has not updated', async () => {
  const { stack, callId } = await offered();
  await say(stack, callId, 'Yes.');
  const again = await say(stack, callId, ASK);
  assert.match(again.reply, /already given back in the last year/);
  assert.equal(eventsOf(stack, callId, 'proposed').length, 1);
  clean(stack, callId);
  // PayPal's list still shows the charge as completed, as it may for a while.
  stack.paypal.mockSetCharges(SUB, [mockCharge({ time: '2026-11-01T10:00:00.000Z' })]);
  const later = await offered(stack);
  assert.match(later.asked.reply, /already given back in the last year/);
  assert.deepEqual(eventsOf(stack, later.callId, 'proposed'), []);
  clean(stack, later.callId);
});

test('the yearly rule counts a refund PayPal lists on an older charge', async () => {
  const stack = buildStack();
  stack.paypal.mockSetCharges(SUB, [mockCharge({ id: 'OLDTX000000000001', status: 'REFUNDED', time: '2026-06-01T10:00:00.000Z' }), mockCharge({ time: '2026-11-01T10:00:00.000Z' })]);
  const { callId, asked } = await offered(stack);
  assert.match(asked.reply, /already given back in the last year/);
  clean(stack, callId);
});

test('a retried leg with the same request id replays PayPal\'s answer and moves money once', async () => {
  const clock = makeClock();
  const tokens = createTokens({ now: clock.now });
  const paypal = createMockPayPal({ tokens, now: clock.now });
  const mint = (kind, targetId) => tokens.mint({ callId: 'c1', pendingId: 'p', kind, targetId, binding: moneyBinding('25.00', 'USD') });
  const money = { callId: 'c1', amountValue: '25.00', currency: 'USD' };
  const a = await paypal.captureSponsorHold(HOLD, mint('cover_capture', HOLD), { ...money, requestId: requestIds.capture(TX) });
  const b = await paypal.captureSponsorHold(HOLD, mint('cover_capture', HOLD), { ...money, requestId: requestIds.capture(TX) });
  assert.equal(a.id, b.id);
  assert.equal(paypal.mockMoney().captures.length, 1);
  const c = await paypal.refundCharge(TX, mint('cover_refund', TX), { ...money, requestId: requestIds.refund(TX) });
  const d = await paypal.refundCharge(TX, mint('cover_refund', TX), { ...money, requestId: requestIds.refund(TX) });
  assert.equal(c.id, d.id);
  assert.equal(paypal.mockMoney().refunded[TX], 2500);
  await assert.rejects(paypal.refundCharge(TX, mint('cover_refund', TX), { ...money, requestId: 'another-id' }), (e) => e.status === 422);
  // A capture PayPal refunded since replays as refunded, which call.js never treats as paid.
  await paypal.unwindSponsorCapture(HOLD, mint('cover_unwind', HOLD), { ...money, captureId: a.id, requestId: requestIds.unwind(a.id) });
  const replay = await paypal.captureSponsorHold(HOLD, mint('cover_capture', HOLD), { ...money, requestId: requestIds.capture(TX) });
  assert.equal(replay.status, 'REFUNDED');
});

test('a cover the ledger holds blocks a new try in the sandbox, and an older one does not block a mock whose money restarted', async () => {
  const stack = buildStack();
  stack.ledger.append({ type: 'cover_month', callId: 'old', subscriptionId: SUB, transactionId: 'OLDTX000000000001', outcome: 'covered' });
  stack.clock.advance(1000);
  // A restarted mock's money starts after that cover.
  stack.paypal.historyStart = stack.clock.now().toISOString();
  const mock = await offered(stack);
  assert.equal(eventsOf(stack, mock.callId, 'proposed').length, 1);
  clean(stack, mock.callId);
  // The sandbox has no restart, so the cover counts for the year.
  delete stack.paypal.historyStart;
  const live = await offered(stack);
  assert.match(live.asked.reply, /already given back in the last year/);
  assert.deepEqual(eventsOf(stack, live.callId, 'proposed'), []);
  assert.equal(eventsOf(stack, live.callId, 'refused').at(-1).reason, 'cover_used');
  clean(stack, live.callId);
});

test('a replayed capture answer that PayPal now shows as given back never runs the refund', async () => {
  const { stack, callId } = await offered();
  const realCapture = stack.paypal.captureSponsorHold;
  const realRead = stack.paypal.getCapture;
  stack.paypal.captureSponsorHold = async (...args) => ({ ...(await realCapture(...args)), status: 'COMPLETED' });
  stack.paypal.getCapture = async (id) => {
    const res = await realRead(id);
    return id.startsWith('MOCKCAP') ? { ...res, data: { ...res.data, status: 'REFUNDED' } } : res;
  };
  const { reply } = await say(stack, callId, 'Yes.');
  assert.match(reply, /PayPal didn't answer clearly about the sponsor's payment/);
  assert.deepEqual(legs(stack, callId), [['cover_capture', false]]);
  assert.equal(donorRefunded(stack), 0);
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open');
  clean(stack, callId);
});

test('an amount PayPal writes with one decimal still moves as two decimals', async () => {
  const stack = buildStack();
  stack.paypal.mockSetCharges(SUB, [mockCharge({ value: '25.0', time: '2026-11-01T10:00:00.000Z' })]);
  const { callId } = await offered(stack);
  assert.deepEqual(eventsOf(stack, callId, 'proposed')[0].legs.map((l) => l.amountValue), ['25.00', '25.00', '25.00']);
  await say(stack, callId, 'Yes.');
  assert.deepEqual(legs(stack, callId), [['cover_capture', true], ['cover_refund', true]]);
  clean(stack, callId);
});

test("the donor's browser never gets the sponsor's hold id", async () => {
  const { stack, callId } = await offered();
  await say(stack, callId, 'Yes.');
  assert.doesNotMatch(JSON.stringify(stack.calls.get(callId)), new RegExp(HOLD));
});

test('a receipt lists the offer amount once', async () => {
  const { stack, callId } = await offered();
  const sentence = buildReceipts(stack.ledger.byCall(callId)).flatMap((r) => r.sentences).find((s) => s.text.startsWith('PayPal shows the latest charge'));
  assert.deepEqual(sentence.facts.map((f) => f.value), ['$25.00', 'November 1', 'completed']);
});

// ---- The grader proves the new sentences ----

test('the templates tie each result sentence to a claim the grader proves, and no template says refunded on its own', () => {
  assert.deepEqual(TEMPLATE_CLAIMS['PayPal now shows your charge of {gift_charge.amount} as {gift_charge.status}.'], ['cover_refund_read', 'wrote_cover_refund']);
  assert.deepEqual(TEMPLATE_CLAIMS["PayPal shows the sponsor's payment of the same amount to {org}, with the status {capture.status}."], ['cover_capture_read', 'wrote_cover_capture']);
  assert.deepEqual(TEMPLATE_CLAIMS["PayPal shows the sponsor's hold is open."], ['hold_open']);
  assert.ok(TEMPLATE_SENTENCES.includes("I can give that {charge.amount} back to you, and a sponsor's hardship fund would pay the same amount to {org}."));
  assert.ok(!TEMPLATE_SENTENCES.some((s) => /\b(refunded|captured|paid)\b/.test(s)));
});

const forged = (event, patch) => ({ ...event, ...patch });
const swapped = (events, pick, patch) => events.map((e) => (pick(e) ? forged(e, patch) : e));
const messages = (problems) => problems.map((v) => v.message).join('\n');

async function coveredEvents() {
  const { stack, callId } = await offered();
  await say(stack, callId, 'Yes.');
  return stack.ledger.byCall(callId);
}

test('the grader fails a refund amount or status PayPal never gave, and a capture claimed with none', async () => {
  const events = await coveredEvents();
  const said = events.findLast((e) => e.type === 'said');
  const wrong = swapped(events, (e) => e === said, { text: said.text.replace('$25.00', '$40.00'), facts: said.facts.map((f) => (f.source === 'gift_charge.amount' ? { ...f, value: '$40.00' } : f)) });
  assert.match(messages(checkFacts(wrong)), /said "\$40\.00" for gift_charge\.amount/);
  const unread = events.filter((e) => !(e.type === 'read' && e.what === 'gift_charge'));
  assert.match(messages(checkFacts(unread)), /gift_charge\.status\) has no earlier PayPal read|claims a refund of the charge/);
  const noCapture = events.filter((e) => !(e.type === 'write' && e.kind === 'cover_capture'));
  const problems = messages(checkFacts(noCapture));
  assert.match(problems, /wrote_cover_capture|an ok capture from the sponsor's hold/);
  assert.match(messages(checkWrites(noCapture)), /the refund ran without the sponsor's ok capture/);
  const failedRead = swapped(events, (e) => e.type === 'read' && e.what === 'capture', { snapshot: { id: 'x', status: 'COMPLETED', amount_value: '24.00', amount_currency: 'USD' } });
  assert.match(messages(checkFacts(failedRead)), /a read of that capture after it that shows the same amount/);
});

test('the grader fails a move of another amount, target or kind than the proposal named', async () => {
  const events = await coveredEvents();
  const write = (kind) => (e) => e.type === 'write' && e.kind === kind;
  assert.match(messages(checkWrites(swapped(events, write('cover_refund'), { amountValue: '26.00' }))), /cover_refund moved 26\.00 USD, its proposal named 25\.00 USD/);
  assert.match(messages(checkWrites(swapped(events, write('cover_capture'), { amountValue: '26.00' }))), /cover_capture moved 26\.00 USD/);
  assert.match(messages(checkWrites(swapped(events, write('cover_refund'), { targetId: 'OTHERTX' }))), /cover_refund targets OTHERTX/);
  assert.match(messages(checkWrites(swapped(events, write('cover_capture'), { targetId: 'OTHERHOLD' }))), /cover_capture targets OTHERHOLD/);
  const noToken = swapped(events, write('cover_refund'), { tokenId: 'not-from-this-yes' });
  assert.match(messages(checkWrites(noToken)), /cover_refund ran without an earlier yes carrying its token/);
  const sameToken = (() => { const first = events.find(write('cover_capture')); return swapped(events, write('cover_refund'), { tokenId: first.tokenId }); })();
  assert.match(messages(checkWrites(sameToken)), /a token was used twice/);
  const notYes = swapped(events, (e) => e.type === 'heard' && e.text === 'Yes.', { text: 'Yes, give me fifty dollars.' });
  assert.match(messages(checkWrites(notYes)), /not a clear yes/);
});

test('the grader fails a move on a charge the staff rule turns down, even when the line proposed it', async () => {
  const events = await coveredEvents();
  const overCap = swapped(events, (e) => e.type === 'call_start', { coverRule: { maxDollars: 10, windowDays: 30, perYear: 1 } });
  assert.match(messages(checkWrites(overCap)), /a charge the staff rule turns down/);
});

test('the grader fails a yes that moved money with no fresh read after it, and a move after the call ended', async () => {
  const events = await coveredEvents();
  const write = events.find((e) => e.type === 'write' && e.kind === 'cover_refund');
  const noRead = events.filter((e) => !(e.type === 'read' && e.what === 'gift_charge' && e.seq > write.seq));
  assert.match(messages(checkWrites(noRead)), /no fresh PayPal read of MOCKTX00000000042 after cover_refund/);
  const seq = events.find((e) => e.type === 'yes').seq;
  const ended = [...events, { type: 'call_end', callId: events[0].callId, seq: seq - 0.5, reason: 'client' }];
  assert.match(messages(checkWrites(ended)), /write happened after the call ended/);
  const before = events.filter((e) => e.type !== 'pin_ok');
  assert.match(messages(checkWrites(before)), /cover_month happened before the PIN passed/);
});

test('the grader fails a "Done." with no money moved, and each failure sentence where it did not happen', async () => {
  const events = await coveredEvents();
  const sentence = (text, claim) => [{ claim, sentence: text }];
  const said = events.findLast((e) => e.type === 'said');
  for (const [text, claim] of [
    ["PayPal didn't accept the sponsor's payment, so I didn't give the month back and no money moved.", 'cover_capture_failed'],
    ["Something changed since I read that to you, so I didn't move any money.", 'cover_changed'],
    ["PayPal didn't answer clearly about the refund, so I can't say it went through.", 'cover_refund_unclear'],
  ]) {
    const forgedSaid = swapped(events, (e) => e === said, { text, facts: [], claims: sentence(text, claim) });
    assert.match(messages(checkFacts(forgedSaid)), new RegExp(`said "${text.slice(0, 30)}.*which claims`), claim);
  }
});

// ---- Receipts, the staff view and the browser ----

test('receipts prove each move from its own read, and nothing is blocked, in every outcome', async () => {
  const { stack, callId } = await offered();
  await say(stack, callId, 'Yes.');
  const sentences = buildReceipts(stack.ledger.byCall(callId)).flatMap((r) => r.sentences);
  const refund = sentences.find((s) => s.text.startsWith('PayPal now shows your charge'));
  assert.equal(refund.verdict, 'proven');
  assert.deepEqual([...new Set(refund.facts.map((f) => f.proof.what))], ['gift_charge']);
  assert.deepEqual(refund.claims.map((c) => [c.name, c.proven]).sort(), [['cover_refund_read', true], ['wrote_cover_refund', true]]);
  const sponsor = sentences.find((s) => s.text.startsWith("PayPal shows the sponsor's payment"));
  assert.equal(sponsor.verdict, 'proven');
  assert.deepEqual([...new Set(sponsor.facts.map((f) => f.proof.what))], ['capture']);
  assert.deepEqual(sentences.filter((s) => s.verdict === 'blocked'), []);
  const failing = await offered();
  failing.stack.paypal.refundCharge = async () => { throw refusal('REFUND_FAILED_INSUFFICIENT_FUNDS'); };
  await say(failing.stack, failing.callId, 'Yes.');
  assert.deepEqual(buildReceipts(failing.stack.ledger.byCall(failing.callId)).flatMap((r) => r.sentences).filter((s) => s.verdict === 'blocked'), []);
});

test('the staff view shows both moves, the outcome and the fee PayPal leaves, and never a token', async () => {
  const { stack, callId } = await offered();
  await say(stack, callId, 'Yes.');
  const events = stack.ledger.byCall(callId);
  const row = summarizeCall(events, stack.config);
  assert.deepEqual(row.covers.map((c) => [c.outcome, c.transactionId, c.amountValue, c.captureFee]), [['covered', TX, '25.00', '1.21']]);
  assert.ok(row.intents.includes('hardship_cover'));
  assert.deepEqual(row.writes.map((w) => [w.kind, w.ok, w.amountValue]), [['cover_capture', true, '25.00'], ['cover_refund', true, '25.00']]);
  const shown = events.map((e) => projectStaffEvent(e));
  assert.doesNotMatch(JSON.stringify(shown), /tokenId|tokenIds/);
  assert.deepEqual(Object.keys(shown.find((e) => e.type === 'cover_month')).sort(), ['amountValue', 'captureFee', 'captureId', 'captureStatus', 'chargeFee', 'currency', 'holdId', 'outcome', 'refundId', 'refundStatus', 'seq', 'subscriptionId', 'transactionId', 'ts', 'turn', 'type']);
});

test('the call state never sends a token to the browser', async () => {
  const { stack, callId } = await offered();
  await say(stack, callId, 'Yes.');
  const seen = JSON.stringify(stack.calls.get(callId));
  assert.ok(eventsOf(stack, callId, 'yes')[0].tokenIds.length === 3);
  assert.doesNotMatch(seen, /tokenId/);
  for (const id of eventsOf(stack, callId, 'yes')[0].tokenIds) assert.ok(!seen.includes(id));
});

// ---- The PayPal client ----

const fakePayPal = (answers, seen) => async (url, init) => {
  if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'A21AA-test', expires_in: 32400 }), { status: 200 });
  seen.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
  const [status, body] = answers.shift();
  return new Response(JSON.stringify(body), { status, headers: { 'paypal-debug-id': 'dbg-1' } });
};

function sandboxClient(answers, seen) {
  const tokens = createTokens();
  const paypal = createPayPal({ baseUrl: SANDBOX_BASE_URL, clientId: 'id', clientSecret: 'secret', tokens, fetchImpl: fakePayPal(answers, seen) });
  const mint = (kind, targetId, amount = '25.00') => tokens.mint({ callId: 'c1', pendingId: 'p', kind, targetId, binding: moneyBinding(amount, 'USD') });
  return { paypal, mint };
}
const money = { callId: 'c1', amountValue: '25.00', currency: 'USD', note: 'Hardship cover' };

test('the sandbox client captures with final_capture false and the charge-derived request id, and no donation items', async () => {
  const seen = [];
  const { paypal, mint } = sandboxClient([[201, { id: 'CAP1', status: 'COMPLETED', amount: { value: '25.00', currency_code: 'USD' } }]], seen);
  const res = await paypal.captureSponsorHold('AUTH1', mint('cover_capture', 'AUTH1'), { ...money, requestId: requestIds.capture(TX) });
  const call = seen.at(-1);
  assert.equal(new URL(call.url).pathname, '/v2/payments/authorizations/AUTH1/capture');
  assert.deepEqual(call.body.amount, { value: '25.00', currency_code: 'USD' });
  assert.equal(call.body.final_capture, false);
  assert.equal(call.headers['PayPal-Request-Id'], `cover-capture-${TX}`);
  assert.doesNotMatch(JSON.stringify(call.body), /DONATION|items/);
  assert.deepEqual([res.id, res.status, res.amountValue], ['CAP1', 'COMPLETED', '25.00']);
});

test('the sandbox client refunds through v2 with the amount, and only a 404 falls back to the v1 sale refund', async () => {
  const seen = [];
  const { paypal, mint } = sandboxClient([[201, { id: 'REF1', status: 'COMPLETED', amount: { value: '25.00', currency_code: 'USD' } }]], seen);
  const res = await paypal.refundCharge(TX, mint('cover_refund', TX), { ...money, requestId: 'r1' });
  assert.equal(new URL(seen.at(-1).url).pathname, `/v2/payments/captures/${TX}/refund`);
  assert.deepEqual(seen.at(-1).body.amount, { value: '25.00', currency_code: 'USD' });
  assert.equal(res.status, 'COMPLETED');

  const fallback = [];
  const second = sandboxClient([[404, { name: 'RESOURCE_NOT_FOUND' }], [201, { id: 'REF2', state: 'completed', amount: { total: '25.00', currency: 'USD' } }]], fallback);
  const old = await second.paypal.refundCharge(TX, second.mint('cover_refund', TX), { ...money, requestId: 'r2' });
  assert.equal(new URL(fallback.at(-1).url).pathname, `/v1/payments/sale/${TX}/refund`);
  assert.deepEqual(fallback.at(-1).body.amount, { total: '25.00', currency: 'USD' });
  assert.equal(fallback.at(-1).headers['PayPal-Request-Id'], 'r2');
  assert.deepEqual([old.id, old.status, old.amountValue], ['REF2', 'COMPLETED', '25.00']);

  const refused = [];
  const third = sandboxClient([[422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'REFUND_FAILED_INSUFFICIENT_FUNDS' }] }]], refused);
  await assert.rejects(third.paypal.refundCharge(TX, third.mint('cover_refund', TX), { ...money, requestId: 'r3' }), (e) => e.status === 422);
  assert.equal(refused.filter((r) => r.url.includes('/sale/')).length, 0, 'a refusal never falls back, so it never refunds by the other road');
});

test('the sandbox client refuses a money move with no token before any network call', async () => {
  const seen = [];
  const { paypal } = sandboxClient([], seen);
  await assert.rejects(paypal.captureSponsorHold('AUTH1', undefined, { ...money, requestId: 'r' }), WriteNotAuthorized);
  await assert.rejects(paypal.refundCharge(TX, 'nope', { ...money, requestId: 'r' }), WriteNotAuthorized);
  await assert.rejects(paypal.unwindSponsorCapture('AUTH1', undefined, { ...money, captureId: 'C', requestId: 'r' }), WriteNotAuthorized);
  assert.deepEqual(seen, []);
});

test('snapshots of a hold and a capture keep only what the line uses', () => {
  assert.deepEqual(toSnapshot('hold', { id: 'A', status: 'CREATED', amount: { value: '200.00', currency_code: 'USD' }, expiration_time: '2026-12-01T00:00:00Z', payer: { email_address: 'x@y.z' } }),
    { id: 'A', status: 'CREATED', amount_value: '200.00', amount_currency: 'USD', expiration_time: '2026-12-01T00:00:00Z' });
  assert.deepEqual(toSnapshot('capture', { id: 'C', status: 'COMPLETED', amount: { value: '25.00', currency_code: 'USD' }, seller_receivable_breakdown: { paypal_fee: { value: '1.21' } }, payer: { email_address: 'x@y.z' } }),
    { id: 'C', status: 'COMPLETED', amount_value: '25.00', amount_currency: 'USD', fee_value: '1.21' });
});

test('the seed calls authorize the sponsor\'s order once, with no donation items', async () => {
  const seen = [];
  const { paypal } = sandboxClient([
    [201, { id: 'ORDER1', status: 'CREATED', links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/approve' }] }],
    [201, { id: 'ORDER1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH9', status: 'CREATED', expiration_time: '2026-12-02T00:00:00Z' }] } }] }],
  ], seen);
  const order = await paypal.createSponsorOrder({ amountValue: '200.00', currency: 'USD', description: 'Hardship fund', brandName: 'Sunny Hollow Pantry', returnUrl: 'https://x.test/', cancelUrl: 'https://x.test/' });
  assert.equal(seen.at(-1).body.intent, 'AUTHORIZE');
  assert.doesNotMatch(JSON.stringify(seen.at(-1).body), /DONATION|items/);
  assert.equal(order.approveUrl, 'https://sandbox.paypal.com/approve');
  const hold = await paypal.authorizeSponsorOrder('ORDER1');
  assert.equal(new URL(seen.at(-1).url).pathname, '/v2/checkout/orders/ORDER1/authorize');
  assert.deepEqual([hold.holdId, hold.status], ['AUTH9', 'CREATED']);
});
