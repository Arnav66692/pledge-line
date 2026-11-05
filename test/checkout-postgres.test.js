import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createMcpSuppliers } from '../src/supplier-mcp.js';
import { createSupplierProtocol } from '../src/supplier-protocol.js';
import { createProcurementService, validateProcurementQuote } from '../src/procurement.js';
import { createCheckoutStore } from '../src/checkout-store.js';
import { createSandboxCheckout } from '../src/sandbox-checkout.js';
import { databaseOptions, protectDatabasePool, inspectDatabaseClient } from '../src/database.js';

test('authenticated MCP and hosted runtime journal recover a sandbox workflow with simulated PayPal responses', { skip: !process.env.CHECKOUT_RUNTIME_TEST_URL }, async () => {
  const { default: pg } = await import('pg');
  const pool = protectDatabasePool(new pg.Pool(databaseOptions(process.env.CHECKOUT_RUNTIME_TEST_URL)));
  const servers = [];
  const now = () => new Date('2026-11-05T07:00:00Z');
  const organizationId = 'runtime-checkout-' + randomUUID();
  try {
    const client = await pool.connect();
    try { assert.equal((await inspectDatabaseClient(client, process.env.CHECKOUT_RUNTIME_TEST_URL)).tls, true); } finally { client.release(); }
    const definitions = [
      { id: 'campus', name: 'Controlled campus lab', payeeId: 'MERCHANT00001', capacity: 60, unitPriceCents: 650, floorUnitPriceCents: 600, setupCents: 1000, shippingCents: 800, taxBps: 500, leadDays: 2 },
      { id: 'club', name: 'Controlled club lab', payeeId: 'MERCHANT00002', capacity: 40, unitPriceCents: 675, floorUnitPriceCents: 620, setupCents: 500, shippingCents: 1200, taxBps: 500, leadDays: 3 },
    ];
    const registry = [];
    for (const definition of definitions) {
      const token = randomBytes(32).toString('base64url');
      const protocol = createSupplierProtocol({ ...definition, token, now });
      const server = http.createServer((req, res) => { protocol.handle(req, res).catch(() => { res.writeHead(503); res.end(); }); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      servers.push(server);
      registry.push({ id: definition.id, name: definition.name, payeeId: definition.payeeId, token, endpoint: 'http://127.0.0.1:' + server.address().port + '/mcp', allowedHosts: [], allowLocal: true });
    }
    const suppliers = createMcpSuppliers({ registry, now });
    // This strategy is deliberately a test double. It does not establish an Anthropic/Jev inference result.
    const agent = { planNegotiation: async ({ quotes }) => quotes.map((quote) => ({ supplierId: quote.supplierId, unitPriceCents: 500, rationale: 'volume' })), reviewProposal: async () => ({ decision: 'within_limits', advisory: true }) };
    const plan = await createProcurementService({ suppliers, now, agent }).request({ quantity: 100, budgetCents: 80000, currency: 'USD', specification: 'Identical white cotton shirts and navy screen print', deadline: '2026-11-15T07:00:00Z' });
    assert.equal(plan.status, 'awaiting_approval', JSON.stringify(plan.rejections));
    assert.equal(plan.proposal.totalCents, 67415);
    const orders = new Map(), captures = new Map(), dispatched = [];
    const paypal = {
      mode: 'paypal-sandbox',
      async createOrder(input) {
        dispatched.push({ kind: 'create', requestId: input.requestId });
        const id = 'LABORDER' + String(orders.size + 1).padStart(9, '0');
        const order = { id, intent: 'CAPTURE', status: 'CREATED', purchase_units: [{ reference_id: input.referenceId, custom_id: input.referenceId, payee: { merchant_id: input.payeeId }, amount: { currency_code: 'USD', value: (input.amountCents / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=' + id }] };
        orders.set(id, order); return structuredClone(order);
      },
      async getOrder(id) { return structuredClone(orders.get(id)); },
      async captureOrder(input) {
        dispatched.push({ kind: 'capture', requestId: input.requestId });
        const order = orders.get(input.id), id = 'LABCAPTURE' + String(captures.size + 1).padStart(7, '0');
        const capture = { id, status: 'COMPLETED', amount: structuredClone(order.purchase_units[0].amount), supplementary_data: { related_ids: { order_id: order.id } } };
        captures.set(id, capture); order.status = 'COMPLETED'; order.purchase_units[0].payments = { captures: [structuredClone(capture)] };
        if (captures.size === 1) throw Error('Synthetic lost capture response');
        return structuredClone(order);
      },
      async getCapture(id) { return structuredClone(captures.get(id)); },
    };
    const getQuote = async (allocation, rfq) => { const supplier = suppliers.find((item) => item.id === allocation.supplierId); return validateProcurementQuote(await supplier.getQuote(allocation.quoteId), supplier, rfq, now().getTime()); };
    const store = createCheckoutStore({ pool });
    await store.checkSchema();
    const factory = () => createSandboxCheckout({ store: createCheckoutStore({ pool }), paypal, getQuote, now, organizationId, checkoutOrigin: 'http://127.0.0.1:3158', allowSandboxWrites: true });
    const service = factory();
    await service.start({ id: plan.id, rfq: plan.request, proposal: plan.proposal, sessionSecretHash: createHash('sha256').update('synthetic-browser-secret').digest('hex') });
    const prepared = await service.prepare({ id: plan.id });
    assert.equal(prepared.status, 'awaiting_paypal_approval');
    assert.equal(dispatched.filter((item) => item.kind === 'create').length, 2);
    for (const order of orders.values()) order.status = 'APPROVED';
    const first = await factory().capture({ id: plan.id, legId: prepared.checkout.legs[0].id });
    assert.equal(first.checkout.legs[0].status, 'confirmed');
    const results = await Promise.all(Array.from({ length: 8 }, () => factory().capture({ id: plan.id, legId: prepared.checkout.legs[1].id })));
    assert.ok(results.some((item) => item.status === 'completed'));
    const restored = await factory().get({ id: plan.id });
    assert.equal(restored.status, 'completed');
    assert.equal(restored.checkout.blockedReason, null);
    assert.equal(dispatched.filter((item) => item.kind === 'capture').length, 2);
    assert.equal(new Set(dispatched.map((item) => item.requestId)).size, 4);
    const saved = await store.get({ organizationId, id: plan.id });
    assert.deepEqual(dispatched.map((item) => item.requestId).sort(), saved.legs.flatMap((item) => [item.createRequestId, item.captureRequestId]).sort());
    assert.ok(saved.legs.every((item) => item.createAttempts === 1 && item.captureAttempts === 1 && item.captureState === 'confirmed'));
    assert.equal(saved.proposal.confirmationToken, undefined);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await pool.end();
  }
});
