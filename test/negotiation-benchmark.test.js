import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkProposal, makeBenchmarkFixture, runNegotiationBenchmark, sourceHashes, summarizeReview, validateFixture, verifyFreeze } from '../scripts/negotiation-benchmark.js';
import { explainProposalReview } from '../src/proposal-review.js';

const epoch = '2026-11-05T20:00:00.000Z';
const hash = (value) => createHash('sha256').update(value).digest('hex');
function example({ budgetCents = 20000, allowSplit = true, suppliers = {} } = {}) {
  return { version: 1, cases: [{ id: 'N-01', epoch,
    request: { quantity: 10, budgetCents, currency: 'USD', specification: 'Identical cotton event shirts, one print.', deadline: '2026-11-10T20:00:00.000Z', allowSplit },
    suppliers: [1, 2, 3].map((id) => ({ id: `supplier-${id}`, capacity: 6, minQuantity: 1,
      initialUnitCents: 600 + id * 10, floorUnitCents: 500 + id * 10, setupCents: 100, shippingCents: 200,
      taxBps: 500, deliveryDays: 2, changedPayee: false, expired: false, ...suppliers[id] })) }] };
}

test('fixture generation is deterministic for a private seed and bounds every scenario', () => {
  const first = makeBenchmarkFixture('b'.repeat(64));
  assert.deepEqual(makeBenchmarkFixture('b'.repeat(64)), first);
  assert.notDeepEqual(makeBenchmarkFixture('c'.repeat(64)), first);
  assert.equal(validateFixture(first).cases.length, 6);
  assert.throws(() => makeBenchmarkFixture('not a seed'), /BENCHMARK_SEED_INVALID/);
  for (const change of [
    (data) => { data.cases[0].request.quantity = 100000; },
    (data) => { data.cases[0].suppliers[0].capacity = 0; },
    (data) => { data.cases[0].suppliers[0].floorUnitCents = -1; },
    (data) => { data.cases[0].suppliers[0].id = 'unregistered-vendor'; },
  ]) { const invalid = structuredClone(first); change(invalid); assert.throws(() => validateFixture(invalid), /BENCHMARK_FIXTURE_INVALID/); }
});

test('frozen source and fixture hashes reject a modified suite or implementation', () => {
  const text = JSON.stringify(example());
  const hashes = sourceHashes();
  const manifest = { version: 1, fixtureSha256: hash(text), sourceHashes: hashes };
  verifyFreeze(text, manifest, hashes);
  assert.throws(() => verifyFreeze(text + ' ', manifest, hashes), /BENCHMARK_FREEZE_MISMATCH/);
  assert.throws(() => verifyFreeze(text, manifest, { ...hashes, 'src/agent.js': 'changed' }), /BENCHMARK_FREEZE_MISMATCH/);
  assert.equal(typeof hashes['src/proposal-review.js'], 'string');
  assert.throws(() => verifyFreeze(text, manifest, { ...hashes, 'src/proposal-review.js': 'changed' }), /BENCHMARK_FREEZE_MISMATCH/);
  assert.throws(() => verifyFreeze(text, manifest, { ...hashes, 'src/new-runtime.js': 'added' }), /BENCHMARK_FREEZE_MISMATCH/);
});

test('the guard retains the complete cheaper baseline and records the extra model-policy calls', async () => {
  const fixture = example();
  const agent = {
    async planNegotiation({ quotes }) { return quotes.map((quote) => ({ supplierId: quote.supplierId, unitPriceCents: quote.unitPriceCents - 20, rationale: 'volume' })); },
    async reviewProposal(input) {
      assert.equal(input.reviewedAt, Date.parse(epoch));
      return explainProposalReview({ ...input, now: input.reviewedAt,
        answer: { choice: 'within_limits', confidence: 0.8, probabilities: { within_limits: 0.8 } } });
    },
  };
  const result = await runNegotiationBenchmark({ fixture, agent });
  const item = result.cases[0];
  assert.equal(result.completed, true);
  assert.equal(item.arms.main_agent.complete, true);
  assert.equal(item.modelComparison.correctFeasibility, true);
  assert.equal(item.modelComparison.modelMinusDeterministicCents, 0);
  assert.equal(item.arms.main_agent.priceGuard.selectedSource, 'baseline');
  assert.ok(item.arms.main_agent.priceGuard.avoidedCents > 0);
  assert.equal(item.arms.main_agent.priceGuard.selectedMatchesProposal, true);
  assert.equal(item.arms.main_agent.priceGuard.selectedNoMoreExpensiveThanCheckedBaseline, true);
  assert.equal(item.arms.main_agent.priceGuard.avoidedCentsMatchesCandidates, true);
  assert.ok(item.arms.main_agent.totalCents < item.arms.initial_quotes.totalCents);
  for (const [name, arm] of Object.entries(item.arms)) {
    assert.equal(arm.paymentCalls, 0);
    assert.equal(arm.quoteCalls, 3);
    assert.equal(arm.negotiationCalls, name === 'main_agent' ? 6 : 3);
    assert.ok(Object.values(arm.negotiationsBySupplier).every((count) => count <= 2));
    assert.equal(arm.exactQuoteBindingsVerified, true);
    assert.equal('issuedQuotes' in arm, false);
    assert.equal(arm.violations.length, 0);
  }
  assert.equal(item.arms.main_agent.advisoryReview.decision, 'needs_review');
  assert.equal(item.arms.main_agent.advisoryReview.allNineCodeChecksPass, true);
  assert.equal(item.arms.main_agent.advisoryReview.onlyReviewerUncertaintyReasons, true);
  assert.deepEqual(item.arms.main_agent.advisoryReview.reasons, [{ code: 'JEV_LOW_CONFIDENCE', source: 'reviewer' }]);
  assert.equal(result.summary.main_agent.warningsOnPassingCodeChecks, 1);
});

test('review reporting allows stable codes and statuses without arbitrary messages or evidence', () => {
  const codes = ['BUDGET', 'QUANTITY', 'SPLIT_POLICY', 'QUOTE_BINDING', 'COST_TOTAL', 'DEADLINE', 'QUOTE_FRESHNESS', 'CURRENCY', 'SPECIFICATION'];
  const result = summarizeReview({ decision: 'needs_review', confidence: 0.7, reviewerDecision: 'within_limits',
    checks: [...codes.map((code) => ({ code, status: 'pass', message: 'private-marker' })), { code: 'INJECTED', status: 'pass' }],
    reasons: [{ code: 'JEV_LOW_CONFIDENCE', source: 'reviewer', evidence: { apiKey: 'private-marker' }, message: 'private-marker' },
      { code: 'INJECTED', source: 'reviewer', message: 'private-marker' }] });
  assert.equal(result.checks.length, 9);
  assert.equal(result.reasons.length, 1);
  assert.equal(result.allNineCodeChecksPass, true);
  assert.equal(result.omittedUnexpectedChecks, 1);
  assert.equal(result.omittedUnexpectedReasons, 1);
  assert.equal(JSON.stringify(result).includes('private-marker'), false);
});

test('budget, split prohibition and invalid suppliers produce honest no-feasible outcomes', async () => {
  for (const fixture of [example({ budgetCents: 100 }), example({ allowSplit: false }),
    example({ suppliers: { 1: { changedPayee: true }, 2: { expired: true } } })]) {
    const result = await runNegotiationBenchmark({ fixture });
    assert.equal(result.cases[0].expectedFeasibleBySupplierFloorBaseline, false);
    for (const arm of Object.values(result.cases[0].arms)) {
      assert.equal(arm.status, 'no_feasible_quote');
      assert.equal(arm.totalCents, null);
      assert.equal(arm.paymentCalls, 0);
    }
  }
});

test('a failed model preserves its failure and marks every remaining model case unrun', async () => {
  const fixture = example();
  fixture.cases.push({ ...structuredClone(fixture.cases[0]), id: 'N-02' });
  let calls = 0;
  const result = await runNegotiationBenchmark({ fixture, agent: { async planNegotiation() { calls += 1; throw Error('synthetic provider failure'); } } });
  assert.equal(result.completed, false);
  assert.equal(result.modelInterrupted, true);
  assert.equal(calls, 1);
  assert.equal(result.cases[0].arms.main_agent.status, 'error');
  assert.equal(result.cases[1].arms.main_agent.status, 'not_run');
  assert.equal(result.summary.main_agent.cases, 2);
  assert.equal(result.summary.main_agent.errorsOrNotRun, 2);
  assert.equal(result.summary.main_agent.measuredLatencyCases, 1);
  assert.equal(result.summary.deterministic_negotiation.completeOrders, 2);
});

test('independent checks reject a paid amount or payee inconsistent with fixture policy', () => {
  const item = example().cases[0];
  const leg = { supplierId: 'supplier-1', payeeId: 'wrong-payee', quantity: 10, unitPriceCents: 510,
    currency: 'USD', specificationHash: hash(item.request.specification), setupCents: 100, shippingCents: 200,
    taxBps: 500, totalCents: 5660, deliveryAt: '2026-11-07T20:00:00.000Z', expiresAt: '2026-11-05T20:15:00.000Z' };
  // Keep the quantity within stock so the independent financial checks are exercised.
  item.suppliers[0].capacity = 10;
  let checked = checkProposal(item, { quantity: 10, totalCents: 5660, allocations: [leg] });
  assert.equal(checked.complete, false);
  assert.ok(checked.violations.includes('PAYEE'));
  checked = checkProposal(item, { quantity: 10, totalCents: 1, allocations: [{ ...leg, payeeId: 'benchmark-payee-supplier-1' }] });
  assert.ok(checked.violations.includes('TOTAL_OR_BUDGET'));
});

test('independent checking requires the exact issued quote rather than a price inside policy bounds', () => {
  const item = example().cases[0];
  item.suppliers[0].capacity = 10;
  const issued = { supplierId: 'supplier-1', quoteId: 'bench-N-01-supplier-1-0', payeeId: 'benchmark-payee-supplier-1',
    unitPriceCents: 610, minQuantity: 1, maxQuantity: 10, currency: 'USD', specificationHash: hash(item.request.specification),
    setupCents: 100, shippingCents: 200, taxBps: 500, deliveryAt: '2026-11-07T20:00:00.000Z', expiresAt: '2026-11-05T20:15:00.000Z' };
  const issuedQuotes = new Map([[issued.quoteId, Object.freeze(issued)]]);
  const leg = { ...issued, quantity: 10, totalCents: 6710 };
  const proposal = (allocation = leg) => ({ quantity: 10, totalCents: allocation.totalCents, allocations: [allocation] });
  assert.equal(checkProposal(item, proposal(), issuedQuotes).complete, true);
  assert.equal(checkProposal(item, proposal(), issuedQuotes).exactQuoteBindingsVerified, true);
  const missingEvidence = checkProposal(item, proposal());
  assert.equal(missingEvidence.complete, false);
  assert.equal(missingEvidence.exactQuoteBindingsVerified, false);
  assert.ok(missingEvidence.violations.includes('QUOTE_BINDING_UNVERIFIED'));
  const forged = { ...leg, unitPriceCents: 510, totalCents: 5660 };
  const altered = [forged, { ...leg, setupCents: 200 }, { ...leg, maxQuantity: 40 },
    { ...leg, deliveryAt: '2026-11-08T20:00:00.000Z' }, { ...leg, expiresAt: '2026-11-05T20:30:00.000Z' }];
  for (const allocation of altered) {
    const result = checkProposal(item, proposal(allocation), issuedQuotes);
    assert.equal(result.complete, false);
    assert.equal(result.exactQuoteBindingsVerified, false);
    assert.ok(result.violations.includes('QUOTE_BINDING_MISMATCH'));
  }
  const unissued = checkProposal(item, proposal({ ...leg, quoteId: 'bench-N-01-supplier-1-1' }), issuedQuotes);
  assert.equal(unissued.complete, false);
  assert.ok(unissued.violations.includes('QUOTE_BINDING_UNVERIFIED'));
});
