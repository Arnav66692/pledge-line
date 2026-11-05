import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureRuntimeServices, dollarsToNanos, readSupplierRegistry, sandboxWritePolicy, SANDBOX_WRITE_UNLOCK_AT } from '../src/runtime-services.js';
import { createRouter } from '../src/router.js';
import { createProcurementService } from '../src/procurement.js';
import { createMockSuppliers } from '../src/supplier-mock.js';

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
