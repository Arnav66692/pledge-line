import test from 'node:test';
import assert from 'node:assert/strict';
import { configureRuntimeServices } from '../src/runtime-services.js';
import { CHECKOUT_SCHEMA_CHECKSUM } from '../src/checkout-store.js';

const config = { port: 3159, router: { mode: 'rules' }, paypal: { clientId: 'client', clientSecret: 'secret' }, publicBaseUrl: 'http://127.0.0.1:3159' };
const env = { PROCUREMENT_SUPPLIER_MODE: 'mcp-sandbox', HOSTED_SUPPLIER_LAB_ENABLED: 'true', SUPPLIER_LAB_PAYEE_ID: 'MERCHANT00001', SUPPLIER_REGISTRY_PATH: '/must-not-read-a-registry' };
const database = () => ({ pool: { async connect() { return { release() {}, async query(sql) {
  if (String(sql).includes('SELECT version,checksum')) return { rows: [{ version: 1, checksum: CHECKOUT_SCHEMA_CHECKSUM }] };
  return { rows: [] };
} }; } } });
const lab = (onClose = () => {}) => ({
  registry: [0, 1, 2].map((i) => ({ id: `lab-${i}`, name: `Controlled lab ${i}`, payeeId: 'MERCHANT00001', endpoint: `http://127.0.0.1:${3160 + i}/mcp`, token: `synthetic-private-token-number-${i}`, allowedHosts: [], allowLocal: true })),
  async close() { onClose(); },
  status: () => ({ running: true, controlledSandbox: true, supplierCount: 3, provenance: 'Controlled sandbox supplier lab. No independent businesses.' }),
});

test('hosted supplier runtime uses private generated registry and closes it exactly once', async () => {
  const db = database(); let starts = 0, closes = 0;
  const runtime = await configureRuntimeServices({ config, database: db, env, startSupplierLab: async (options) => {
    assert.equal(options.pool, db.pool); assert.equal(options.payeeId, 'MERCHANT00001'); starts += 1; return lab(() => { closes += 1; });
  } });
  assert.equal(starts, 1); assert.equal(runtime.suppliers.length, 3);
  const status = runtime.commerceStatus();
  assert.equal(status.hostedSupplierLab.controlledSandbox, true);
  assert.match(status.supplierProvenance, /Controlled sandbox supplier lab/);
  assert.equal(JSON.stringify(status).includes('synthetic-private-token'), false);
  assert.equal(status.livePayments, false);
  const first = runtime.close(), second = runtime.close();
  assert.equal(first, second); await first; assert.equal(closes, 1);
});

test('hosted lab requires explicit network mode, storage and a distinct public port before starting', async () => {
  let starts = 0;
  const startSupplierLab = async () => { starts += 1; return lab(); };
  await assert.rejects(configureRuntimeServices({ config, env: { ...env, PROCUREMENT_SUPPLIER_MODE: 'mock' }, startSupplierLab }), /HOSTED_SUPPLIER_LAB_MODE_REQUIRED/);
  await assert.rejects(configureRuntimeServices({ config, env, startSupplierLab }), /CHECKOUT_DATABASE_REQUIRED/);
  await assert.rejects(configureRuntimeServices({ config: { ...config, port: 3160 }, database: database(), env, startSupplierLab }), /HOSTED_SUPPLIER_LAB_PORT_CONFLICT/);
  assert.equal(starts, 0);
});

test('later runtime initialization failure drains the private supplier lab', async () => {
  let closes = 0;
  await assert.rejects(configureRuntimeServices({ config: { ...config, paypal: {} }, database: database(), env,
    startSupplierLab: async () => lab(() => { closes += 1; }) }), /PAYPAL_SANDBOX_CREDENTIALS_REQUIRED/);
  assert.equal(closes, 1);
});

test('hosted lab is inert in ordinary mock runtime without its exact switch', async () => {
  for (const enabled of [undefined, 'false', 'TRUE', '1']) {
    const runtime = await configureRuntimeServices({ config, env: { HOSTED_SUPPLIER_LAB_ENABLED: enabled },
      startSupplierLab: () => { throw Error('must not start'); } });
    assert.equal(runtime.commerceStatus().hostedSupplierLab, null);
    await runtime.close();
  }
});
