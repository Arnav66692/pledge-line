import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadiness } from '../src/readiness.js';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { tempLedgerPath } from './helpers.js';

const healthy = (extra = {}) => createReadiness({ requireDatabase: true, requireAi: true, requireSupplierLab: true, requireRecovery: true,
  databaseProbe: async () => true, aiStatus: async () => ({ stopped: false, pendingRequests: [] }),
  commerceStatus: () => ({ sandboxWritesEnabled: true, hostedSupplierLab: { running: true }, checkoutRecovery: { running: true } }), cacheMs: 0, ...extra });

test('readiness reports local dependencies and does not claim provider connectivity or live authority', async () => {
  const result = await healthy()();
  assert.equal(result.ready, true);
  assert.equal(result.providerConnectivityChecked, false);
  assert.equal(result.livePayments, false);
  assert.equal(result.capabilities.goalDrafting, true);
  assert.equal(result.capabilities.sandboxCheckout, true);
});

test('a database or supplier failure is sanitized and funding stops preserve read-only recovery capability', async () => {
  const broken = await healthy({ databaseProbe: async () => { throw Error('postgres://secret:password@private'); } })();
  assert.equal(broken.ready, false);
  assert.equal(broken.components.database, 'unavailable');
  assert.equal(broken.capabilities.sandboxCheckout, false);
  assert.doesNotMatch(JSON.stringify(broken), /password|private|postgres:/);
  const stopped = await healthy({ aiStatus: async () => ({ stopped: true, pendingRequests: [] }) })();
  assert.equal(stopped.ready, false);
  assert.equal(stopped.capabilities.goalDrafting, false);
  assert.equal(stopped.capabilities.financialRecovery, true);
  assert.equal(stopped.capabilities.donorReadback, true);
  const unavailable = await healthy({ commerceStatus: () => ({ hostedSupplierLab: { running: false }, checkoutRecovery: { running: true } }) })();
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.components.supplierLab, 'unavailable');
});

test('ordinary in-flight inference is busy rather than a dead service', async () => {
  const result = await healthy({ aiStatus: async () => ({ stopped: false, pendingRequests: [{}] }) })();
  assert.equal(result.ready, true);
  assert.equal(result.components.ai, 'busy');
  assert.equal(result.capabilities.goalDrafting, false);
  assert.equal(result.capabilities.financialRecovery, true);
});

test('missing or malformed AI status cannot advertise available drafting', async () => {
  for (const state of [{}, { pendingRequests: [] }, { stopped: false }, { stopped: false, pendingRequests: null },
    { stopped: false, pendingRequests: [], accounts: {} }, { stopped: false, pendingRequests: [], credentialsConfigured: { anthropic: true } }]) {
    const result = await healthy({ aiStatus: async () => state })();
    assert.equal(result.ready, false);
    assert.equal(result.components.ai, 'unavailable');
    assert.equal(result.capabilities.goalDrafting, false);
    assert.equal(result.capabilities.financialRecovery, true);
  }
});

test('slow checks are bounded, coalesced and do not accumulate new unresolved probes', async () => {
  let calls = 0;
  const check = healthy({ timeoutMs: 5, databaseProbe: () => { calls += 1; return new Promise(() => {}); } });
  const [a, b] = await Promise.all([check(), check()]);
  assert.equal(a.ready, false); assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.equal((await check()).ready, false); assert.equal(calls, 1);
});

test('HTTP liveness stays available, readiness is truthful and HEAD cannot start a call', async () => {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' });
  const deps = buildDeps(config, { ledgerPath: tempLedgerPath(), checkReadiness: healthy({ databaseProbe: async () => false }), log: { info() {}, error() {} } });
  let starts = 0; deps.calls.start = async () => { starts += 1; throw Error('must not start'); };
  const server = createServer(deps); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const ready = await fetch(base + '/readyz'); assert.equal(ready.status, 503); assert.equal((await ready.json()).ready, false);
    for (const path of ['/healthz', '/demo', '/app.js']) {
      const response = await fetch(base + path, { method: 'HEAD' }); assert.equal(response.status, 200); assert.equal(await response.text(), '');
    }
    const headReady = await fetch(base + '/readyz', { method: 'HEAD' }); assert.equal(headReady.status, 503); assert.equal(await headReady.text(), '');
    assert.equal((await fetch(base + '/api/calls', { method: 'HEAD' })).status, 405);
    assert.equal((await fetch(base + '/readyz', { method: 'POST' })).status, 405);
    assert.equal(starts, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
