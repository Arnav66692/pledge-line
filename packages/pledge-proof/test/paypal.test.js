import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, receipt } from '../src/index.js';
import { subscriptionRead, subscriptionWrite } from '../src/paypal.js';

const ID = 'I-GIFT0001';
const subscription = (status) => ({
  id: ID,
  status,
  plan_id: 'P-MONTHLY-25',
  billing_info: { next_billing_time: '2026-12-01T08:00:00Z', last_payment: { amount: { value: '25.00', currency_code: 'USD' } } },
});

for (const [paypalStatus, generic] of [
  ['ACTIVE', 'active'],
  ['SUSPENDED', 'suspended'],
  ['CANCELLED', 'cancelled'],
  ['EXPIRED', 'expired'],
  ['APPROVAL_PENDING', 'approval_pending'],
]) {
  test(`PayPal status ${paypalStatus} maps to the generic status ${generic}`, () => {
    const read = subscriptionRead(subscription(paypalStatus), { turn: 1, at: '2026-11-07T17:01:00Z', subscriptionId: ID });
    assert.equal(read.values.status, generic);
  });
}

test('a subscription read keeps the id, plan, amount and next billing date', () => {
  const read = subscriptionRead(subscription('ACTIVE'), { turn: 4, at: '2026-11-07T17:04:00Z', subscriptionId: ID });
  assert.deepEqual(read, {
    turn: 4,
    at: '2026-11-07T17:04:00Z',
    object: { type: 'subscription', id: ID },
    values: {
      status: 'active',
      reference: ID,
      plan_id: 'P-MONTHLY-25',
      amount: { value: '25.00', currency: 'USD' },
      date: '2026-12-01',
    },
  });
});

test('a null body, as when PayPal returned nothing, gives a read with no values', () => {
  const read = subscriptionRead(null, { turn: 2, subscriptionId: ID });
  assert.deepEqual(read.values, {});
  assert.equal(read.object.id, ID);
});

test('a 204 from suspend is an ok write', () => {
  const write = subscriptionWrite('suspend', { turn: 2, at: '2026-11-07T17:02:00Z', subscriptionId: ID, httpStatus: 204, body: null });
  assert.equal(write.ok, true);
  assert.equal(write.action, 'suspend');
  assert.equal(write.subject, ID);
  assert.equal(write.error, null);
});

test('a 422 from cancel is not ok and keeps PayPal error name and debug id', () => {
  const write = subscriptionWrite('cancel', {
    turn: 3,
    subscriptionId: ID,
    httpStatus: 422,
    body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'abc123' },
  });
  assert.equal(write.ok, false);
  assert.equal(write.error, 'UNPROCESSABLE_ENTITY');
  assert.equal(write.debugId, 'abc123');
});

test('a 500 from activate is not ok, so a read after it decides the reply', () => {
  const write = subscriptionWrite('activate', { turn: 2, subscriptionId: ID, httpStatus: 500, body: null });
  assert.equal(write.ok, false);
  assert.equal(write.error, 'UNKNOWN_ERROR');
});

test('an action outside suspend, activate and cancel is rejected', () => {
  assert.throws(() => subscriptionWrite('refund', { turn: 1, subscriptionId: ID, httpStatus: 204 }), TypeError);
});

test('the adapter output feeds verify: the amount PayPal returned backs the amount the reply says', () => {
  const reads = [subscriptionRead(subscription('ACTIVE'), { turn: 1, at: '2026-11-07T17:01:00Z', subscriptionId: ID })];
  const sentences = [{ turn: 1, text: 'Your last gift was 25 dollars.', facts: [{ kind: 'amount', value: '25.00', currency: 'USD', subject: ID }] }];
  assert.deepEqual(verify({ sentences, reads, writes: [] }), [{ turn: 1, text: 'Your last gift was 25 dollars.', verdict: 'backed' }]);
});

test('the adapter write feeds verify: a 422 suspend cannot back a paused claim', () => {
  const writes = [subscriptionWrite('suspend', { turn: 2, subscriptionId: ID, httpStatus: 422, body: { name: 'UNPROCESSABLE_ENTITY' } })];
  const sentences = [{ turn: 2, text: 'I paused it.', facts: [{ kind: 'action', value: 'suspend', subject: ID }] }];
  const [result] = receipt({ sentences, reads: [], writes });
  assert.equal(result.verdict, 'unbacked');
});
