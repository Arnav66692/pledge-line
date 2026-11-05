import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer, createWebhookHandler } from '../src/server.js';
import { configureRuntimeServices } from '../src/runtime-services.js';
import { tempLedgerPath } from './helpers.js';

const quiet = { info() {}, error() {} };

test('HTTP routes await asynchronous call creation, authentication, reads and gap persistence', async () => {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', PILOT_PIN: '482613' });
  const deps = buildDeps(config, { ledgerPath: tempLedgerPath(), log: quiet });
  const original = deps.calls;
  let authenticationBegan;
  deps.calls = { ...original,
    start: async (input) => original.start(input),
    authenticate: async (...args) => {
      authenticationBegan = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return original.authenticate(...args);
    },
    get: async (id) => original.get(id),
    logGap: async () => ({ persisted: true }),
    turn: async (_id, _input, arrival) => ({ arrivedBeforeAuthenticationWait: arrival.receivedAt <= authenticationBegan }),
  };
  const server = createServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/calls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const started = await response.json();
    assert.match(started.callId, /^[0-9a-f-]{36}$/);
    const route = `${base}/api/calls/${started.callId}`;
    assert.equal((await fetch(route, { headers: { 'x-call-secret': 'wrong' } })).status, 401);
    const headers = { 'x-call-secret': started.sessionSecret, 'content-type': 'application/json' };
    const fetched = await fetch(route, { headers });
    assert.equal(fetched.status, 200);
    assert.ok(Object.keys(await fetched.json()).length > 0);
    const gap = await fetch(`${route}/gap`, { method: 'POST', headers,
      body: JSON.stringify({ turn: 0, gapMs: 50, source: 'typed', muted: true }) });
    assert.deepEqual(await gap.json(), { persisted: true });
    const earlyYes = await fetch(`${route}/turn`, { method: 'POST', headers,
      body: JSON.stringify({ text: 'yes', source: 'typed', answering: 1 }) });
    assert.deepEqual(await earlyYes.json(), { arrivedBeforeAuthenticationWait: true });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('verified webhook cannot be acknowledged before the durable ledger barrier', async () => {
  let release, entered;
  const barrier = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  let records = [], reloads = 0, reserved = 0, settled = false;
  const ledger = { byType: () => records, reload: async () => { reloads += 1; },
    ensureCapacity: async () => { reserved += 1; }, append: (event) => { records.push(event); },
    flush: async () => { entered(); await barrier; } };
  const handler = createWebhookHandler({ ledger, log: quiet, webhookId: 'WH-SYNTHETIC',
    paypal: { verifyWebhookSignature: async () => ({ verified: true, verifyStatus: 'SUCCESS' }) } });
  const result = handler.handle({ rawBody: Buffer.from(JSON.stringify({ id: 'EV-SYNTHETIC', event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'INV2-SYNTHETIC' } })), headers: {} });
  result.then(() => { settled = true; });
  await waiting;
  assert.equal(settled, false);
  assert.equal(reloads, 1); assert.equal(reserved, 1);
  release();
  assert.deepEqual(await result, { verified: true, verifyStatus: 'SUCCESS' });
});

test('durable donor startup requires PostgreSQL and never silently selects a local ledger', async () => {
  const config = { port: 3159, router: { mode: 'rules' }, paypal: {}, publicBaseUrl: 'http://127.0.0.1:3159' };
  await assert.rejects(configureRuntimeServices({ config, env: { DONOR_DURABILITY_ENABLED: 'true' } }), /DONOR_DATABASE_REQUIRED/);
});
