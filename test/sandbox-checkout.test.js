import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createSandboxCheckout } from '../src/sandbox-checkout.js';
import { canCloseUnpaidCheckout } from '../src/checkout-store.js';

const copy = (value) => structuredClone(value);
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const merchant = ['MERCHANT00001', 'MERCHANT00002'];

// A service test double. Actual SQL commit/rollback and hosted constraints are tested separately.
function memoryStore() {
  const rows = new Map();
  const store = {
    rows,
    async reserve({ organizationId, id, rfq, proposal, sessionSecretHash }) {
      const existing = rows.get(id);
      if (existing) {
        assert.deepEqual(existing.request, rfq); assert.deepEqual(existing.proposal, proposal); assert.equal(existing.sessionSecretHash, sessionSecretHash);
        return copy(existing);
      }
      const row = { id, organizationId, request: copy(rfq), proposal: copy(proposal), sessionSecretHash, blockedReason: null,
        legs: proposal.allocations.map((allocation) => {
          const legId = randomUUID();
          return { id: legId, allocation: copy(allocation), referenceId: `pl-${proposal.termsHash}-${legId}`,
            createRequestId: randomUUID(), captureRequestId: randomUUID(), createState: 'reserved', captureState: 'reserved',
            createAttempts: 0, captureAttempts: 0, orderId: null, approvalUrl: null, captureId: null };
        }) };
      rows.set(id, row); return copy(row);
    },
    async get({ organizationId, id }) { const row = rows.get(id); return row?.organizationId === organizationId ? copy(row) : null; },
    async block({ id, reason }) { const row = rows.get(id); row.blockedReason ??= reason; return copy(row); },
    async closeExpiredUnpaid({ id, at, orderChecks }) {
      const row = rows.get(id);
      if (row.blockedReason === 'closed_unpaid') return copy(row);
      if (!canCloseUnpaidCheckout(row, at)) throw Object.assign(new Error('CHECKOUT_CLOSE_UNPAID_BLOCKED'), { code: 'CHECKOUT_CLOSE_UNPAID_BLOCKED' });
      row.blockedReason = 'closed_unpaid';
      for (const leg of row.legs) leg.closedUnpaidEvidence = { ...copy(orderChecks.find((check) => check.legId === leg.id)), closedAt: new Date(at).toISOString() };
      return copy(row);
    },
    async claimCreate({ id, legId }) {
      const row = rows.get(id), leg = row.legs.find((item) => item.id === legId), position = row.legs.indexOf(leg);
      if (row.blockedReason || leg.createState !== 'reserved' || row.legs.some((item) => ['claimed', 'unknown'].includes(item.createState) || ['claimed', 'unknown'].includes(item.captureState)) ||
        row.legs.slice(0, position).some((item) => item.createState !== 'ready')) return { claimed: false };
      leg.createState = 'claimed'; leg.createAttempts = 1;
      return { claimed: true, requestId: leg.createRequestId, leg: copy(leg), workflow: copy(row) };
    },
    async markCreateUnknown({ id, legId }) {
      const row = rows.get(id), leg = row.legs.find((item) => item.id === legId);
      if (leg.createState === 'claimed') leg.createState = 'unknown';
      return copy(row);
    },
    async recordOrder({ id, legId, orderId, approvalUrl, orderStatus, proof, state = 'ready' }) {
      const row = rows.get(id), leg = row.legs.find((item) => item.id === legId);
      if (leg.orderId && leg.orderId !== orderId) throw Error('immutable order');
      Object.assign(leg, { createState: state, orderId, approvalUrl, orderStatus, createEvidence: proof }); return copy(row);
    },
    async claimCapture({ id, legId }) {
      const row = rows.get(id), leg = row.legs.find((item) => item.id === legId), position = row.legs.indexOf(leg);
      if (row.blockedReason || leg.captureState !== 'reserved' || row.legs.some((item) => item.createState !== 'ready' || ['claimed', 'unknown'].includes(item.captureState)) ||
        row.legs.slice(0, position).some((item) => item.captureState !== 'confirmed')) return { claimed: false };
      leg.captureState = 'claimed'; leg.captureAttempts = 1;
      return { claimed: true, requestId: leg.captureRequestId, leg: copy(leg), workflow: copy(row) };
    },
    async recordCapture({ id, legId, state, captureId = null, proof }) {
      const row = rows.get(id), leg = row.legs.find((item) => item.id === legId);
      assert.ok(['claimed', 'unknown', 'confirmed'].includes(leg.captureState));
      if (leg.captureState === 'confirmed') { assert.equal(captureId, leg.captureId); assert.deepEqual(proof, leg.captureEvidence); }
      Object.assign(leg, { captureState: state, captureId: captureId ?? leg.captureId, captureEvidence: proof }); return copy(row);
    },
  };
  return store;
}

async function fixture({ allowSandboxWrites = true } = {}) {
  let clock = Date.parse('2026-11-05T02:00:00Z');
  const now = () => new Date(clock), expiresAt = new Date(clock + 15 * 60 * 1000).toISOString();
  const deadline = new Date(clock + 7 * 86400000).toISOString();
  const rfq = { specification: 'White cotton shirts with one navy print and identical artwork', quantity: 100, budgetCents: 80000, currency: 'USD', deadline };
  const allocations = [
    { supplierId: 'campus', supplierName: 'Campus test supplier', payeeId: merchant[0], quoteId: 'quote-campus', quantity: 60, unitPriceCents: 600,
      goodsCents: 36000, setupCents: 1000, shippingCents: 800, taxCents: 1850, totalCents: 39650, currency: 'USD', expiresAt, deliveryAt: new Date(clock + 2 * 86400000).toISOString() },
    { supplierId: 'club', supplierName: 'Club test supplier', payeeId: merchant[1], quoteId: 'quote-club', quantity: 40, unitPriceCents: 620,
      goodsCents: 24800, setupCents: 500, shippingCents: 1200, taxCents: 1265, totalCents: 27765, currency: 'USD', expiresAt, deliveryAt: new Date(clock + 3 * 86400000).toISOString() },
  ];
  const terms = { request: rfq, allocations, totalCents: 67415, expiresAt, disclosure: 'Sandbox supplier payments are separate. No automatic refunds or replacement purchases.' };
  const proposal = { ...terms, request: undefined, termsHash: hash(terms), quantity: 100, currency: 'USD', confirmationToken: 'private-confirmation-token-not-persisted' };
  delete proposal.request;
  const quotes = allocations.map((allocation) => ({ ...allocation, minQuantity: 1, maxQuantity: allocation.quantity, taxBps: 500, specificationHash: hash(rfq.specification) }));
  const store = memoryStore(), orders = new Map(), captures = new Map(), calls = [];
  let lostCreate = false, lostCapture = false, unreadableAfterCapture = false, pendingCapture = false;
  const paypal = {
    mode: 'paypal-sandbox',
    async createOrder(input) {
      calls.push({ method: 'create', ...input });
      const id = `ORDER${String(orders.size + 1).padStart(10, '0')}`;
      const amount = { value: (input.amountCents / 100).toFixed(2), currency_code: input.currency };
      const order = { id, status: 'CREATED', intent: 'CAPTURE', purchase_units: [{ reference_id: input.referenceId, custom_id: input.referenceId,
        payee: { merchant_id: input.payeeId }, amount }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
      orders.set(id, order);
      if (lostCreate) throw Error('lost create answer');
      return copy(order);
    },
    async getOrder(id) {
      calls.push({ method: 'readOrder', id });
      if (unreadableAfterCapture && captures.size) throw Error('lost read');
      return copy(orders.get(id));
    },
    async captureOrder(input) {
      calls.push({ method: 'capture', ...input });
      const order = orders.get(input.id), id = `CAPTURE${String(captures.size + 1).padStart(8, '0')}`;
      const capture = { id, status: pendingCapture ? 'PENDING' : 'COMPLETED', amount: copy(order.purchase_units[0].amount),
        supplementary_data: { related_ids: { order_id: order.id } } };
      captures.set(id, capture); order.status = pendingCapture ? 'APPROVED' : 'COMPLETED'; order.purchase_units[0].payments = { captures: [copy(capture)] };
      if (lostCapture) throw Error('lost capture answer');
      return copy(order);
    },
    async getCapture(id) { calls.push({ method: 'readCapture', id }); return copy(captures.get(id)); },
  };
  const options = { store, paypal, getQuote: async (allocation) => copy(quotes.find((quote) => quote.quoteId === allocation.quoteId)), now, organizationId: 'org',
    checkoutOrigin: 'http://127.0.0.1:3158', allowSandboxWrites };
  const service = createSandboxCheckout(options), id = randomUUID(), sessionSecretHash = hash('browser-secret');
  const started = await service.start({ id, rfq, proposal, sessionSecretHash });
  return { service, options, id, rfq, proposal, started, sessionSecretHash, store, paypal, quotes, orders, captures, calls,
    approve: () => { for (const order of orders.values()) order.status = 'APPROVED'; },
    flags: (flags) => { ({ lostCreate = false, lostCapture = false, unreadableAfterCapture = false, pendingCapture = false } = flags); },
    advance: (ms) => { clock += ms; } };
}

test('sandbox workflow persists exact approved terms and only exposes approval after a stored order read', async () => {
  const f = await fixture();
  assert.equal(f.started.status, 'awaiting_checkout');
  assert.equal(JSON.stringify(f.started).includes('sessionSecretHash'), false);
  assert.equal(JSON.stringify(f.started).includes('private-confirmation-token'), false);
  const state = await f.service.prepare({ id: f.id });
  assert.equal(state.status, 'awaiting_paypal_approval');
  assert.equal(state.checkout.legs.length, 2);
  assert.ok(state.checkout.legs.every((leg) => leg.approvalUrl.startsWith('https://www.sandbox.paypal.com/checkoutnow?token=')));
  assert.equal(f.calls.filter((call) => call.method === 'create').length, 2);
  await f.service.prepare({ id: f.id });
  assert.equal(f.calls.filter((call) => call.method === 'create').length, 2);
  assert.ok(f.calls.filter((call) => call.method === 'create').every((call) => !call.returnUrl.includes('secret') && new URL(call.returnUrl).searchParams.get('checkout') === f.id));
  const row = await f.store.get({ organizationId: 'org', id: f.id });
  assert.equal(row.sessionSecretHash, f.sessionSecretHash);
  assert.equal(row.proposal.confirmationToken, undefined);
});

test('checkout prepare preserves the approved fingerprint after PostgreSQL-style object-key reordering', async () => {
  const f = await fixture();
  const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  const get = f.store.get;
  f.store.get = async (input) => sorted(await get(input));
  const state = await f.service.prepare({ id: f.id });
  assert.equal(state.status, 'awaiting_paypal_approval');
  assert.equal(state.proposal.termsHash, f.proposal.termsHash);
  assert.equal(f.calls.filter((call) => call.method === 'create').length, 2);
});

test('a concurrent capture after reconciliation loads does not become an unexpected external payment', async () => {
  const f = await fixture();
  const prepared = await f.service.prepare({ id: f.id });
  f.approve();
  const legId = prepared.checkout.legs[0].id;
  const readOrder = f.paypal.getOrder;
  let interleave = true;
  f.paypal.getOrder = async (orderId) => {
    if (interleave) {
      interleave = false;
      await f.service.capture({ id: f.id, legId });
    }
    return readOrder(orderId);
  };
  const state = await f.service.reconcile({ id: f.id });
  assert.equal(state.checkout.blockedReason, null);
  assert.equal(state.checkout.legs[0].status, 'confirmed');
  assert.equal(f.calls.filter((item) => item.method === 'capture').length, 1);
});

test('PayPal buyer approval and prior supplier confirmation are required before each separate capture', async () => {
  const f = await fixture(), ready = await f.service.prepare({ id: f.id });
  const [first, second] = ready.checkout.legs;
  await f.service.capture({ id: f.id, legId: first.id });
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
  f.approve();
  await f.service.capture({ id: f.id, legId: second.id });
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
  const partial = await f.service.capture({ id: f.id, legId: first.id });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.checkout.legs[0].status, 'confirmed');
  const completed = await f.service.capture({ id: f.id, legId: second.id });
  assert.equal(completed.status, 'completed');
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 2);
  assert.equal(f.calls.filter((call) => call.method === 'readCapture').length, 2);
});

test('concurrent capture calls commit only one initial attempt', async () => {
  const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve();
  await Promise.all(Array.from({ length: 16 }, () => f.service.capture({ id: f.id, legId: ready.checkout.legs[0].id })));
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 1);
  assert.equal((await f.service.get({ id: f.id })).checkout.legs[0].status, 'confirmed');
});

test('a lost successful capture response is recovered by original order and capture reads without replay', async () => {
  const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve(); f.flags({ lostCapture: true });
  const firstId = ready.checkout.legs[0].id;
  assert.equal((await f.service.capture({ id: f.id, legId: firstId })).checkout.legs[0].status, 'confirmed');
  const replacement = createSandboxCheckout(f.options);
  await replacement.capture({ id: f.id, legId: firstId });
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 1);
});

test('unknown captures survive service replacement and later reconciliation does not dispatch payments', async () => {
  const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve(); f.flags({ unreadableAfterCapture: true });
  const [first, second] = ready.checkout.legs;
  assert.equal((await f.service.capture({ id: f.id, legId: first.id })).status, 'uncertain');
  await f.service.capture({ id: f.id, legId: second.id });
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 1);
  f.flags({});
  const replacement = createSandboxCheckout(f.options);
  const state = await replacement.capture({ id: f.id, legId: first.id });
  assert.equal(state.status, 'partial');
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 1);
  await replacement.reconcile({ id: f.id });
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 1);
});

test('a lost order creation response blocks a replacement order and later supplier creation across restart', async () => {
  const f = await fixture(); f.flags({ lostCreate: true });
  assert.equal((await f.service.prepare({ id: f.id })).status, 'uncertain');
  const replacement = createSandboxCheckout(f.options);
  await replacement.prepare({ id: f.id }); await replacement.reconcile({ id: f.id });
  assert.equal(f.calls.filter((call) => call.method === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
});

test('a slow first order cannot dispatch a later supplier order after quote expiry', async () => {
  const f = await fixture(), create = f.paypal.createOrder;
  f.paypal.createOrder = async (input) => { const result = await create(input); f.advance(20 * 60 * 1000); return result; };
  const state = await f.service.prepare({ id: f.id });
  assert.equal(state.status, 'expired');
  assert.equal(state.checkout.blockedReason, 'quote_changed');
  assert.equal(f.calls.filter((call) => call.method === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
});

test('changed provider amount, payee, currency or terms binding prevents capture', async (t) => {
  for (const mutation of [
    (unit) => { unit.payee.merchant_id = 'ATTACKER0001'; }, (unit) => { unit.amount.value = '396.51'; },
    (unit) => { unit.amount.currency_code = 'EUR'; }, (unit) => { unit.custom_id = 'other-terms'; },
  ]) await t.test('binding mutation', async () => {
    const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve();
    mutation(f.orders.values().next().value.purchase_units[0]);
    await assert.rejects(f.service.capture({ id: f.id, legId: ready.checkout.legs[0].id }), /BINDING_CHANGED/);
    assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
    assert.equal((await f.service.get({ id: f.id })).checkout.blockedReason, 'provider_binding_changed');
  });
});

test('a malformed completed capture remains unknown rather than establishing payment', async () => {
  const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve();
  const original = f.paypal.getCapture;
  f.paypal.getCapture = async (id) => ({ ...await original(id), amount: { value: '396.51', currency_code: 'USD' } });
  const state = await f.service.capture({ id: f.id, legId: ready.checkout.legs[0].id });
  assert.equal(state.status, 'uncertain');
  assert.equal(state.checkout.legs[0].captureId, null);
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 1);
});

test('a changed provider binding after capture remains uncertain and cannot be treated as an expired unpaid plan', async () => {
  const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve();
  const capture = f.paypal.captureOrder;
  f.paypal.captureOrder = async (input) => {
    const result = await capture(input);
    f.orders.get(input.id).purchase_units[0].payee.merchant_id = 'ATTACKER0001';
    return result;
  };
  const state = await f.service.capture({ id: f.id, legId: ready.checkout.legs[0].id });
  assert.equal(state.status, 'uncertain');
  assert.equal(state.checkout.blockedReason, 'provider_binding_changed');
  assert.equal(state.checkout.legs[0].status, 'uncertain');
  await f.service.capture({ id: f.id, legId: ready.checkout.legs[1].id });
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 1);
});

test('quote changes, expiry and storage uncertainty cannot authorize a fresh capture', async (t) => {
  await t.test('changed supplier quote', async () => {
    const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve();
    f.quotes[0].shippingCents += 1;
    assert.equal((await f.service.capture({ id: f.id, legId: ready.checkout.legs[0].id })).status, 'expired');
    assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
  });
  await t.test('expiry during persisted claim', async () => {
    const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve();
    const claim = f.store.claimCapture;
    f.store.claimCapture = async (input) => { const result = await claim(input); f.advance(20 * 60 * 1000); return result; };
    await f.service.capture({ id: f.id, legId: ready.checkout.legs[0].id });
    assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
    assert.equal((await f.service.get({ id: f.id })).checkout.blockedReason, 'quote_changed');
  });
  await t.test('claim commit failure', async () => {
    const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve();
    f.store.claimCapture = async () => { throw Error('ambiguous COMMIT'); };
    await assert.rejects(f.service.capture({ id: f.id, legId: ready.checkout.legs[0].id }));
    assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
  });
});

test('unpersisted order responses never expose a checkout link or allow creation replay', async () => {
  const f = await fixture();
  f.store.recordOrder = async () => { throw Error('database unavailable'); };
  const state = await f.service.prepare({ id: f.id });
  assert.equal(state.status, 'uncertain');
  assert.equal(state.checkout.legs[0].approvalUrl, null);
  await f.service.prepare({ id: f.id });
  assert.equal(f.calls.filter((call) => call.method === 'create').length, 1);
});

test('disabled writes and a mismatched exact terms hash fail before any provider write', async () => {
  const f = await fixture({ allowSandboxWrites: false });
  await assert.rejects(f.service.prepare({ id: f.id }), /SANDBOX_WRITES_DISABLED/);
  await assert.rejects(f.service.capture({ id: f.id, legId: f.started.checkout.legs[0].id }), /SANDBOX_WRITES_DISABLED/);
  await assert.rejects(f.service.start({ id: randomUUID(), rfq: f.rfq, proposal: { ...f.proposal, totalCents: 67416 }, sessionSecretHash: f.sessionSecretHash }), /TERMS_CHANGED/);
  assert.equal(f.calls.length, 0);
});

test('pending capture status is unknown until a same-identity authoritative read confirms it', async () => {
  const f = await fixture(), ready = await f.service.prepare({ id: f.id }); f.approve(); f.flags({ pendingCapture: true });
  const first = ready.checkout.legs[0];
  assert.equal((await f.service.capture({ id: f.id, legId: first.id })).status, 'uncertain');
  const capture = f.captures.values().next().value, order = f.orders.get(first.orderId);
  capture.status = 'COMPLETED'; order.status = 'COMPLETED'; order.purchase_units[0].payments.captures[0].status = 'COMPLETED';
  assert.equal((await f.service.reconcile({ id: f.id })).status, 'partial');
  assert.equal(f.calls.filter((call) => call.method === 'capture').length, 1);
});

test('an expired unpaid checkout closes in the app after exact provider reads and never reopens', async () => {
  const f = await fixture(), prepared = await f.service.prepare({ id: f.id });
  const original = await f.store.get({ organizationId: 'org', id: f.id });
  f.orders.get(prepared.checkout.legs[0].orderId).status = 'PAYER_ACTION_REQUIRED';
  f.orders.get(prepared.checkout.legs[1].orderId).status = 'APPROVED';
  f.advance(20 * 60 * 1000);
  const callsBefore = f.calls.length;
  const closed = await f.service.closeUnpaid({ id: f.id });
  assert.equal(closed.status, 'closed_unpaid');
  assert.equal(closed.checkout.blockedReason, 'closed_unpaid');
  assert.equal(closed.checkout.canCloseUnpaid, false);
  assert.ok(closed.checkout.legs.every((leg) => leg.status === 'closed_unpaid' && leg.approvalUrl === null));
  assert.deepEqual(f.calls.slice(callsBefore).map((call) => call.method), ['readOrder', 'readOrder']);
  const saved = await f.store.get({ organizationId: 'org', id: f.id });
  for (let index = 0; index < saved.legs.length; index += 1) {
    for (const key of ['allocation', 'referenceId', 'createRequestId', 'captureRequestId', 'createState', 'captureState', 'createAttempts', 'captureAttempts', 'createEvidence', 'captureEvidence']) {
      assert.deepEqual(saved.legs[index][key], original.legs[index][key], `${key} remains unchanged`);
    }
    assert.equal(saved.legs[index].closedUnpaidEvidence.orderId, saved.legs[index].orderId);
  }
  const restored = createSandboxCheckout(f.options);
  assert.equal((await restored.get({ id: f.id })).status, 'closed_unpaid');
  await restored.prepare({ id: f.id });
  await restored.capture({ id: f.id, legId: prepared.checkout.legs[0].id });
  await restored.reconcile({ id: f.id });
  await restored.closeUnpaid({ id: f.id });
  assert.equal(f.calls.length, callsBefore + 2, 'A closed plan has no further provider or financial dispatch.');
});

test('unexpired, uncertain and capture-attempted checkout plans cannot close as unpaid', async (t) => {
  await t.test('unexpired terms', async () => {
    const f = await fixture();
    await f.service.prepare({ id: f.id });
    const before = f.calls.length;
    await assert.rejects(f.service.closeUnpaid({ id: f.id }), /CHECKOUT_CLOSE_UNPAID_BLOCKED/);
    assert.equal(f.calls.length, before);
  });
  await t.test('lost creation result', async () => {
    const f = await fixture(); f.flags({ lostCreate: true });
    await f.service.prepare({ id: f.id }); f.advance(20 * 60 * 1000);
    await assert.rejects(f.service.closeUnpaid({ id: f.id }), /CHECKOUT_CLOSE_UNPAID_BLOCKED/);
    assert.equal((await f.service.get({ id: f.id })).status, 'uncertain');
  });
  await t.test('any local capture claim, even with no provider capture yet', async () => {
    const f = await fixture(), prepared = await f.service.prepare({ id: f.id });
    await f.store.claimCapture({ id: f.id, legId: prepared.checkout.legs[0].id });
    f.advance(20 * 60 * 1000);
    await assert.rejects(f.service.closeUnpaid({ id: f.id }), /CHECKOUT_CLOSE_UNPAID_BLOCKED/);
    assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
  });
});

test('expired unpaid closure refuses mismatched provider records, payment evidence and concurrent claims', async (t) => {
  await t.test('a changed payee', async () => {
    const f = await fixture(), prepared = await f.service.prepare({ id: f.id });
    f.orders.get(prepared.checkout.legs[0].orderId).purchase_units[0].payee.merchant_id = 'ATTACKER0001';
    f.advance(20 * 60 * 1000);
    await assert.rejects(f.service.closeUnpaid({ id: f.id }));
    assert.notEqual((await f.service.get({ id: f.id })).status, 'closed_unpaid');
  });
  await t.test('pending external capture evidence', async () => {
    const f = await fixture(), prepared = await f.service.prepare({ id: f.id });
    f.orders.get(prepared.checkout.legs[0].orderId).purchase_units[0].payments = { captures: [{ id: 'CAPTURE000001', status: 'PENDING' }] };
    f.advance(20 * 60 * 1000);
    await assert.rejects(f.service.closeUnpaid({ id: f.id }));
    assert.notEqual((await f.service.get({ id: f.id })).status, 'closed_unpaid');
  });
  await t.test('malformed payment collections are not evidence of an unpaid order', async () => {
    const f = await fixture(), prepared = await f.service.prepare({ id: f.id });
    f.orders.get(prepared.checkout.legs[0].orderId).purchase_units[0].payments = false;
    f.advance(20 * 60 * 1000);
    await assert.rejects(f.service.closeUnpaid({ id: f.id }));
    assert.notEqual((await f.service.get({ id: f.id })).status, 'closed_unpaid');
  });
  await t.test('capture claim arriving while the last order is read', async () => {
    const f = await fixture(), prepared = await f.service.prepare({ id: f.id });
    const getOrder = f.paypal.getOrder;
    f.paypal.getOrder = async (id) => {
      if (id === prepared.checkout.legs[1].orderId) await f.store.claimCapture({ id: f.id, legId: prepared.checkout.legs[0].id });
      return getOrder(id);
    };
    f.advance(20 * 60 * 1000);
    await assert.rejects(f.service.closeUnpaid({ id: f.id }), /CHECKOUT_CLOSE_UNPAID_BLOCKED/);
    assert.equal((await f.service.get({ id: f.id })).status, 'uncertain');
    assert.equal(f.calls.filter((call) => call.method === 'capture').length, 0);
  });
});
