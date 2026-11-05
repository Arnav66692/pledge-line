// The charge check (PICK.md): "Is this charge real?" Reads the gift's latest charge from PayPal, says what it was,
// and only on a clear yes in the next turn logs a refund request for staff. Nothing here writes to PayPal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStack, verifiedCall, say, eventsOf } from './helpers.js';
import { rulesRoute, INTENTS, SYSTEM_PROMPT, ROUTE_TOOL } from '../src/router.js';
import { createPayPal, toSnapshot, PayPalError, WriteNotAuthorized } from '../src/paypal.js';
import { mockCharge, MOCK_TRANSACTION_ID } from '../src/paypal-mock.js';
import { createRefundDesk } from '../src/refund-desk.js';
import { createTokens } from '../src/gate.js';
import { gradeCall, checkFacts, checkWrites, checkSafety } from '../src/check.js';
import { buildReceipts } from '../src/receipt.js';
import { projectStaffEvent, summarizeCall } from '../src/staff.js';
import { TEMPLATE_CLAIMS, TEMPLATE_SENTENCES } from '../src/template-words.js';
import { MOCK_SUBSCRIPTION_ID, SANDBOX_BASE_URL } from '../src/config.js';

const ASK = "I see a PayPal charge I don't recognize.";
const SUB = MOCK_SUBSCRIPTION_ID;
const allClear = (grade) => [...grade.facts, ...grade.writes, ...grade.safety];

async function askedCall(stack = buildStack()) {
  const callId = await verifiedCall(stack);
  const asked = await say(stack, callId, ASK);
  return { stack, callId, asked };
}

// ---- Routing ----

test('the rules router sends a charge the caller does not know to charge_check, and a stop still to stop', () => {
  for (const text of [ASK, 'Is this charge real?', 'I was charged twenty five dollars and I do not recognise it.',
    'There is a strange charge on my bank statement.', 'I think this is fraud.', 'I want a refund.', 'Can I get my money back for that charge?',
    'I think you charged me forty dollars last month, can you check?']) {
    assert.equal(rulesRoute(text).intent, 'charge_check', text);
  }
  assert.equal(rulesRoute('I was charged twenty five dollars.').amountDollars, 0, 'an amount said about a charge never drafts a gift');
  assert.equal(rulesRoute('Stop charging me, cancel it.').intent, 'stop_gift');
  assert.equal(rulesRoute('Cancel it right now, I want a refund.').intent, 'cancel_now');
  assert.equal(rulesRoute('Pause my gift.').intent, 'pause_gift');
  assert.equal(rulesRoute("I'd like to give fifty dollars, just once.").intent, 'one_time_gift');
});

test('a question about the next charge stays a gift question, unless it doubts a charge', () => {
  for (const text of ['When will I be charged next?', 'How much will I be charged next month?', 'How much am I charged each month?']) {
    assert.equal(rulesRoute(text).intent, 'gift_status', text);
  }
  assert.equal(rulesRoute("I don't recognize this charge, will I be charged again next month?").intent, 'charge_check');
});

test('a charge PayPal shows as refunded or declined is read aloud with no refund offer', async () => {
  for (const status of ['REFUNDED', 'DECLINED']) {
    const stack = buildStack();
    stack.paypal.mockSetCharges(SUB, [mockCharge({ status, time: '2026-11-01T10:00:00.000Z' })]);
    const { callId, asked } = await askedCall(stack);
    assert.equal(asked.reply, 'PayPal shows the latest charge for your monthly gift to Sunny Hollow Pantry was $25.00 on November 1, '
      + `with the status ${status.toLowerCase()}. In your PayPal activity, it is the transaction ending in 0042. What else can I help with?`);
    assert.deepEqual(eventsOf(stack, callId, 'proposed'), [], status);
    assert.equal(asked.state.pending, null);
    assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
  }
});

test('Gemini and Haiku can pick charge_check, and the prompt says when', () => {
  assert.ok(INTENTS.includes('charge_check'));
  assert.ok(ROUTE_TOOL.input_schema.properties.intent.enum.includes('charge_check'));
  assert.match(SYSTEM_PROMPT, /^charge_check, sees a PayPal charge they don't recognize/m);
});

// ---- The read-back ----

test('the line reads the latest charge from PayPal and says its amount, date, status and transaction, then asks', async () => {
  const { stack, callId, asked } = await askedCall();
  assert.equal(asked.reply, "PayPal shows the latest charge for your monthly gift to Sunny Hollow Pantry was $25.00 on November 1, with the status completed. "
    + 'In your PayPal activity, it is the transaction ending in 0042. If you still don\'t recognize it, I can ask staff to look at a refund. '
    + 'Would you like me to ask staff? Please say yes or no.');
  const reads = eventsOf(stack, callId, 'read');
  assert.deepEqual(reads.map((e) => [e.what, e.id, e.status]), [['charge', SUB, 'COMPLETED']]);
  assert.equal(reads[0].snapshot.transaction_id, MOCK_TRANSACTION_ID);
  const said = eventsOf(stack, callId, 'said').at(-1);
  assert.deepEqual(said.facts.map((f) => [f.source, f.value]),
    [['charge.amount', '$25.00'], ['charge.date', 'November 1'], ['charge.status', 'completed'], ['charge.id_last4', '0042']]);
  assert.deepEqual(eventsOf(stack, callId, 'proposed').map((e) => [e.kind, e.targetId, e.origin]), [['refund_request', SUB, 'charge_check']]);
  assert.equal(asked.state.pending.label, 'Ask staff to look at a refund for the charge');
  assert.equal(asked.state.record.charge.transactionId, MOCK_TRANSACTION_ID);
  assert.deepEqual(eventsOf(stack, callId, 'write'), [], 'reading a charge writes nothing');
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('the line reads the newest of several charges, in the window it asked PayPal for', async () => {
  const stack = buildStack();
  stack.paypal.mockSetCharges(SUB, [
    mockCharge({ id: 'OLDTX000000000001', time: '2026-10-01T10:00:00.000Z' }),
    mockCharge({ id: 'NEWTX000000007A1B', value: '30.00', status: 'PENDING', time: '2026-11-02T18:00:00.000Z' }),
    mockCharge({ id: 'OLDTX000000000002', time: '2025-01-01T10:00:00.000Z' }),
  ]);
  const { callId, asked } = await askedCall(stack);
  assert.match(asked.reply, /was \$30\.00 on November 2, with the status pending\. In your PayPal activity, it is the transaction ending in 7A1B\./);
  assert.deepEqual(eventsOf(stack, callId, 'read')[0].snapshot.count, 2, 'a charge from before the window is not listed');
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('no charge, or one PayPal returns half filled, is said plainly with no refund offer', async () => {
  const none = buildStack();
  none.paypal.mockSetCharges(SUB, []);
  const empty = await askedCall(none);
  assert.equal(empty.asked.reply, 'PayPal shows no recent charge for your monthly gift. Staff can help during open hours.');
  assert.deepEqual(eventsOf(none, empty.callId, 'proposed'), []);
  assert.deepEqual(allClear(gradeCall(none.ledger.byCall(empty.callId), null)), []);

  const half = buildStack();
  half.paypal.mockSetCharges(SUB, [{ ...mockCharge({ time: '2026-11-01T10:00:00.000Z' }), amount_with_breakdown: null }]);
  const odd = await askedCall(half);
  assert.equal(odd.asked.reply, "PayPal didn't return a charge I can read clearly, so I won't guess. Staff can help during open hours.");
  assert.deepEqual(eventsOf(half, odd.callId, 'proposed'), []);
  assert.deepEqual(allClear(gradeCall(half.ledger.byCall(odd.callId), null)), []);
});

// ---- The gate ----

test('a refund request needs a clear yes in its own turn, logs one request for the charge read aloud, and never touches PayPal', async () => {
  const { stack, callId } = await askedCall();
  const before = (await stack.paypal.getSubscription(SUB)).data.status;
  const { reply, state } = await say(stack, callId, 'Yes, ask staff.');
  assert.equal(reply, "OK. I've asked staff to look at a refund of $25.00 for the charge on November 1. PayPal now shows that charge as completed. "
    + 'What else can I help with?');
  const requests = eventsOf(stack, callId, 'refund_request');
  assert.deepEqual(requests.map((e) => [e.subscriptionId, e.transactionId, e.amountValue, e.amountCurrency]), [[SUB, MOCK_TRANSACTION_ID, '25.00', 'USD']]);
  const [write] = eventsOf(stack, callId, 'write');
  assert.equal(write.kind, 'refund_request');
  assert.equal(write.ok, true);
  assert.ok(write.tokenId, 'the write used a one-time token from the gate');
  assert.ok(requests[0].seq < write.seq);
  assert.equal((await stack.paypal.getSubscription(SUB)).data.status, before, 'the gift is unchanged');
  assert.equal(state.pending, null);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('a yes in the asking turn, an okay, or a yes with more in it never logs a request', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, "Yes, I don't recognize this charge, refund it.");
  assert.deepEqual(eventsOf(stack, callId, 'refund_request'), [], 'a yes in the same turn as the request does not count');
  const okay = await say(stack, callId, 'Okay.');
  assert.match(okay.reply, /^I need a clear yes or no before I change anything\./);
  const more = await say(stack, callId, 'Yes, and send it to my other card.');
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.doesNotMatch(more.reply, /I've asked staff/);
  assert.deepEqual(eventsOf(stack, callId, 'refund_request'), []);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('"yes, refund it" answers the offer, and "I want my money back" asks again without reading the charge twice', async () => {
  const { stack, callId } = await askedCall();
  const again = await say(stack, callId, 'I want my money back.');
  assert.match(again.reply, /^I need a clear yes or no before I change anything\. PayPal shows the latest charge/);
  assert.equal(eventsOf(stack, callId, 'read').length, 1, 'the charge is not read again');
  assert.equal(eventsOf(stack, callId, 'proposed').length, 1, 'the offer stays the same proposal');
  assert.deepEqual(eventsOf(stack, callId, 'withdrawn'), []);
  const { reply } = await say(stack, callId, 'Yes, refund it.');
  assert.match(reply, /^OK\. I've asked staff to look at a refund of \$25\.00/);
  assert.equal(eventsOf(stack, callId, 'refund_request').length, 1);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('a refund yes never approves another change, and a pause yes never logs a refund request', async () => {
  const { stack, callId } = await askedCall();
  await say(stack, callId, 'Yes, pause it.');
  assert.deepEqual(eventsOf(stack, callId, 'refund_request'), []);
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.equal(eventsOf(stack, callId, 'proposed').at(-1).kind, 'suspend');
  await say(stack, callId, 'Yes, ask staff.');
  assert.deepEqual(eventsOf(stack, callId, 'refund_request'), []);
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('a stale yes to the refund offer logs nothing', async () => {
  const { stack, callId } = await askedCall();
  stack.clock.advance(stack.config.limits.pendingTtlMs + 1000);
  await say(stack, callId, 'Yes.');
  assert.deepEqual(eventsOf(stack, callId, 'refund_request'), []);
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.equal(eventsOf(stack, callId, 'expired').length, 1);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('before the PIN, a charge question reads nothing and logs nothing', async () => {
  const stack = buildStack();
  const { callId } = stack.calls.start({ userAgent: 'node-test' });
  const { reply } = await say(stack, callId, ASK);
  assert.match(reply, /PIN/);
  assert.deepEqual(eventsOf(stack, callId, 'read'), []);
  assert.deepEqual(eventsOf(stack, callId, 'proposed'), []);
});

test('a no logs nothing and says so', async () => {
  const { stack, callId } = await askedCall();
  const { reply } = await say(stack, callId, 'No, that is fine, I remember it now.');
  assert.equal(reply, "OK, I won't ask staff for a refund. What else can I help with?");
  assert.deepEqual(eventsOf(stack, callId, 'refund_request'), []);
  assert.deepEqual(eventsOf(stack, callId, 'write'), []);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('the desk only logs with a live token for this call and this gift, and a token works once', () => {
  const stack = buildStack();
  const tokens = createTokens({ now: stack.clock.now });
  const desk = createRefundDesk({ ledger: stack.ledger, tokens });
  const charge = { transaction_id: MOCK_TRANSACTION_ID, amount_value: '25.00', amount_currency: 'USD', time: '2026-11-01T10:00:00.000Z' };
  assert.throws(() => desk.request(SUB, undefined, { callId: 'c1', charge }), WriteNotAuthorized);
  assert.throws(() => desk.request(SUB, 'made-up', { callId: 'c1', charge }), WriteNotAuthorized);
  const wrongKind = tokens.mint({ callId: 'c1', pendingId: 'p', kind: 'cancel', targetId: SUB });
  assert.throws(() => desk.request(SUB, wrongKind, { callId: 'c1', charge }), /wrong_kind/);
  const token = tokens.mint({ callId: 'c1', pendingId: 'p', kind: 'refund_request', targetId: SUB });
  desk.request(SUB, token, { callId: 'c1', turn: 2, charge });
  assert.throws(() => desk.request(SUB, token, { callId: 'c1', charge }), /unknown_or_used/);
  assert.equal(stack.ledger.byType('refund_request').length, 1);
  assert.throws(() => createRefundDesk({ ledger: stack.ledger, tokens: null }).request(SUB, token, { callId: 'c1', charge }), WriteNotAuthorized);
});

// ---- The read-back after the request ----

test('the yes withdraws a refund request when PayPal now lists a different charge', async () => {
  const { stack, callId } = await askedCall();
  stack.paypal.mockSetCharges(SUB, [mockCharge({ time: '2026-11-01T10:00:00.000Z' }), mockCharge({ id: 'NEWTX0000000099ZZ', value: '40.00', time: '2026-11-03T17:00:00.000Z' })]);
  const { reply } = await say(stack, callId, 'Yes.');
  assert.match(reply, /set that earlier request aside/);
  const reads = eventsOf(stack, callId, 'read');
  assert.ok(reads.some((e) => e.what === 'charge' && e.snapshot?.transaction_id === 'NEWTX0000000099ZZ'), 'a fresh charge read detects the changed target');
  assert.equal(eventsOf(stack, callId, 'write').length, 0);
  assert.equal(eventsOf(stack, callId, 'refund_request').length, 0, 'neither charge is forwarded without new consent');
  assert.equal(eventsOf(stack, callId, 'withdrawn').length, 1);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('"How do you know?" while the request waits reads the gift and the charge again and keeps the offer open', async () => {
  const { stack, callId } = await askedCall();
  const { reply } = await say(stack, callId, 'How do you know?');
  assert.match(reply, /^I just checked PayPal's record again\. PayPal shows the latest charge/);
  const turn = eventsOf(stack, callId, 'said').at(-1).turn;
  assert.deepEqual(eventsOf(stack, callId, 'read').filter((e) => e.turn === turn).map((e) => e.what).sort(), ['charge', 'plan', 'subscription']);
  await say(stack, callId, 'Yes.');
  assert.equal(eventsOf(stack, callId, 'refund_request').length, 1);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

// ---- PayPal errors ----

test('a PayPal error on the charge read says so, offers nothing, and grades clean', async () => {
  const stack = buildStack();
  stack.paypal.getSubscriptionCharges = async () => { throw new PayPalError({ status: 503, name: 'SERVICE_UNAVAILABLE', message: 'try later' }); };
  const { callId, asked } = await askedCall(stack);
  assert.equal(asked.reply, "Sorry, I couldn't get a clear answer from PayPal just now, so I didn't change anything. Please try again in a minute.");
  assert.deepEqual(eventsOf(stack, callId, 'proposed'), []);
  assert.equal(eventsOf(stack, callId, 'read').at(-1).error, 'SERVICE_UNAVAILABLE 503');
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('a PayPal error during consent revalidation withdraws the request without forwarding it', async () => {
  const { stack, callId } = await askedCall();
  stack.paypal.getSubscriptionCharges = async () => { throw new PayPalError({ status: 0, name: 'TIMEOUT', message: 'PayPal did not answer in time' }); };
  const { reply } = await say(stack, callId, 'Yes.');
  assert.match(reply, /set that earlier request aside/);
  assert.equal(eventsOf(stack, callId, 'refund_request').length, 0);
  assert.equal(eventsOf(stack, callId, 'write').length, 0);
  assert.equal(eventsOf(stack, callId, 'withdrawn').length, 1);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

test('a request the desk cannot log says nothing changed', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, ASK);
  // The token store forgets the token, as a restart between the yes and the write would.
  const realConsume = stack.tokens.consume;
  stack.tokens.consume = () => { throw new WriteNotAuthorized('unknown_or_used'); };
  const { reply } = await say(stack, callId, 'Yes.');
  stack.tokens.consume = realConsume;
  assert.equal(reply, "I couldn't pass that request to staff just now, so nothing changed. Staff can help during open hours. What else can I help with?");
  assert.deepEqual(eventsOf(stack, callId, 'refund_request'), []);
  assert.equal(eventsOf(stack, callId, 'write')[0].ok, false);
  assert.deepEqual(allClear(gradeCall(stack.ledger.byCall(callId), null)), []);
});

// ---- A locked call ----

test('a locked call never reads a charge or logs a request', async () => {
  const stack = buildStack();
  const { callId } = stack.calls.start({ userAgent: 'node-test' });
  for (const pin of ['1111', '2222', '3333']) await stack.calls.turn(callId, { text: pin, source: 'keypad' });
  const { reply } = await say(stack, callId, ASK);
  assert.equal(reply, 'This call has ended. Please start a new call if you need anything else.');
  assert.deepEqual(eventsOf(stack, callId, 'read'), []);
  assert.deepEqual(eventsOf(stack, callId, 'refund_request'), []);
  assert.deepEqual(checkSafety(stack.ledger.byCall(callId)), []);
});

// ---- The grader proves the new sentences ----

test('the templates tie each new result sentence to a claim the grader proves', () => {
  assert.deepEqual(TEMPLATE_CLAIMS["I've asked staff to look at a refund of {charge.amount} for the charge on {charge.date}."], ['refund_matches_read', 'wrote_refund_request']);
  assert.deepEqual(TEMPLATE_CLAIMS['PayPal now shows that charge as {charge.status}.'], ['refund_matches_read']);
  assert.deepEqual(TEMPLATE_CLAIMS['PayPal shows no recent charge for your monthly gift.'], ['no_charge']);
  assert.deepEqual(TEMPLATE_CLAIMS["OK, I won't ask staff for a refund."], ['no_refund_request']);
  assert.ok(TEMPLATE_SENTENCES.includes('PayPal shows the latest charge for your monthly gift to {org} was {charge.amount} on {charge.date}, with the status {charge.status}.'));
  assert.ok(!TEMPLATE_SENTENCES.some((s) => /\brefunded\b/.test(s)), 'no template ever says a charge was refunded');
});

const forged = (event, patch) => ({ ...event, ...patch });

test('the grader fails a wrong charge fact, a status PayPal never gave, and a refund claimed with no request', async () => {
  const { stack, callId } = await askedCall();
  const events = stack.ledger.byCall(callId);
  const said = events.findLast((e) => e.type === 'said');
  const wrongAmount = events.map((e) => (e === said ? forged(e, {
    text: e.text.replace('$25.00', '$40.00'), facts: e.facts.map((f) => (f.source === 'charge.amount' ? { ...f, value: '$40.00' } : f)) }) : e));
  assert.match(checkFacts(wrongAmount).map((v) => v.message).join('\n'), /said "\$40\.00" for charge\.amount, PayPal's latest read gives "\$25\.00"/);
  const refunded = events.map((e) => (e === said ? forged(e, { text: e.text.replace('with the status completed', 'with the status refunded') }) : e));
  assert.match(checkFacts(refunded).map((v) => v.message).join('\n'), /spoke status "refunded" that no PayPal read covers/);
  const claimedDone = events.map((e) => (e === said ? forged(e, {
    text: "I've asked staff to look at a refund for the charge I read you.",
    facts: [], claims: [{ claim: 'wrote_refund_request', sentence: "I've asked staff to look at a refund for the charge I read you." }] }) : e));
  assert.match(checkFacts(claimedDone).map((v) => v.message).join('\n'), /claims a refund request logged in that turn, after a clear yes/);
});

test('the grader fails a request that names another charge than the one read aloud', async () => {
  const { stack, callId } = await askedCall();
  await say(stack, callId, 'Yes.');
  const events = stack.ledger.byCall(callId).map((e) => (e.type === 'refund_request' ? { ...e, transactionId: 'OTHERTX0000000001' } : e));
  assert.match(checkWrites(events).map((v) => v.message).join('\n'), /the refund request names OTHERTX0000000001, not MOCKTX00000000042/);
  assert.match(checkFacts(events).map((v) => v.message).join('\n'), /claims a refund request logged in that turn/);
  const twice = stack.ledger.byCall(callId).flatMap((e) => (e.type === 'refund_request' ? [e, { ...e, seq: e.seq + 0.5 }] : [e]));
  assert.match(checkWrites(twice).map((v) => v.message).join('\n'), /logged 2 requests for staff, not one/);
});

test('the grader fails a charge read of another gift', async () => {
  const { stack, callId } = await askedCall();
  const events = stack.ledger.byCall(callId).map((e) => (e.type === 'read' && e.what === 'charge' ? { ...e, id: 'I-SOMEONE-ELSE' } : e));
  assert.match(checkWrites(events, { subscriptionId: SUB }).map((v) => v.message).join('\n'), /a read of I-SOMEONE-ELSE/);
});

// ---- Receipts and the staff view ----

test('receipts prove each charge sentence from the charge read', async () => {
  const { stack, callId } = await askedCall();
  await say(stack, callId, 'Yes.');
  const receipts = buildReceipts(stack.ledger.byCall(callId));
  const sentences = receipts.flatMap((r) => r.sentences);
  const latest = sentences.find((s) => s.text.startsWith('PayPal shows the latest charge'));
  assert.equal(latest.verdict, 'proven');
  assert.deepEqual([...new Set(latest.facts.map((f) => f.proof.what))], ['charge']);
  for (const text of ["I've asked staff to look at a refund of $25.00 for the charge on November 1.", 'PayPal now shows that charge as completed.']) {
    const sentence = sentences.find((s) => s.text === text);
    assert.equal(sentence?.verdict, 'proven', text);
    assert.ok(sentence.claims.every((c) => c.proven && c.meaning), text);
  }
  assert.deepEqual(sentences.filter((s) => s.verdict === 'blocked'), []);
});

test('the staff view shows the request and its charge, never a payer name or email', async () => {
  const { stack, callId } = await askedCall();
  await say(stack, callId, 'Yes.');
  const events = stack.ledger.byCall(callId);
  const shown = projectStaffEvent(events.find((e) => e.type === 'refund_request'));
  assert.deepEqual(Object.keys(shown).sort(), ['amountCurrency', 'amountValue', 'chargeTime', 'seq', 'subscriptionId', 'transactionId', 'ts', 'turn', 'type']);
  const row = summarizeCall(events, stack.config);
  assert.deepEqual(row.refundRequests.map((r) => r.transactionId), [MOCK_TRANSACTION_ID]);
  assert.ok(row.intents.includes('charge_check'));
  assert.doesNotMatch(JSON.stringify(events.filter((e) => e.type === 'read' && e.what === 'charge')), /Maria|Lopez|personal\.example/);
});

// ---- The PayPal client ----

test('the sandbox client lists the charges with start_time and end_time, and the snapshot keeps only the latest', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'A21AA-test', expires_in: 32400 }), { status: 200 });
    return new Response(JSON.stringify({ transactions: [mockCharge({ time: '2026-10-01T10:00:00Z' }), mockCharge({ id: 'NEWEST00000000ABC', time: '2026-11-01T10:00:00Z' })] }),
      { status: 200, headers: { 'paypal-debug-id': 'dbg-9' } });
  };
  const paypal = createPayPal({ baseUrl: SANDBOX_BASE_URL, clientId: 'id', clientSecret: 'secret', tokens: createTokens(), fetchImpl });
  const res = await paypal.getSubscriptionCharges(SUB, { startTime: '2025-11-03T18:00:00Z', endTime: '2026-11-03T18:00:00Z' });
  const url = new URL(seen.at(-1));
  assert.equal(url.pathname, `/v1/billing/subscriptions/${SUB}/transactions`);
  assert.equal(url.searchParams.get('start_time'), '2025-11-03T18:00:00.000Z');
  assert.equal(url.searchParams.get('end_time'), '2026-11-03T18:00:00.000Z');
  assert.equal(res.debugId, 'dbg-9');
  assert.deepEqual(toSnapshot('charge', res.data), { transaction_id: 'NEWEST00000000ABC', status: 'COMPLETED', amount_value: '25.00', amount_currency: 'USD', time: '2026-11-01T10:00:00Z', count: 2, refunded_count: 0 });
  await assert.rejects(paypal.getSubscriptionCharges(SUB, { startTime: 'later', endTime: 'now' }), /time window is not valid/);
  assert.equal(typeof paypal.refundCapture, 'undefined', "the charge check has no refund call, and Covered Month's needs its own token (cover.test.js)");
});
