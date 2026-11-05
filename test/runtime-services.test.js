import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureRuntimeServices, dollarsToNanos, readSupplierRegistry, sandboxWritePolicy, SANDBOX_WRITE_UNLOCK_AT } from '../src/runtime-services.js';
import { createRouter } from '../src/router.js';
import { createProcurementService } from '../src/procurement.js';
import { createMockSuppliers } from '../src/supplier-mock.js';
import { CHECKOUT_SCHEMA_CHECKSUM } from '../src/checkout-store.js';

test('legacy unguarded Anthropic construction is disabled and subscription credentials cannot be a fallback', () => {
  assert.throws(() => createRouter({ mode: 'haiku', apiKey: 'synthetic-key' }), /GUARDED_AI_GATEWAY_REQUIRED/);
});

test('placeholder lab merchants cannot enable payment writes even after the time gate with a true switch', () => {
  const after = new Date('2026-11-05T06:00:00Z');
  assert.deepEqual(sandboxWritePolicy({ LAB_MERCHANT_MODE: 'placeholder', PAYPAL_SANDBOX_CHECKOUT_WRITES: 'true' }, after), { enabled: false, blockedReason: 'placeholder_merchants' });
  assert.deepEqual(sandboxWritePolicy({ PAYPAL_SANDBOX_CHECKOUT_WRITES: 'true' }, '2026-11-05T04:00:00Z'), { enabled: false, blockedReason: 'time_gate' });
  assert.equal(sandboxWritePolicy({ PAYPAL_SANDBOX_CHECKOUT_WRITES: 'true' }, 'invalid date').enabled, false);
  assert.deepEqual(sandboxWritePolicy({ PAYPAL_SANDBOX_CHECKOUT_WRITES: 'false' }, after), { enabled: false, blockedReason: 'operator_disabled' });
  assert.deepEqual(sandboxWritePolicy({ LAB_MERCHANT_MODE: 'configured', PAYPAL_SANDBOX_CHECKOUT_WRITES: 'true' }, after), { enabled: true, blockedReason: null });
});

test('paid runtime requires durable storage and operator prepaid confirmation before schema or API access', async () => {
  const config = { router: { mode: 'anthropic' } };
  await assert.rejects(configureRuntimeServices({ config, env: {} }), /AI_DATABASE_REQUIRED/);
  await assert.rejects(configureRuntimeServices({ config, database: { pool: { connect() { throw Error('must not query'); } } }, env: {} }), /AI_PREPAID_CONFIRMATION_REQUIRED/);
  await assert.rejects(configureRuntimeServices({ config: { router: { mode: 'haiku' } }, env: {} }), /USE_GUARDED_ANTHROPIC_MODE/);
  const offline = await configureRuntimeServices({ config: { router: { mode: 'rules' } }, env: {} });
  assert.equal(offline.agent, null);
  assert.equal(offline.commerceStatus().livePayments, false);
  assert.equal(SANDBOX_WRITE_UNLOCK_AT, '2026-11-05T05:00:00.000Z');
});

test('dollar allocation parsing uses exact bounded nanodollars and cannot silently round or raise ceilings', () => {
  assert.equal(dollarsToNanos('0.000000042', 5, 200000000000), 42);
  assert.equal(dollarsToNanos('200', 5, 200000000000), 200000000000);
  assert.equal(dollarsToNanos('0', 5, 200000000000), 0);
  for (const raw of ['200.000000001', '-1', '1e2', '1.0000000001', 'NaN', ' 5 ']) assert.throws(() => dollarsToNanos(raw, 5, 200000000000), /AI_ALLOCATION_INVALID/);
});

test('supplier registry resolves only dedicated operator MCP token names and does not expose private values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-registry-'));
  const file = path.join(directory, 'registry.json');
  const entry = { id: 'lab', name: 'Controlled lab', payeeId: 'SANDBOXMERCHANT', endpoint: 'https://supplier.example/mcp', tokenEnv: 'MCP_SUPPLIER_TOKEN', allowedHosts: ['supplier.example'] };
  fs.writeFileSync(file, JSON.stringify([entry]));
  const result = readSupplierRegistry(file, { MCP_SUPPLIER_TOKEN: 'synthetic-private-token-at-least-24-chars' });
  assert.equal(result[0].tokenEnv, undefined);
  assert.equal(result[0].token, 'synthetic-private-token-at-least-24-chars');
  for (const changed of [{ ...entry, tokenEnv: 'ANTHROPIC_API_KEY' }, { ...entry, token: 'inline-key' }]) {
    fs.writeFileSync(file, JSON.stringify([changed]));
    assert.throws(() => readSupplierRegistry(file, {}), (error) => error.message === 'SUPPLIER_REGISTRY_INVALID');
  }
  fs.rmSync(directory, { recursive: true });
});

test('network quote planning uses bounded Anthropic offers and an advisory review without sending approval tokens', async () => {
  const now = () => new Date('2026-11-05T07:00:00Z');
  const seen = [];
  const suppliers = createMockSuppliers({ now }).map((supplier) => ({ ...supplier, mode: 'mcp-sandbox',
    async negotiate(input) { if (input.counterOffer) assert.deepEqual(Object.keys(input.counterOffer), ['unitPriceCents']); return supplier.negotiate(input); } }));
  const service = createProcurementService({ suppliers, now, agent: {
    async planNegotiation({ quotes }) { seen.push('main'); return quotes.map((quote) => ({ supplierId: quote.supplierId, unitPriceCents: quote.unitPriceCents - 1, rationale: 'budget' })); },
    async reviewProposal({ proposal }) { assert.equal('confirmationToken' in proposal, false); seen.push('review'); return { decision: 'within_limits', advisory: true }; },
  } });
  const state = await service.request({ quantity: 100, budgetCents: 80000, currency: 'USD', specification: 'White cotton shirts, identical navy print.', deadline: '2026-11-15T07:00:00Z' });
  assert.deepEqual(seen, ['main', 'review']);
  assert.equal(state.mode.payments, 'paypal-sandbox');
  assert.equal(state.comparison.baselineTotalCents - state.proposal.totalCents, state.comparison.savingsCents);
  await assert.rejects(service.approve(state.id, state.proposal), /durable PayPal sandbox checkout/);
});

test('runtime recovery is explicitly enabled, startup-inert and limited to existing provider reads', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-recovery-runtime-'));
  const registry = path.join(directory, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify([{ id: 'lab', name: 'Controlled lab', payeeId: 'MERCHANT00001', endpoint: 'https://supplier.example/mcp', tokenEnv: 'MCP_SUPPLIER_TOKEN', allowedHosts: ['supplier.example'] }]));
  const env = { PROCUREMENT_SUPPLIER_MODE: 'mcp-sandbox', SUPPLIER_REGISTRY_PATH: registry, MCP_SUPPLIER_TOKEN: 'synthetic-token-at-least-24-characters' };
  const config = { router: { mode: 'rules' }, paypal: { clientId: 'client', clientSecret: 'secret' }, publicBaseUrl: 'http://127.0.0.1:3158' };
  const workflowId = '00000000-0000-0000-0000-000000000001', legId = '00000000-0000-0000-0000-000000000002';
  const allocation = { supplierId: 'lab', payeeId: 'MERCHANT00001', totalCents: 100, currency: 'USD', quantity: 1 };
  const referenceId = `pl-${'a'.repeat(64)}-${legId}`;
  const row = { id: workflowId, organization_id: 'demo-organization', binding: { request: {}, proposal: { expiresAt: '2026-11-04T01:00:00Z', allocations: [allocation] } },
    session_secret_hash: 'private-session-marker', blocked_reason: null, created_at: new Date(), updated_at: new Date(),
    legs: [{ id: legId, allocation, referenceId, createState: 'ready', createAttempts: 1, orderId: 'ORDER00000001', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER00000001',
      captureState: 'unknown', captureAttempts: 1, captureId: null, captureEvidence: { unknown: true } }] };
  const queries = [], requests = []; let releases = 0, hang = false, bodyOpened;
  const opened = new Promise((resolve) => { bodyOpened = resolve; });
  const database = { pool: { async connect() {
    return { on() {}, off() {}, release() { releases += 1; }, async query(input, values) {
      const sql = typeof input === 'string' ? input : input.text, parameters = typeof input === 'string' ? values : input.values;
      queries.push({ sql, parameters });
      if (sql.includes('SELECT version,checksum')) return { rows: [{ version: 1, checksum: CHECKOUT_SCHEMA_CHECKSUM }] };
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
      if (sql.startsWith('SELECT id FROM')) return { rows: [{ id: workflowId }] };
      if (sql.startsWith('UPDATE pledge_checkout_workflows')) { row.legs = JSON.parse(parameters[2]); row.blocked_reason = parameters[3]; }
      return { rows: sql.startsWith('SELECT *') || sql.startsWith('UPDATE') ? [structuredClone(row)] : [] };
    } };
  } } };
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(new URL(url).hostname, 'api-m.sandbox.paypal.com', 'Recovery never calls a supplier.');
    if (url.endsWith('/token')) return json({ access_token: 'token', expires_in: 300 });
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    if (hang) return new Response(new ReadableStream({ start() { bodyOpened(); } }));
    const capture = { id: 'CAPTURE000001', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' }, supplementary_data: { related_ids: { order_id: 'ORDER00000001' } } };
    if (url.includes('/payments/captures/')) return json(capture);
    return json({ id: 'ORDER00000001', intent: 'CAPTURE', status: 'COMPLETED', purchase_units: [{ reference_id: referenceId, custom_id: referenceId,
      payee: { merchant_id: 'MERCHANT00001' }, amount: capture.amount, payments: { captures: [capture] } }] });
  };
  try {
    const mock = await configureRuntimeServices({ config, env: { CHECKOUT_RECOVERY_ENABLED: 'true' }, fetchImpl });
    assert.equal(mock.checkoutRecovery, null);
    for (const enabled of [undefined, 'false', 'TRUE', '1']) {
      const offline = await configureRuntimeServices({ config, database, env: { ...env, CHECKOUT_RECOVERY_ENABLED: enabled }, fetchImpl });
      assert.equal(offline.checkoutRecovery, null); assert.equal(offline.commerceStatus().checkoutRecovery.enabled, false);
    }
    const runtime = await configureRuntimeServices({ config, database, env: { ...env, CHECKOUT_RECOVERY_ENABLED: 'true' }, fetchImpl });
    assert.equal(requests.length, 0); assert.equal(runtime.checkoutRecovery.status().running, false);
    assert.equal((await runtime.checkoutRecovery.sweepOnce()).reconciled, 1);
    assert.equal(row.legs[0].captureState, 'confirmed'); assert.equal(row.legs[0].captureId, 'CAPTURE000001');
    assert.equal(requests.filter(({ options }) => options.method === 'POST').length, 1, 'Only OAuth uses POST.');
    assert.ok(queries.filter(({ sql }) => sql.startsWith('SELECT id FROM')).every(({ parameters }) => parameters[0] === 'demo-organization'));
    const status = JSON.stringify(runtime.commerceStatus());
    assert.equal(status.includes(workflowId), false); assert.equal(status.includes('private-session'), false);
    await assert.rejects(runtime.checkout.prepare({ id: workflowId }), /SANDBOX_WRITES_DISABLED/);
    row.legs[0].captureState = 'unknown'; row.legs[0].captureId = null; hang = true;
    const active = runtime.checkoutRecovery.sweepOnce(); await opened;
    const releasedBeforeStop = releases, stopping = runtime.checkoutRecovery.stop();
    await stopping; assert.equal((await active).aborted, true); assert.ok(releases > releasedBeforeStop, 'Aborted work drains before lease release.');
    const requestCount = requests.length; await runtime.checkoutRecovery.sweepOnce(); assert.equal(requests.length, requestCount);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
