import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProcurementService } from '../src/procurement.js';

const now = () => new Date('2026-11-05T12:00:00Z');
const request = (extra = {}) => ({ quantity: 10, budgetCents: 10000, currency: 'USD', allowSplit: true,
  specification: 'Identical cotton volunteer shirts and navy print.', deadline: '2026-11-12T12:00:00Z', ...extra });
const agent = { mode: 'anthropic', planNegotiation: async ({ quotes }) => quotes.map((quote) => ({
  supplierId: quote.supplierId, unitPriceCents: quote.unitPriceCents - 1, rationale: 'budget',
})), reviewProposal: async () => ({ decision: 'within_limits', advisory: true, authorizesPayment: false }) };

function supplier({ id = 'controlled', initial = {}, baseline = {}, model = {} } = {}) {
  const records = new Map(), calls = [];
  let issued = 0, payments = 0;
  const issue = (rfq, terms) => {
    if (terms instanceof Error) throw terms;
    const quote = { supplierId: id, payeeId: 'REGISTEREDMERCHANT', quoteId: `quote-${++issued}`,
      specificationHash: createHash('sha256').update(rfq.specification).digest('hex'), currency: 'USD',
      minQuantity: 1, maxQuantity: rfq.quantity, unitPriceCents: 500, setupCents: 0, shippingCents: 0, taxBps: 0,
      deliveryAt: '2026-11-06T12:00:00Z', expiresAt: '2026-11-05T13:00:00Z', ...terms };
    records.set(quote.quoteId, structuredClone(quote)); return quote;
  };
  return { id, name: 'Controlled test supplier', payeeId: 'REGISTEREDMERCHANT', mode: 'simulated', calls,
    quote: async (rfq) => issue(rfq, initial),
    negotiate: async ({ request: rfq, counterOffer }) => { calls.push(counterOffer ? 'agent' : 'baseline'); return issue(rfq, counterOffer ? model : baseline); },
    getQuote: async (id) => structuredClone(records.get(id)),
    settle: async () => { payments += 1; throw Error('No test may pay.'); }, getSettlement: async () => null,
    get paymentAttempts() { return payments; },
  };
}

test('the price guard selects the cheaper complete baseline including fees, even when the model has the cheaper unit price', async () => {
  const adapter = supplier({ baseline: { unitPriceCents: 200 }, model: { unitPriceCents: 100, setupCents: 2000 } });
  const state = await createProcurementService({ now, suppliers: [adapter], agent }).request(request());
  assert.deepEqual(adapter.calls, ['baseline', 'agent']);
  assert.equal(state.proposal.totalCents, 2000);
  assert.deepEqual(state.negotiationTrace.priceGuard, { version: 1, baselineTotalCents: 2000, agentTotalCents: 3000,
    selectedTotalCents: 2000, selectedSource: 'baseline', comparisonComplete: true, avoidedCents: 1000 });
  const round = state.negotiationTrace.supplierRounds[0];
  assert.equal(state.proposal.allocations[0].quoteId, round.baselineQuote.quoteId);
  assert.equal(state.quotes[0].quoteId, round.acceptedQuoteId);
  assert.equal(round.responseQuote.unitPriceCents, 100);
  assert.equal(round.outcome, 'accepted_baseline');
  assert.equal(adapter.paymentAttempts, 0);
  assert.deepEqual(state.settlements, []);
});

test('a genuinely cheaper complete model allocation remains selected', async () => {
  const adapter = supplier({ baseline: { unitPriceCents: 200 }, model: { unitPriceCents: 250, shippingCents: 0 }, initial: { unitPriceCents: 500, shippingCents: 0 } });
  // A different fee structure makes the larger model unit price cheaper all-in.
  const original = adapter.negotiate;
  adapter.negotiate = async (input) => ({ ...(await original(input)), shippingCents: input.counterOffer ? 0 : 1000 });
  const state = await createProcurementService({ now, suppliers: [adapter], agent }).request(request());
  assert.equal(state.proposal.totalCents, 2500);
  assert.equal(state.negotiationTrace.priceGuard.baselineTotalCents, 3000);
  assert.equal(state.negotiationTrace.priceGuard.selectedSource, 'agent');
  assert.equal(state.negotiationTrace.priceGuard.avoidedCents, 0);
  const round = state.negotiationTrace.supplierRounds[0];
  assert.equal(round.acceptedQuoteId, round.responseQuote.quoteId);
});

test('alternate quotes cannot double-count one supplier stock, and a feasible model plan can rescue an infeasible baseline', async () => {
  const adapter = supplier({ initial: { maxQuantity: 4 }, baseline: { unitPriceCents: 100, maxQuantity: 4 }, model: { unitPriceCents: 200, maxQuantity: 8 } });
  const state = await createProcurementService({ now, suppliers: [adapter], agent }).request(request({ quantity: 8 }));
  assert.equal(state.proposal.quantity, 8);
  assert.equal(state.proposal.allocations.length, 1);
  assert.equal(state.proposal.totalCents, 1600);
  assert.equal(state.negotiationTrace.priceGuard.baselineTotalCents, null, 'Initial and baseline are alternate quotes for four units, not eight units of stock.');
  assert.equal(state.negotiationTrace.priceGuard.agentTotalCents, 1600);
  assert.equal(state.negotiationTrace.priceGuard.selectedSource, 'agent');
  assert.equal(state.negotiationTrace.priceGuard.comparisonComplete, false);
  assert.equal(state.negotiationTrace.priceGuard.avoidedCents, 0);
});

test('an invalid baseline payee is excluded without retaining its payload or inventing comparison savings', async () => {
  const adapter = supplier({ baseline: { unitPriceCents: 1, payeeId: 'attacker-payee', password: 'private-marker' }, model: { unitPriceCents: 100 } });
  const state = await createProcurementService({ now, suppliers: [adapter], agent }).request(request({ budgetCents: 2000 }));
  assert.equal(state.negotiationTrace.supplierRounds[0].baselineQuote, null);
  assert.equal(state.negotiationTrace.supplierRounds[0].baselineReasonCode, 'payee_mismatch');
  assert.equal(state.negotiationTrace.priceGuard.baselineTotalCents, null);
  assert.equal(state.negotiationTrace.priceGuard.avoidedCents, 0);
  assert.equal(state.proposal.totalCents, 1000);
  assert.ok(!JSON.stringify(state).includes('attacker-payee'));
  assert.ok(!JSON.stringify(state).includes('private-marker'));
});

test('equal complete prices prefer baseline terms and model failure never dispatches a baseline fallback', async () => {
  const adapter = supplier({ baseline: { unitPriceCents: 100 }, model: { unitPriceCents: 100 } });
  const state = await createProcurementService({ now, suppliers: [adapter], agent }).request(request());
  assert.equal(state.negotiationTrace.priceGuard.selectedSource, 'baseline');
  assert.equal(state.negotiationTrace.priceGuard.avoidedCents, 0);
  const stopped = supplier();
  await assert.rejects(createProcurementService({ now, suppliers: [stopped], agent: { ...agent,
    planNegotiation: async () => { throw Error('AI_BUDGET_STOPPED'); } } }).request(request()), /main agent could not verify/);
  assert.deepEqual(stopped.calls, []);
  assert.equal(stopped.paymentAttempts, 0);
});

test('the guard selects a cheaper hybrid of validated baseline and model quotes rather than either whole portfolio', async () => {
  const stock = { minQuantity: 1, maxQuantity: 1 };
  const first = supplier({ id: 'first', initial: { ...stock, unitPriceCents: 100 },
    baseline: { ...stock, unitPriceCents: 50 }, model: { ...stock, unitPriceCents: 40 } });
  const second = supplier({ id: 'second', initial: { ...stock, unitPriceCents: 100 },
    baseline: { ...stock, unitPriceCents: 40 }, model: { ...stock, unitPriceCents: 50 } });
  const state = await createProcurementService({ now, suppliers: [first, second], agent }).request(request({ quantity: 2 }));
  assert.deepEqual(state.negotiationTrace.priceGuard, { version: 1, baselineTotalCents: 90, agentTotalCents: 90,
    selectedTotalCents: 80, selectedSource: 'hybrid', comparisonComplete: true, avoidedCents: 10 });
  assert.equal(state.proposal.totalCents, 80);
  assert.equal(state.proposal.allocations.length, 2);
  assert.equal(new Set(state.proposal.allocations.map((leg) => leg.supplierId)).size, 2);
  for (const round of state.negotiationTrace.supplierRounds) {
    const expected = round.supplierId === 'first' ? round.responseQuote.quoteId : round.baselineQuote.quoteId;
    assert.equal(round.acceptedQuoteId, expected);
    assert.equal(state.quotes.find((quote) => quote.supplierId === round.supplierId).quoteId, expected);
    assert.equal(state.proposal.allocations.find((leg) => leg.supplierId === round.supplierId).quoteId, expected);
  }
  assert.deepEqual(first.calls, ['baseline', 'agent']);
  assert.deepEqual(second.calls, ['baseline', 'agent']);
  assert.equal(first.paymentAttempts + second.paymentAttempts, 0);
});

test('a feasible hybrid does not invent comparison savings when neither separate portfolio fits the budget', async () => {
  const stock = { minQuantity: 1, maxQuantity: 1 };
  const first = supplier({ id: 'first', initial: { ...stock, unitPriceCents: 100 },
    baseline: { ...stock, unitPriceCents: 40 }, model: { ...stock, unitPriceCents: 10, payeeId: 'unregistered' } });
  const second = supplier({ id: 'second', initial: { ...stock, unitPriceCents: 100 },
    baseline: { ...stock, unitPriceCents: 10, payeeId: 'unregistered' }, model: { ...stock, unitPriceCents: 40 } });
  const state = await createProcurementService({ now, suppliers: [first, second], agent }).request(request({ quantity: 2, budgetCents: 80 }));
  assert.equal(state.proposal.totalCents, 80);
  assert.deepEqual(state.negotiationTrace.priceGuard, { version: 1, baselineTotalCents: null, agentTotalCents: null,
    selectedTotalCents: 80, selectedSource: 'hybrid', comparisonComplete: false, avoidedCents: null });
  assert.equal(state.proposal.allocations.length, 2);
  assert.ok(state.proposal.allocations.every((leg) => leg.payeeId === 'REGISTEREDMERCHANT'));
  assert.ok(!JSON.stringify(state).includes('unregistered'));
});

test('reused quote identities cannot replace known prices, fees or quantity bounds', async () => {
  for (const [baseline, model] of [
    [{ unitPriceCents: 50 }, { unitPriceCents: 40 }],
    [{ shippingCents: 50 }, { setupCents: 40 }],
    [{ minQuantity: 2, maxQuantity: 9 }, { minQuantity: 3, maxQuantity: 8 }],
  ]) {
    const adapter = supplier({ initial: { quoteId: 'same-quote', unitPriceCents: 100 },
      baseline: { quoteId: 'same-quote', unitPriceCents: 100, ...baseline },
      model: { quoteId: 'same-quote', unitPriceCents: 100, ...model } });
    const service = createProcurementService({ now, suppliers: [adapter], agent });
    const state = await service.request(request());
    const round = state.negotiationTrace.supplierRounds[0];
    assert.equal(round.baselineReasonCode, 'quote_identity_changed');
    assert.equal(round.responseReasonCode, 'quote_identity_changed');
    assert.equal(round.baselineQuote, null);
    assert.equal(round.responseQuote, null);
    assert.equal(round.outcome, 'kept_initial');
    assert.equal(round.acceptedQuoteId, round.initialQuote.quoteId);
    assert.equal(state.quotes[0].unitPriceCents, 100);
    assert.equal(state.quotes[0].shippingCents, 0);
    assert.equal(state.quotes[0].setupCents, 0);
    assert.equal(state.quotes[0].minQuantity, 1);
    assert.equal(state.quotes[0].maxQuantity, 10);
    assert.equal(state.proposal.totalCents, 1000);
    assert.equal(state.proposal.allocations[0].unitPriceCents, state.quotes[0].unitPriceCents);
    const refused = await service.approve(state.id, state.proposal);
    assert.equal(refused.status, 'expired', 'A provider retaining its changed quote cannot pass the fresh exact-term check.');
    assert.equal(adapter.paymentAttempts, 0);
  }
});

test('a model response cannot mutate an earlier baseline quote identity', async () => {
  const adapter = supplier({ initial: { unitPriceCents: 100 },
    baseline: { quoteId: 'baseline-quote', unitPriceCents: 50 },
    model: { quoteId: 'baseline-quote', unitPriceCents: 40 } });
  const state = await createProcurementService({ now, suppliers: [adapter], agent }).request(request());
  const round = state.negotiationTrace.supplierRounds[0];
  assert.equal(round.baselineQuote.unitPriceCents, 50);
  assert.equal(round.responseQuote, null);
  assert.equal(round.responseReasonCode, 'quote_identity_changed');
  assert.equal(round.outcome, 'accepted_baseline');
  assert.equal(state.proposal.totalCents, 500);
  assert.equal(state.quotes[0].unitPriceCents, 50);
  assert.equal(state.quotes[0].quoteId, state.proposal.allocations[0].quoteId);
  assert.equal(state.quotes[0].totalCents, state.proposal.allocations[0].totalCents);
});

test('identical commercial terms may reuse an identity and remain attributed to the initial offer', async () => {
  const terms = { quoteId: 'same-quote', unitPriceCents: 100 };
  const adapter = supplier({ initial: terms, baseline: terms, model: terms });
  const state = await createProcurementService({ now, suppliers: [adapter], agent }).request(request());
  const round = state.negotiationTrace.supplierRounds[0];
  assert.equal(round.baselineReasonCode, 'baseline_verified');
  assert.equal(round.responseReasonCode, 'no_discount');
  assert.equal(round.outcome, 'kept_initial');
  assert.equal(round.reasonCode, 'initial_terms_selected');
  assert.equal(state.proposal.totalCents, 1000);
  assert.equal(state.negotiationTrace.priceGuard.selectedSource, 'baseline');
  assert.equal(round.acceptedQuoteId, round.initialQuote.quoteId);
  assert.equal(state.quotes[0].unitPriceCents, state.proposal.allocations[0].unitPriceCents);
});
