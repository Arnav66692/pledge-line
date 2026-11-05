import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { tempLedgerPath } from './helpers.js';
import { databaseOptions, verifyDatabaseSettings, protectDatabasePool } from '../src/database.js';
import { createProcurementHttp } from '../src/procurement-http.js';

test('closing an expired unpaid checkout requires its original session and never invokes financial methods', async () => {
  const id = randomUUID(), secret = 'synthetic-private-session-key', calls = [];
  const closed = { id, status: 'closed_unpaid', checkout: { blockedReason: 'closed_unpaid' } };
  const route = createProcurementHttp({
    createService() { throw Error('No replacement service may be created'); }, limiter: { allow: () => true },
    readJson: async () => ({}), send(res, status, body) { Object.assign(res, { status, body }); },
    checkoutStore: { get: async () => ({ sessionSecretHash: createHash('sha256').update(secret).digest('hex') }) },
    checkout: { closeUnpaid: async (input) => { calls.push(input); return closed; },
      prepare() { throw Error('Unexpected order creation'); }, capture() { throw Error('Unexpected capture'); },
      reconcile() { throw Error('Closure must use its bounded verification path'); } },
  });
  const request = async (method, key) => {
    const response = {};
    await route({ method, headers: { 'x-procurement-secret': key } }, response, `/api/procurement/${id}/close-unpaid`, 'test');
    return response;
  };
  assert.equal((await request('POST', 'wrong-session')).status, 401);
  assert.equal((await request('GET', secret)).status, 405);
  assert.equal(calls.length, 0);
  const response = await request('POST', secret);
  assert.equal(response.status, 200);
  assert.equal(response.body.state.status, 'closed_unpaid');
  assert.deepEqual(calls, [{ id }]);
  assert.equal(JSON.stringify(response.body).includes(secret), false);
});

test('supply desk binds HTTP approval to its session and exact terms', async () => {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' });
  const deps = buildDeps(config, { ledgerPath: tempLedgerPath(), log: { info() {}, error() {} } });
  const server = createServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { secret, body, method = body ? 'POST' : 'GET' } = {}) => fetch(base + path, {
    method, headers: { ...(secret ? { 'x-procurement-secret': secret } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const created = await request('/api/procurement', { body: { quantity: 100, budgetCents: 80000, currency: 'USD',
      specification: 'White cotton shirts with the same one-color club logo', deadline: new Date(Date.now() + 7 * 86400000).toISOString() } });
    assert.equal(created.status, 201);
    const { id, sessionSecret, state } = await created.json();
    assert.equal(state.status, 'awaiting_approval');
    assert.equal(state.proposal.allocations.length, 2);
    assert.equal((await request(`/api/procurement/${id}`)).status, 401);
    assert.equal((await request(`/api/procurement/${id}`, { secret: 'other-session' })).status, 401);
    const own = await (await request(`/api/procurement/${id}`, { secret: sessionSecret })).json();
    assert.ok(!JSON.stringify(own).includes(sessionSecret));
    const wrong = await request(`/api/procurement/${id}/approve`, { secret: sessionSecret,
      body: { confirmationToken: state.proposal.confirmationToken, termsHash: 'changed' } });
    assert.equal(wrong.status, 409);
    const approval = { confirmationToken: state.proposal.confirmationToken, termsHash: state.proposal.termsHash };
    const paid = await (await request(`/api/procurement/${id}/approve`, { secret: sessionSecret, body: approval })).json();
    assert.equal(paid.state.status, 'completed');
    assert.equal(paid.state.settlements.length, 2);
    const repeated = await (await request(`/api/procurement/${id}/approve`, { secret: sessionSecret, body: approval })).json();
    assert.deepEqual(repeated.state.settlements, paid.state.settlements);
    assert.equal((await request(`/api/procurement/${id}/reconcile`, { secret: 'other-session', body: {} })).status, 401);
    const page = await (await request('/procurement')).text();
    assert.match(page, /simulated/i);
    assert.match(page, /procurement\.js/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('hosted database configuration always verifies TLS and bounds connections', () => {
  const options = databaseOptions('postgresql://test:synthetic@db.example.test/pledge?sslmode=disable');
  assert.equal(new URL(options.connectionString).searchParams.get('sslmode'), 'verify-full');
  assert.equal(options.max, 5);
  assert.ok(options.connectionTimeoutMillis > 0);
  assert.throws(() => databaseOptions('https://db.example.test/pledge'));
  assert.throws(() => databaseOptions('postgresql://test:synthetic@sample.neon.tech/pledge?host=other.example'));
});

test('provider quorum durability never bypasses verified transport or synchronous commits', () => {
  const neon = 'postgresql://test:synthetic@sample.neon.tech/pledge';
  const row = { fsync: 'off', synchronous_commit: 'on', tls: false };
  const transport = { encrypted: true, authorized: true };
  assert.equal(verifyDatabaseSettings(neon, row, transport).durabilityModel, 'neon-wal-quorum');
  assert.throws(() => verifyDatabaseSettings(neon, row, { encrypted: true, authorized: false }), /TLS_REQUIRED/);
  assert.throws(() => verifyDatabaseSettings(neon, { ...row, synchronous_commit: 'off' }, transport), /DURABILITY_REQUIRED/);
  assert.throws(() => verifyDatabaseSettings('postgresql://test:synthetic@other.example/pledge', row, transport), /DURABILITY_REQUIRED/);
});

test('idle database errors are handled without terminating the server or exposing raw connection data', () => {
  const messages = [];
  const pool = protectDatabasePool(new EventEmitter(), (message) => messages.push(message));
  assert.doesNotThrow(() => pool.emit('error', new Error('synthetic private connection detail')));
  assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes('private connection'));
});
