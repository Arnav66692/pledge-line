import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallService } from '../src/call.js';
import { PayPalError } from '../src/paypal.js';
import { gradeCall } from '../src/check.js';
import { buildStack, say, verifiedCall, eventsOf } from './helpers.js';

const SUB = 'I-MOCK0000001';
const failTimeout = () => new PayPalError({ status: 0, name: 'TIMEOUT', message: 'lost answer' });
const noWrites = (stack, callId) => assert.deepEqual(eventsOf(stack, callId, 'write'), []);

test('a changed subscription is set aside without minting consent or writing, and needs a new request', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my monthly gift.');
  stack.paypal.mockSetSubscriptionStatus(SUB, 'SUSPENDED');
  const result = await say(stack, callId, 'Yes.');
  assert.match(result.reply, /set that earlier request aside/);
  assert.equal(result.state.pending, null);
  noWrites(stack, callId);
  assert.deepEqual(eventsOf(stack, callId, 'yes'), []);
  await say(stack, callId, 'Yes.');
  noWrites(stack, callId);
  assert.deepEqual(gradeCall(stack.ledger.byCall(callId), null).facts, []);
});

test('a changed plan price or an unavailable fresh subscription read closes the proposal', async () => {
  for (const problem of ['plan', 'subscription']) {
    const stack = buildStack();
    const callId = await verifiedCall(stack);
    await say(stack, callId, 'Pause my monthly gift.');
    if (problem === 'plan') {
      const read = stack.paypal.getPlan;
      stack.paypal.getPlan = async (...args) => {
        const result = await read(...args);
        result.data.billing_cycles[0].pricing_scheme.fixed_price.value = '30.00';
        return result;
      };
    } else {
      stack.paypal.getSubscription = async () => { throw failTimeout(); };
    }
    const result = await say(stack, callId, 'Yes.');
    assert.equal(result.state.pending, null, problem);
    noWrites(stack, callId);
    assert.deepEqual(eventsOf(stack, callId, 'yes'), []);
    assert.deepEqual(gradeCall(stack.ledger.byCall(callId), null).facts, []);
  }
});

test('invoice revalidation compares the complete recipient, even when the masked email is unchanged', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Give fifty dollars once.');
  const read = stack.paypal.getInvoice;
  stack.paypal.getInvoice = async (...args) => {
    const result = await read(...args);
    result.data.primary_recipients[0].billing_info.email_address = 'sb-someone-else@personal.example.com';
    return result;
  };
  const result = await say(stack, callId, 'Yes.');
  assert.equal(result.state.pending, null);
  noWrites(stack, callId);
  await say(stack, callId, 'Goodbye.');
  assert.deepEqual(eventsOf(stack, callId, 'staging_write').map((e) => e.kind), ['create_draft']);
  assert.equal(eventsOf(stack, callId, 'draft_cleanup_deferred').length, 1);
});

test('an uncertain invoice send is never repeated or deleted while the outcome can still be in flight', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Give fifty dollars once.');
  stack.paypal.sendInvoice = async () => { throw failTimeout(); };
  await say(stack, callId, 'Yes.');
  await say(stack, callId, 'Goodbye.');
  assert.equal(eventsOf(stack, callId, 'write').filter((e) => e.kind === 'send_invoice').length, 1);
  assert.deepEqual(eventsOf(stack, callId, 'staging_write').map((e) => e.kind), ['create_draft']);
  assert.equal(eventsOf(stack, callId, 'draft_cleanup_deferred').length, 1);
});

test('a temporary readback error is retried without repeating the financial write', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, 'Pause my monthly gift.');
  const write = stack.paypal.suspendSubscription;
  const read = stack.paypal.getSubscription;
  let afterWrite = false;
  let failed = false;
  stack.paypal.suspendSubscription = async (...args) => { const result = await write(...args); afterWrite = true; return result; };
  stack.paypal.getSubscription = async (...args) => {
    if (afterWrite && !failed) { failed = true; throw failTimeout(); }
    return read(...args);
  };
  const result = await say(stack, callId, 'Yes.');
  assert.match(result.reply, /suspended/);
  assert.equal(eventsOf(stack, callId, 'write').length, 1);
  assert.equal(failed, true);
});

test('missing subscription setup does not falsely claim a PayPal lookup found no gift', async () => {
  const stack = buildStack();
  stack.config = { ...stack.config, demoSubscriptionId: null };
  stack.calls = createCallService({ config: stack.config, ledger: stack.ledger, paypal: stack.paypal, router: stack.router, gate: stack.gate,
    now: stack.clock.now, sleep: async () => {} });
  const callId = await verifiedCall(stack);
  const result = await say(stack, callId, 'Check my monthly gift.');
  assert.match(result.reply, /no subscription configured/);
  assert.doesNotMatch(result.reply, /couldn't find a monthly gift in PayPal/);
  assert.deepEqual(eventsOf(stack, callId, 'read'), []);
  assert.deepEqual(gradeCall(stack.ledger.byCall(callId), null).facts, []);
});

test('a callback request does not promise a callback has been scheduled', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  const result = await say(stack, callId, 'Please have staff call me back.');
  assert.match(result.reply, /noted that you'd like a call/);
  assert.doesNotMatch(result.reply, /will call/);
  assert.deepEqual(gradeCall(stack.ledger.byCall(callId), null).facts, []);
});

test('a refused refund with an unreadable charge never unwinds the sponsor capture', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, "I lost my job, I can't do it this month.");
  const read = stack.paypal.getCapture;
  let refundAttempted = false;
  stack.paypal.refundCharge = async () => {
    refundAttempted = true;
    throw new PayPalError({ status: 422, name: 'UNPROCESSABLE_ENTITY', message: 'refund refused' });
  };
  stack.paypal.getCapture = async (...args) => {
    if (refundAttempted) throw failTimeout();
    return read(...args);
  };
  const result = await say(stack, callId, 'Yes.');
  assert.match(result.reply, /couldn't confirm the charge's status/);
  assert.deepEqual(eventsOf(stack, callId, 'write').map((e) => e.kind), ['cover_capture', 'cover_refund']);
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open');
  assert.deepEqual(gradeCall(stack.ledger.byCall(callId), null).facts, []);
});

test('an unconfirmed sponsor capture never starts the donor refund or unwind', async () => {
  for (const problem of ['pending', 'unreadable', 'amount', 'currency']) {
    const stack = buildStack();
    const callId = await verifiedCall(stack);
    await say(stack, callId, "I lost my job, I can't do it this month.");
    const read = stack.paypal.getCapture;
    stack.paypal.getCapture = async (id, ...args) => {
      if (!id.startsWith('MOCKCAP')) return read(id, ...args);
      if (problem === 'unreadable') throw failTimeout();
      const result = await read(id, ...args);
      if (problem === 'pending') result.data.status = 'PENDING';
      if (problem === 'amount') result.data.amount.value = '20.00';
      if (problem === 'currency') result.data.amount.currency_code = 'EUR';
      return result;
    };
    const result = await say(stack, callId, 'Yes.');
    assert.match(result.reply, /didn't answer clearly about the sponsor's payment/, problem);
    assert.deepEqual(eventsOf(stack, callId, 'write').map((e) => e.kind), ['cover_capture'], problem);
    const cover = eventsOf(stack, callId, 'cover_month')[0];
    assert.equal(cover.outcome, 'open', problem);
    assert.ok(cover.captureId, problem);
    assert.deepEqual(gradeCall(stack.ledger.byCall(callId), null).facts, [], problem);
  }
});

test('a pending refund is kept open until a fresh read confirms the donor was refunded', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, "I lost my job, I can't do it this month.");
  stack.paypal.refundCharge = async () => ({ id: 'MOCKPENDINGREFUND', status: 'PENDING', amountValue: '25.00' });
  const result = await say(stack, callId, 'Yes.');
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open');
  assert.doesNotMatch(result.reply, /charge of \$25\.00 as refunded/);
  assert.deepEqual(eventsOf(stack, callId, 'write').map((e) => e.kind), ['cover_capture', 'cover_refund']);
});

test('a malformed successful refund response is unknown and never unwinds or retries money', async () => {
  for (const response of [
    { id: 'MOCKREFUND', status: null, amountValue: '25.00' },
    { id: null, status: 'COMPLETED', amountValue: '25.00' },
    { id: 'MOCKREFUND', status: 'COMPLETED', amountValue: '24.00' },
  ]) {
    const stack = buildStack();
    const callId = await verifiedCall(stack);
    await say(stack, callId, "I lost my job, I can't do it this month.");
    stack.paypal.refundCharge = async () => response;
    const result = await say(stack, callId, 'Yes.');
    assert.match(result.reply, /didn't answer clearly about the refund/);
    assert.deepEqual(eventsOf(stack, callId, 'write').map((e) => e.kind), ['cover_capture', 'cover_refund']);
    const record = eventsOf(stack, callId, 'cover_month')[0];
    assert.equal(record.outcome, 'open');
    assert.equal(record.refundId, response.id);
    assert.deepEqual(gradeCall(stack.ledger.byCall(callId), null).facts, []);
  }
});

test('a malformed successful capture response is unknown and never refunds the donor', async () => {
  const stack = buildStack();
  const callId = await verifiedCall(stack);
  await say(stack, callId, "I lost my job, I can't do it this month.");
  stack.paypal.captureSponsorHold = async () => ({ id: null, status: 'COMPLETED', amountValue: '25.00' });
  const result = await say(stack, callId, 'Yes.');
  assert.match(result.reply, /didn't answer clearly about the sponsor's payment/);
  assert.deepEqual(eventsOf(stack, callId, 'write').map((e) => e.kind), ['cover_capture']);
  assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open');
});

test('a partial or mismatched refund never marks the month fully covered', async () => {
  for (const problem of ['partial', 'amount', 'currency', 'id']) {
    const stack = buildStack();
    const callId = await verifiedCall(stack);
    await say(stack, callId, "I lost my job, I can't do it this month.");
    const read = stack.paypal.getCapture;
    const refund = stack.paypal.refundCharge;
    let afterRefund = false;
    stack.paypal.refundCharge = async (...args) => { const value = await refund(...args); afterRefund = true; return value; };
    stack.paypal.getCapture = async (id, ...args) => {
      const result = await read(id, ...args);
      if (afterRefund && !id.startsWith('MOCKCAP')) {
        if (problem === 'partial') result.data.status = 'PARTIALLY_REFUNDED';
        if (problem === 'amount') result.data.amount.value = '24.00';
        if (problem === 'currency') result.data.amount.currency_code = 'EUR';
        if (problem === 'id') result.data.id = 'WRONGTRANSACTION';
      }
      return result;
    };
    const result = await say(stack, callId, 'Yes.');
    assert.equal(eventsOf(stack, callId, 'cover_month')[0].outcome, 'open', problem);
    assert.doesNotMatch(result.reply, /^Done\./, problem);
  }
});
