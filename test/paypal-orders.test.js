import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxOrders, sandboxApprovalUrl, usdCents } from '../src/paypal-orders.js';

const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const input = { requestId: '12345678-1234-1234-1234-123456789012', payeeId: 'MERCHANT00001', amountCents: 39650, currency: 'USD',
  referenceId: 'pl-approved-quote', returnUrl: 'http://127.0.0.1:3158/procurement?returned=1', cancelUrl: 'http://127.0.0.1:3158/procurement?cancelled=1' };

test('sandbox Orders uses explicit credentials, fixed hosts, exact cents and caller request IDs', async () => {
  const requests = [];
  const client = createSandboxOrders({ clientId: 'sandbox-client', clientSecret: 'private-sandbox-secret', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return url.endsWith('/token') ? response({ access_token: 'private-token', expires_in: 300 }) : response({ id: 'ORDER00000001', status: 'CREATED' });
  } });
  await client.createOrder(input);
  await client.captureOrder({ id: 'ORDER00000001', requestId: 'capture-stable-request' });
  await client.getOrder('ORDER00000001');
  await client.getCapture('CAPTURE000001');
  assert.equal(requests[0].url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
  assert.equal(requests[0].options.headers.Authorization, `Basic ${Buffer.from('sandbox-client:private-sandbox-secret').toString('base64')}`);
  assert.equal(requests[0].options.body, 'grant_type=client_credentials');
  const order = requests[1];
  assert.equal(order.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
  assert.equal(order.options.headers['PayPal-Request-Id'], input.requestId);
  assert.equal(order.options.headers.Authorization, 'Bearer private-token');
  assert.deepEqual(JSON.parse(order.options.body).purchase_units, [{ reference_id: input.referenceId, custom_id: input.referenceId,
    amount: { currency_code: 'USD', value: '396.50' }, payee: { merchant_id: input.payeeId } }]);
  assert.equal(JSON.parse(order.options.body).intent, 'CAPTURE');
  assert.equal(requests[2].options.headers['PayPal-Request-Id'], 'capture-stable-request');
  assert.ok(requests.every(({ url, options }) => new URL(url).hostname === 'api-m.sandbox.paypal.com' && options.redirect === 'error'));
  assert.equal(requests.filter(({ url }) => url.endsWith('/token')).length, 1);
});

test('sandbox write failures are sanitized and never retried', async () => {
  const requests = [];
  const client = createSandboxOrders({ clientId: 'client', clientSecret: 'secret', fetchImpl: async (url) => {
    requests.push(url);
    if (url.endsWith('/token')) return response({ access_token: 'token', expires_in: 300 });
    return response({ private: 'credential-that-must-not-escape' }, 500);
  } });
  await assert.rejects(client.createOrder(input), (error) => error.code === 'PAYPAL_SANDBOX_REQUEST_FAILED' && error.status === 500 && !error.message.includes('credential'));
  assert.equal(requests.filter((url) => url.endsWith('/v2/checkout/orders')).length, 1);
});

test('invalid money, recipients, callbacks and missing stable IDs fail before networking', async () => {
  let called = false;
  const client = createSandboxOrders({ clientId: 'client', clientSecret: 'secret', fetchImpl: async () => { called = true; throw Error('must not call'); } });
  for (const change of [{ amountCents: 1.5 }, { amountCents: 0 }, { currency: 'EUR' }, { payeeId: 'mock-payee-vendor' },
    { requestId: '' }, { referenceId: '<script>' }, { returnUrl: 'https://user:secret@example.com/return' }, { cancelUrl: 'http://public.example.com/return' }]) {
    await assert.rejects(client.createOrder({ ...input, ...change }));
  }
  assert.throws(() => client.captureOrder({ id: 'ORDER00000001', requestId: '' }), /PAYPAL_REQUEST_ID_REQUIRED/);
  assert.throws(() => createSandboxOrders({ clientId: '', clientSecret: 'secret' }), /CREDENTIALS_REQUIRED/);
  assert.equal(called, false);
});

test('only exact sandbox approval links and strict positive decimal USD amounts are accepted', () => {
  assert.equal(sandboxApprovalUrl('https://www.sandbox.paypal.com/checkoutnow?token=ORDER00000001', 'ORDER00000001'), 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER00000001');
  for (const url of ['https://www.paypal.com/checkoutnow?token=ORDER00000001', 'https://www.sandbox.paypal.com.evil.test/checkoutnow?token=ORDER00000001',
    'http://www.sandbox.paypal.com/checkoutnow?token=ORDER00000001', 'https://user:secret@www.sandbox.paypal.com/checkoutnow?token=ORDER00000001',
    'https://www.sandbox.paypal.com/checkoutnow?token=OTHER0000001', 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER00000001&token=ORDER00000001']) {
    assert.throws(() => sandboxApprovalUrl(url, 'ORDER00000001'), /APPROVAL_URL_INVALID/);
  }
  assert.equal(usdCents('396.50'), 39650);
  assert.equal(usdCents('0.01'), 1);
  for (const value of ['00.01', '1', '1.0', '1.001', '-1.00', '0.00', 1, 'NaN', '1e2']) assert.throws(() => usdCents(value), /AMOUNT_INVALID/);
});

test('malformed or oversized provider responses do not leak bodies', async () => {
  const client = createSandboxOrders({ clientId: 'client', clientSecret: 'secret', fetchImpl: async (url) => url.endsWith('/token')
    ? response({ access_token: 'token', expires_in: 300 }) : new Response('private'.repeat(50000)) });
  await assert.rejects(client.getOrder('ORDER00000001'), (error) => error.code === 'PAYPAL_RESPONSE_INVALID' && !error.message.includes('private'));
});
