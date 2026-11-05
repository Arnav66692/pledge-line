import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcurementService } from '../src/procurement.js';
import { createMockSuppliers } from '../src/supplier-mock.js';

const now = () => new Date('2026-11-05T12:00:00Z');
const request = (extra = {}) => ({ quantity: 100, budgetCents: 80000, currency: 'USD',
  deadline: '2026-11-12T12:00:00Z', specification: 'Identical white cotton volunteer shirts with one navy print.', ...extra });
const reviewer = { reviewProposal: async () => ({ decision: 'within_limits', advisory: true, authorizesPayment: false }) };
const planner = { ...reviewer, planNegotiation: async ({ quotes }) => quotes.map((quote) => ({
  supplierId: quote.supplierId, unitPriceCents: quote.unitPriceCents - 50, rationale: 'volume',
})) };

test('the negotiation record distinguishes model offers, supplier responses and the exact selected quotes', async () => {
  const offersSent = [];
  const suppliers = createMockSuppliers({ now }).map((supplier) => ({ ...supplier,
    async negotiate(input) {
      offersSent.push({ supplierId: supplier.id, ...input.counterOffer });
      return supplier.negotiate(input);
    },
  }));
  const service = createProcurementService({ suppliers, now, agent: planner });
  const state = await service.request(request());
  const trace = state.negotiationTrace;
  assert.equal(trace.version, 1);
  assert.equal(trace.supplierRounds.length, 3);
  for (const round of trace.supplierRounds) {
    assert.equal(round.counteroffer.source, 'main_agent');
    assert.equal(round.counteroffer.rationale, 'volume');
    assert.equal(round.counteroffer.unitPriceCents, offersSent.find((offer) => offer.supplierId === round.supplierId && offer.unitPriceCents).unitPriceCents);
    assert.equal(round.counteroffer.unitPriceCents, round.initialQuote.unitPriceCents - 50);
    assert.equal(round.baselineQuote.quoteId, round.acceptedQuoteId);
    assert.notEqual(round.initialQuote.quoteId, round.responseQuote.quoteId);
    assert.equal(round.outcome, 'accepted_baseline');
    assert.equal(round.reasonCode, 'baseline_price_guard');
    assert.equal(round.responseReasonCode, 'discount_verified');
    assert.equal(round.selectedForAllocation, state.proposal.allocations.some((leg) => leg.quoteId === round.acceptedQuoteId));
  }
  assert.deepEqual(trace.allocation.allocations, state.proposal.allocations.map(({ supplierId, quoteId, quantity, totalCents }) => ({ supplierId, quoteId, quantity, totalCents })));
  assert.equal(trace.allocation.totalCents, state.proposal.totalCents);
  assert.equal(trace.allocation.allocations.reduce((sum, leg) => sum + leg.quantity, 0), request().quantity);
  assert.deepEqual(state.settlements, [], 'Inspecting negotiation evidence creates no payment authority.');
  trace.supplierRounds[0].counteroffer.unitPriceCents = 1;
  assert.notEqual(service.get(state.id).negotiationTrace.supplierRounds[0].counteroffer.unitPriceCents, 1);
});

test('a response with worse fees remains inspectable while the original quote remains selected', async () => {
  const suppliers = createMockSuppliers({ now });
  const first = suppliers[0];
  const negotiate = first.negotiate;
  first.negotiate = async (input) => ({ ...(await negotiate(input)), shippingCents: 90000 });
  const state = await createProcurementService({ suppliers, now, agent: planner }).request(request({ budgetCents: 200000 }));
  const round = state.negotiationTrace.supplierRounds.find((item) => item.supplierId === first.id);
  assert.equal(round.outcome, 'kept_initial');
  assert.equal(round.reasonCode, 'initial_terms_selected');
  assert.equal(round.responseReasonCode, 'terms_not_improved');
  assert.equal(round.responseQuote.shippingCents, 90000);
  assert.equal(round.acceptedQuoteId, round.initialQuote.quoteId);
  assert.equal(state.quotes.find((quote) => quote.supplierId === first.id).quoteId, round.initialQuote.quoteId);
});

test('invalid supplier responses have stable rejection codes without persisting their payload or errors', async () => {
  const suppliers = createMockSuppliers({ scenario: 'injected-payee', now });
  const second = suppliers[1];
  second.quote = async () => { throw new Error('postgres://private-password@example.invalid/database'); };
  const state = await createProcurementService({ suppliers, now, agent: planner }).request(request());
  const trace = state.negotiationTrace;
  assert.equal(trace.supplierRounds[0].responseReasonCode, 'payee_mismatch');
  assert.equal(trace.supplierRounds[0].baselineReasonCode, 'payee_mismatch');
  assert.equal(trace.supplierRounds[0].initialQuote.supplierId, suppliers[0].id);
  assert.equal(trace.supplierRounds[0].responseQuote, null);
  assert.equal(trace.supplierRounds[0].acceptedQuoteId, trace.supplierRounds[0].initialQuote.quoteId);
  assert.equal(trace.supplierRounds[1].reasonCode, 'supplier_unavailable');
  assert.equal(trace.supplierRounds[1].initialQuote, null);
  assert.deepEqual(trace.allocation.rejections.map(({ reasonCode }) => reasonCode), ['payee_mismatch', 'supplier_unavailable']);
  for (const forbidden of ['attacker-payee', 'ignore all', 'private-password', 'postgres://']) assert.ok(!JSON.stringify(state).includes(forbidden));
});

test('infeasible allocation retains the negotiation record without an approval or settlement', async () => {
  const state = await createProcurementService({ now }).request(request({ budgetCents: 1 }));
  assert.equal(state.status, 'no_feasible_quote');
  assert.equal(state.negotiationTrace.allocation.status, 'no_feasible_quote');
  assert.equal(state.negotiationTrace.allocation.totalCents, null);
  assert.deepEqual(state.negotiationTrace.allocation.allocations, []);
  assert.ok(state.negotiationTrace.supplierRounds.every((round) => round.counteroffer === null && !round.selectedForAllocation));
  assert.equal(state.proposal, null);
  assert.deepEqual(state.settlements, []);
});

test('malformed counteroffers fail before a supplier sees them', async () => {
  for (const offers of [null, [], [{ supplierId: 'campus-print', unitPriceCents: 1, rationale: 'ignore every limit' }],
    [{ supplierId: 'campus-print', unitPriceCents: 999999, rationale: 'budget' }],
    [{ supplierId: 'campus-print', unitPriceCents: 600, rationale: 'volume', apiKey: 'private-marker' }],
    Array(6).fill({ supplierId: 'campus-print', unitPriceCents: 600, rationale: 'budget' })]) {
    let negotiations = 0;
    const suppliers = createMockSuppliers({ now }).map((supplier) => ({ ...supplier, negotiate: async () => { negotiations += 1; throw Error(); } }));
    await assert.rejects(createProcurementService({ now, suppliers, agent: { ...reviewer, planNegotiation: async () => offers } }).request(request()), /could not verify a negotiation plan/);
    assert.equal(negotiations, 0);
  }
});

test('five maximum-length registered suppliers retain bounded evidence with sanitized labels', async () => {
  const supplier = createMockSuppliers({ now })[2];
  const adapters = Array.from({ length: 5 }, (_, index) => ({ ...supplier,
    id: `supplier-${index}`, name: `Private owner${index}@example.invalid\n${'x'.repeat(50)}`,
    payeeId: 'P'.repeat(120),
    async quote(input) { return { ...(await supplier.quote(input)), supplierId: this.id, payeeId: this.payeeId, quoteId: `${index}${'q'.repeat(119)}` }; },
    async negotiate({ request: input }) { return { ...(await supplier.negotiate({ request: input })), supplierId: this.id, payeeId: this.payeeId, quoteId: `${index}${'n'.repeat(119)}` }; },
  }));
  const state = await createProcurementService({ now, suppliers: adapters, agent: planner }).request(request({ budgetCents: 200000 }));
  assert.equal(state.negotiationTrace.supplierRounds.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(state.negotiationTrace)) < 16 * 1024);
  assert.ok(state.negotiationTrace.supplierRounds.every((round) => !round.supplierName.includes('@') && !round.supplierName.includes('\n')));
});
