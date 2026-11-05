import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcurementService } from '../src/procurement.js';
import { createMockSuppliers } from '../src/supplier-mock.js';

const START = Date.parse('2026-11-04T18:00:00Z');
const request = (extra = {}) => ({ quantity: 100, budgetCents: 80000, currency: 'USD',
  deadline: new Date(START + 3 * 86400000).toISOString(), specification: 'White cotton shirts, one navy club logo, sizes and artwork approved.', ...extra });

function setup(scenario = 'normal', options = {}) {
  let at = START;
  const now = () => new Date(at);
  const suppliers = createMockSuppliers({ scenario, now });
  const service = createProcurementService({ suppliers, now, ...options });
  return { service, suppliers, advance: (ms) => { at += ms; } };
}

const approve = (service, state, extra = {}) => service.approve(state.id, {
  confirmationToken: state.proposal.confirmationToken, termsHash: state.proposal.termsHash, ...extra,
});

test('a complete multi-vendor allocation includes all costs, negotiates and respects budget and deadline', async () => {
  const { service } = setup();
  const state = await service.request(request());
  assert.equal(state.status, 'awaiting_approval');
  assert.deepEqual(state.proposal.allocations.map((a) => a.quantity), [60, 40]);
  assert.equal(state.proposal.allocations.reduce((n, a) => n + a.quantity, 0), 100);
  assert.equal(state.proposal.allocations.reduce((n, a) => n + a.totalCents, 0), state.proposal.totalCents);
  assert.ok(state.proposal.totalCents <= 80000);
  for (const a of state.proposal.allocations) {
    assert.equal(a.totalCents, a.goodsCents + a.taxCents + a.shippingCents + a.setupCents);
    assert.ok(Date.parse(a.deliveryAt) <= Date.parse(state.request.deadline));
  }
  assert.equal(state.mode.suppliers, 'simulated');
  assert.equal(state.mode.payments, 'mock');
  assert.ok(state.quotes.some((q) => q.negotiated));
  assert.deepEqual(state.settlements, []);
});

test('an impossible budget or incomplete allocation never creates an approval or payment', async () => {
  const { service } = setup();
  const state = await service.request(request({ budgetCents: 100 }));
  assert.equal(state.status, 'no_feasible_quote');
  assert.equal(state.proposal, null);
  assert.deepEqual(state.settlements, []);
  await assert.rejects(service.approve(state.id, { confirmationToken: 'anything', termsHash: 'anything' }), /proposal/i);
  const small = setup();
  const limited = createProcurementService({ suppliers: small.suppliers.slice(0, 2), now: () => new Date(START) });
  const incomplete = await limited.request(request({ quantity: 150, budgetCents: 200000 }));
  assert.equal(incomplete.status, 'no_feasible_quote', 'no payment proposal can buy only part of the requested quantity');
  assert.equal(incomplete.proposal, null);
});

test('invalid RFQs are refused rather than rounded into different purchases', async () => {
  const { service } = setup();
  for (const change of [{ budgetCents: 1.2 }, { quantity: 0 }, { quantity: 2.5 }, { currency: 'usd' },
    { deadline: 'next Friday' }, { deadline: new Date(START - 1).toISOString() }, { specification: '' }]) {
    await assert.rejects(service.request(request(change)));
  }
});

test('a supplier cannot change its registered payee or inject instructions into the public quote', async () => {
  const { service } = setup('injected-payee');
  const state = await service.request(request());
  assert.ok(state.rejections.some((r) => r.reason.includes('payee')));
  assert.ok(!JSON.stringify(state).includes('attacker-payee'));
  assert.ok(!JSON.stringify(state).includes('ignore all'));
  assert.ok(state.proposal?.allocations.every((a) => a.payeeId.startsWith('mock-payee-')));
});

test('expired quotes and cheaper late deliveries cannot be selected', async () => {
  const expired = setup('expired-quotes');
  assert.equal((await expired.service.request(request())).status, 'no_feasible_quote');
  const late = setup('delivery-miss');
  const state = await late.service.request(request());
  assert.ok(state.rejections.some((r) => r.reason.includes('deadline')));
  assert.ok(state.proposal?.allocations.every((a) => Date.parse(a.deliveryAt) <= Date.parse(state.request.deadline)));
});

test('approval is bound to exact terms and a one-time token', async () => {
  const { service } = setup();
  const state = await service.request(request());
  await assert.rejects(approve(service, state, { termsHash: 'changed-budget' }), /approval/i);
  await assert.rejects(approve(service, state, { confirmationToken: 'wrong-token' }), /approval/i);
  await assert.rejects(approve(service, state, { confirmationToken: '８'.repeat(64) }), /approval/i);
  assert.deepEqual(service.get(state.id).settlements, []);
  const completed = await approve(service, state);
  assert.equal(completed.status, 'completed');
  const duplicate = await approve(service, state);
  assert.equal(duplicate.status, 'completed');
  assert.equal(duplicate.settlements.length, 2);
  assert.equal(duplicate.timeline.filter((e) => e.type === 'payment_attempt').length, 2);
});

test('simultaneous approvals share one execution, with no duplicate supplier payment', async () => {
  const { service } = setup();
  const state = await service.request(request());
  const results = await Promise.all(Array.from({ length: 20 }, () => approve(service, state)));
  assert.ok(results.every((r) => r.status === 'completed'));
  assert.equal(service.get(state.id).timeline.filter((e) => e.type === 'payment_attempt').length, 2);
});

test('quote expiry or a payee change before approval prevents every payment', async () => {
  const expired = setup();
  const state = await expired.service.request(request());
  expired.advance(3600000);
  assert.equal((await approve(expired.service, state)).status, 'expired');
  assert.deepEqual(expired.service.get(state.id).settlements, []);
  const changed = setup();
  const before = await changed.service.request(request());
  const first = changed.suppliers.find((s) => s.id === before.proposal.allocations[0].supplierId);
  const read = first.getQuote;
  first.getQuote = async (id) => ({ ...(await read(id)), payeeId: 'another-payee' });
  assert.equal((await approve(changed.service, before)).status, 'expired');
  assert.deepEqual(changed.service.get(before.id).settlements, []);
});

test('an applied payment with a lost response is verified and never charged twice', async () => {
  const { service } = setup('timeout-after-payment');
  const state = await service.request(request());
  const completed = await approve(service, state);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.timeline.some((e) => e.type === 'recovered'));
  assert.equal(completed.timeline.filter((e) => e.type === 'payment_attempt').length, 2);
  await service.reconcile(state.id);
  assert.equal(service.get(state.id).timeline.filter((e) => e.type === 'payment_attempt').length, 2);
});

test('an unknown payment blocks later vendors until reconciliation confirms the same request', async () => {
  const { service } = setup('pending-payment');
  const state = await service.request(request());
  const uncertain = await approve(service, state);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.timeline.filter((e) => e.type === 'payment_attempt').length, 1);
  await approve(service, state);
  assert.equal(service.get(state.id).timeline.filter((e) => e.type === 'payment_attempt').length, 1);
  const result = await service.reconcile(state.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.timeline.filter((e) => e.type === 'payment_attempt').length, 2);
});

test('partial completion is visible and never represented as rollback or a complete order', async () => {
  const { service } = setup('supplier-declines');
  const state = await service.request(request());
  const partial = await approve(service, state);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.settlements.filter((s) => s.status === 'confirmed').length, 1);
  assert.equal(partial.settlements.filter((s) => s.status === 'failed').length, 1);
  const before = partial.timeline.filter((e) => e.type === 'payment_attempt').length;
  await service.reconcile(state.id);
  assert.equal(service.get(state.id).timeline.filter((e) => e.type === 'payment_attempt').length, before);
  assert.ok(!partial.timeline.some((e) => /rolled back|all paid/i.test(e.message)));
});

test('returned states are copies and cannot mutate the budget, payee or confirmation', async () => {
  const { service } = setup();
  const state = await service.request(request());
  state.request.budgetCents = 900000;
  state.proposal.allocations[0].payeeId = 'attacker-payee';
  assert.equal(service.get(state.id).request.budgetCents, 80000);
  assert.notEqual(service.get(state.id).proposal.allocations[0].payeeId, 'attacker-payee');
});

test('a journal reservation failure prevents every supplier payment', async () => {
  const { service } = setup('normal', { journal: { reserveOperation: async () => { throw new Error('database unavailable'); } } });
  const state = await service.request(request());
  const result = await approve(service, state);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.settlements, []);
  assert.ok(!result.timeline.some((e) => e.type === 'payment_attempt'));
});

test('the service bounds retained procurement sessions', async () => {
  const { service } = setup('normal', { maxSessions: 1 });
  await service.request(request());
  await assert.rejects(service.request(request()), (error) => error.status === 429);
});

test('a lost database outcome after settlement blocks further vendors and reconciles the same payment', async () => {
  let unavailable = true;
  const journal = {
    reserveOperation: async () => ({}),
    claimLeg: async ({ operationKey, kind }) => ({ claimed: true, requestId: `${operationKey}-${kind}` }),
    recordLegOutcome: async () => { if (unavailable) throw new Error('outcome persistence unavailable'); },
  };
  const { service } = setup('normal', { journal });
  const state = await service.request(request());
  assert.equal((await approve(service, state)).status, 'uncertain');
  assert.equal(service.get(state.id).timeline.filter((e) => e.type === 'payment_attempt').length, 1);
  await approve(service, state);
  assert.equal(service.get(state.id).timeline.filter((e) => e.type === 'payment_attempt').length, 1);
  unavailable = false;
  assert.equal((await service.reconcile(state.id)).status, 'completed');
  assert.equal(service.get(state.id).timeline.filter((e) => e.type === 'payment_attempt').length, 2);
});

test('a journal claim that is unavailable or already claimed never triggers a supplier attempt', async () => {
  for (const claimLeg of [async () => ({ claimed: false, reason: 'already claimed' }), async () => { throw new Error('storage unavailable'); }]) {
    const { service } = setup('normal', { journal: { reserveOperation: async () => ({}), claimLeg } });
    const state = await service.request(request());
    const result = await approve(service, state);
    assert.equal(result.timeline.filter((e) => e.type === 'payment_attempt').length, 0);
    assert.deepEqual(result.settlements, []);
    assert.notEqual(result.status, 'completed');
  }
});

test('a completed response with mismatched payment facts stays unknown and is never retried', async () => {
  const { service, suppliers } = setup();
  const first = suppliers.find((supplier) => supplier.id === 'campus-print');
  const read = first.getSettlement;
  first.getSettlement = async (id) => { const record = await read(id); return record && { ...record, amountCents: record.amountCents + 1 }; };
  const state = await service.request(request());
  const result = await approve(service, state);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.settlements[0].status, 'unknown');
  await service.reconcile(state.id);
  assert.equal(service.get(state.id).timeline.filter((e) => e.type === 'payment_attempt').length, 1);
});

test('a declined response with mismatched payment facts stays unknown and blocks later vendors', async () => {
  for (const mismatch of [
    { payeeId: 'mock-payee-another-vendor' }, { quoteId: 'another-quote' }, { quantity: 1 },
    { amountCents: 1 }, { currency: 'EUR' }, { termsHash: 'another-approval' },
  ]) {
    const { service, suppliers } = setup();
    const first = suppliers.find((supplier) => supplier.id === 'campus-print');
    const read = first.getSettlement;
    first.getSettlement = async (id) => {
      const record = await read(id);
      return record && { ...record, status: 'DECLINED', ...mismatch };
    };
    const state = await service.request(request());
    const result = await approve(service, state);
    assert.equal(result.status, 'uncertain', JSON.stringify(mismatch));
    assert.equal(result.settlements[0].status, 'unknown');
    assert.ok(!result.timeline.some((e) => e.type === 'payment_declined'));
    const reconciled = await service.reconcile(state.id);
    assert.equal(reconciled.status, 'uncertain');
    assert.equal(reconciled.timeline.filter((e) => e.type === 'payment_attempt').length, 1);
    assert.equal(reconciled.settlements.length, 1);
  }
});
