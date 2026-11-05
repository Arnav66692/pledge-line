import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcurementHttp } from '../src/procurement-http.js';

const id = 'f2cb7591-bbd0-48d8-84f5-67acb8754f88';
const plan = { id, mode: { suppliers: 'mcp', payments: 'paypal-sandbox' }, status: 'awaiting_approval',
  request: { quantity: 1, budgetCents: 100 }, quotes: [{ quoteId: 'quote1' }], timeline: [],
  comparison: { savingsCents: 10 }, proposal: { termsHash: 'a'.repeat(64), confirmationToken: 'b'.repeat(64), expiresAt: '2030-01-01T00:00:00Z', allocations: [] } };

function fixture() {
  let durable = null, writes = false;
  const calls = [];
  const checkoutStore = { get: async ({ id: target }) => durable?.id === target ? structuredClone(durable) : null };
  const publicState = () => ({ id, request: plan.request, proposal: durable.proposal, mode: plan.mode, status: 'awaiting_checkout', checkout: { legs: [] } });
  const checkout = {
    async start(input) { calls.push(['start', input]); durable = structuredClone(input); delete durable.proposal.confirmationToken; return publicState(); },
    async get() { return publicState(); },
    async prepare(input) { calls.push(['prepare', input]); return publicState(); },
    async capture(input) { calls.push(['capture', input]); return publicState(); },
    async reconcile(input) { calls.push(['reconcile', input]); return publicState(); },
  };
  const options = { createService: async () => ({ request: async () => structuredClone(plan), get: async () => structuredClone(plan) }),
    send: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => req.body ?? {},
    limiter: { allow: () => true }, checkout, checkoutStore, commerceStatus: () => ({ sandboxWritesEnabled: writes, payments: 'paypal-sandbox' }) };
  let route = createProcurementHttp(options);
  return { calls, setWrites(value) { writes = value; }, restart() { route = createProcurementHttp(options); },
    async request(path, { method = 'GET', secret, body } = {}) {
      const response = {};
      await route({ method, headers: secret ? { 'x-procurement-secret': secret } : {}, body }, response, path, '127.0.0.1');
      return response;
    },
  };
}

test('network approval binds exact terms and persists session authority before any checkout write', async () => {
  const f = fixture();
  const created = await f.request('/api/procurement', { method: 'POST', body: {} });
  const secret = created.body.sessionSecret;
  assert.equal(created.body.commerce.payments, 'paypal-sandbox');
  const bad = await f.request('/api/procurement/' + id + '/approve', { method: 'POST', secret, body: { confirmationToken: 'wrong', termsHash: plan.proposal.termsHash } });
  assert.equal(bad.status, 409);
  assert.equal(f.calls.length, 0);
  const approved = await f.request('/api/procurement/' + id + '/approve', { method: 'POST', secret, body: plan.proposal });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.state.status, 'awaiting_checkout');
  assert.equal(approved.body.state.quotes[0].quoteId, 'quote1');
  assert.equal(approved.body.state.comparison.savingsCents, 10);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'start');
  assert.match(f.calls[0][1].sessionSecretHash, /^[0-9a-f]{64}$/);
  assert.notEqual(f.calls[0][1].sessionSecretHash, secret);
});

test('durable capability restores after HTTP-process replacement and another session cannot capture', async () => {
  const f = fixture();
  const secret = (await f.request('/api/procurement', { method: 'POST' })).body.sessionSecret;
  await f.request('/api/procurement/' + id + '/approve', { method: 'POST', secret, body: plan.proposal });
  f.restart();
  const restored = await f.request('/api/procurement/' + id, { secret });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.state.proposal.confirmationToken, undefined);
  const other = await f.request('/api/procurement/' + id + '/capture', { method: 'POST', secret: 'another-session', body: { legId: 'leg1' } });
  assert.equal(other.status, 401);
  assert.equal(f.calls.filter((item) => item[0] === 'capture').length, 0);
});

test('writes-disabled refuses capture, duplicate approval is read-only, explicit reconcile never prepares', async () => {
  const f = fixture();
  const secret = (await f.request('/api/procurement', { method: 'POST' })).body.sessionSecret;
  await f.request('/api/procurement/' + id + '/approve', { method: 'POST', secret, body: plan.proposal });
  f.setWrites(true);
  await f.request('/api/procurement/' + id + '/approve', { method: 'POST', secret, body: plan.proposal });
  assert.equal(f.calls.length, 1);
  await f.request('/api/procurement/' + id + '/reconcile', { method: 'POST', secret });
  assert.deepEqual(f.calls.map((item) => item[0]), ['start', 'reconcile']);
  f.setWrites(false);
  assert.equal((await f.request('/api/procurement/' + id + '/capture', { method: 'POST', secret, body: { legId: 'leg1' } })).status, 409);
  f.setWrites(true);
  await f.request('/api/procurement/' + id + '/prepare', { method: 'POST', secret });
  await f.request('/api/procurement/' + id + '/capture', { method: 'POST', secret, body: { legId: 'leg1' } });
  assert.deepEqual(f.calls.map((item) => item[0]), ['start', 'reconcile', 'prepare', 'capture']);
});
